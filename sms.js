const config=()=>{
  const accountSid=process.env.TWILIO_ACCOUNT_SID;
  const authToken=process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid=process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from=process.env.TWILIO_SMS_FROM;
  if(!accountSid||!authToken||(!messagingServiceSid&&!from))throw Object.assign(new Error('SMS is not configured.'),{code:'SMS_CONFIG_MISSING'});
  return{accountSid,authToken,messagingServiceSid,from};
};

export async function sendOtpSms({to,code}){
  const{accountSid,authToken,messagingServiceSid,from}=config();
  const body=new URLSearchParams({To:to,Body:`Your Shilp & Soul verification code is ${code}. It expires in 10 minutes. Do not share this code.`});
  if(messagingServiceSid)body.set('MessagingServiceSid',messagingServiceSid);
  else body.set('From',from);
  const response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,{
    method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body,
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok||!result.sid)throw Object.assign(new Error(result.message||'Twilio rejected the SMS.'),{statusCode:response.status,providerCode:result.code});
  return{id:result.sid};
}

export async function sendOrderSummarySms({order,items}){
  const{accountSid,authToken,messagingServiceSid,from}=config();
  const itemSummary=items.map(item=>`${item.product_name} x ${item.quantity}`).join(', ').slice(0,700);
  const body=new URLSearchParams({To:order.notification_destination,Body:`Shilp & Soul order ${order.order_number} received. ${itemSummary}. Total S$${Number(order.total_amount).toFixed(2)}.`});
  if(messagingServiceSid)body.set('MessagingServiceSid',messagingServiceSid);
  else body.set('From',from);
  const response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,{
    method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body,
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok||!result.sid)throw Object.assign(new Error(result.message||'Twilio rejected the SMS.'),{statusCode:response.status,providerCode:result.code});
  return{id:result.sid};
}
