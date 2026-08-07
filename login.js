import{Router}from'express';import sql from'./db.js';import{tokenFor,verifyPassword}from'./auth.js';import{userColumns}from'./utils.js';
const router=Router();
router.post(['/login','/auth/login'],async(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');if(!email||!password)return res.status(400).json({error:'Email and password are required.'});const rows=await sql.query(`SELECT ${userColumns},password_hash FROM users WHERE LOWER(email)=$1 LIMIT 1`,[email]);const user=rows[0];if(!user?.is_active||!await verifyPassword(password,user?.password_hash))return res.status(401).json({error:'Invalid email or password.'});delete user.password_hash;return res.json({token:tokenFor(user),user})});
export default router;
