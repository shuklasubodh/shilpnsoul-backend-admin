import{Router}from'express';
import sql from'./db.js';
import{authenticate,admin,isAdmin,hashPassword}from'./auth.js';
import{emailPattern,normalizeCountryCode,notFound,page,phoneWithCountryCode,userColumns}from'./utils.js';

const router=Router();router.use(authenticate);
router.post('/',admin,async(req,res)=>{
  const{first_name,last_name}=req.body,email=String(req.body.email||'').trim().toLowerCase(),countryCode=normalizeCountryCode(req.body.country_code),phone=phoneWithCountryCode(countryCode,req.body.phone),password=String(req.body.password||req.body.password_hash||''),role=String(req.body.role||'CUSTOMER').toUpperCase(),active=req.body.is_active??true;
  if(!first_name||!last_name||!emailPattern.test(email)||!countryCode||!phone||password.length<12||!['ADMIN','CUSTOMER'].includes(role)||typeof active!=='boolean')return res.status(400).json({error:'Invalid user fields. Select a country code and provide a valid mobile number.'});
  const hash=await hashPassword(password),rows=await sql.query(`INSERT INTO users(first_name,last_name,email,password_hash,country_code,phone,role,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${userColumns}`,[first_name,last_name,email,hash,countryCode,phone,role,active]);return res.status(201).json(rows[0]);
});
router.get('/',admin,async(req,res)=>{const p=page(req.query),count=await sql`SELECT COUNT(*)::int count FROM users`,rows=await sql.query(`SELECT ${userColumns} FROM users ORDER BY id LIMIT $1 OFFSET $2`,[p.limit,p.start]);res.set('X-Total-Count',count[0].count);return res.json(rows)});
router.get('/:id',async(req,res)=>{if(!isAdmin(req.user)&&String(req.user.id)!==req.params.id)return res.status(403).json({error:'Access denied.'});const rows=await sql.query(`SELECT ${userColumns} FROM users WHERE id=$1`,[req.params.id]);return rows[0]?res.json(rows[0]):notFound(res,'User')});
router.put('/:id',async(req,res)=>{
  if(!isAdmin(req.user)&&String(req.user.id)!==req.params.id)return res.status(403).json({error:'Access denied.'});const old=(await sql`SELECT * FROM users WHERE id=${req.params.id}`)[0];if(!old)return notFound(res,'User');
  const first=req.body.first_name??old.first_name,last=req.body.last_name??old.last_name,email=String(req.body.email??old.email).trim().toLowerCase(),countryCode=normalizeCountryCode(req.body.country_code??old.country_code??'+65'),phone=req.body.phone===undefined?old.phone:phoneWithCountryCode(countryCode,req.body.phone),role=isAdmin(req.user)?String(req.body.role??old.role).toUpperCase():old.role,active=isAdmin(req.user)?req.body.is_active??old.is_active:old.is_active;
  if(!countryCode||!phone)return res.status(400).json({error:'Select a country code and provide a valid mobile number.'});let hash=old.password_hash;const nextPassword=req.body.password??req.body.password_hash;if(nextPassword){if(typeof nextPassword!=='string'||nextPassword.length<12)return res.status(400).json({error:'Password requires at least 12 characters.'});hash=await hashPassword(nextPassword)}
  const rows=await sql.query(`UPDATE users SET first_name=$1,last_name=$2,email=$3,country_code=$4,phone=$5,role=$6,is_active=$7,password_hash=$8,updated_at=NOW() WHERE id=$9 RETURNING ${userColumns}`,[first,last,email,countryCode,phone,role,active,hash,req.params.id]);return res.json(rows[0]);
});
router.delete('/:id',admin,async(req,res)=>{if(String(req.user.id)===req.params.id)return res.status(409).json({error:'Cannot delete yourself.'});const rows=await sql.query(`DELETE FROM users WHERE id=$1 RETURNING ${userColumns}`,[req.params.id]);return rows[0]?res.json(rows[0]):notFound(res,'User')});
export default router;
