import crypto from 'node:crypto';
import { promisify } from 'node:util';
import sql from './db.js';
const scrypt=promisify(crypto.scrypt);
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const secret=()=>{const s=process.env.AUTH_SECRET;if(!s||s.length<32)throw new Error('AUTH_SECRET must have at least 32 characters');return s};
export async function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const key=await scrypt(password,salt,64);return `scrypt$${salt}$${key.toString('hex')}`}
export async function verifyPassword(password,hash){const [a,salt,want]=String(hash||'').split('$');if(a!=='scrypt'||!/^[a-f\d]{32}$/i.test(salt)||!/^[a-f\d]{128}$/i.test(want))return false;const got=await scrypt(password,salt,64);return equal(got.toString('hex'),want)}
export function tokenFor(user){const p=Buffer.from(JSON.stringify({sub:String(user.id),exp:Date.now()+86400000})).toString('base64url');return `${p}.${crypto.createHmac('sha256',secret()).update(p).digest('base64url')}`}
export async function authenticate(req,res,next){try{const [scheme,token,extra]=String(req.get('authorization')||'').trim().split(/\s+/);if(scheme?.toLowerCase()!=='bearer'||!token||extra)throw 0;const [p,s,x]=token.split('.');if(!p||!s||x||!equal(s,crypto.createHmac('sha256',secret()).update(p).digest('base64url')))throw 0;const c=JSON.parse(Buffer.from(p,'base64url'));if(!/^\d+$/.test(c.sub)||Date.now()>=c.exp)throw 0;const rows=await sql`SELECT id,first_name,last_name,email,phone,role,is_active FROM users WHERE id=${c.sub}`;if(!rows[0]?.is_active)throw 0;req.user=rows[0];next()}catch{return res.status(401).json({error:'Authentication required.'})}}
export const admin=(req,res,next)=>String(req.user?.role).toUpperCase()==='ADMIN'?next():res.status(403).json({error:'Administrator access required.'});
export const isAdmin=u=>String(u?.role).toUpperCase()==='ADMIN';
