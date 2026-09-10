import {Router} from 'express';
import crypto from 'node:crypto';
import sql from './db.js';
import {authenticate,admin,isAdmin,orderAccessTokenFor,verifyNotificationToken,verifyOrderAccessToken} from './auth.js';
import {getEmailDeliveryStatus,sendOrderSummary} from './email.js';
import {normalizeWhatsAppNumber,sendOrderSummaryWhatsApp} from './whatsapp.js';
import {sendOrderSummarySms} from './sms.js';
import {notFound} from './utils.js';
import {notificationChannels,resolveNotificationChannel,returnDeadlineOpen,verificationMatches} from './checkoutPolicy.js';

const router=Router();

const contactBelongsToCustomer=async(email,phone,whatsapp)=>{
  if(email&&(await sql`SELECT id FROM users WHERE LOWER(email)=${email} LIMIT 1`)[0])return true;
  if(phone&&(await sql`SELECT id FROM users WHERE phone=${phone} LIMIT 1`)[0])return true;
  return Boolean(whatsapp&&(await sql`SELECT id FROM users WHERE whatsapp_number=${whatsapp} LIMIT 1`)[0]);
};

export const sendNotificationSummary=async(order,{resend=false}={})=>{
  if(order.notification_channel==='EMAIL')return sendOrderSummary(order,{resend});
  const items=order.items||await sql`SELECT * FROM order_items WHERE order_id=${order.id} ORDER BY id`;
  const idempotencyKey=resend?`order-summary/${order.id}/resend/${crypto.randomUUID()}`:`order-summary/${order.id}/created`;
  const provider=order.notification_channel==='SMS'?'TWILIO':'META_WHATSAPP';
  const delivery=(await sql`INSERT INTO notification_deliveries(order_id,notification_type,channel,destination,provider,status,idempotency_key) VALUES(${order.id},'ORDER_SUMMARY',${order.notification_channel},${order.notification_destination},${provider},'PENDING',${idempotencyKey}) ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=NOW() RETURNING *`)[0];
  try{
    const result=order.notification_channel==='SMS'?await sendOrderSummarySms({order,items}):await sendOrderSummaryWhatsApp({order,items});
    await sql`UPDATE notification_deliveries SET status='ACCEPTED',provider_message_id=${result.id},updated_at=NOW() WHERE id=${delivery.id}`;
    return{status:'ACCEPTED',message_id:result.id};
  }catch(error){
    console.error('Order notification failed',{orderId:order.id,channel:order.notification_channel,error:error.message,providerCode:error.providerCode,statusCode:error.statusCode});
    await sql`UPDATE notification_deliveries SET status='FAILED',error_message=${String(error.message).slice(0,500)},updated_at=NOW() WHERE id=${delivery.id}`;
    return{status:'FAILED'};
  }
};

const verifiedNotification=async(req,user)=>{
  const requestedChannel=String(req.body.notification_channel||user?.preferred_notification_channel||'').toUpperCase();
  const email=String(req.body.contact_email||user?.email||'').trim().toLowerCase();
  const channel=resolveNotificationChannel({customer:Boolean(user),email,requestedChannel,preferredChannel:user?.preferred_notification_channel});
  const destination=channel==='EMAIL'?email:channel==='WHATSAPP'?normalizeWhatsAppNumber(req.body.notification_destination||req.body.contact_whatsapp||user?.whatsapp_number):normalizeWhatsAppNumber(req.body.notification_destination||req.body.contact_phone||user?.phone);
  if(!notificationChannels.includes(channel)||!destination)throw Object.assign(new Error('Select and confirm an email, SMS, or WhatsApp notification channel.'),{status:400});
  if(user){
    const expected=channel==='EMAIL'?String(user.email).toLowerCase():channel==='WHATSAPP'?normalizeWhatsAppNumber(user.whatsapp_number):normalizeWhatsAppNumber(user.phone);
    const verified=channel==='EMAIL'?user.email_verified_at:channel==='SMS'?user.phone_verified_at:user.whatsapp_verified_at;
    if(destination!==expected)throw Object.assign(new Error('Use the selected contact stored on your customer account.'),{status:403});
    if(verified)return{channel,destination};
  }
  let claims;
  try{claims=verifyNotificationToken(req.body.notification_verification_token)}catch{throw Object.assign(new Error('Verify the selected notification destination before placing the order.'),{status:403})}
  if(!verificationMatches({claims,channel,destination}))throw Object.assign(new Error('The verification must match the selected channel and destination.'),{status:403});
  const challenge=(await sql`SELECT id FROM notification_verifications WHERE id=${claims.verification_id} AND channel=${channel} AND destination=${destination} AND purpose='CHECKOUT' AND verified_at IS NOT NULL AND (${user?.id||null}::bigint IS NULL OR user_id=${user?.id||null})`)[0];
  if(!challenge)throw Object.assign(new Error('Notification verification is incomplete.'),{status:403});
  return{channel,destination};
};

