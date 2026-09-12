import {Router} from 'express';
import {sendContactMessage} from './email.js';
import {emailPattern} from './utils.js';

const router=Router();
const attempts=new Map();
const WINDOW_MS=10*60*1000;
const MAX_ATTEMPTS=3;

router.post('/contact',async(req,res)=>{
  const name=String(req.body.name||'').trim();
  const email=String(req.body.email||'').trim().toLowerCase();
  const subject=String(req.body.subject||'').trim();
  const message=String(req.body.message||'').trim();
  const requestId=String(req.body.request_id||'').trim();
  if(req.body.website)return res.status(202).json({message:'Your message has been sent.'});
  if(name.length>120||!emailPattern.test(email)||email.length>320||subject.length<2||subject.length>150||message.length<10||message.length>5000||!/^[0-9a-f-]{36}$/i.test(requestId))return res.status(400).json({error:'Enter a valid email, subject, and message.'});

  const key=String(req.ip||req.socket?.remoteAddress||'unknown');
  const now=Date.now();
  const recent=(attempts.get(key)||[]).filter(timestamp=>now-timestamp<WINDOW_MS);
  if(recent.length>=MAX_ATTEMPTS)return res.status(429).json({error:'Too many messages. Please try again in a few minutes.'});
  attempts.set(key,[...recent,now]);

  await sendContactMessage({name,email,subject,message,requestId});
  return res.status(202).json({message:'Your message has been sent.'});
});

export default router;
