import {Router} from 'express';
import crypto from 'node:crypto';
import sql from './db.js';
import {authenticate,admin,isAdmin,orderAccessTokenFor,verifyNotificationToken,verifyOrderAccessToken} from './auth.js';
import {sendOrderSummary} from './email.js';
import {notFound} from './utils.js';

const router=Router();

const verifiedNotification=async(req,user)=>{
  const channel=String(req.body.notification_channel||'').toUpperCase(),destination=String(req.body.notification_destination||req.body.contact_email||'').trim().toLowerCase();
  if(channel!=='EMAIL')throw Object.assign(new Error(channel==='WHATSAPP'?'WhatsApp notifications are not configured yet.':'Select and confirm an email notification channel.'),{status:channel==='WHATSAPP'?503:400});
  if(user?.email_verified_at&&destination===String(user.email).toLowerCase())return{channel,destination};
  let claims;
  try{claims=verifyNotificationToken(req.body.notification_verification_token)}catch{throw Object.assign(new Error('Verify the selected email before placing the order.'),{status:403})}
  if(claims.type!=='notification-verification'||claims.purpose!=='CHECKOUT'||claims.channel!==channel||claims.destination!==destination)throw Object.assign(new Error('The notification verification does not match this order.'),{status:403});
  const challenge=(await sql`SELECT id FROM notification_verifications WHERE id=${claims.verification_id} AND verified_at IS NOT NULL`)[0];
  if(!challenge)throw Object.assign(new Error('Notification verification is incomplete.'),{status:403});
  return{channel,destination};
};