const createOrder=async(req,res,user=null)=>{
  const {shipping_name,shipping_phone,shipping_address}=req.body;
  const items=req.body.items;
  const paymentMethod=String(req.body.payment_method||'CASH').toUpperCase();
  if(!['CASH','STRIPE'].includes(paymentMethod))return res.status(400).json({error:'Payment method must be CASH or STRIPE.'});
  if(!shipping_name||!shipping_address||!Array.isArray(items)||!items.length)return res.status(400).json({error:'Shipping name, address, and items are required.'});
  let notification;
  try{notification=await verifiedNotification(req,user)}catch(error){return res.status(error.status||400).json({error:error.message})}
  const contactEmail=String(req.body.contact_email||user?.email||'').trim().toLowerCase()||(notification.channel==='EMAIL'?notification.destination:null);
  const contactPhone=normalizeWhatsAppNumber(req.body.contact_phone||user?.phone||shipping_phone)||(notification.channel==='SMS'?notification.destination:null);
  const contactWhatsapp=normalizeWhatsAppNumber(req.body.contact_whatsapp||user?.whatsapp_number)||(notification.channel==='WHATSAPP'?notification.destination:null);
  const deliveryPhone=normalizeWhatsAppNumber(shipping_phone)||contactPhone||null;
  if(!user&&await contactBelongsToCustomer(contactEmail,contactPhone,contactWhatsapp))return res.status(409).json({error:'This contact belongs to a customer account. Log in before checking out.',code:'CUSTOMER_LOGIN_REQUIRED'});
  const returnWindowDays=user?Number(user.return_window_days):2;
  const requested=new Map();
  let total=0;
  for(const item of items){
    const product=(await sql`SELECT p.*,pc.id product_color_id,pc.color,pc.quantity color_quantity,EXISTS(SELECT 1 FROM product_color x WHERE x.product_id=p.id) has_colors FROM products p LEFT JOIN product_color pc ON pc.product_id=p.id AND pc.id=${item.product_color_id} WHERE p.id=${item.product_id} AND p.is_active=true`)[0];
    const quantity=Number(item.quantity);
    if(!product||!Number.isInteger(quantity)||quantity<1)return res.status(409).json({error:'Product or quantity is invalid.'});
    if(product.has_colors&&!product.product_color_id)return res.status(409).json({error:`Select an available color for ${product.name}.`});
    if(!product.has_colors&&item.product_color_id!=null)return res.status(409).json({error:`${product.name} does not have a color option.`});
    const available=Number(product.has_colors?product.color_quantity:product.stock_quantity);
    if(quantity>available)return res.status(409).json({error:`Insufficient stock for ${product.name}${product.color?` (${product.color})`:''}.`});
    const key=product.product_color_id?`color:${product.product_color_id}`:`product:${product.id}`,existing=requested.get(key);
    requested.set(key,{product_id:product.id,product_color_id:product.product_color_id||null,quantity:(existing?.quantity||0)+quantity,product_name:product.name,color:product.color||null,unit_price:Number(product.price)});
  }
  const prepared=[...requested.values()];
  total=prepared.reduce((sum,item)=>sum+item.unit_price*item.quantity,0);
  const number=`ORD-${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
  const payload=JSON.stringify(prepared);
  const created=await sql.query(`
    WITH requested AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(product_id bigint,product_color_id bigint,quantity integer,product_name text,color text,unit_price numeric)
    ), locked_colors AS MATERIALIZED (
      SELECT pc.id,pc.product_id,pc.quantity available,r.quantity requested_quantity
      FROM product_color pc JOIN requested r ON r.product_color_id=pc.id AND r.product_id=pc.product_id
      ORDER BY pc.id FOR UPDATE OF pc
    ), locked_products AS MATERIALIZED (
      SELECT p.id,p.stock_quantity available,r.quantity requested_quantity
      FROM products p JOIN requested r ON r.product_id=p.id AND r.product_color_id IS NULL
      ORDER BY p.id FOR UPDATE OF p
    ), inventory AS MATERIALIZED (
      SELECT available,requested_quantity FROM locked_colors
      UNION ALL
      SELECT available,requested_quantity FROM locked_products
    ), eligible AS MATERIALIZED (
      SELECT COUNT(*)=(SELECT COUNT(*) FROM requested) AND COALESCE(BOOL_AND(available>=requested_quantity),false) ok FROM inventory
    ), reduced_colors AS (
      UPDATE product_color pc SET quantity=pc.quantity-r.quantity,updated_at=NOW()
      FROM requested r,eligible e WHERE e.ok AND r.product_color_id IS NOT NULL AND pc.id=r.product_color_id RETURNING pc.id
    ), reduced_products AS (
      UPDATE products p SET stock_quantity=p.stock_quantity-r.quantity,updated_at=NOW()
      FROM requested r,eligible e WHERE e.ok AND r.product_color_id IS NULL AND p.id=r.product_id RETURNING p.id
    ), new_order AS (
      INSERT INTO orders(user_id,order_number,status,shipping_name,shipping_phone,shipping_address,total_amount,contact_email,contact_phone,contact_whatsapp,payment_method,payment_status,notification_channel,notification_destination,return_window_days)
      SELECT $2,$3,'PENDING',$4,$5,$6,$7,$8,$9,$15,$10,'UNPAID',$11,$12,$14 FROM eligible WHERE ok AND (SELECT COUNT(*) FROM reduced_colors)+(SELECT COUNT(*) FROM reduced_products)=(SELECT COUNT(*) FROM requested)
      RETURNING *
    ), new_items AS (
      INSERT INTO order_items(order_id,product_id,product_color_id,color,product_name,quantity,unit_price,subtotal)
      SELECT o.id,r.product_id,r.product_color_id,r.color,r.product_name,r.quantity,r.unit_price,r.quantity*r.unit_price FROM new_order o CROSS JOIN requested r RETURNING id
    ), new_event AS (
      INSERT INTO order_events(order_id,event_type,to_status,to_payment_status,actor_type,actor_id)
      SELECT id,'ORDER_CREATED','PENDING','UNPAID',$13,$2 FROM new_order RETURNING id
    ) SELECT * FROM new_order WHERE (SELECT COUNT(*) FROM new_items)>0 AND (SELECT COUNT(*) FROM new_event)>0
  `,[payload,user?.id||null,number,shipping_name,deliveryPhone,shipping_address,total.toFixed(2),contactEmail,contactPhone,paymentMethod,notification.channel,notification.destination,user?'CUSTOMER':'GUEST',returnWindowDays,contactWhatsapp]);
  const order=created[0];
  if(!order)return res.status(409).json({error:'Insufficient stock for one or more selected products.'});
  order.items=await sql`SELECT * FROM order_items WHERE order_id=${order.id}`;
  order.notification=paymentMethod==='STRIPE'?{status:'PENDING_PAYMENT'}:await sendNotificationSummary(order);
  if(!user)order.order_access_token=orderAccessTokenFor(order);
  return res.status(201).json(order);
};

const resendOrderSummary=async(res,order)=>{
  const recent=await sql`SELECT created_at FROM notification_deliveries WHERE order_id=${order.id} AND notification_type='ORDER_SUMMARY' AND created_at>NOW()-INTERVAL '1 hour' ORDER BY created_at DESC`;
  if(recent.length>=3)return res.status(429).json({error:'Order summary resend limit reached. Try again in one hour.'});
  if(recent[0]&&Date.now()-new Date(recent[0].created_at).getTime()<60000)return res.status(429).json({error:'Please wait before resending the order summary.'});
  order.items=await sql`SELECT * FROM order_items WHERE order_id=${order.id}`;
  const notification=await sendNotificationSummary(order,{resend:true});
  return notification.status==='ACCEPTED'?res.json(notification):res.status(503).json({error:'The order summary could not be sent. Please try again.'});
};

const orderNotificationStatus=async(res,order)=>{
  const delivery=(await sql`SELECT * FROM notification_deliveries WHERE order_id=${order.id} AND notification_type='ORDER_SUMMARY' AND channel=${order.notification_channel} ORDER BY created_at DESC LIMIT 1`)[0];
  if(!delivery)return res.status(404).json({error:'No order notification has been requested yet.'});
  let status=delivery.status,providerEvent=null,errorMessage=delivery.error_message||null;
  if(delivery.provider==='RESEND'&&delivery.provider_message_id&&['PENDING','ACCEPTED'].includes(status)){
    try{
      const current=await getEmailDeliveryStatus(delivery.provider_message_id);
      status=current.status;providerEvent=current.provider_event;
      await sql`UPDATE notification_deliveries SET status=${status},updated_at=NOW() WHERE id=${delivery.id}`;
    }catch(error){
      console.error('Email delivery status check failed',{orderId:order.id,deliveryId:delivery.id,error:error.message});
      errorMessage='Delivery status is temporarily unavailable.';
    }
  }
  return res.json({channel:delivery.channel,status,provider_event:providerEvent,error:errorMessage});
};

const createActionRequest=async(req,res,order,requestedByType)=>{
  const actionType=String(req.body.action_type||'').toUpperCase();
  const reason=String(req.body.reason||'').trim().slice(0,1000)||null;
  if(!['CANCEL','RETURN'].includes(actionType))return res.status(400).json({error:'Action type must be CANCEL or RETURN.'});
  if(actionType==='CANCEL'&&!['PENDING','CONFIRMED','PROCESSING'].includes(order.status))return res.status(409).json({error:'This order can no longer be cancelled.'});
  let orderItemId=null,quantity=null;
  if(actionType==='RETURN'){
    if(!['DELIVERED','RETURNED'].includes(order.status)||!order.delivered_at)return res.status(409).json({error:'Only delivered orders can be returned.'});
    if(!returnDeadlineOpen({deliveredAt:order.delivered_at,windowDays:order.return_window_days||2}))return res.status(409).json({error:`The ${order.return_window_days||2}-day return window has closed.`});
    orderItemId=String(req.body.order_item_id||'');quantity=Number(req.body.quantity);
    const item=/^\d+$/.test(orderItemId)?(await sql`SELECT id,quantity FROM order_items WHERE id=${orderItemId} AND order_id=${order.id}`)[0]:null;
    if(!item||!Number.isInteger(quantity)||quantity<1)return res.status(400).json({error:'Select a valid order item and return quantity.'});
    const committed=(await sql`SELECT COALESCE(SUM(quantity),0)::int quantity FROM order_action_requests WHERE order_item_id=${item.id} AND action_type='RETURN' AND status IN ('REVIEW','APPROVED')`)[0];
    if(quantity+Number(committed.quantity)>Number(item.quantity))return res.status(409).json({error:'The requested return quantity exceeds the quantity eligible for return.'});
  }
  try{
    const created=(await sql`WITH request AS (
      INSERT INTO order_action_requests(order_id,order_item_id,action_type,original_order_status,quantity,reason,requested_by_type,requested_by_id)
      VALUES(${order.id},${orderItemId},${actionType},${order.status},${quantity},${reason},${requestedByType},${req.user?.id||null}) RETURNING *
    ), changed AS (
      UPDATE orders SET status=${actionType==='RETURN'?'RETURN_REVIEW':'CANCEL_REVIEW'},updated_at=NOW() WHERE id=${order.id} RETURNING id
    ) SELECT request.* FROM request,changed`)[0];
    await sql`INSERT INTO order_events(order_id,event_type,from_status,to_status,actor_type,actor_id,metadata) VALUES(${order.id},${actionType+'_REQUESTED'},${order.status},${actionType==='RETURN'?'RETURN_REVIEW':'CANCEL_REVIEW'},${requestedByType},${req.user?.id||null},jsonb_build_object('request_id',${created.id}::bigint))`;
    return res.status(201).json(created);
  }catch(error){
    if(error.code==='23505')return res.status(409).json({error:'This order already has a matching request under review.'});
    throw error;
  }
};

const guestOrderForAction=async(req)=>{
  let access;try{access=verifyOrderAccessToken(req.get('x-order-access-token'))}catch{return null}
  const order=(await sql`SELECT * FROM orders WHERE id=${req.params.id} AND user_id IS NULL`)[0];
  return order&&access.type==='guest-order'&&String(access.sub)===String(order.id)&&access.destination===order.notification_destination?order:null;
};

router.post('/orders/guest',(req,res)=>createOrder(req,res));
router.post('/orders/:id/guest-actions',async(req,res)=>{
  const order=await guestOrderForAction(req);
  return order?createActionRequest(req,res,order,'GUEST'):notFound(res,'Order');
});
router.post('/orders/track',async(req,res)=>{
  const orderNumber=String(req.body.orderNumber||req.body.order_number||'').trim();
  const channel=String(req.body.channel||'EMAIL').toUpperCase();
  const destination=channel==='EMAIL'?String(req.body.destination||req.body.email||'').trim().toLowerCase():normalizeWhatsAppNumber(req.body.destination||req.body.phone);
  if(!['EMAIL','WHATSAPP','SMS'].includes(channel)||!destination)return res.status(400).json({error:'Enter the email address or phone number used for order notifications.'});
  const order=(await sql`SELECT * FROM orders WHERE order_number=${orderNumber} AND user_id IS NULL AND ((${channel}='EMAIL' AND LOWER(contact_email)=${destination}) OR (${channel}='SMS' AND contact_phone=${destination}) OR (${channel}='WHATSAPP' AND contact_whatsapp=${destination}))`)[0];
  if(!order)return res.status(404).json({error:'Guest order not found.'});
  order.items=await sql`SELECT * FROM order_items WHERE order_id=${order.id}`;
  order.order_access_token=orderAccessTokenFor(order);
  return res.json(order);
});
router.post('/orders/:id/guest-notifications/resend',async(req,res)=>{
  let access;
  try{access=verifyOrderAccessToken(req.get('x-order-access-token'))}catch{return res.status(403).json({error:'Guest order access has expired.'})}
  const order=(await sql`SELECT * FROM orders WHERE id=${req.params.id} AND user_id IS NULL`)[0];
  if(!order||access.type!=='guest-order'||String(access.sub)!==String(order.id)||access.destination!==order.notification_destination)return notFound(res,'Order');
  return resendOrderSummary(res,order);
});
router.get('/orders/:id/guest-notifications/status',async(req,res)=>{
  let access;
  try{access=verifyOrderAccessToken(req.get('x-order-access-token'))}catch{return res.status(403).json({error:'Guest order access has expired.'})}
  const order=(await sql`SELECT * FROM orders WHERE id=${req.params.id} AND user_id IS NULL`)[0];
  if(!order||access.type!=='guest-order'||String(access.sub)!==String(order.id)||access.destination!==order.notification_destination)return notFound(res,'Order');
  return orderNotificationStatus(res,order);
});

router.use('/orders',authenticate);
router.post('/orders',(req,res)=>createOrder(req,res,req.user));
router.post('/orders/:id/actions',async(req,res)=>{
  const order=(await sql`SELECT * FROM orders WHERE id=${req.params.id} AND user_id=${req.user.id}`)[0];
  return order?createActionRequest(req,res,order,'CUSTOMER'):notFound(res,'Order');
});
router.get('/orders/action-requests/review',admin,async(req,res)=>{
  const rows=await sql`SELECT ar.*,o.order_number,o.status order_status,oi.product_name,oi.color,oi.quantity ordered_quantity
    FROM order_action_requests ar JOIN orders o ON o.id=ar.order_id LEFT JOIN order_items oi ON oi.id=ar.order_item_id
    WHERE ar.status='REVIEW' ORDER BY ar.requested_at`;
  res.set('X-Total-Count',rows.length);return res.json(rows);
});
router.post('/orders/action-requests/:requestId/decision',admin,async(req,res)=>{
  const decision=String(req.body.decision||'').toUpperCase(),note=String(req.body.note||'').trim().slice(0,1000)||null;
  if(!['APPROVED','REJECTED'].includes(decision))return res.status(400).json({error:'Decision must be APPROVED or REJECTED.'});
  const request=(await sql`SELECT ar.*,o.status order_status FROM order_action_requests ar JOIN orders o ON o.id=ar.order_id WHERE ar.id=${req.params.requestId}`)[0];
  if(!request)return notFound(res,'Action request');
  if(request.status!=='REVIEW')return res.status(409).json({error:'This request has already been decided.'});
  const finalStatus=decision==='APPROVED'?(request.action_type==='CANCEL'?'CANCELLED':'RETURNED'):request.original_order_status;
  const rows=await sql.query(`
    WITH decided AS (
      UPDATE order_action_requests SET status=$1,decided_by=$2,decided_at=NOW(),decision_note=$3,updated_at=NOW()
      WHERE id=$4 AND status='REVIEW' RETURNING *
    ), changed AS (
      UPDATE orders SET status=$5,updated_at=NOW() FROM decided WHERE orders.id=decided.order_id RETURNING orders.id
    ), restore_rows AS (
      SELECT oi.product_id,oi.product_color_id,SUM(CASE WHEN d.action_type='CANCEL' THEN oi.quantity ELSE d.quantity END)::integer quantity
      FROM decided d JOIN order_items oi ON oi.order_id=d.order_id
      WHERE $1='APPROVED' AND (d.action_type='CANCEL' OR oi.id=d.order_item_id)
      GROUP BY oi.product_id,oi.product_color_id
    ), restore_colors AS (
      UPDATE product_color pc SET quantity=pc.quantity+r.quantity,updated_at=NOW()
      FROM restore_rows r WHERE r.product_color_id IS NOT NULL AND pc.id=r.product_color_id RETURNING pc.id
    ), restore_products AS (
      UPDATE products p SET stock_quantity=p.stock_quantity+r.quantity,updated_at=NOW()
      FROM restore_rows r WHERE r.product_color_id IS NULL AND p.id=r.product_id RETURNING p.id
    )
    SELECT d.* FROM decided d,changed
  `,[decision,req.user.id,note,request.id,finalStatus]);
  if(!rows[0])return res.status(409).json({error:'This request was decided by another administrator.'});
  await sql`INSERT INTO order_events(order_id,event_type,from_status,to_status,actor_type,actor_id,metadata) VALUES(${request.order_id},${request.action_type+'_'+decision},${request.order_status},${finalStatus},'ADMIN',${req.user.id},jsonb_build_object('request_id',${request.id}::bigint))`;
  return res.json(rows[0]);
});

router.get('/orders/:id/notifications/status',async(req,res)=>{
  const order=(await sql`SELECT * FROM orders WHERE id=${req.params.id} AND user_id=${req.user.id}`)[0];
  if(!order)return notFound(res,'Order');
  const channel=String(req.query.channel||order.notification_channel).toUpperCase();
  const destination=channel==='EMAIL'?order.contact_email:channel==='WHATSAPP'?order.contact_whatsapp:order.contact_phone;
  if(!['EMAIL','SMS','WHATSAPP'].includes(channel)||!destination)return res.status(400).json({error:'This notification channel is not available for the order.'});
  return orderNotificationStatus(res,{...order,notification_channel:channel});
});

router.get('/orders',async(req,res)=>{const rows=isAdmin(req.user)?await sql`SELECT * FROM orders ORDER BY id DESC`:await sql`SELECT * FROM orders WHERE user_id=${req.user.id} AND customer_hidden_at IS NULL ORDER BY id DESC`;res.set('X-Total-Count',rows.length);return res.json(rows)});
router.get('/orders/:id',async(req,res)=>{const order=(await sql`SELECT * FROM orders WHERE id=${req.params.id}`)[0];if(!order||!isAdmin(req.user)&&(String(order.user_id)!==String(req.user.id)||order.customer_hidden_at))return notFound(res,'Order');order.items=await sql`SELECT * FROM order_items WHERE order_id=${order.id}`;return res.json(order)});
router.put('/orders/:id',admin,async(req,res)=>{
  const status=String(req.body.status||'').toUpperCase();
  if(!['PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED'].includes(status))return res.status(400).json({error:'Cancellation and return statuses require the review workflow.'});

  const current=(await sql`SELECT * FROM orders WHERE id=${req.params.id}`)[0];
  if(!current)return notFound(res,'Order');
  if(['CANCEL_REVIEW','RETURN_REVIEW'].includes(current.status))return res.status(409).json({error:'Decide the open cancellation or return request before changing this order.'});
  if(current.status==='CANCELLED'){
    if(status==='CANCELLED')return res.json(current);
    return res.status(409).json({error:'Cancelled orders cannot be reopened.'});
  }
  if(current.status===status)return res.json(current);

  if(status==='CANCELLED'){
    const rows=await sql`
      WITH cancelled_order AS (
        UPDATE orders
        SET status='CANCELLED',updated_at=NOW()
        WHERE id=${req.params.id} AND status<>'CANCELLED'
        RETURNING *
      ), item_quantities AS (
        SELECT oi.product_color_id,SUM(oi.quantity)::integer AS quantity
        FROM order_items oi
        JOIN cancelled_order co ON co.id=oi.order_id
        WHERE oi.product_color_id IS NOT NULL
        GROUP BY oi.product_color_id
      ), restored_colors AS (
        UPDATE product_color p
        SET quantity=p.quantity+iq.quantity,updated_at=NOW()
        FROM item_quantities iq
        WHERE p.id=iq.product_color_id
        RETURNING p.id
      ), legacy_quantities AS (
        SELECT oi.product_id,SUM(oi.quantity)::integer quantity FROM order_items oi JOIN cancelled_order co ON co.id=oi.order_id
        WHERE oi.product_color_id IS NULL GROUP BY oi.product_id
      ), restored_legacy_products AS (
        UPDATE products p SET stock_quantity=p.stock_quantity+lq.quantity,updated_at=NOW() FROM legacy_quantities lq WHERE p.id=lq.product_id RETURNING p.id
      )
      INSERT INTO order_events(order_id,event_type,from_status,to_status,actor_type,actor_id)
      SELECT id,'STATUS_CHANGED',${current.status},'CANCELLED','ADMIN',${req.user.id} FROM cancelled_order
      RETURNING (SELECT row_to_json(co) FROM cancelled_order co) AS order
    `;
    if(rows[0]?.order)return res.json(rows[0].order);

    const latest=(await sql`SELECT * FROM orders WHERE id=${req.params.id}`)[0];
    return latest?res.json(latest):notFound(res,'Order');
  }

  const rows=await sql`WITH changed AS (UPDATE orders SET status=${status},delivered_at=CASE WHEN ${status}='DELIVERED' THEN COALESCE(delivered_at,NOW()) ELSE delivered_at END,updated_at=NOW() WHERE id=${req.params.id} AND status NOT IN ('CANCELLED','RETURNED') RETURNING *) INSERT INTO order_events(order_id,event_type,from_status,to_status,actor_type,actor_id) SELECT id,'STATUS_CHANGED',${current.status},${status},'ADMIN',${req.user.id} FROM changed RETURNING (SELECT row_to_json(c) FROM changed c) AS order`;
  if(rows[0]?.order)return res.json(rows[0].order);
  return res.status(409).json({error:'Cancelled orders cannot be reopened.'});
});
router.delete('/orders/:id',async(req,res)=>{
  const rows=await sql`
    WITH hidden AS (
      UPDATE orders SET customer_hidden_at=NOW(),updated_at=NOW()
      WHERE id=${req.params.id} AND user_id=${req.user.id} AND customer_hidden_at IS NULL
        AND (payment_status='PAID' OR status IN ('CANCELLED','RETURNED'))
      RETURNING id
    )
    INSERT INTO order_events(order_id,event_type,actor_type,actor_id)
    SELECT id,'HIDDEN_BY_CUSTOMER','CUSTOMER',${req.user.id} FROM hidden
    RETURNING order_id
  `;
  if(rows[0])return res.status(204).end();
  const order=(await sql`SELECT id FROM orders WHERE id=${req.params.id} AND user_id=${req.user.id}`)[0];
  return order?res.status(409).json({error:'Only paid, cancelled, or returned orders can be removed from order history.'}):notFound(res,'Order');
});
router.get('/orders/:id/history',async(req,res)=>{
  const order=(await sql`SELECT id,user_id,customer_hidden_at FROM orders WHERE id=${req.params.id}`)[0];
  if(!order||!isAdmin(req.user)&&(String(order.user_id)!==String(req.user.id)||order.customer_hidden_at))return notFound(res,'Order');
  return res.json(await sql`SELECT id,event_type,from_status,to_status,from_payment_status,to_payment_status,actor_type,created_at FROM order_events WHERE order_id=${order.id} ORDER BY created_at,id`);
});
router.post('/orders/:id/notifications/resend',async(req,res)=>{
  const order=(await sql`SELECT * FROM orders WHERE id=${req.params.id} AND user_id=${req.user.id}`)[0];
  if(!order)return notFound(res,'Order');
  const channel=String(req.body.channel||order.notification_channel).toUpperCase();
  if(!['EMAIL','WHATSAPP','SMS'].includes(channel))return res.status(400).json({error:'Select email, SMS, or WhatsApp.'});
  const destination=channel==='EMAIL'?String(order.contact_email||req.user.email||'').trim().toLowerCase():channel==='WHATSAPP'?normalizeWhatsAppNumber(order.contact_whatsapp||req.user.whatsapp_number):normalizeWhatsAppNumber(order.contact_phone||req.user.phone);
  if(!destination)return res.status(400).json({error:`No ${channel==='EMAIL'?'email address':'phone number'} is available for this order.`});
  return resendOrderSummary(res,{...order,notification_channel:channel,notification_destination:destination});
});
router.get('/order-items/order/:id',async(req,res)=>{const order=(await sql`SELECT * FROM orders WHERE id=${req.params.id}`)[0];if(!order||!isAdmin(req.user)&&String(order.user_id)!==String(req.user.id))return res.status(403).json({error:'Access denied.'});return res.json(await sql`SELECT * FROM order_items WHERE order_id=${req.params.id}`)});

export default router;
