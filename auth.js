import crypto from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import sql from './db.js';
const scrypt=promisify(crypto.scrypt);
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
export const authSecret=()=>{const configured=process.env.AUTH_SECRET;if(configured?.length>=32)return configured;const error=new Error('AUTH_SECRET must be configured with at least 32 characters.');error.code='AUTH_SECRET_MISSING';throw error};
export async function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const key=await scrypt(password,salt,64);return `scrypt$${salt}$${key.toString('hex')}`}
export async function verifyPassword(password,hash){const stored=String(hash||'');if(/^\$2[aby]\$\d{2}\$.{53}$/.test(stored))return bcrypt.compare(String(password),stored);const [a,salt,want]=stored.split('$');if(a!=='scrypt'||!/^[a-f\d]{32}$/i.test(salt)||!/^[a-f\d]{128}$/i.test(want))return false;const got=await scrypt(password,salt,64);return equal(got.toString('hex'),want)}
export function tokenFor(user){return jwt.sign({role:String(user.role||'CUSTOMER').toUpperCase()},authSecret(),{algorithm:'HS256',subject:String(user.id),issuer:'shilpnsoul-api',audience:'shilpnsoul-web',expiresIn:process.env.JWT_EXPIRES_IN||'2h'})}
export const notificationTokenFor=({channel,destination,purpose,verificationId})=>jwt.sign({type:'notification-verification',channel,destination,purpose,verification_id:String(verificationId)},authSecret(),{algorithm:'HS256',issuer:'shilpnsoul-api',audience:'shilpnsoul-notifications',expiresIn:'30m'});
export const verifyNotificationToken=token=>jwt.verify(String(token||''),authSecret(),{algorithms:['HS256'],issuer:'shilpnsoul-api',audience:'shilpnsoul-notifications'});
export const orderAccessTokenFor=order=>jwt.sign({type:'guest-order',destination:order.notification_destination},authSecret(),{algorithm:'HS256',subject:String(order.id),issuer:'shilpnsoul-api',audience:'shilpnsoul-guest-order',expiresIn:'24h'});
export const verifyOrderAccessToken=token=>jwt.verify(String(token||''),authSecret(),{algorithms:['HS256'],issuer:'shilpnsoul-api',audience:'shilpnsoul-guest-order'});
const authenticatedUser=async req=>{const [scheme,token,extra]=String(req.get('authorization')||'').trim().split(/\s+/);if(scheme?.toLowerCase()!=='bearer'||!token||extra)throw 0;const claims=jwt.verify(token,authSecret(),{algorithms:['HS256'],issuer:'shilpnsoul-api',audience:'shilpnsoul-web'});if(!/^\d+$/.test(String(claims.sub)))throw 0;const rows=await sql`SELECT id,first_name,last_name,email,country_code,phone,whatsapp_number,role,is_active,email_verified_at,phone_verified_at,whatsapp_verified_at,preferred_notification_channel,return_window_days,updated_at FROM users WHERE id=${claims.sub}`;if(!rows[0]?.is_active||!claims.iat||claims.iat*1000+999<new Date(rows[0].updated_at).getTime())throw 0;return{claims,user:rows[0]}};
export async function authenticate(req,res,next){try{const result=await authenticatedUser(req);req.auth=result.claims;req.user=result.user;next()}catch{return res.status(401).json({error:'Authentication required.'})}}
export async function optionalAuthenticate(req,res,next){if(!req.get('authorization'))return next();try{const result=await authenticatedUser(req);req.auth=result.claims;req.user=result.user;next()}catch{return res.status(401).json({error:'Authentication required.'})}}
export const admin=(req,res,next)=>String(req.user?.role).toUpperCase()==='ADMIN'?next():res.status(403).json({error:'Administrator access required.'});
export const isAdmin=u=>String(u?.role).toUpperCase()==='ADMIN';
