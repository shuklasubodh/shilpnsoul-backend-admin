import crypto from 'node:crypto';
import {Router} from 'express';
import sql from './db.js';

const router=Router();

export const normalizeWhatsAppNumber=value=>{
  const raw=String(value||'').trim();
  const normalized=`+${raw.replace(/\D/g,'')}`;
  return /^\+[1-9]\d{7,14}$/.test(normalized)?normalized:'';
};

const config=()=>{
  const accessToken=process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId=process.env.WHATSAPP_PHONE_NUMBER_ID;
  if(!accessToken||!phoneNumberId)throw Object.assign(new Error('WhatsApp Cloud API is not configured.'),{code:'WHATSAPP_CONFIG_MISSING'});
  return{accessToken,phoneNumberId,version:process.env.WHATSAPP_GRAPH_API_VERSION||'v23.0'};
};

const sendMessage=async payload=>{
  const {accessToken,phoneNumberId,version}=config();
  const response=await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`,{
    method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp',...payload}),
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(result.error?.message||'Meta rejected the WhatsApp message.'),{statusCode:response.status,providerCode:result.error?.code});
  const id=result.messages?.[0]?.id;
  if(!id)throw new Error('Meta did not return a WhatsApp message ID.');
  return{id};
};

export const sendOtpWhatsApp=({to,code})=>sendMessage({
  to:normalizeWhatsAppNumber(to).slice(1),type:'template',template:{
    name:process.env.WHATSAPP_OTP_TEMPLATE||'shilpnsoul_otp',language:{code:process.env.WHATSAPP_TEMPLATE_LANGUAGE||'en'},
    components:[
      {type:'body',parameters:[{type:'text',text:code}]},
      {type:'button',sub_type:'url',index:'0',parameters:[{type:'text',text:code}]},
    ],
  },
});

export const sendOrderSummaryWhatsApp=({order,items})=>{
  const template=process.env.WHATSAPP_ORDER_TEMPLATE;
  if(!template)throw Object.assign(new Error('The WhatsApp order-summary template is not configured.'),{code:'WHATSAPP_CONFIG_MISSING'});
  const itemSummary=items.map(item=>`${item.product_name} x ${item.quantity}`).join(', ').slice(0,900);
  return sendMessage({to:normalizeWhatsAppNumber(order.notification_destination).slice(1),type:'template',template:{
    name:template,language:{code:process.env.WHATSAPP_TEMPLATE_LANGUAGE||'en'},components:[{type:'body',parameters:[
      {type:'text',text:String(order.shipping_name).slice(0,100)},
      {type:'text',text:String(order.order_number).slice(0,100)},
      {type:'text',text:itemSummary||'Order items'},
      {type:'text',text:`S$${Number(order.total_amount).toFixed(2)}`},
    ]}],
  }});
};

const validSignature=req=>{
  const secret=process.env.WHATSAPP_APP_SECRET,signature=String(req.get('x-hub-signature-256')||'');
  if(!secret||!req.rawBody||!signature.startsWith('sha256='))return false;
  const expected=`sha256=${crypto.createHmac('sha256',secret).update(req.rawBody).digest('hex')}`;
  const left=Buffer.from(signature),right=Buffer.from(expected);
  return left.length===right.length&&crypto.timingSafeEqual(left,right);
};

router.get('/whatsapp/webhook',(req,res)=>{
  if(req.query['hub.mode']==='subscribe'&&req.query['hub.verify_token']===process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)return res.status(200).send(String(req.query['hub.challenge']||''));
  return res.status(403).send('Verification failed');
});

router.post('/whatsapp/webhook',async(req,res)=>{
  if(!validSignature(req))return res.status(401).json({error:'Invalid webhook signature.'});
  const statuses=(req.body.entry||[]).flatMap(entry=>(entry.changes||[]).flatMap(change=>change.value?.statuses||[]));
  for(const status of statuses){
    const mapped=status.status==='failed'?'FAILED':status.status==='delivered'||status.status==='read'?'DELIVERED':'ACCEPTED';
    const error=status.errors?.[0]?.title||status.errors?.[0]?.message||null;
    await sql`UPDATE notification_deliveries SET status=${mapped},error_message=${error?String(error).slice(0,500):null},updated_at=NOW() WHERE provider='META_WHATSAPP' AND provider_message_id=${status.id}`;
  }
  return res.sendStatus(200);
});

export default router;
