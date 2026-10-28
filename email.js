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

export async function getEmailDeliveryStatus(messageId){
  if(!messageId)return{status:'PENDING',provider_event:'queued'};
  const result=await resendClient().emails.get(messageId);
  if(result.error)throw Object.assign(new Error(result.error.message||'Unable to retrieve email delivery status.'),{statusCode:result.error.statusCode||400});
  const providerEvent=String(result.data?.last_event||'queued').toLowerCase();
  const status={delivered:'DELIVERED',opened:'DELIVERED',clicked:'DELIVERED',bounced:'BOUNCED',complained:'COMPLAINED',suppressed:'SUPPRESSED',failed:'FAILED',canceled:'FAILED'}[providerEvent]||'ACCEPTED';
  return{status,provider_event:providerEvent};
}

const Frame=({preview,title,children})=>h(Html,{lang:'en',dir:'ltr'},h(Head),h(Body,{style:base},
  h(Preview,null,preview),h(Container,{lang:'en',dir:'ltr',style:container},
    h(Text,{style:{color:colors.brand,fontSize:'12px',fontWeight:'700',letterSpacing:'1px',margin:'0 0 18px'}},'SHILP & SOUL'),
    h(Heading,{as:'h1',style:{fontSize:'26px',fontWeight:'500',lineHeight:'1.25',margin:'0 0 18px'}},title),children,
    h(Hr,{style:{border:`0 solid ${colors.line}`,borderTopWidth:'1px',margin:'26px 0 18px'}}),
    h(Text,{style:{color:colors.muted,fontSize:'13px',lineHeight:'1.5',margin:0}},'Need help? Reply to this email and our team will assist you.')
  )));

const otpPurposeText=purpose=>({
  REGISTRATION:'Use this code to finish creating your customer account.',
  PASSWORD_RESET:'Use this code to reset your account password.',
  INITIAL_ADMIN:'Use this code to authorize creation of the first Shilp & Soul administrator. If you did not start setup, do not share this code.',
  GUEST_ORDER_ACCESS:'Use this code to securely view your guest order.',
  ACCOUNT_CONTACT_CHANGE:'Use this code to confirm the new email address on your customer account.',
  CHECKOUT:'Use this code to confirm email notifications before placing your order.',
}[purpose]||'Use this code to confirm your email address.');
const otpSubject=purpose=>({PASSWORD_RESET:'Reset your Shilp & Soul password',GUEST_ORDER_ACCESS:'Your Shilp & Soul guest-order code',ACCOUNT_CONTACT_CHANGE:'Confirm your new Shilp & Soul email'}[purpose]||'Your Shilp & Soul verification code');

const OtpEmail=({code,purpose,expiresMinutes})=>h(Frame,{preview:`Your verification code expires in ${expiresMinutes} minutes.`,title:'Confirm your email address'},
  h(Text,{style:{fontSize:'16px',lineHeight:'1.6'}},otpPurposeText(purpose)),
  h(Section,{style:{backgroundColor:colors.paper,border:`1px solid ${colors.line}`,padding:'18px',textAlign:'center'}},
    h(Text,{style:{fontFamily:'Courier New, monospace',fontSize:'30px',fontWeight:'700',letterSpacing:'6px',margin:0}},code)),
  h(Text,{style:{color:colors.muted,fontSize:'14px',lineHeight:'1.5'}},`This code expires in ${expiresMinutes} minutes. If you did not request it, you can ignore this email.`));

const InvitationEmail=({name,invitationUrl,expiresHours})=>h(Frame,{preview:'Complete your Shilp & Soul account setup.',title:'You are invited'},
  h(Text,{style:{fontSize:'16px',lineHeight:'1.6'}},`Hello ${name || 'there'}, an administrator created a Shilp & Soul account for you.`),
  h(Text,{style:{fontSize:'14px',lineHeight:'1.6'}},'Open the secure invitation below to create your password and verify any SMS or WhatsApp contact included with your account.'),
  h(Section,{style:{margin:'24px 0'}},h('a',{href:invitationUrl,style:{backgroundColor:colors.brand,color:'#ffffff',display:'inline-block',padding:'12px 18px',textDecoration:'none'}},'Complete account setup')),
  h(Text,{style:{color:colors.muted,fontSize:'13px',lineHeight:'1.5',wordBreak:'break-all'}},invitationUrl),
  h(Text,{style:{color:colors.muted,fontSize:'13px'}},`This invitation expires in ${expiresHours} hours.`));

