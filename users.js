import{Router}from'express';
import crypto from'node:crypto';
import sql from'./db.js';
import{authenticate,admin,isAdmin,hashPassword,optionalAuthenticate,verifyNotificationToken,verifyPassword}from'./auth.js';
import{sendInvitationEmail}from'./email.js';
import{emailPattern,normalizeCountryCode,notFound,page,phoneWithCountryCode,userColumns}from'./utils.js';
import{normalizeOwnershipContacts}from'./checkoutPolicy.js';

const router=Router();
const contactChangeProof=async({token,channel,destination,userId})=>{
  let claims;try{claims=verifyNotificationToken(token)}catch{throw Object.assign(new Error(`Verify the new ${channel.toLowerCase()} contact before saving.`),{status:403})}
  if(claims.type!=='notification-verification'||claims.purpose!=='ACCOUNT_CONTACT_CHANGE'||claims.channel!==channel||claims.destination!==destination||String(claims.subject_id)!==String(userId))throw Object.assign(new Error(`The ${channel.toLowerCase()} verification does not match this contact change.`),{status:403});
  const row=(await sql`SELECT id FROM notification_verifications WHERE id=${claims.verification_id} AND user_id=${userId} AND subject_type='CUSTOMER' AND subject_id=${String(userId)} AND purpose='ACCOUNT_CONTACT_CHANGE' AND channel=${channel} AND destination=${destination} AND verified_at IS NOT NULL AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>NOW()`)[0];
  if(!row)throw Object.assign(new Error(`The ${channel.toLowerCase()} verification is incomplete, expired, or already used.`),{status:403});
  return row.id;
};
router.get('/phone-availability',async(req,res)=>{
  const countryCode=normalizeCountryCode(req.query.country_code||'+65'),phone=phoneWithCountryCode(countryCode,req.query.phone);
  if(!countryCode||!phone)return res.status(400).json({error:'Enter a valid country calling code and phone number.'});
  return res.json({available:true,phone,message:'Availability is confirmed securely during registration.'});
});
router.post('/contact-ownership/check',optionalAuthenticate,async(req,res)=>{
  const contacts=normalizeOwnershipContacts(req.body?.contacts);
  if(!contacts)return res.status(400).json({error:'Supply at least one valid email address or mobile contact.'});
  const conflict=(await sql.query(`
    SELECT EXISTS(
      SELECT 1 FROM users
      WHERE ($1::bigint IS NULL OR id<>$1)
        AND (($2::text<>'' AND LOWER(email)=$2) OR (cardinality($3::text[])>0 AND (phone=ANY($3::text[]) OR whatsapp_number=ANY($3::text[]))))
    ) AS found
  `,[req.user?.id||null,contacts.email,contacts.phones]))[0]?.found===true;
  res.set('Cache-Control','no-store');
  return res.json({available:!conflict,has_conflict:conflict});
});
router.use(authenticate);
router.post('/',admin,async(req,res)=>{
  const{first_name,last_name}=req.body,email=String(req.body.email||'').trim().toLowerCase(),countryCode=normalizeCountryCode(req.body.country_code),phone=String(req.body.phone||'').trim()?phoneWithCountryCode(countryCode,req.body.phone):null,whatsapp=String(req.body.whatsapp_number||'').trim()?phoneWithCountryCode(countryCode,req.body.whatsapp_number):null,role=String(req.body.role||'CUSTOMER').toUpperCase(),returnDays=Number(req.body.return_window_days??2);
  if(!first_name||!last_name||!emailPattern.test(email)||!countryCode||!['ADMIN','CUSTOMER'].includes(role)||!Number.isInteger(returnDays)||returnDays<0||returnDays>365)return res.status(400).json({error:'Invalid user fields or return window.'});
  const temporaryPassword=crypto.randomBytes(32).toString('hex'),hash=await hashPassword(temporaryPassword);
  let user;
  try{
    user=(await sql.query(`INSERT INTO users(first_name,last_name,email,password_hash,country_code,phone,whatsapp_number,role,is_active,preferred_notification_channel,return_window_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,FALSE,'EMAIL',$9) RETURNING ${userColumns}`,[first_name,last_name,email,hash,countryCode,phone,whatsapp,role,returnDays]))[0];
    const token=crypto.randomBytes(32).toString('base64url'),tokenHash=crypto.createHash('sha256').update(token).digest('hex');
    const invitation=(await sql`INSERT INTO user_invitations(user_id,token_hash,expires_at,created_by) VALUES(${user.id},${tokenHash},NOW()+INTERVAL '48 hours',${req.user.id}) RETURNING id`)[0];
    const appUrl=String(process.env.CUSTOMER_APP_URL||'http://localhost:5173').replace(/\/$/,'');
    await sendInvitationEmail({to:user.email,name:`${user.first_name} ${user.last_name}`.trim(),invitationUrl:`${appUrl}/?invitation=${encodeURIComponent(token)}`,invitationId:invitation.id});
    return res.status(201).json(user);
  }catch(error){
    if(user?.id)await sql`DELETE FROM users WHERE id=${user.id} AND is_active=FALSE`;
    return res.status(error.code==='23505'?409:500).json({error:error.code==='23505'?'A user with one of these contact details already exists.':'The invitation could not be created.'});
  }
});
router.get('/',admin,async(req,res)=>{const p=page(req.query),count=await sql`SELECT COUNT(*)::int count FROM users`,rows=await sql.query(`SELECT ${userColumns} FROM users ORDER BY id LIMIT $1 OFFSET $2`,[p.limit,p.start]);res.set('X-Total-Count',count[0].count);return res.json(rows)});
router.get('/:id',async(req,res)=>{if(!isAdmin(req.user)&&String(req.user.id)!==req.params.id)return res.status(403).json({error:'Access denied.'});const rows=await sql.query(`SELECT ${userColumns} FROM users WHERE id=$1`,[req.params.id]);return rows[0]?res.json(rows[0]):notFound(res,'User')});
router.put('/:id',async(req,res)=>{
  if(!isAdmin(req.user)&&String(req.user.id)!==req.params.id)return res.status(403).json({error:'Access denied.'});const old=(await sql`SELECT * FROM users WHERE id=${req.params.id}`)[0];if(!old)return notFound(res,'User');
  const first=req.body.first_name??old.first_name,last=req.body.last_name??old.last_name,email=String(req.body.email??old.email).trim().toLowerCase(),countryCode=normalizeCountryCode(req.body.country_code??old.country_code??'+65'),phone=req.body.phone===undefined?old.phone:(String(req.body.phone||'').trim()?phoneWithCountryCode(countryCode,req.body.phone):null),whatsapp=req.body.whatsapp_number===undefined?old.whatsapp_number:(String(req.body.whatsapp_number||'').trim()?phoneWithCountryCode(countryCode,req.body.whatsapp_number):null),role=isAdmin(req.user)?String(req.body.role??old.role).toUpperCase():old.role,active=isAdmin(req.user)?req.body.is_active??old.is_active:old.is_active,preferred=String(req.body.preferred_notification_channel??old.preferred_notification_channel??'EMAIL').toUpperCase(),returnDays=isAdmin(req.user)?Number(req.body.return_window_days??old.return_window_days??2):Number(old.return_window_days??2);
  if(!emailPattern.test(email)||!countryCode||!['EMAIL','SMS','WHATSAPP'].includes(preferred)||preferred==='SMS'&&!phone||preferred==='WHATSAPP'&&!whatsapp||!Number.isInteger(returnDays)||returnDays<0||returnDays>365)return res.status(400).json({error:'Invalid contact, notification preference, or return window.'});let hash=old.password_hash;const nextPassword=req.body.password??req.body.password_hash;const sensitiveChange=nextPassword||email!==String(old.email).toLowerCase()||phone!==old.phone||whatsapp!==old.whatsapp_number;if(!isAdmin(req.user)&&sensitiveChange&&!await verifyPassword(String(req.body.current_password||''),old.password_hash))return res.status(403).json({error:'Current password is required to change your password or contact details.'});if(nextPassword){if(typeof nextPassword!=='string'||nextPassword.length<12)return res.status(400).json({error:'Password requires at least 12 characters.'});hash=await hashPassword(nextPassword)}
  const proofIds=[];
  if(!isAdmin(req.user)){
    try{
      if(email!==String(old.email).toLowerCase())proofIds.push(await contactChangeProof({token:req.body.verification_tokens?.EMAIL,channel:'EMAIL',destination:email,userId:req.user.id}));
      if(phone!==old.phone&&phone)proofIds.push(await contactChangeProof({token:req.body.verification_tokens?.SMS,channel:'SMS',destination:phone,userId:req.user.id}));
      if(whatsapp!==old.whatsapp_number&&whatsapp)proofIds.push(await contactChangeProof({token:req.body.verification_tokens?.WHATSAPP,channel:'WHATSAPP',destination:whatsapp,userId:req.user.id}));
    }catch(error){return res.status(error.status||403).json({error:error.message})}
  }
  const rows=await sql.query(`WITH consumed AS (
    UPDATE notification_verifications SET consumed_at=NOW()
    WHERE id=ANY($13::bigint[]) AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>NOW()
    RETURNING id
  ), proofs AS MATERIALIZED (
    SELECT COUNT(*)=cardinality($13::bigint[]) ok FROM consumed
  )
  UPDATE users SET first_name=$1,last_name=$2,email=$3,country_code=$4,phone=$5,whatsapp_number=$6,role=$7,is_active=$8,password_hash=$9,preferred_notification_channel=$10,return_window_days=$11,
    email_verified_at=CASE WHEN LOWER(email)<>$3 THEN NOW() ELSE email_verified_at END,
    phone_verified_at=CASE WHEN phone IS DISTINCT FROM $5 THEN CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() END ELSE phone_verified_at END,
    whatsapp_verified_at=CASE WHEN whatsapp_number IS DISTINCT FROM $6 THEN CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END ELSE whatsapp_verified_at END,
    updated_at=NOW()
  FROM proofs WHERE id=$12 AND proofs.ok RETURNING ${userColumns}`,[first,last,email,countryCode,phone,whatsapp,role,active,hash,preferred,returnDays,req.params.id,proofIds]);
  if(!rows[0])return res.status(409).json({error:'A contact verification was already used or expired. Verify the changed contact again.'});
  return res.json(rows[0]);
});
router.delete('/:id',admin,async(req,res)=>{if(String(req.user.id)===req.params.id)return res.status(409).json({error:'Cannot delete yourself.'});const rows=await sql.query(`DELETE FROM users WHERE id=$1 RETURNING ${userColumns}`,[req.params.id]);return rows[0]?res.json(rows[0]):notFound(res,'User')});
export default router;
