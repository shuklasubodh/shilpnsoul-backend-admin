import {Router} from 'express';
import crypto from 'node:crypto';
import sql from './db.js';
import {authenticate,admin} from './auth.js';
import {sendMarketingWelcomeEmail} from './email.js';
import {emailPattern,page} from './utils.js';

const router=Router();

router.post('/marketing',async(req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase();
  if(!emailPattern.test(email)||email.length>320)return res.status(400).json({error:'Enter a valid email address.'});
  const existing=(await sql`SELECT id,status FROM marketing WHERE email=${email} LIMIT 1`)[0];
  if(existing?.status==='SUBSCRIBED')return res.status(409).json({code:'ALREADY_SUBSCRIBED',error:'This email is already registered for newsletter updates.'});
  const requestId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(req.body.request_id||''))?String(req.body.request_id):crypto.randomUUID();
  const record=existing
    ?(await sql`UPDATE marketing SET status='SUBSCRIBED',source='STOREFRONT_FOOTER',subscribed_at=NOW(),unsubscribed_at=NULL,updated_at=NOW() WHERE id=${existing.id} RETURNING id,email,status,subscribed_at`)[0]
    :(await sql`INSERT INTO marketing(email,status,source,subscribed_at,unsubscribed_at) VALUES(${email},'SUBSCRIBED','STOREFRONT_FOOTER',NOW(),NULL) ON CONFLICT(email) DO NOTHING RETURNING id,email,status,subscribed_at`)[0];
  if(!record)return res.status(409).json({code:'ALREADY_SUBSCRIBED',error:'This email is already registered for newsletter updates.'});
  try{
    await sendMarketingWelcomeEmail({to:email,subscriptionId:record.id,requestId});
  }catch(error){
    console.error('Marketing welcome email failed',{code:error.providerCode||error.code||null,status:error.statusCode||null});
    return res.status(503).json({error:'Your newsletter registration was saved, but the confirmation email could not be sent. Please try again.'});
  }
  return res.status(201).json({message:'You are registered and a confirmation email has been sent.',data:record});
});

router.get('/marketing',authenticate,admin,async(req,res)=>{
  const p=page(req.query);
  const count=(await sql`SELECT COUNT(*)::int count FROM marketing`)[0].count;
  const rows=await sql.query('SELECT id,email,status,source,subscribed_at,unsubscribed_at,created_at,updated_at FROM marketing ORDER BY subscribed_at DESC LIMIT $1 OFFSET $2',[p.limit,p.start]);
  res.set('X-Total-Count',count);
  return res.json(rows);
});

export default router;