const OrderSummaryEmail=({order,items})=>h(Frame,{preview:`Order ${order.order_number} received. Total S$${Number(order.total_amount).toFixed(2)}.`,title:'Your order is confirmed'},
  h(Text,{style:{fontSize:'16px',lineHeight:'1.6'}},`Thank you, ${order.shipping_name}. We received order ${order.order_number}.`),
  h(Heading,{as:'h2',style:{fontSize:'18px',margin:'24px 0 8px'}},'Order summary'),
  ...items.map(item=>h(Section,{key:item.id,style:{borderBottom:`1px solid ${colors.line}`,padding:'10px 0'}},
    h(Text,{style:{fontSize:'14px',margin:0}},`${item.product_name} x ${item.quantity}`),
    h(Text,{style:{color:colors.muted,fontSize:'13px',margin:'4px 0 0'}},`S$${Number(item.subtotal).toFixed(2)}`))),
  h(Text,{style:{fontSize:'17px',fontWeight:'700',textAlign:'right'}},`Total S$${Number(order.total_amount).toFixed(2)}`),
  h(Heading,{as:'h2',style:{fontSize:'18px',margin:'24px 0 8px'}},'Delivery address'),
  h(Text,{style:{fontSize:'14px',lineHeight:'1.6',whiteSpace:'pre-line'}},order.shipping_address));

const AdminOrderAlertEmail=({admin,order,items})=>h(Frame,{preview:`Paid order ${order.order_number} requires fulfilment.`,title:'A paid order is ready to process'},
  h(Text,{style:{fontSize:'16px',lineHeight:'1.6'}},`Hello ${admin.first_name || 'Admin'}, order ${order.order_number} has been paid and requires attention.`),
  h(Section,{style:{backgroundColor:colors.paper,border:`1px solid ${colors.line}`,padding:'16px'}},
    h(Text,{style:{fontSize:'14px',margin:'0 0 6px'}},`Customer type: ${order.user_id ? 'Registered customer' : 'Guest checkout'}`),
    h(Text,{style:{fontSize:'14px',margin:'0 0 6px'}},`Name: ${order.shipping_name}`),
    h(Text,{style:{fontSize:'14px',margin:'0 0 6px'}},`Email: ${order.contact_email || 'Not supplied'}`),
    h(Text,{style:{fontSize:'14px',margin:'0 0 6px'}},`Phone: ${order.shipping_phone || order.contact_phone || 'Not supplied'}`),
    h(Text,{style:{fontSize:'14px',margin:'0 0 6px'}},`Payment: ${order.payment_method} / ${order.payment_status}`),
    h(Text,{style:{fontSize:'14px',margin:0}},`Order status: ${order.status}`)),
  h(Heading,{as:'h2',style:{fontSize:'18px',margin:'24px 0 8px'}},'Items'),
  ...items.map(item=>h(Section,{key:item.id,style:{borderBottom:`1px solid ${colors.line}`,padding:'10px 0'}},
    h(Text,{style:{fontSize:'14px',fontWeight:'700',margin:0}},item.product_name),
    h(Text,{style:{color:colors.muted,fontSize:'13px',margin:'4px 0 0'}},[
      item.color&&`Colour: ${item.color}`,item.size&&`Size: ${item.size}`,`Quantity: ${item.quantity}`,
      `Unit: S$${Number(item.unit_price).toFixed(2)}`,`Subtotal: S$${Number(item.subtotal).toFixed(2)}`,
    ].filter(Boolean).join(' · ')))),
  h(Text,{style:{fontSize:'17px',fontWeight:'700',textAlign:'right'}},`Order total S$${Number(order.total_amount).toFixed(2)}`),
  h(Heading,{as:'h2',style:{fontSize:'18px',margin:'24px 0 8px'}},'Delivery address'),
  h(Text,{style:{fontSize:'14px',lineHeight:'1.6',whiteSpace:'pre-line'}},order.shipping_address));

const ContactEmail=({name,email,subject,message})=>h(Frame,{preview:`New customer enquiry: ${subject}`,title:'New contact form message'},
  h(Text,{style:{fontSize:'14px',lineHeight:'1.6'}},`From: ${name || 'Storefront visitor'} (${email})`),
  h(Heading,{as:'h2',style:{fontSize:'18px',margin:'24px 0 8px'}},subject),
  h(Text,{style:{fontSize:'14px',lineHeight:'1.7',whiteSpace:'pre-wrap'}},message));

const MarketingWelcomeEmail=()=>h(Frame,{preview:'You are registered for regular news from Shilp & Soul.',title:'Welcome to Notes from the studio'},
  h(Text,{style:{fontSize:'16px',lineHeight:'1.6'}},'You are registered for the Shilp & Soul newsletter.'),
  h(Text,{style:{color:colors.muted,fontSize:'14px',lineHeight:'1.7'}},'You will receive regular updates about new collections, craft stories, artisan work and quiet inspiration from our studio.'));

const sendEmail=async({to,subject,element,text,idempotencyKey,tags,replyTo})=>{
  const html=await render(element);
  const result=await resendClient().emails.send({from:fromAddress(),to:[to],subject,html,text,tags,replyTo},{idempotencyKey});
  if(result.error)throw Object.assign(new Error(result.error.message||'Resend rejected the email.'),{statusCode:result.error.statusCode||400});
  return result.data;
};

export const sendContactMessage=({name,email,subject,message,requestId})=>sendEmail({
  to:process.env.CONTACT_EMAIL_TO||'shilpsoul26@gmail.com',
  subject:`Storefront enquiry: ${subject}`,
  element:h(ContactEmail,{name,email,subject,message}),
  text:[`From: ${name || 'Storefront visitor'} <${email}>`,`Subject: ${subject}`,'',message].join('\n'),
  idempotencyKey:`contact/${requestId}`,
  tags:[{name:'email_type',value:'contact'}],
  replyTo:email,
});

