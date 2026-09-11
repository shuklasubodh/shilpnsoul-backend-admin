import {Router} from 'express';
import sql from './db.js';
import {authenticate,admin} from './auth.js';
import {emailPattern,page} from './utils.js';

const router=Router();

router.post('/marketing',async(req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase();
  if(!emailPattern.test(email)||email.length>320)return res.status(400).json({error:'Enter a valid email address.'});
  const record=(await sql`INSERT INTO marketing(email,status,source,subscribed_at,unsubscribed_at) VALUES(${email},'SUBSCRIBED','STOREFRONT_FOOTER',NOW(),NULL) ON CONFLICT(email) DO UPDATE SET status='SUBSCRIBED',unsubscribed_at=NULL,updated_at=NOW() RETURNING id,email,status,subscribed_at`)[0];
  return res.status(201).json({message:'Thanks for registering for marketing messages.',data:record});
});

router.get('/marketing',authenticate,admin,async(req,res)=>{
  const p=page(req.query);
  const count=(await sql`SELECT COUNT(*)::int count FROM marketing`)[0].count;
  const rows=await sql.query('SELECT id,email,status,source,subscribed_at,unsubscribed_at,created_at,updated_at FROM marketing ORDER BY subscribed_at DESC LIMIT $1 OFFSET $2',[p.limit,p.start]);
  res.set('X-Total-Count',count);
  return res.json(rows);
});

export default router;
