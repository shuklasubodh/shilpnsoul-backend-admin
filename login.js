import crypto from 'node:crypto';
import {Router} from 'express';
import sql from './db.js';
import {authenticate,authSecret,clearCustomerSessionCookie,hashPassword,optionalAuthenticate,rotateSessionCsrf,setCustomerSessionCookie,tokenFor,verifyNotificationToken,verifyPassword} from './auth.js';
import {sendOtpEmail} from './email.js';
import {emailPattern,normalizeCountryCode,phoneWithCountryCode,userColumns} from './utils.js';
import {normalizeWhatsAppNumber} from './whatsapp.js';

const router=Router();
const registrationEnabled=process.env.REGISTRATION_ENABLED==='true';
const normalizeEmail=value=>String(value||'').trim().toLowerCase();
const hashValue=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const codeHash=(code,destination,nonce)=>crypto.createHmac('sha256',authSecret()).update(`${code}:${destination}:${nonce}`).digest('hex');
const safeEqual=(left,right)=>{const a=Buffer.from(String(left)),b=Buffer.from(String(right));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const optionalPhone=(countryCode,value)=>String(value||'').trim()?normalizeWhatsAppNumber(phoneWithCountryCode(countryCode,value)):null;
const optionalWhatsApp=value=>String(value||'').trim()?normalizeWhatsAppNumber(value):null;

const assertUniqueContacts=async({email,phone,whatsapp,userId=null})=>{
  const duplicate=(await sql.query(`
    SELECT id FROM users
    WHERE ($4::bigint IS NULL OR id<>$4)
      AND (LOWER(email)=$1::text
        OR ($2::text IS NOT NULL AND (phone=$2::text OR whatsapp_number=$2::text))
        OR ($3::text IS NOT NULL AND (phone=$3::text OR whatsapp_number=$3::text)))
    LIMIT 1
  `,[email,phone,whatsapp,userId]))[0];
  if(duplicate)throw Object.assign(new Error('An account already uses one of these contact details.'),{status:409});
};

const verifiedProof=async({token,channel,destination,purpose,userId=null})=>{
  let proof;
  try{proof=verifyNotificationToken(token)}catch{throw Object.assign(new Error(`Verify ${channel.toLowerCase()} before continuing.`),{status:403})}
  if(proof.type!=='notification-verification'||proof.purpose!==purpose||proof.channel!==channel||proof.destination!==destination)throw Object.assign(new Error(`The ${channel.toLowerCase()} verification does not match.`),{status:403});
  const challenge=(await sql.query(`
    SELECT id FROM notification_verifications
    WHERE id=$1::bigint AND channel=$2::text AND destination=$3::text
      AND purpose=$4::text AND verified_at IS NOT NULL AND consumed_at IS NULL
      AND superseded_at IS NULL AND expires_at>NOW()
      AND (($5::bigint IS NULL AND user_id IS NULL AND subject_type='GUEST') OR user_id=$5::bigint)
  `,[proof.verification_id,channel,destination,purpose,userId]))[0];
  if(!challenge)throw Object.assign(new Error(`${channel} verification is incomplete or already used.`),{status:403});
  return challenge.id;
};

router.post('/auth/register',async(req,res)=>{
  if(!registrationEnabled)return res.status(403).json({error:'New account registration is currently unavailable.'});
  const firstName=String(req.body.first_name||'').trim(),lastName=String(req.body.last_name||'').trim();
  const email=normalizeEmail(req.body.email),countryCode=normalizeCountryCode(req.body.country_code||'+65');
  const phone=optionalPhone(countryCode,req.body.phone),whatsappNumber=optionalWhatsApp(req.body.whatsapp_number),password=String(req.body.password||'');
  const preferredChannel=String(req.body.preferred_notification_channel||'EMAIL').toUpperCase();
  if(!firstName||!lastName||!emailPattern.test(email)||!countryCode||password.length<12)return res.status(400).json({error:'Name, a valid email, and a password of at least 12 characters are required.'});
  if(String(req.body.phone||'').trim()&&!phone)return res.status(400).json({error:'Enter a valid SMS number.'});
  if(String(req.body.whatsapp_number||'').trim()&&!whatsappNumber)return res.status(400).json({error:'Enter a valid WhatsApp number.'});
  const destinations={EMAIL:email,...(phone?{SMS:phone}:{}),...(whatsappNumber?{WHATSAPP:whatsappNumber}:{})};
  if(!destinations[preferredChannel])return res.status(400).json({error:'The preferred notification channel must have a supplied contact.'});
  try{
    await assertUniqueContacts({email,phone,whatsapp:whatsappNumber});
    const challengeIds=[];
    for(const[channel,destination]of Object.entries(destinations))challengeIds.push(await verifiedProof({token:req.body.verification_tokens?.[channel],channel,destination,purpose:'REGISTRATION'}));
    const hash=await hashPassword(password);
    const user=(await sql.query(`WITH consumed AS (
      UPDATE notification_verifications SET consumed_at=NOW()
      WHERE id=ANY($9::bigint[]) AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>NOW()
      RETURNING id
    ), proofs AS MATERIALIZED (SELECT COUNT(*)=cardinality($9::bigint[]) ok FROM consumed)
    INSERT INTO users(first_name,last_name,email,password_hash,country_code,phone,whatsapp_number,role,is_active,email_verified_at,phone_verified_at,whatsapp_verified_at,preferred_notification_channel)
    SELECT $1,$2,$3,$4,$5,$6,$7,'CUSTOMER',TRUE,NOW(),CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END,CASE WHEN $7::text IS NULL THEN NULL ELSE NOW() END,$8 FROM proofs WHERE proofs.ok
    RETURNING ${userColumns}`,[firstName,lastName,email,hash,countryCode,phone,whatsappNumber,preferredChannel,challengeIds]))[0];
    if(!user)return res.status(409).json({error:'A contact verification was already used or expired. Verify again.'});
    const session=await tokenFor(user);setCustomerSessionCookie(res,session.token);
    return res.status(201).json({user,csrf_token:session.csrfToken});
  }catch(error){
    const status=error.status||(/already assigned|duplicate/i.test(error.message)?409:500);
    if(status>=500)console.error('Customer registration failed',{code:error.code||null,constraint:error.constraint||null});
    return res.status(status).json({error:error.status?error.message:error.code==='23505'?'An account already uses one of these contact details.':'Registration could not be completed.'});
  }
});

router.post('/auth/password-reset/request',async(req,res)=>{
  const email=normalizeEmail(req.body.email);
  const generic={message:'If an active account uses that email, a verification code has been sent.'};
  if(!emailPattern.test(email))return res.status(202).json(generic);
  const user=(await sql`SELECT id,email,is_active FROM users WHERE LOWER(email)=${email} LIMIT 1`)[0];
  if(!user?.is_active)return res.status(202).json(generic);
  const recent=await sql`SELECT created_at FROM notification_verifications WHERE user_id=${user.id} AND channel='EMAIL' AND purpose='PASSWORD_RESET' AND created_at>NOW()-INTERVAL '1 hour' ORDER BY created_at DESC`;
  if(recent[0]&&Date.now()-new Date(recent[0].created_at).getTime()<60000)return res.status(202).json(generic);
  if(recent.length>=3)return res.status(202).json(generic);
  await sql`UPDATE notification_verifications SET superseded_at=NOW() WHERE user_id=${user.id} AND channel='EMAIL' AND purpose='PASSWORD_RESET' AND consumed_at IS NULL AND superseded_at IS NULL`;
  const code=String(crypto.randomInt(100000,1000000)),nonce=crypto.randomBytes(16).toString('hex');
  const verification=(await sql`INSERT INTO notification_verifications(user_id,channel,destination,purpose,code_hash,nonce,expires_at,subject_type,subject_id,public_id) VALUES(${user.id},'EMAIL',${email},'PASSWORD_RESET',${codeHash(code,email,nonce)},${nonce},NOW()+INTERVAL '10 minutes','CUSTOMER',${String(user.id)},${crypto.randomUUID()}) RETURNING id`)[0];
  try{await sendOtpEmail({to:email,code,purpose:'PASSWORD_RESET',verificationId:verification.id})}catch(error){console.error('Password reset email failed',{userId:user.id,providerCode:error.providerCode||error.code||null,status:error.statusCode||null})}
  return res.status(202).json(generic);
});

router.post('/auth/password-reset/confirm',async(req,res)=>{
  const email=normalizeEmail(req.body.email),code=String(req.body.code||'').trim(),password=String(req.body.password||'');
  if(!emailPattern.test(email)||!/^[0-9]{6}$/.test(code)||password.length<12)return res.status(400).json({error:'Enter a valid email, six-digit code, and password of at least 12 characters.'});
  const verification=(await sql`SELECT * FROM notification_verifications WHERE channel='EMAIL' AND destination=${email} AND purpose='PASSWORD_RESET' AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`)[0];
  if(!verification||verification.superseded_at||verification.attempts>=5||new Date(verification.expires_at)<=new Date())return res.status(410).json({error:'This verification code has expired. Request a new code.'});
  if(!safeEqual(codeHash(code,email,verification.nonce),verification.code_hash)){
    await sql`UPDATE notification_verifications SET attempts=attempts+1 WHERE id=${verification.id} AND attempts<5 AND consumed_at IS NULL AND superseded_at IS NULL`;
    return res.status(400).json({error:'Incorrect verification code.'});
  }
  const hash=await hashPassword(password);
  const changed=await sql`WITH consumed AS (UPDATE notification_verifications SET verified_at=COALESCE(verified_at,NOW()),consumed_at=NOW() WHERE id=${verification.id} AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>NOW() AND attempts<5 RETURNING user_id) UPDATE users SET password_hash=${hash},updated_at=NOW() FROM consumed WHERE users.id=consumed.user_id RETURNING users.id`;
  if(!changed[0])return res.status(409).json({error:'This verification code has already been used.'});
  await sql`UPDATE admin_auth_sessions SET revoked_at=NOW() WHERE user_id=${changed[0].id} AND revoked_at IS NULL`;
  return res.json({message:'Password updated. You can now sign in.'});
});

const inspectInvitation=async(req,res)=>{
  const token=String(req.body?.invitation_token||'');
  if(!token)return res.status(400).json({error:'A valid invitation is required.'});
  const invitation=(await sql`SELECT u.first_name,u.last_name,u.email,u.phone,u.whatsapp_number,u.role,i.expires_at FROM user_invitations i JOIN users u ON u.id=i.user_id WHERE i.token_hash=${hashValue(token)} AND i.accepted_at IS NULL AND i.expires_at>NOW()`)[0];
  res.set('Cache-Control','no-store');
  return invitation?res.json(invitation):res.status(410).json({error:'This invitation is invalid or expired.'});
};
router.post('/auth/invitations/inspect',inspectInvitation);
router.get('/auth/invitations/:token',(req,res)=>res.status(410).set('Cache-Control','no-store').json({error:'Invitation inspection has moved to POST /api/auth/invitations/inspect.'}));

router.post('/auth/invitations/accept',async(req,res)=>{
  const invitationToken=String(req.body.invitation_token||''),password=String(req.body.password||'');
  if(!invitationToken||password.length<12)return res.status(400).json({error:'A valid invitation and password of at least 12 characters are required.'});
  const invitation=(await sql`SELECT i.*,u.email,u.phone,u.whatsapp_number,u.role FROM user_invitations i JOIN users u ON u.id=i.user_id WHERE i.token_hash=${hashValue(invitationToken)} AND i.accepted_at IS NULL AND i.expires_at>NOW()`)[0];
  if(!invitation)return res.status(410).json({error:'This invitation is invalid or expired.'});
  const destinations={...(String(invitation.role).toUpperCase()==='ADMIN'?{EMAIL:String(invitation.email).toLowerCase()}:{}),...(invitation.phone?{SMS:invitation.phone}:{}),...(invitation.whatsapp_number?{WHATSAPP:invitation.whatsapp_number}:{})};
  try{
    const challengeIds=[];
    for(const[channel,destination]of Object.entries(destinations))challengeIds.push(await verifiedProof({token:req.body.verification_tokens?.[channel],channel,destination,purpose:'INVITATION',userId:invitation.user_id}));
    const hash=await hashPassword(password);
    const user=(await sql.query(`WITH consumed AS (
      UPDATE notification_verifications SET consumed_at=NOW() WHERE id=ANY($3::bigint[]) AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>NOW() RETURNING id
    ), proofs AS MATERIALIZED (SELECT COUNT(*)=cardinality($3::bigint[]) ok FROM consumed),
    accepted AS (UPDATE user_invitations SET accepted_at=NOW() FROM proofs WHERE id=$1 AND accepted_at IS NULL AND proofs.ok RETURNING user_id)
    UPDATE users SET password_hash=$2,is_active=TRUE,email_verified_at=NOW(),phone_verified_at=CASE WHEN phone IS NULL THEN NULL ELSE NOW() END,whatsapp_verified_at=CASE WHEN whatsapp_number IS NULL THEN NULL ELSE NOW() END,updated_at=NOW() FROM accepted WHERE users.id=accepted.user_id RETURNING ${userColumns}`,[invitation.id,hash,challengeIds]))[0];
    if(!user)return res.status(409).json({error:'This invitation has already been used.'});
    if(user.role==='CUSTOMER'){const session=await tokenFor(user);setCustomerSessionCookie(res,session.token);return res.json({message:'Invitation accepted.',user,csrf_token:session.csrfToken})}
    return res.json({message:'Invitation accepted.'});
  }catch(error){return res.status(error.status||500).json({error:error.message||'Invitation could not be accepted.'})}
});

router.post(['/login','/auth/login'],async(req,res)=>{const email=normalizeEmail(req.body.email),password=String(req.body.password||'');if(!email||!password)return res.status(400).json({error:'Email and password are required.'});const rows=await sql.query(`SELECT ${userColumns},password_hash FROM users WHERE LOWER(email)=$1 LIMIT 1`,[email]);const user=rows[0];if(!user?.is_active||!await verifyPassword(password,user?.password_hash))return res.status(401).json({error:'Invalid email or password.'});delete user.password_hash;const session=await tokenFor(user);setCustomerSessionCookie(res,session.token);return res.json({user,csrf_token:session.csrfToken})});
router.get('/auth/session',optionalAuthenticate,async(req,res)=>req.user
  ?res.json({user:req.user,csrf_token:await rotateSessionCsrf(req.auth.sid),expires_at:new Date(req.auth.exp*1000).toISOString()})
  :res.json({user:null,authenticated:false}));
router.post('/auth/logout',authenticate,async(req,res)=>{if(req.auth.sid)await sql`UPDATE auth_sessions SET revoked_at=NOW() WHERE session_id=${req.auth.sid} AND user_id=${req.user.id}`;clearCustomerSessionCookie(res);return res.status(204).end()});

export {assertUniqueContacts,hashValue};
export default router;
