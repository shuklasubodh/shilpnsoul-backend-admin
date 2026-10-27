import crypto from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import sql from './db.js';
const scrypt=promisify(crypto.scrypt);
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const tokenHash=value=>crypto.createHash('sha256').update(String(value||'')).digest('hex');
const unsafeMethod=method=>!['GET','HEAD','OPTIONS'].includes(String(method||'GET').toUpperCase());
const cookies=req=>Object.fromEntries(String(req.get('cookie')||'').split(';').map(part=>part.trim()).filter(Boolean).map(part=>{const index=part.indexOf('=');if(index<0)return[part,''];try{return[part.slice(0,index),decodeURIComponent(part.slice(index+1))]}catch{return[part.slice(0,index),part.slice(index+1)]}}));
const sameSite=()=>{const configured=String(process.env.AUTH_COOKIE_SAME_SITE||'').toLowerCase();return['lax','strict','none'].includes(configured)?configured:(process.env.NODE_ENV==='production'?'none':'lax')};
const cookieOptions=maxAge=>({httpOnly:true,secure:process.env.NODE_ENV==='production'||sameSite()==='none',sameSite:sameSite(),path:'/api',maxAge});
const CUSTOMER_COOKIE='shilpnsoul_session';
const orderCookieName=orderId=>`shilpnsoul_order_${orderId}`;
let browserSessionSchemaPromise;
const ensureBrowserSessionSchema=()=>{
  if(!browserSessionSchemaPromise)browserSessionSchemaPromise=(async()=>{
    await sql`CREATE TABLE IF NOT EXISTS auth_sessions (
      session_id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS csrf_token_hash TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id,expires_at DESC)`;
  })().catch(error=>{browserSessionSchemaPromise=undefined;throw error});
  return browserSessionSchemaPromise;
};
export const setCustomerSessionCookie=(res,token)=>res.cookie(CUSTOMER_COOKIE,token,cookieOptions(30*60*1000));
export const clearCustomerSessionCookie=res=>res.clearCookie(CUSTOMER_COOKIE,cookieOptions(0));
export const setOrderAccessCookie=(res,orderId,token,expiresAt)=>res.cookie(orderCookieName(orderId),token,cookieOptions(Math.max(0,new Date(expiresAt).getTime()-Date.now())));
export const clearOrderAccessCookie=(res,orderId)=>res.clearCookie(orderCookieName(orderId),cookieOptions(0));
export const orderAccessTokenFromRequest=(req,orderId)=>String(req.get('x-order-access-token')||cookies(req)[orderCookieName(orderId)]||'');
const accessTokenLifetime=()=>{const value=String(process.env.JWT_EXPIRES_IN||'30m').trim();const match=value.match(/^(\d+)m$/);return match&&Number(match[1])>=5&&Number(match[1])<=30?value:'30m'};
export const authSecret=()=>{const configured=process.env.AUTH_SECRET;if(configured?.length>=32)return configured;const error=new Error('AUTH_SECRET must be configured with at least 32 characters.');error.code='AUTH_SECRET_MISSING';throw error};
export async function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const key=await scrypt(password,salt,64);return `scrypt$${salt}$${key.toString('hex')}`}
export async function verifyPassword(password,hash){const stored=String(hash||'');if(/^\$2[aby]\$\d{2}\$.{53}$/.test(stored))return bcrypt.compare(String(password),stored);const [a,salt,want]=stored.split('$');if(a!=='scrypt'||!/^[a-f\d]{32}$/i.test(salt)||!/^[a-f\d]{128}$/i.test(want))return false;const got=await scrypt(password,salt,64);return equal(got.toString('hex'),want)}
export async function tokenFor(user){
  await ensureBrowserSessionSchema();
  const sessionId=crypto.randomUUID(),csrfToken=crypto.randomBytes(32).toString('base64url'),sessionHours=Math.max(1,Math.min(168,Number(process.env.CUSTOMER_SESSION_HOURS)||24));
  const expiresAt=new Date(Date.now()+sessionHours*60*60*1000);
  await sql`INSERT INTO auth_sessions(session_id,user_id,csrf_token_hash,expires_at) VALUES(${sessionId},${user.id},${tokenHash(csrfToken)},${expiresAt})`;
  const token=jwt.sign({role:String(user.role||'CUSTOMER').toUpperCase(),sid:sessionId},authSecret(),{algorithm:'HS256',subject:String(user.id),issuer:'shilpnsoul-api',audience:'shilpnsoul-web',expiresIn:accessTokenLifetime()});
  return{token,csrfToken,expiresAt};
}
export const notificationTokenFor=({channel,destination,purpose,verificationId,subjectType,subjectId,contextHash})=>jwt.sign({type:'notification-verification',channel,destination,purpose,verification_id:String(verificationId),subject_type:subjectType,subject_id:subjectId||undefined,context_hash:contextHash||undefined},authSecret(),{algorithm:'HS256',issuer:'shilpnsoul-api',audience:'shilpnsoul-notifications',expiresIn:'10m'});
export const verifyNotificationToken=token=>jwt.verify(String(token||''),authSecret(),{algorithms:['HS256'],issuer:'shilpnsoul-api',audience:'shilpnsoul-notifications'});
export async function orderAccessTokenFor(order,{scopes=['READ'],expiresAt}={}){
  const token=crypto.randomBytes(32).toString('base64url'),csrfToken=crypto.randomBytes(32).toString('base64url');
  const expiry=expiresAt||new Date(Date.now()+30*60*1000);
  await sql`INSERT INTO order_access_grants(order_id,token_hash,csrf_token_hash,scopes,expires_at) VALUES(${order.id},${tokenHash(token)},${tokenHash(csrfToken)},${scopes},${expiry})`;
  return{token,csrfToken,expiresAt:expiry};
}
export async function verifyOrderAccessToken(token,{orderId,scope,consume=false}={}){
  const raw=String(token||'');
  if(!raw)return null;
  const rows=consume
    ?await sql`UPDATE order_access_grants SET scopes=CASE WHEN ${scope||null}::text IS NULL OR cardinality(scopes)=1 THEN scopes ELSE array_remove(scopes,${scope||null}::text) END,consumed_at=CASE WHEN ${scope||null}::text IS NULL OR cardinality(scopes)=1 THEN NOW() ELSE consumed_at END WHERE token_hash=${tokenHash(raw)} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>NOW() AND (${orderId||null}::bigint IS NULL OR order_id=${orderId||null}) AND (${scope||null}::text IS NULL OR ${scope||null}=ANY(scopes)) RETURNING *`
    :await sql`SELECT * FROM order_access_grants WHERE token_hash=${tokenHash(raw)} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>NOW() AND (${orderId||null}::bigint IS NULL OR order_id=${orderId||null}) AND (${scope||null}::text IS NULL OR ${scope||null}=ANY(scopes)) LIMIT 1`;
  return rows[0]||null;
}
export async function authorizeOrderAccess(req,{orderId,scope,consume=false,mutation=false}={}){
  const bearer=String(req.get('x-order-access-token')||''),token=bearer||orderAccessTokenFromRequest(req,orderId);
  const grant=await verifyOrderAccessToken(token,{orderId,scope,consume});
  if(!grant)return null;
  if(!bearer&&mutation&&!equal(tokenHash(req.get('x-csrf-token')),grant.csrf_token_hash))return null;
  return grant;
}
const authenticatedUser=async req=>{
  const [scheme,bearer,extra]=String(req.get('authorization')||'').trim().split(/\s+/),cookieToken=cookies(req)[CUSTOMER_COOKIE],usingBearer=scheme?.toLowerCase()==='bearer'&&bearer&&!extra;
  const token=usingBearer?bearer:cookieToken;if(!token)throw 0;
  const claims=jwt.verify(token,authSecret(),{algorithms:['HS256'],issuer:'shilpnsoul-api',audience:'shilpnsoul-web'});if(!/^\d+$/.test(String(claims.sub))||!claims.sid)throw 0;
  const idleMinutes=Math.max(5,Math.min(240,Number(process.env.CUSTOMER_IDLE_MINUTES)||30));
  const session=(await sql`UPDATE auth_sessions SET last_seen_at=NOW() WHERE session_id=${claims.sid} AND user_id=${claims.sub} AND revoked_at IS NULL AND expires_at>NOW() AND last_seen_at>NOW()-(${idleMinutes}::int*INTERVAL '1 minute') RETURNING session_id,csrf_token_hash,expires_at`)[0];if(!session)throw 0;
  if(!usingBearer&&unsafeMethod(req.method)&&!equal(tokenHash(req.get('x-csrf-token')),session.csrf_token_hash))throw Object.assign(new Error('CSRF validation failed.'),{code:'CSRF_INVALID'});
  const rows=await sql`SELECT id,first_name,last_name,email,country_code,phone,whatsapp_number,role,is_active,email_verified_at,phone_verified_at,whatsapp_verified_at,preferred_notification_channel,return_window_days,updated_at FROM users WHERE id=${claims.sub}`;if(!rows[0]?.is_active||!claims.iat||claims.iat*1000+999<new Date(rows[0].updated_at).getTime())throw 0;return{claims,user:rows[0],session,usingBearer};
};
export async function rotateSessionCsrf(sessionId){const csrfToken=crypto.randomBytes(32).toString('base64url');await sql`UPDATE auth_sessions SET csrf_token_hash=${tokenHash(csrfToken)} WHERE session_id=${sessionId} AND revoked_at IS NULL`;return csrfToken}
export async function authenticate(req,res,next){try{const result=await authenticatedUser(req);req.auth=result.claims;req.user=result.user;req.authSession=result.session;req.authUsingBearer=result.usingBearer;next()}catch(error){if(error?.code!=='CSRF_INVALID'&&cookies(req)[CUSTOMER_COOKIE])clearCustomerSessionCookie(res);return res.status(error?.code==='CSRF_INVALID'?403:401).json({error:error?.code==='CSRF_INVALID'?'Request verification failed. Refresh and try again.':'Authentication required.'})}}
export async function optionalAuthenticate(req,res,next){if(!req.get('authorization')&&!cookies(req)[CUSTOMER_COOKIE])return next();try{const result=await authenticatedUser(req);req.auth=result.claims;req.user=result.user;req.authSession=result.session;req.authUsingBearer=result.usingBearer;next()}catch(error){if(error?.code!=='CSRF_INVALID'&&cookies(req)[CUSTOMER_COOKIE])clearCustomerSessionCookie(res);return res.status(error?.code==='CSRF_INVALID'?403:401).json({error:error?.code==='CSRF_INVALID'?'Request verification failed. Refresh and try again.':'Authentication required.'})}}
export const admin=(req,res,next)=>String(req.user?.role).toUpperCase()==='ADMIN'?next():res.status(403).json({error:'Administrator access required.'});
export const isAdmin=u=>String(u?.role).toUpperCase()==='ADMIN';
