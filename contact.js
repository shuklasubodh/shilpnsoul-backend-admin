import {Router} from 'express';
import {optionalAuthenticate} from './auth.js';
import {sendContactEmail} from './email.js';

const router=Router();
const attempts=new Map();
router.post('/contact',optionalAuthenticate,async(req,res)=>{
  const subject=String(req.body.subject||'').trim(),message=String(req.body.message||'').trim();
  if(subject.length<2||subject.length>150||message.length<10||message.length>5000)return res.status(400).json({error:'Enter a subject and a message between 10 and 5,000 characters.'});
  const key=String(req.ip||'unknown'),now=Date.now(),recent=(attempts.get(key)||[]).filter(time=>now-time<600000);
  if(recent.length>=5)return res.status(429).json({error:'Please wait before sending another message.'});
  attempts.set(key,[...recent,now]);
  const customer=req.user?[req.user.first_name,req.user.last_name,`(#${req.user.id})`].filter(Boolean).join(' '):'';
  await sendContactEmail({subject,message,customer});
  return res.status(202).json({message:'Message accepted.'});
});
export default router;