export const sendMarketingWelcomeEmail=({to,subscriptionId,requestId})=>sendEmail({
  to,
  subject:'Welcome to the Shilp & Soul newsletter',
  element:h(MarketingWelcomeEmail),
  text:'You are registered for the Shilp & Soul newsletter. You will receive regular updates about new collections, craft stories, artisan work and quiet inspiration from our studio.',
  idempotencyKey:`marketing-welcome/${subscriptionId}/${requestId}`,
  tags:[{name:'email_type',value:'marketing_welcome'}],
});

export const sendOtpEmail=({to,code,purpose,verificationId,expiresMinutes=10})=>sendEmail({
  to,subject:otpSubject(purpose),element:h(OtpEmail,{code,purpose,expiresMinutes}),
  text:`${otpPurposeText(purpose)} Your code is ${code}. It expires in ${expiresMinutes} minutes. If you did not request it, ignore this email.`,
  idempotencyKey:`otp/${verificationId}`,tags:[{name:'email_type',value:'otp'}],
});

export const sendInvitationEmail=({to,name,invitationUrl,invitationId,expiresHours=48})=>sendEmail({
  to,
  subject:'Complete your Shilp & Soul account setup',
  element:h(InvitationEmail,{name,invitationUrl,expiresHours}),
  text:`Hello ${name || 'there'}, complete your Shilp & Soul account setup: ${invitationUrl}. This invitation expires in ${expiresHours} hours.`,
  idempotencyKey:`user-invitation/${invitationId}`,
  tags:[{name:'email_type',value:'user_invitation'}],
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
    await sql`UPDATE notification_deliveries SET status='FAILED',error_message='Provider delivery failed',updated_at=NOW() WHERE id=${delivery.id}`;
    return {status:'FAILED'};
  }
}

export async function sendPaidOrderAdminAlerts(orderId){
  const order=(await sql`SELECT * FROM orders WHERE id=${orderId} AND payment_status='PAID'`)[0];
  if(!order)return{};
  const [items,admins]=await Promise.all([
    sql`SELECT * FROM order_items WHERE order_id=${orderId} ORDER BY id`,
    sql`SELECT id,first_name,last_name,email FROM users WHERE UPPER(role)='ADMIN' AND is_active=TRUE AND email IS NOT NULL ORDER BY id`,
  ]);
  if(!admins.length){console.warn('Paid order has no active administrator email recipient',{orderId});return{}}
  const results={};
  for(const admin of admins){
    const idempotencyKey=`admin-order-alert/${order.id}/${admin.id}`;
    const delivery=(await sql`INSERT INTO notification_deliveries(order_id,notification_type,channel,destination,provider,status,idempotency_key) VALUES(${order.id},'ADMIN_ORDER_ALERT','EMAIL',${admin.email},'RESEND','PENDING',${idempotencyKey}) ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=NOW() RETURNING *`)[0];
    if(['ACCEPTED','DELIVERED'].includes(delivery.status)){results[admin.id]={status:delivery.status};continue}
    try{
      const details=[
        `Paid order ${order.order_number} requires fulfilment.`,
        `Customer type: ${order.user_id?'Registered customer':'Guest checkout'}`,
        `Name: ${order.shipping_name}`,
        `Email: ${order.contact_email||'Not supplied'}`,
        `Phone: ${order.shipping_phone||order.contact_phone||'Not supplied'}`,
        `Payment: ${order.payment_method} / ${order.payment_status}`,
        `Order status: ${order.status}`,'',
        ...items.map(item=>[item.product_name,item.color&&`Colour ${item.color}`,item.size&&`Size ${item.size}`,`Quantity ${item.quantity}`,`Unit S$${Number(item.unit_price).toFixed(2)}`,`Subtotal S$${Number(item.subtotal).toFixed(2)}`].filter(Boolean).join(' · ')),
        '',`Total: S$${Number(order.total_amount).toFixed(2)}`,`Delivery address: ${order.shipping_address}`,
      ];
      const data=await sendEmail({to:admin.email,subject:`Paid order ${order.order_number} – action required`,element:h(AdminOrderAlertEmail,{admin,order,items}),text:details.join('\n'),idempotencyKey,tags:[{name:'email_type',value:'admin_order_alert'},{name:'order_id',value:String(order.id)}]});
      await sql`UPDATE notification_deliveries SET status='ACCEPTED',provider_message_id=${data.id},error_message=NULL,updated_at=NOW() WHERE id=${delivery.id}`;
      results[admin.id]={status:'ACCEPTED',message_id:data.id};
    }catch(error){
      console.error('Paid order administrator alert failed',{orderId:order.id,adminId:admin.id,error:error.message});
      await sql`UPDATE notification_deliveries SET status='FAILED',error_message='Provider delivery failed',updated_at=NOW() WHERE id=${delivery.id}`;
      results[admin.id]={status:'FAILED'};
    }
  }
  return results;
}
