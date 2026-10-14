import crypto from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import sql from './db.js';
const scrypt=promisify(crypto.scrypt);
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const accessTokenLifetime=()=>{const value=String(process.env.JWT_EXPIRES_IN||'30m').trim();const match=value.match(/^(\d+)m$/);return match&&Number(match[1])>=5&&Number(match[1])<=30?value:'30m'};
export const authSecret=()=>{const configured=process.env.AUTH_SECRET;if(configured?.length>=32)return configured;const error=new Error('AUTH_SECRET must be configured with at least 32 characters.');error.code='AUTH_SECRET_MISSING';throw error};
export async function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const key=await scrypt(password,salt,64);return `scrypt$${salt}$${key.toString('hex')}`}
export async function verifyPassword(password,hash){const stored=String(hash||'');if(/^\$2[aby]\$\d{2}\$.{53}$/.test(stored))return bcrypt.compare(String(password),stored);const [a,salt,want]=stored.split('$');if(a!=='scrypt'||!/^[a-f\d]{32}$/i.test(salt)||!/^[a-f\d]{128}$/i.test(want))return false;const got=await scrypt(password,salt,64);return equal(got.toString('hex'),want)}
export async function tokenFor(user){
  const sessionId=crypto.randomUUID(),sessionHours=Math.max(1,Math.min(168,Number(process.env.CUSTOMER_SESSION_HOURS)||24));
  const expiresAt=new Date(Date.now()+sessionHours*60*60*1000);
  await sql`INSERT INTO auth_sessions(session_id,user_id,expires_at) VALUES(${sessionId},${user.id},${expiresAt})`;
  return jwt.sign({role:String(user.role||'CUSTOMER').toUpperCase(),sid:sessionId},authSecret(),{algorithm:'HS256',subject:String(user.id),issuer:'shilpnsoul-api',audience:'shilpnsoul-web',expiresIn:accessTokenLifetime()});
}
export const notificationTokenFor=({channel,destination,purpose,verificationId,subjectType,subjectId,contextHash})=>jwt.sign({type:'notification-verification',channel,destination,purpose,verification_id:String(verificationId),subject_type:subjectType,subject_id:subjectId||undefined,context_hash:contextHash||undefined},authSecret(),{algorithm:'HS256',issuer:'shilpnsoul-api',audience:'shilpnsoul-notifications',expiresIn:'10m'});
export const verifyNotificationToken=token=>jwt.verify(String(token||''),authSecret(),{algorithms:['HS256'],issuer:'shilpnsoul-api',audience:'shilpnsoul-notifications'});
const tokenHash=value=>crypto.createHash('sha256').update(String(value||'')).digest('hex');
export async function orderAccessTokenFor(order,{scopes=['READ'],expiresAt}={}){
  const token=crypto.randomBytes(32).toString('base64url');
  const expiry=expiresAt||new Date(Date.now()+30*60*1000);
  await sql`INSERT INTO order_access_grants(order_id,token_hash,scopes,expires_at) VALUES(${order.id},${tokenHash(token)},${scopes},${expiry})`;
  return token;
}
export async function verifyOrderAccessToken(token,{orderId,scope,consume=false}={}){
  const raw=String(token||'');
  if(!raw)return null;
  const rows=consume
    ?await sql`UPDATE order_access_grants SET scopes=CASE WHEN ${scope||null}::text IS NULL OR cardinality(scopes)=1 THEN scopes ELSE array_remove(scopes,${scope||null}::text) END,consumed_at=CASE WHEN ${scope||null}::text IS NULL OR cardinality(scopes)=1 THEN NOW() ELSE consumed_at END WHERE token_hash=${tokenHash(raw)} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>NOW() AND (${orderId||null}::bigint IS NULL OR order_id=${orderId||null}) AND (${scope||null}::text IS NULL OR ${scope||null}=ANY(scopes)) RETURNING *`
    :await sql`SELECT * FROM order_access_grants WHERE token_hash=${tokenHash(raw)} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>NOW() AND (${orderId||null}::bigint IS NULL OR order_id=${orderId||null}) AND (${scope||null}::text IS NULL OR ${scope||null}=ANY(scopes)) LIMIT 1`;
  return rows[0]||null;
}
const authenticatedUser=async req=>{const [scheme,token,extra]=String(req.get('authorization')||'').trim().split(/\s+/);if(scheme?.toLowerCase()!=='bearer'||!token||extra)throw 0;const claims=jwt.verify(token,authSecret(),{algorithms:['HS256'],issuer:'shilpnsoul-api',audience:'shilpnsoul-web'});if(!/^\d+$/.test(String(claims.sub)))throw 0;if(claims.sid){const idleMinutes=Math.max(5,Math.min(240,Number(process.env.CUSTOMER_IDLE_MINUTES)||30));const session=(await sql`UPDATE auth_sessions SET last_seen_at=NOW() WHERE session_id=${claims.sid} AND user_id=${claims.sub} AND revoked_at IS NULL AND expires_at>NOW() AND last_seen_at>NOW()-(${idleMinutes}::int*INTERVAL '1 minute') RETURNING session_id`)[0];if(!session)throw 0}const rows=await sql`SELECT id,first_name,last_name,email,country_code,phone,whatsapp_number,role,is_active,email_verified_at,phone_verified_at,whatsapp_verified_at,preferred_notification_channel,return_window_days,updated_at FROM users WHERE id=${claims.sub}`;if(!rows[0]?.is_active||!claims.iat||claims.iat*1000+999<new Date(rows[0].updated_at).getTime())throw 0;return{claims,user:rows[0]}};
export async function authenticate(req,res,next){try{const result=await authenticatedUser(req);req.auth=result.claims;req.user=result.user;next()}catch{return res.status(401).json({error:'Authentication required.'})}}
export async function optionalAuthenticate(req,res,next){if(!req.get('authorization'))return next();try{const result=await authenticatedUser(req);req.auth=result.claims;req.user=result.user;next()}catch{return res.status(401).json({error:'Authentication required.'})}}
export const admin=(req,res,next)=>String(req.user?.role).toUpperCase()==='ADMIN'?next():res.status(403).json({error:'Administrator access required.'});
export const isAdmin=u=>String(u?.role).toUpperCase()==='ADMIN';
