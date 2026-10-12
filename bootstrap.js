import crypto from 'node:crypto';
import {Router} from 'express';
import sql from './db.js';
import {authSecret,hashPassword} from './auth.js';
import {bootstrapContextHash,maskedEmail} from './bootstrapPolicy.js';
import {sendOtpEmail} from './email.js';
import {consumeRateLimit} from './rateLimit.js';

const router=Router();
router.use('/admin/bootstrap',(req,res,next)=>{res.set('Cache-Control','no-store');next()});
const normalizeEmail=value=>String(value||'').trim().toLowerCase();
const codeHash=(code,destination,nonce)=>crypto.createHmac('sha256',authSecret()).update(`${code}:${destination}:${nonce}`).digest('hex');
const safeEqual=(left,right)=>{const a=Buffer.from(String(left)),b=Buffer.from(String(right));return a.length===b.length&&crypto.timingSafeEqual(a,b)};

const config=()=>{
  const email=normalizeEmail(process.env.INITIAL_ADMIN_EMAIL);
  const bootstrapSecret=String(process.env.INITIAL_ADMIN_BOOTSTRAP_SECRET||'');
  if(email!=='subodhshukla@gmail.com'||bootstrapSecret.length<32){
    const error=new Error('Initial administrator security is not configured.');
    error.code='INITIAL_ADMIN_CONFIG_MISSING';
    throw error;
  }
  return{email,bootstrapSecret};
};

const secretMatches=(submitted,expected)=>safeEqual(
  crypto.createHash('sha256').update(String(submitted||'')).digest('hex'),
  crypto.createHash('sha256').update(expected).digest('hex'),
);

export const storeReadiness=async()=>{
  const state=(await sql`SELECT status FROM system_bootstrap WHERE id=1`)[0];
  const activeAdmin=(await sql`SELECT id FROM users WHERE role='ADMIN' AND is_active=TRUE LIMIT 1`)[0];
  return{bootstrapComplete:state?.status==='COMPLETED',activeAdmin:Boolean(activeAdmin)};
};

export const requireStoreReady=async(req,res,next)=>{
  try{
    const readiness=await storeReadiness();
    if(!readiness.bootstrapComplete||!readiness.activeAdmin)return res.status(503).json({error:'Store setup is incomplete. Ordering is temporarily unavailable.',code:'STORE_SETUP_REQUIRED'});
    return next();
  }catch(error){return next(error)}
};

router.get('/admin/bootstrap/status',async(req,res,next)=>{
  try{
    let configured=true,emailHint='';
    try{emailHint=maskedEmail(config().email)}catch{configured=false}
    const state=(await sql`SELECT status,completed_at FROM system_bootstrap WHERE id=1`)[0];
    const userCount=Number((await sql`SELECT COUNT(*)::int count FROM users`)[0]?.count||0);
    const activeAdmin=Boolean((await sql`SELECT id FROM users WHERE role='ADMIN' AND is_active=TRUE LIMIT 1`)[0]);
    return res.json({setup_required:state?.status==='PENDING'&&userCount===0,configured,approver_email_hint:emailHint,recovery_required:state?.status==='COMPLETED'&&!activeAdmin});
  }catch(error){return next(error)}
});

router.post('/admin/bootstrap/request-code',async(req,res,next)=>{
  try{
    const {email,bootstrapSecret}=config();
    const firstName=String(req.body.first_name||'').trim(),lastName=String(req.body.last_name||'').trim(),password=String(req.body.password||'');
    if(!firstName||!lastName||password.length<15)return res.status(400).json({error:'First name, last name, and a password of at least 15 characters are required.'});
    if(!secretMatches(req.body.bootstrap_secret,bootstrapSecret))return res.status(403).json({error:'Initial administrator authorization failed.'});
    const allowed=await consumeRateLimit({scope:'initial-admin-email-global',identity:'global',maxAttempts:3,windowSeconds:3600,blockSeconds:3600});
    if(!allowed)return res.status(429).json({error:'Authorization code limit reached. Try again later.'});
    const state=(await sql`SELECT b.status,(SELECT COUNT(*)::int FROM users) user_count FROM system_bootstrap b WHERE b.id=1`)[0];
    if(!state||state.status!=='PENDING'||Number(state.user_count)!==0)return res.status(409).json({error:'Initial administrator setup is no longer available.'});
    const recent=(await sql`SELECT created_at FROM notification_verifications WHERE purpose='INITIAL_ADMIN' AND destination=${email} AND created_at>NOW()-INTERVAL '1 hour' ORDER BY created_at DESC`)[0];
    if(recent&&Date.now()-new Date(recent.created_at).getTime()<60000)return res.status(429).json({error:'Please wait before requesting another authorization code.'});
    const code=String(crypto.randomInt(100000,1000000)),nonce=crypto.randomBytes(16).toString('hex');
    const contextHash=bootstrapContextHash({firstName,lastName,email,password},authSecret());
    const challenge=(await sql`INSERT INTO notification_verifications(channel,destination,purpose,context_hash,code_hash,nonce,expires_at) VALUES('EMAIL',${email},'INITIAL_ADMIN',${contextHash},${codeHash(code,email,nonce)},${nonce},NOW()+INTERVAL '10 minutes') RETURNING id,expires_at`)[0];
    const delivery=(await sql`INSERT INTO notification_deliveries(verification_id,notification_type,channel,destination,provider,status,idempotency_key) VALUES(${challenge.id},'OTP','EMAIL',${email},'RESEND','PENDING',${`otp/${challenge.id}`}) RETURNING id`)[0];
    try{
      const sent=await sendOtpEmail({to:email,code,purpose:'INITIAL_ADMIN',verificationId:challenge.id});
      await sql`UPDATE notification_deliveries SET status='ACCEPTED',provider_message_id=${sent.id},updated_at=NOW() WHERE id=${delivery.id}`;
    }catch(error){
      await sql`UPDATE notification_verifications SET consumed_at=NOW() WHERE id=${challenge.id}`;
      await sql`UPDATE notification_deliveries SET status='FAILED',error_message=${String(error.message).slice(0,500)},updated_at=NOW() WHERE id=${delivery.id}`;
      throw error;
    }
    return res.status(201).json({challenge_id:challenge.id,expires_at:challenge.expires_at,message:'An authorization code was sent to the configured owner email.'});
  }catch(error){return next(error)}
});

