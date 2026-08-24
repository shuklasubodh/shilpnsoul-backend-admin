import{Router}from'express';import sql from'./db.js';import{authenticate,hashPassword,tokenFor,verifyNotificationToken,verifyPassword}from'./auth.js';import{emailPattern,userColumns}from'./utils.js';
const router=Router();
router.post('/auth/register',async(req,res)=>{
  const firstName=String(req.body.first_name||'').trim(),lastName=String(req.body.last_name||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),phone=String(req.body.phone||'').trim(),password=String(req.body.password||'');
  if(!firstName||!lastName||!emailPattern.test(email)||password.length<12)return res.status(400).json({error:'Name, verified email, and a password of at least 12 characters are required.'});
  let verification;
  try{verification=verifyNotificationToken(req.body.verification_token)}catch{return res.status(403).json({error:'Email verification is required before registration.'})}
  if(verification.type!=='notification-verification'||verification.purpose!=='REGISTRATION'||verification.channel!=='EMAIL'||verification.destination!==email)return res.status(403).json({error:'The verified email does not match this registration.'});
  const challenge=(await sql`SELECT id FROM notification_verifications WHERE id=${verification.verification_id} AND verified_at IS NOT NULL`)[0];
  if(!challenge)return res.status(403).json({error:'Email verification is incomplete.'});
  const hash=await hashPassword(password);
  const user=(await sql.query(`INSERT INTO users(first_name,last_name,email,password_hash,phone,role,is_active,email_verified_at) VALUES($1,$2,$3,$4,$5,'CUSTOMER',TRUE,NOW()) RETURNING ${userColumns}`,[firstName,lastName,email,hash,phone||null]))[0];
  return res.status(201).json({token:tokenFor(user),user});
});
router.post(['/login','/auth/login'],async(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');if(!email||!password)return res.status(400).json({error:'Email and password are required.'});const rows=await sql.query(`SELECT ${userColumns},password_hash FROM users WHERE LOWER(email)=$1 LIMIT 1`,[email]);const user=rows[0];if(!user?.is_active||!await verifyPassword(password,user?.password_hash))return res.status(401).json({error:'Invalid email or password.'});delete user.password_hash;return res.json({token:tokenFor(user),user})});
router.get('/auth/session',authenticate,(req,res)=>res.json({user:req.user,expires_at:new Date(req.auth.exp*1000).toISOString()}));
export default router;
