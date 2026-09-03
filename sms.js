const credentials=()=>{
  const accountSid=process.env.TWILIO_ACCOUNT_SID;
  const authToken=process.env.TWILIO_AUTH_TOKEN;
  if(!accountSid||!authToken)throw Object.assign(new Error('Twilio credentials are not configured.'),{code:'SMS_CONFIG_MISSING'});
  return{accountSid,authToken};
};

const messagingConfig=()=>{
  const{accountSid,authToken}=credentials();
  const messagingServiceSid=process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from=process.env.TWILIO_SMS_FROM;
  if(!messagingServiceSid&&!from)throw Object.assign(new Error('SMS messaging is not configured.'),{code:'SMS_CONFIG_MISSING'});
  return{accountSid,authToken,messagingServiceSid,from};
};

const verifyConfig=()=>{
  const{accountSid,authToken}=credentials(),serviceSid=process.env.TWILIO_VERIFY_SERVICE_SID;
  if(!serviceSid?.startsWith('VA'))throw Object.assign(new Error('Twilio Verify is not configured.'),{code:'SMS_CONFIG_MISSING'});
  return{accountSid,authToken,serviceSid};
};

const request=async(url,body,accountSid,authToken)=>{
  const response=await fetch(url,{
    method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body,
  });
  const result=await response.json().catch(()=>({}));
  return{response,result};
};

export async function sendOtpSms({to}){
  const{accountSid,authToken,serviceSid}=verifyConfig();
  const{response,result}=await request(`https://verify.twilio.com/v2/Services/${serviceSid}/Verifications`,new URLSearchParams({To:to,Channel:'sms'}),accountSid,authToken);
  if(!response.ok||!result.sid)throw Object.assign(new Error(result.message||'Twilio Verify rejected the SMS.'),{statusCode:response.status,providerCode:result.code});
  return{id:result.sid};
}

export async function verifyOtpSms({to,code}){
  const{accountSid,authToken,serviceSid}=verifyConfig();
  const{response,result}=await request(`https://verify.twilio.com/v2/Services/${serviceSid}/VerificationCheck`,new URLSearchParams({To:to,Code:code}),accountSid,authToken);
  if(response.status===404&&result.code===20404)return false;
  if(!response.ok)throw Object.assign(new Error(result.message||'Twilio Verify could not check the code.'),{statusCode:response.status,providerCode:result.code});
  return result.status==='approved';
}

export async function sendOrderSummarySms({order,items}){
  const{accountSid,authToken,messagingServiceSid,from}=messagingConfig();
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