const createOrder=async(req,res,user=null)=>{
  const {shipping_name,shipping_phone,shipping_address}=req.body;
  const items=req.body.items;
  const paymentMethod=String(req.body.payment_method||'CASH').toUpperCase();
  if(!['CASH','STRIPE'].includes(paymentMethod))return res.status(400).json({error:'Payment method must be CASH or STRIPE.'});
  if(!shipping_name||!shipping_phone||!shipping_address||!Array.isArray(items)||!items.length)return res.status(400).json({error:'Shipping and items required.'});
  let notification;
  try{notification=await verifiedNotification(req,user)}catch(error){return res.status(error.status||400).json({error:error.message})}
  const prepared=[];
  let total=0;
  for(const item of items){
    const product=(await sql`SELECT * FROM products WHERE id=${item.product_id} AND is_active=true`)[0];
    const quantity=Number(item.quantity);
    if(!product||!Number.isInteger(quantity)||quantity<1||quantity>product.stock_quantity)return res.status(409).json({error:'Product unavailable or insufficient stock.'});
    prepared.push({product,quantity,subtotal:Number(product.price)*quantity});
    total+=Number(product.price)*quantity;
  }
  const number=`ORD-${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
  const order=(await sql`INSERT INTO orders(user_id,order_number,status,shipping_name,shipping_phone,shipping_address,total_amount,contact_email,contact_phone,payment_method,payment_status,notification_channel,notification_destination) VALUES(${user?.id||null},${number},'PENDING',${shipping_name},${shipping_phone},${shipping_address},${total.toFixed(2)},${req.body.contact_email||user?.email||notification.destination},${req.body.contact_phone||user?.phone||shipping_phone},${paymentMethod},'UNPAID',${notification.channel},${notification.destination}) RETURNING *`)[0];
  await sql`INSERT INTO order_events(order_id,event_type,to_status,to_payment_status,actor_type,actor_id) VALUES(${order.id},'ORDER_CREATED','PENDING','UNPAID',${user?'CUSTOMER':'GUEST'},${user?.id||null})`;
  for(const item of prepared){
    await sql`INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price,subtotal) VALUES(${order.id},${item.product.id},${item.product.name},${item.quantity},${item.product.price},${item.subtotal.toFixed(2)})`;
    await sql`UPDATE products SET stock_quantity=stock_quantity-${item.quantity},updated_at=NOW() WHERE id=${item.product.id}`;
  }
  order.items=await sql`SELECT * FROM order_items WHERE order_id=${order.id}`;
  order.notification=await sendOrderSummary(order);
  if(!user)order.order_access_token=orderAccessTokenFor(order);
  return res.status(201).json(order);
};

const resendOrderSummary=async(res,order)=>{
  const recent=await sql`SELECT created_at FROM notification_deliveries WHERE order_id=${order.id} AND notification_type='ORDER_SUMMARY' AND created_at>NOW()-INTERVAL '1 hour' ORDER BY created_at DESC`;
  if(recent.length>=3)return res.status(429).json({error:'Order summary resend limit reached. Try again in one hour.'});
  if(recent[0]&&Date.now()-new Date(recent[0].created_at).getTime()<60000)return res.status(429).json({error:'Please wait before resending the order summary.'});
  order.items=await sql`SELECT * FROM order_items WHERE order_id=${order.id}`;
  const notification=await sendOrderSummary(order,{resend:true});
  return notification.status==='ACCEPTED'?res.json(notification):res.status(503).json({error:'The order summary could not be sent. Please try again.'});
};

router.post('/orders/guest',(req,res)=>createOrder(req,res));
router.post('/orders/track',async(req,res)=>{
  const orderNumber=String(req.body.orderNumber||req.body.order_number||'').trim(),email=String(req.body.email||'').trim().toLowerCase();
  const order=(await sql`SELECT * FROM orders WHERE order_number=${orderNumber} AND LOWER(contact_email)=${email} AND user_id IS NULL`)[0];
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

router.use(authenticate);
router.post('/orders',(req,res)=>createOrder(req,res,req.user));

router.get('/orders',async(req,res)=>{const rows=isAdmin(req.user)?await sql`SELECT * FROM orders ORDER BY id DESC`:await sql`SELECT * FROM orders WHERE user_id=${req.user.id} AND customer_hidden_at IS NULL ORDER BY id DESC`;res.set('X-Total-Count',rows.length);return res.json(rows)});
router.get('/orders/:id',async(req,res)=>{const order=(await sql`SELECT * FROM orders WHERE id=${req.params.id}`)[0];if(!order||!isAdmin(req.user)&&(String(order.user_id)!==String(req.user.id)||order.customer_hidden_at))return notFound(res,'Order');order.items=await sql`SELECT * FROM order_items WHERE order_id=${order.id}`;return res.json(order)});
router.put('/orders/:id',admin,async(req,res)=>{
  const status=String(req.body.status||'').toUpperCase();
  if(!['PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED','RETURNED'].includes(status))return res.status(400).json({error:'Invalid status.'});

  const current=(await sql`SELECT * FROM orders WHERE id=${req.params.id}`)[0];
  if(!current)return notFound(res,'Order');
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
        SELECT oi.product_id,SUM(oi.quantity)::integer AS quantity
        FROM order_items oi
        JOIN cancelled_order co ON co.id=oi.order_id
        GROUP BY oi.product_id
      ), restored_products AS (
        UPDATE products p
        SET stock_quantity=p.stock_quantity+iq.quantity,updated_at=NOW()
        FROM item_quantities iq
        WHERE p.id=iq.product_id
        RETURNING p.id
      )
      INSERT INTO order_events(order_id,event_type,from_status,to_status,actor_type,actor_id)
      SELECT id,'STATUS_CHANGED',${current.status},'CANCELLED','ADMIN',${req.user.id} FROM cancelled_order
      RETURNING (SELECT row_to_json(co) FROM cancelled_order co) AS order
    `;
    if(rows[0]?.order)return res.json(rows[0].order);

    const latest=(await sql`SELECT * FROM orders WHERE id=${req.params.id}`)[0];
    return latest?res.json(latest):notFound(res,'Order');
  }

  const rows=await sql`WITH changed AS (UPDATE orders SET status=${status},updated_at=NOW() WHERE id=${req.params.id} AND status<>'CANCELLED' RETURNING *) INSERT INTO order_events(order_id,event_type,from_status,to_status,actor_type,actor_id) SELECT id,'STATUS_CHANGED',${current.status},${status},'ADMIN',${req.user.id} FROM changed RETURNING (SELECT row_to_json(c) FROM changed c) AS order`;
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
  return resendOrderSummary(res,order);
});
router.get('/order-items/order/:id',async(req,res)=>{const order=(await sql`SELECT * FROM orders WHERE id=${req.params.id}`)[0];if(!order||!isAdmin(req.user)&&String(order.user_id)!==String(req.user.id))return res.status(403).json({error:'Access denied.'});return res.json(await sql`SELECT * FROM order_items WHERE order_id=${req.params.id}`)});

export default router;
