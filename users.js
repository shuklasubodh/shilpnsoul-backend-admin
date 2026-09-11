import{Router}from'express';
import sql from'./db.js';
import{authenticate,admin,isAdmin,hashPassword}from'./auth.js';
import{emailPattern,normalizeCountryCode,notFound,page,phoneWithCountryCode,userColumns}from'./utils.js';

const router=Router();
router.get('/phone-availability',async(req,res)=>{
  const countryCode=normalizeCountryCode(req.query.country_code||'+65'),phone=phoneWithCountryCode(countryCode,req.query.phone);
  if(!countryCode||!phone)return res.status(400).json({error:'Enter a valid country calling code and phone number.'});
  const existing=(await sql`SELECT id FROM users WHERE phone=${phone} LIMIT 1`)[0];
  return res.json({available:!existing,phone});
});
router.use(authenticate);
router.post('/',admin,async(req,res)=>{
  const{first_name,last_name}=req.body,email=String(req.body.email||'').trim().toLowerCase(),countryCode=normalizeCountryCode(req.body.country_code),phone=phoneWithCountryCode(countryCode,req.body.phone),whatsapp=phoneWithCountryCode(countryCode,req.body.whatsapp_number),password=String(req.body.password||req.body.password_hash||''),role=String(req.body.role||'CUSTOMER').toUpperCase(),active=req.body.is_active??true,preferred=String(req.body.preferred_notification_channel||'EMAIL').toUpperCase(),returnDays=Number(req.body.return_window_days??2);
  if(!first_name||!last_name||!emailPattern.test(email)||!countryCode||!phone||!whatsapp||password.length<12||!['ADMIN','CUSTOMER'].includes(role)||typeof active!=='boolean'||!['EMAIL','SMS','WHATSAPP'].includes(preferred)||!Number.isInteger(returnDays)||returnDays<0||returnDays>365)return res.status(400).json({error:'Invalid user fields, notification preference, or return window.'});
  const hash=await hashPassword(password),rows=await sql.query(`INSERT INTO users(first_name,last_name,email,password_hash,country_code,phone,whatsapp_number,role,is_active,preferred_notification_channel,return_window_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${userColumns}`,[first_name,last_name,email,hash,countryCode,phone,whatsapp,role,active,preferred,returnDays]);return res.status(201).json(rows[0]);
});
router.get('/',admin,async(req,res)=>{const p=page(req.query),count=await sql`SELECT COUNT(*)::int count FROM users`,rows=await sql.query(`SELECT ${userColumns} FROM users ORDER BY id LIMIT $1 OFFSET $2`,[p.limit,p.start]);res.set('X-Total-Count',count[0].count);return res.json(rows)});
router.get('/:id',async(req,res)=>{if(!isAdmin(req.user)&&String(req.user.id)!==req.params.id)return res.status(403).json({error:'Access denied.'});const rows=await sql.query(`SELECT ${userColumns} FROM users WHERE id=$1`,[req.params.id]);return rows[0]?res.json(rows[0]):notFound(res,'User')});
router.put('/:id',async(req,res)=>{
  if(!isAdmin(req.user)&&String(req.user.id)!==req.params.id)return res.status(403).json({error:'Access denied.'});const old=(await sql`SELECT * FROM users WHERE id=${req.params.id}`)[0];if(!old)return notFound(res,'User');
  const first=req.body.first_name??old.first_name,last=req.body.last_name??old.last_name,email=String(req.body.email??old.email).trim().toLowerCase(),countryCode=normalizeCountryCode(req.body.country_code??old.country_code??'+65'),phone=req.body.phone===undefined?old.phone:phoneWithCountryCode(countryCode,req.body.phone),whatsapp=req.body.whatsapp_number===undefined?old.whatsapp_number:phoneWithCountryCode(countryCode,req.body.whatsapp_number),role=isAdmin(req.user)?String(req.body.role??old.role).toUpperCase():old.role,active=isAdmin(req.user)?req.body.is_active??old.is_active:old.is_active,preferred=String(req.body.preferred_notification_channel??old.preferred_notification_channel??'EMAIL').toUpperCase(),returnDays=isAdmin(req.user)?Number(req.body.return_window_days??old.return_window_days??2):Number(old.return_window_days??2);
  if(!countryCode||!phone||!whatsapp||!['EMAIL','SMS','WHATSAPP'].includes(preferred)||!Number.isInteger(returnDays)||returnDays<0||returnDays>365)return res.status(400).json({error:'Invalid contact, notification preference, or return window.'});let hash=old.password_hash;const nextPassword=req.body.password??req.body.password_hash;if(nextPassword){if(typeof nextPassword!=='string'||nextPassword.length<12)return res.status(400).json({error:'Password requires at least 12 characters.'});hash=await hashPassword(nextPassword)}
  const rows=await sql.query(`UPDATE users SET first_name=$1,last_name=$2,email=$3,country_code=$4,phone=$5,whatsapp_number=$6,role=$7,is_active=$8,password_hash=$9,preferred_notification_channel=$10,return_window_days=$11,email_verified_at=CASE WHEN LOWER(email)<>$3 THEN NULL ELSE email_verified_at END,phone_verified_at=CASE WHEN phone<>$5 THEN NULL ELSE phone_verified_at END,whatsapp_verified_at=CASE WHEN whatsapp_number<>$6 THEN NULL ELSE whatsapp_verified_at END,updated_at=NOW() WHERE id=$12 RETURNING ${userColumns}`,[first,last,email,countryCode,phone,whatsapp,role,active,hash,preferred,returnDays,req.params.id]);return res.json(rows[0]);
});
router.delete('/:id',admin,async(req,res)=>{if(String(req.user.id)===req.params.id)return res.status(409).json({error:'Cannot delete yourself.'});const rows=await sql.query(`DELETE FROM users WHERE id=$1 RETURNING ${userColumns}`,[req.params.id]);return rows[0]?res.json(rows[0]):notFound(res,'User')});
export default router;