router.post('/admin/bootstrap/complete',async(req,res,next)=>{
  try{
    const {email,bootstrapSecret}=config();
    const firstName=String(req.body.first_name||'').trim(),lastName=String(req.body.last_name||'').trim(),password=String(req.body.password||''),code=String(req.body.code||'').trim(),challengeId=String(req.body.challenge_id||'');
    if(!/^\d+$/.test(challengeId)||!/^\d{6}$/.test(code)||!firstName||!lastName||password.length<15)return res.status(400).json({error:'Valid administrator details and a six-digit authorization code are required.'});
    if(!secretMatches(req.body.bootstrap_secret,bootstrapSecret))return res.status(403).json({error:'Initial administrator authorization failed.'});
    const contextHash=bootstrapContextHash({firstName,lastName,email,password},authSecret());
    const challenge=(await sql`SELECT id,code_hash,nonce,attempts,expires_at FROM notification_verifications WHERE id=${challengeId} AND purpose='INITIAL_ADMIN' AND channel='EMAIL' AND destination=${email} AND context_hash=${contextHash} AND consumed_at IS NULL`)[0];
    if(!challenge||challenge.attempts>=5||new Date(challenge.expires_at)<=new Date())return res.status(410).json({error:'This authorization code is invalid or expired. Request a new code.'});
    if(!safeEqual(codeHash(code,email,challenge.nonce),challenge.code_hash)){
      await sql`UPDATE notification_verifications SET attempts=attempts+1 WHERE id=${challenge.id} AND consumed_at IS NULL`;
      return res.status(400).json({error:'Incorrect authorization code.'});
    }
    const passwordHash=await hashPassword(password);
    const rows=await sql.query(`
      WITH bootstrap_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtextextended('shilpnsoul-initial-admin-bootstrap',0))
      ), state AS MATERIALIZED (
        SELECT b.status FROM system_bootstrap b CROSS JOIN bootstrap_lock WHERE b.id=1 FOR UPDATE OF b
      ), challenge AS MATERIALIZED (
        SELECT nv.id FROM notification_verifications nv CROSS JOIN state
        WHERE nv.id=$1 AND nv.purpose='INITIAL_ADMIN' AND nv.channel='EMAIL' AND nv.destination=$2
          AND nv.context_hash=$3 AND nv.code_hash=$4 AND nv.consumed_at IS NULL
          AND nv.attempts<5 AND nv.expires_at>NOW()
        FOR UPDATE OF nv
      ), created AS (
        INSERT INTO users(first_name,last_name,email,password_hash,country_code,phone,whatsapp_number,role,is_active,email_verified_at,preferred_notification_channel)
        SELECT $5,$6,$2,$7,'+65',NULL,NULL,'ADMIN',TRUE,NOW(),'EMAIL'
        FROM state,challenge
        WHERE state.status='PENDING' AND NOT EXISTS(SELECT 1 FROM users)
        RETURNING id,first_name,last_name,email
      ), consumed AS (
        UPDATE notification_verifications SET verified_at=NOW(),consumed_at=NOW()
        WHERE id IN(SELECT id FROM challenge) AND EXISTS(SELECT 1 FROM created)
        RETURNING id
      ), completed AS (
        UPDATE system_bootstrap SET status='COMPLETED',admin_user_id=created.id,completed_at=NOW(),updated_at=NOW()
        FROM created WHERE system_bootstrap.id=1 AND EXISTS(SELECT 1 FROM consumed)
        RETURNING system_bootstrap.id
      )
      SELECT created.* FROM created,completed
    `,[challenge.id,email,contextHash,challenge.code_hash,firstName,lastName,passwordHash]);
    if(!rows[0])return res.status(409).json({error:'Initial administrator setup is no longer available or the authorization was already used.'});
    console.info('Initial administrator bootstrap completed',{userId:rows[0].id,email:rows[0].email});
    return res.status(201).json({message:'Initial administrator created. Sign in with the new credentials.',email:rows[0].email});
  }catch(error){return next(error)}
});

export default router;
