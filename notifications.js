import crypto from 'node:crypto';
import {Router} from 'express';
import sql from './db.js';
import {notificationTokenFor,optionalAuthenticate} from './auth.js';
import {sendOtpEmail} from './email.js';
import {normalizeWhatsAppNumber,sendOtpWhatsApp} from './whatsapp.js';
import {sendOtpSms,verifyOtpSms} from './sms.js';
import {emailPattern} from './utils.js';

const router=Router();
const normalize=(channel,value)=>channel==='EMAIL'?String(value||'').trim().toLowerCase():normalizeWhatsAppNumber(value);
const codeHash=(code,destination,nonce)=>crypto.createHmac('sha256',process.env.AUTH_SECRET||process.env.DATABASE_URL||process.env.POSTGRES_URL||'').update(`${code}:${destination}:${nonce}`).digest('hex');
const safeEqual=(left,right)=>{const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&crypto.timingSafeEqual(a,b)};

router.post('/notification-verifications/request',optionalAuthenticate,async(req,res)=>{
  const channel=String(req.body.channel||'').toUpperCase(),purpose=String(req.body.purpose||'').toUpperCase(),destination=normalize(channel,req.body.destination);
  if(!['REGISTRATION','CHECKOUT'].includes(purpose))return res.status(400).json({error:'Invalid verification purpose.'});
  if(!['EMAIL','WHATSAPP','SMS'].includes(channel)||(channel==='EMAIL'?!emailPattern.test(destination):!destination))return res.status(400).json({error:'A valid email or mobile notification destination is required.'});
  if(req.user&&['WHATSAPP','SMS'].includes(channel)&&destination!==normalizeWhatsAppNumber(req.user.phone))return res.status(403).json({error:'Verify the mobile number stored on your account.'});
  if(req.user&&purpose==='CHECKOUT'&&destination===String(req.user.email).toLowerCase()&&req.user.email_verified_at)return res.json({verified:true,channel,destination});
  if(req.user&&purpose==='CHECKOUT'&&['WHATSAPP','SMS'].includes(channel)&&destination===normalizeWhatsAppNumber(req.user.phone)&&req.user.phone_verified_at)return res.json({verified:true,channel,destination});

  const recent=await sql`SELECT nv.created_at FROM notification_verifications nv JOIN notification_deliveries nd ON nd.verification_id=nv.id WHERE nv.channel=${channel} AND nv.destination=${destination} AND nv.created_at>NOW()-INTERVAL '1 hour' AND nd.status IN ('PENDING','ACCEPTED','DELIVERED') ORDER BY nv.created_at DESC`;
  if(recent[0]&&Date.now()-new Date(recent[0].created_at).getTime()<60000)return res.status(429).json({error:'Please wait before requesting another code.',retry_after_seconds:60-Math.floor((Date.now()-new Date(recent[0].created_at).getTime())/1000)});
  if(recent.length>=3)return res.status(429).json({error:'Verification code limit reached. Try again in one hour.'});

  const code=String(crypto.randomInt(100000,1000000)),nonce=crypto.randomBytes(16).toString('hex');
  const verification=(await sql`INSERT INTO notification_verifications(user_id,channel,destination,purpose,code_hash,nonce,expires_at) VALUES(${req.user?.id||null},${channel},${destination},${purpose},${codeHash(code,destination,nonce)},${nonce},NOW()+INTERVAL '10 minutes') RETURNING id,expires_at`)[0];
  const idempotencyKey=`otp/${verification.id}`;
  const provider=channel==='WHATSAPP'?'META_WHATSAPP':channel==='SMS'?'TWILIO':'RESEND';
  const delivery=(await sql`INSERT INTO notification_deliveries(verification_id,notification_type,channel,destination,provider,status,idempotency_key) VALUES(${verification.id},'OTP',${channel},${destination},${provider},'PENDING',${idempotencyKey}) RETURNING id`)[0];
  try{
    const result=channel==='WHATSAPP'?await sendOtpWhatsApp({to:destination,code,purpose,verificationId:verification.id}):channel==='SMS'?await sendOtpSms({to:destination}):await sendOtpEmail({to:destination,code,purpose,verificationId:verification.id});
    await sql`UPDATE notification_deliveries SET status='ACCEPTED',provider_message_id=${result.id},updated_at=NOW() WHERE id=${delivery.id}`;
  }catch(error){
    console.error('Verification delivery failed',{channel,provider,code:error.providerCode||error.code||null,status:error.statusCode||null,message:error.message});
    await sql`UPDATE notification_deliveries SET status='FAILED',error_message=${String(error.message).slice(0,500)},updated_at=NOW() WHERE id=${delivery.id}`;
    return res.status(503).json({error:`The verification ${channel==='WHATSAPP'?'WhatsApp message':channel==='SMS'?'SMS':'email'} could not be sent. Please try again.`});
  }
  return res.status(201).json({verification_id:verification.id,channel,destination,expires_at:verification.expires_at,resend_after_seconds:60});
});

router.post('/notification-verifications/verify',optionalAuthenticate,async(req,res)=>{
  const id=String(req.body.verification_id||''),code=String(req.body.code||'').trim();
  if(!/^\d+$/.test(id)||!/^\d{6}$/.test(code))return res.status(400).json({error:'A valid verification code is required.'});
  const verification=(await sql`SELECT * FROM notification_verifications WHERE id=${id}`)[0];
  if(!verification||verification.verified_at||new Date(verification.expires_at)<=new Date()||verification.attempts>=5)return res.status(410).json({error:'This verification code has expired. Request a new code.'});
  let approved;
  try{approved=verification.channel==='SMS'?await verifyOtpSms({to:verification.destination,code}):safeEqual(codeHash(code,verification.destination,verification.nonce),verification.code_hash)}catch(error){
    console.error('Verification check failed',{channel:verification.channel,code:error.providerCode||error.code||null,status:error.statusCode||null,message:error.message});
    return res.status(503).json({error:'The verification service is unavailable. Please try again.'});
  }
  if(!approved){
    await sql`UPDATE notification_verifications SET attempts=attempts+1 WHERE id=${id}`;
    return res.status(400).json({error:'Incorrect verification code.'});
  }
  await sql`UPDATE notification_verifications SET verified_at=NOW() WHERE id=${id}`;
  if(req.user&&verification.channel==='EMAIL'&&verification.destination===String(req.user.email).toLowerCase())await sql`UPDATE users SET email_verified_at=NOW(),updated_at=NOW() WHERE id=${req.user.id}`;
  if(req.user&&['WHATSAPP','SMS'].includes(verification.channel)&&verification.destination===normalizeWhatsAppNumber(req.user.phone))await sql`UPDATE users SET phone_verified_at=NOW(),updated_at=NOW() WHERE id=${req.user.id}`;
  const verificationToken=notificationTokenFor({channel:verification.channel,destination:verification.destination,purpose:verification.purpose,verificationId:verification.id});
  return res.json({verified:true,channel:verification.channel,destination:verification.destination,verification_token:verificationToken});
});

export default router;
