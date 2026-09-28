import {Router} from 'express';
import {sendContactMessage} from './email.js';
import {emailPattern} from './utils.js';

const router=Router();
router.post('/contact',async(req,res)=>{
  const name=String(req.body.name||'').trim();
  const email=String(req.body.email||'').trim().toLowerCase();
  const subject=String(req.body.subject||'').trim();
  const message=String(req.body.message||'').trim();
  const requestId=String(req.body.request_id||'').trim();
  if(req.body.website)return res.status(202).json({message:'Your message has been sent.'});
  if(name.length>120||!emailPattern.test(email)||email.length>320||subject.length<2||subject.length>150||message.length<10||message.length>5000||!/^[0-9a-f-]{36}$/i.test(requestId))return res.status(400).json({error:'Enter a valid email, subject, and message.'});

  await sendContactMessage({name,email,subject,message,requestId});
  return res.status(202).json({message:'Your message has been sent.'});
});

export default router;
