import crypto from 'node:crypto';
import {Router} from 'express';
import sql from './db.js';
import {authSecret,notificationTokenFor,optionalAuthenticate} from './auth.js';
import {sendOtpEmail} from './email.js';
import {normalizeWhatsAppNumber,sendOtpWhatsApp} from './whatsapp.js';
import {sendOtpSms,verifyOtpSms} from './sms.js';
import {emailPattern} from './utils.js';
import {validCheckoutId} from './checkoutPolicy.js';

const router=Router();
const normalize=(channel,value)=>channel==='EMAIL'?String(value||'').trim().toLowerCase():normalizeWhatsAppNumber(value);
const codeHash=(code,destination,nonce)=>crypto.createHmac('sha256',authSecret()).update(`${code}:${destination}:${nonce}`).digest('hex');
const safeEqual=(left,right)=>{const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const tokenHash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');

router.post('/notification-verifications/request',optionalAuthenticate,async(req,res)=>{
  const channel=String(req.body.channel||'').toUpperCase(),purpose=String(req.body.purpose||'').toUpperCase(),destination=normalize(channel,req.body.destination);
  let suppressDelivery=false;
  if(!['REGISTRATION','CHECKOUT','INVITATION','ACCOUNT_CONTACT_CHANGE'].includes(purpose))return res.status(400).json({error:'Invalid verification purpose.'});
  if(purpose==='ACCOUNT_CONTACT_CHANGE'&&!req.user)return res.status(401).json({error:'Authentication required.'});
  if(purpose==='REGISTRATION'&&process.env.REGISTRATION_ENABLED!=='true')return res.status(403).json({error:'New account registration is currently unavailable.'});
  if(!['EMAIL','WHATSAPP','SMS'].includes(channel)||(channel==='EMAIL'?!emailPattern.test(destination):!destination))return res.status(400).json({error:'A valid email or mobile notification destination is required.'});
  if(!req.user&&purpose==='CHECKOUT'&&req.body.checkout_id&&!validCheckoutId(req.body.checkout_id))return res.status(400).json({error:'The checkout reference is invalid. Restart checkout and try again.'});
  let verificationUserId=req.user?.id||null;
  if(purpose==='INVITATION'){
    const invitation=(await sql`SELECT i.user_id,u.email,u.phone,u.whatsapp_number,u.role FROM user_invitations i JOIN users u ON u.id=i.user_id WHERE i.token_hash=${tokenHash(req.body.invitation_token)} AND i.accepted_at IS NULL AND i.expires_at>NOW()`)[0];
    if(!invitation)return res.status(410).json({error:'This invitation is invalid or expired.'});
    const expected=channel==='EMAIL'?String(invitation.email).toLowerCase():channel==='WHATSAPP'?normalizeWhatsAppNumber(invitation.whatsapp_number):normalizeWhatsAppNumber(invitation.phone);
    if(!expected||destination!==expected||(channel==='EMAIL'&&String(invitation.role).toUpperCase()!=='ADMIN'))return res.status(403).json({error:'Verify a contact required by this invitation.'});
    verificationUserId=invitation.user_id;
  }
  if(!req.user&&purpose==='CHECKOUT'){
    const existing=channel==='EMAIL'
      ?(await sql`SELECT id FROM users WHERE LOWER(email)=${destination} LIMIT 1`)[0]
      :(await sql`SELECT id FROM users WHERE phone=${destination} OR whatsapp_number=${destination} LIMIT 1`)[0];
    if(existing)suppressDelivery=true;
  }
  const expectedAccountDestination=channel==='EMAIL'?String(req.user?.email||'').toLowerCase():channel==='WHATSAPP'?normalizeWhatsAppNumber(req.user?.whatsapp_number):normalizeWhatsAppNumber(req.user?.phone);
  if(req.user&&purpose==='CHECKOUT'&&destination!==expectedAccountDestination){
    const duplicate=channel==='EMAIL'
      ?(await sql`SELECT id FROM users WHERE LOWER(email)=${destination} AND id<>${req.user.id} LIMIT 1`)[0]
      :(await sql`SELECT id FROM users WHERE id<>${req.user.id} AND (phone=${destination} OR whatsapp_number=${destination}) LIMIT 1`)[0];
    if(duplicate)suppressDelivery=true;
  }
  if(purpose==='ACCOUNT_CONTACT_CHANGE'){
    const duplicate=channel==='EMAIL'
      ?(await sql`SELECT id FROM users WHERE LOWER(email)=${destination} AND id<>${req.user.id} LIMIT 1`)[0]
      :(await sql`SELECT id FROM users WHERE id<>${req.user.id} AND (phone=${destination} OR whatsapp_number=${destination}) LIMIT 1`)[0];
    if(duplicate)suppressDelivery=true;
    verificationUserId=req.user.id;
  }
  if(req.user&&purpose==='CHECKOUT'&&destination===String(req.user.email).toLowerCase()&&req.user.email_verified_at)return res.json({verified:true,channel,destination});
  if(req.user&&purpose==='CHECKOUT'&&channel==='SMS'&&destination===normalizeWhatsAppNumber(req.user.phone)&&req.user.phone_verified_at)return res.json({verified:true,channel,destination});
  if(req.user&&purpose==='CHECKOUT'&&channel==='WHATSAPP'&&destination===normalizeWhatsAppNumber(req.user.whatsapp_number)&&req.user.whatsapp_verified_at)return res.json({verified:true,channel,destination});

  const recent=await sql`SELECT nv.created_at FROM notification_verifications nv JOIN notification_deliveries nd ON nd.verification_id=nv.id WHERE nv.channel=${channel} AND nv.destination=${destination} AND nv.created_at>NOW()-INTERVAL '1 hour' AND nd.status IN ('PENDING','ACCEPTED','DELIVERED') ORDER BY nv.created_at DESC`;
  if(recent[0]&&Date.now()-new Date(recent[0].created_at).getTime()<60000)return res.status(429).json({error:'Please wait before requesting another code.',retry_after_seconds:60-Math.floor((Date.now()-new Date(recent[0].created_at).getTime())/1000)});
  if(recent.length>=3)return res.status(429).json({error:'Verification code limit reached. Try again in one hour.'});

  const subjectType=verificationUserId?'CUSTOMER':'GUEST',subjectId=verificationUserId?String(verificationUserId):String(req.body.checkout_id||crypto.randomUUID());
  await sql`UPDATE notification_verifications SET superseded_at=NOW() WHERE channel=${channel} AND destination=${destination} AND purpose=${purpose} AND subject_type=${subjectType} AND (${subjectType}='GUEST' OR subject_id=${subjectId}) AND consumed_at IS NULL AND superseded_at IS NULL`;
  const code=String(crypto.randomInt(100000,1000000)),nonce=crypto.randomBytes(16).toString('hex');
  const verification=(await sql`INSERT INTO notification_verifications(user_id,channel,destination,purpose,code_hash,nonce,expires_at,subject_type,subject_id,public_id) VALUES(${verificationUserId},${channel},${destination},${purpose},${codeHash(code,destination,nonce)},${nonce},NOW()+INTERVAL '10 minutes',${subjectType},${subjectId},${crypto.randomUUID()}) RETURNING id,expires_at`)[0];
  const idempotencyKey=`otp/${verification.id}`;
  const provider=channel==='WHATSAPP'?'META_WHATSAPP':channel==='SMS'?'TWILIO':'RESEND';
  const delivery=suppressDelivery?null:(await sql`INSERT INTO notification_deliveries(verification_id,notification_type,channel,destination,provider,status,idempotency_key) VALUES(${verification.id},'OTP',${channel},${destination},${provider},'PENDING',${idempotencyKey}) RETURNING id`)[0];
  if(suppressDelivery){res.set('Cache-Control','no-store');return res.status(201).json({verification_id:verification.id,channel,destination,checkout_id:purpose==='CHECKOUT'?subjectId:undefined,expires_at:verification.expires_at,resend_after_seconds:60})}
  try{
    const result=channel==='WHATSAPP'?await sendOtpWhatsApp({to:destination,code,purpose,verificationId:verification.id}):channel==='SMS'?await sendOtpSms({to:destination}):await sendOtpEmail({to:destination,code,purpose,verificationId:verification.id});
    await sql`UPDATE notification_deliveries SET status='ACCEPTED',provider_message_id=${result.id},updated_at=NOW() WHERE id=${delivery.id}`;
  }catch(error){
    console.error('Verification delivery failed',{channel,provider,providerCode:error.providerCode||error.code||null,status:error.statusCode||null});
    await sql`UPDATE notification_deliveries SET status='FAILED',error_message='Provider delivery failed',updated_at=NOW() WHERE id=${delivery.id}`;
    return res.status(503).json({error:`The verification ${channel==='WHATSAPP'?'WhatsApp message':channel==='SMS'?'SMS':'email'} could not be sent. Please try again.`});
  }
  res.set('Cache-Control','no-store');
  return res.status(201).json({verification_id:verification.id,channel,destination,checkout_id:purpose==='CHECKOUT'?subjectId:undefined,expires_at:verification.expires_at,resend_after_seconds:60});
});

router.post('/notification-verifications/verify',optionalAuthenticate,async(req,res)=>{
  const id=String(req.body.verification_id||''),code=String(req.body.code||'').trim();
  if(!/^\d+$/.test(id)||!/^\d{6}$/.test(code))return res.status(400).json({error:'A valid verification code is required.'});
  const verification=(await sql`SELECT * FROM notification_verifications WHERE id=${id}`)[0];
  if(!verification||verification.verified_at||verification.consumed_at||verification.superseded_at||new Date(verification.expires_at)<=new Date()||verification.attempts>=5)return res.status(410).json({error:'This verification code has expired. Request a new code.'});
  if(verification.purpose==='CHECKOUT'){
    const subjectMatches=verification.subject_type==='CUSTOMER'
      ?req.user&&String(verification.user_id)===String(req.user.id)&&String(verification.subject_id)===String(req.user.id)
      :validCheckoutId(req.body.checkout_id)&&String(verification.subject_id)===String(req.body.checkout_id);
    if(!subjectMatches)return res.status(403).json({error:'This verification does not belong to the current checkout.'});
  }
  let approved;
  try{approved=verification.channel==='SMS'?await verifyOtpSms({to:verification.destination,code}):safeEqual(codeHash(code,verification.destination,verification.nonce),verification.code_hash)}catch(error){
    console.error('Verification check failed',{channel:verification.channel,providerCode:error.providerCode||error.code||null,status:error.statusCode||null});
    return res.status(503).json({error:'The verification service is unavailable. Please try again.'});
  }
  if(!approved){
    await sql`UPDATE notification_verifications SET attempts=attempts+1 WHERE id=${id} AND attempts<5 AND verified_at IS NULL AND consumed_at IS NULL AND superseded_at IS NULL`;
    return res.status(400).json({error:'Incorrect verification code.'});
  }
  const verified=(await sql`UPDATE notification_verifications SET verified_at=NOW() WHERE id=${id} AND verified_at IS NULL AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>NOW() AND attempts<5 RETURNING *`)[0];
  if(!verified)return res.status(409).json({error:'This verification code has already been used or replaced.'});
  const verificationToken=notificationTokenFor({channel:verified.channel,destination:verified.destination,purpose:verified.purpose,verificationId:verified.id,subjectType:verified.subject_type,subjectId:verified.subject_id,contextHash:verified.context_hash});
  res.set('Cache-Control','no-store');
  return res.json({verified:true,channel:verification.channel,destination:verification.destination,verification_token:verificationToken});
});

export default router;
