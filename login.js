import{Router}from'express';import sql from'./db.js';import{authenticate,hashPassword,tokenFor,verifyNotificationToken,verifyPassword}from'./auth.js';import{emailPattern,normalizeCountryCode,phoneWithCountryCode,userColumns}from'./utils.js';import{normalizeWhatsAppNumber}from'./whatsapp.js';
const router=Router();
router.post('/auth/register',async(req,res)=>{
  const firstName=String(req.body.first_name||'').trim(),lastName=String(req.body.last_name||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),countryCode=normalizeCountryCode(req.body.country_code||'+65'),phone=normalizeWhatsAppNumber(phoneWithCountryCode(countryCode,req.body.phone)),whatsappNumber=normalizeWhatsAppNumber(req.body.whatsapp_number),password=String(req.body.password||'');
  const preferredChannel=String(req.body.preferred_notification_channel||'EMAIL').toUpperCase();
  if(!firstName||!lastName||!emailPattern.test(email)||!phone||!whatsappNumber||password.length<12||!['EMAIL','SMS','WHATSAPP'].includes(preferredChannel))return res.status(400).json({error:'Name, email, SMS number, WhatsApp number, notification preference, and a password of at least 12 characters are required.'});
  const destinations={EMAIL:email,SMS:phone,WHATSAPP:whatsappNumber},proofs={};
  try{for(const channel of Object.keys(destinations))proofs[channel]=verifyNotificationToken(req.body.verification_tokens?.[channel])}catch{return res.status(403).json({error:'Verify email, SMS, and WhatsApp before registration.'})}
  for(const[channel,destination]of Object.entries(destinations)){
    const proof=proofs[channel];
    if(proof.type!=='notification-verification'||proof.purpose!=='REGISTRATION'||proof.channel!==channel||proof.destination!==destination)return res.status(403).json({error:`The ${channel} verification does not match this registration.`});
    const challenge=(await sql`SELECT id FROM notification_verifications WHERE id=${proof.verification_id} AND channel=${channel} AND destination=${destination} AND purpose='REGISTRATION' AND user_id IS NULL AND verified_at IS NOT NULL`)[0];
    if(!challenge)return res.status(403).json({error:`${channel} verification is incomplete.`});
  }
  const hash=await hashPassword(password);
  const user=(await sql.query(`INSERT INTO users(first_name,last_name,email,password_hash,country_code,phone,whatsapp_number,role,is_active,email_verified_at,phone_verified_at,whatsapp_verified_at,preferred_notification_channel) VALUES($1,$2,$3,$4,$5,$6,$7,'CUSTOMER',TRUE,NOW(),NOW(),NOW(),$8) RETURNING ${userColumns}`,[firstName,lastName,email,hash,countryCode,phone,whatsappNumber,preferredChannel]))[0];
  return res.status(201).json({token:tokenFor(user),user});
});
router.post(['/login','/auth/login'],async(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');if(!email||!password)return res.status(400).json({error:'Email and password are required.'});const rows=await sql.query(`SELECT ${userColumns},password_hash FROM users WHERE LOWER(email)=$1 LIMIT 1`,[email]);const user=rows[0];if(!user?.is_active||!await verifyPassword(password,user?.password_hash))return res.status(401).json({error:'Invalid email or password.'});delete user.password_hash;return res.json({token:tokenFor(user),user})});
router.get('/auth/session',authenticate,(req,res)=>res.json({user:req.user,expires_at:new Date(req.auth.exp*1000).toISOString()}));
export default router;
