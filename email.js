import React from 'react';
import crypto from 'node:crypto';
import {Body,Container,Head,Heading,Hr,Html,Preview,Section,Text} from '@react-email/components';
import {render} from '@react-email/render';
import {Resend} from 'resend';
import sql from './db.js';

const h=React.createElement;
const colors={ink:'#22221f',muted:'#66665f',paper:'#f7f5ef',brand:'#304a3a',line:'#d8d3c8'};
const base={fontFamily:'Arial, sans-serif',backgroundColor:colors.paper,color:colors.ink,margin:0,padding:'24px 10px'};
const container={backgroundColor:'#ffffff',border:`1px solid ${colors.line}`,margin:'0 auto',maxWidth:'560px',padding:'32px'};
const fromAddress=()=>`Shilp & Soul <orders@${process.env.RESEND_EMAIL_DOMAIN||'shilpnsoul.com'}>`;
const resendClient=()=>{
  if(!process.env.RESEND_API_KEY)throw Object.assign(new Error('Resend is not configured.'),{code:'RESEND_CONFIG_MISSING'});
  return new Resend(process.env.RESEND_API_KEY);
};

const Frame=({preview,title,children})=>h(Html,{lang:'en',dir:'ltr'},h(Head),h(Body,{style:base},
  h(Preview,null,preview),h(Container,{lang:'en',dir:'ltr',style:container},
    h(Text,{style:{color:colors.brand,fontSize:'12px',fontWeight:'700',letterSpacing:'1px',margin:'0 0 18px'}},'SHILP & SOUL'),
    h(Heading,{as:'h1',style:{fontSize:'26px',fontWeight:'500',lineHeight:'1.25',margin:'0 0 18px'}},title),children,
    h(Hr,{style:{border:`0 solid ${colors.line}`,borderTopWidth:'1px',margin:'26px 0 18px'}}),
    h(Text,{style:{color:colors.muted,fontSize:'13px',lineHeight:'1.5',margin:0}},'Need help? Reply to this email and our team will assist you.')
  )));

const OtpEmail=({code,purpose,expiresMinutes})=>h(Frame,{preview:`Your verification code expires in ${expiresMinutes} minutes.`,title:'Confirm your email address'},
  h(Text,{style:{fontSize:'16px',lineHeight:'1.6'}},purpose==='REGISTRATION'?'Use this code to finish creating your customer account.':'Use this code to confirm email notifications before placing your order.'),
  h(Section,{style:{backgroundColor:colors.paper,border:`1px solid ${colors.line}`,padding:'18px',textAlign:'center'}},
    h(Text,{style:{fontFamily:'Courier New, monospace',fontSize:'30px',fontWeight:'700',letterSpacing:'6px',margin:0}},code)),
  h(Text,{style:{color:colors.muted,fontSize:'14px',lineHeight:'1.5'}},`This code expires in ${expiresMinutes} minutes. If you did not request it, you can ignore this email.`));

const OrderSummaryEmail=({order,items})=>h(Frame,{preview:`Order ${order.order_number} received. Total S$${Number(order.total_amount).toFixed(2)}.`,title:'Your order is confirmed'},
  h(Text,{style:{fontSize:'16px',lineHeight:'1.6'}},`Thank you, ${order.shipping_name}. We received order ${order.order_number}.`),
  h(Heading,{as:'h2',style:{fontSize:'18px',margin:'24px 0 8px'}},'Order summary'),
  ...items.map(item=>h(Section,{key:item.id,style:{borderBottom:`1px solid ${colors.line}`,padding:'10px 0'}},
    h(Text,{style:{fontSize:'14px',margin:0}},`${item.product_name} x ${item.quantity}`),
    h(Text,{style:{color:colors.muted,fontSize:'13px',margin:'4px 0 0'}},`S$${Number(item.subtotal).toFixed(2)}`))),
  h(Text,{style:{fontSize:'17px',fontWeight:'700',textAlign:'right'}},`Total S$${Number(order.total_amount).toFixed(2)}`),
  h(Heading,{as:'h2',style:{fontSize:'18px',margin:'24px 0 8px'}},'Delivery address'),
  h(Text,{style:{fontSize:'14px',lineHeight:'1.6',whiteSpace:'pre-line'}},order.shipping_address));

const sendEmail=async({to,subject,element,text,idempotencyKey,tags})=>{
  const html=await render(element);
  const result=await resendClient().emails.send({from:fromAddress(),to:[to],subject,html,text,tags},{idempotencyKey});
  if(result.error)throw Object.assign(new Error(result.error.message||'Resend rejected the email.'),{statusCode:result.error.statusCode||400});
  return result.data;
};

export const sendOtpEmail=({to,code,purpose,verificationId,expiresMinutes=10})=>sendEmail({
  to,subject:`Your Shilp & Soul verification code`,element:h(OtpEmail,{code,purpose,expiresMinutes}),
  text:`Your Shilp & Soul verification code is ${code}. It expires in ${expiresMinutes} minutes. If you did not request it, ignore this email.`,
  idempotencyKey:`otp/${verificationId}`,tags:[{name:'email_type',value:'otp'}],
});

export async function sendOrderSummary(order,{resend=false}={}){
  const items=order.items||await sql`SELECT * FROM order_items WHERE order_id=${order.id} ORDER BY id`;
  const delivery=(await sql`INSERT INTO notification_deliveries(order_id,notification_type,channel,destination,provider,status,idempotency_key) VALUES(${order.id},'ORDER_SUMMARY','EMAIL',${order.notification_destination},'RESEND','PENDING',${resend?`order-summary/${order.id}/resend/${crypto.randomUUID()}`:`order-summary/${order.id}/created`}) ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=NOW() RETURNING *`)[0];
  try{
    const data=await sendEmail({to:order.notification_destination,subject:`Order ${order.order_number} received`,element:h(OrderSummaryEmail,{order,items}),
      text:[`Order ${order.order_number} received.`,`Thank you, ${order.shipping_name}.`,...items.map(item=>`${item.product_name} x ${item.quantity}: S$${Number(item.subtotal).toFixed(2)}`),`Total: S$${Number(order.total_amount).toFixed(2)}`,`Delivery address: ${order.shipping_address}`].join('\n'),
      idempotencyKey:delivery.idempotency_key,tags:[{name:'email_type',value:'order_summary'},{name:'order_id',value:String(order.id)}]});
    await sql`UPDATE notification_deliveries SET status='ACCEPTED',provider_message_id=${data.id},updated_at=NOW() WHERE id=${delivery.id}`;
    return {status:'ACCEPTED',message_id:data.id};
  }catch(error){
    await sql`UPDATE notification_deliveries SET status='FAILED',error_message=${String(error.message).slice(0,500)},updated_at=NOW() WHERE id=${delivery.id}`;
    return {status:'FAILED'};
  }
}
