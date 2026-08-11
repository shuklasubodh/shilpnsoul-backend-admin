import {Router} from 'express';
import crypto from 'node:crypto';
import sql from './db.js';
import {authenticate,admin,isAdmin} from './auth.js';
import {notFound} from './utils.js';

const router=Router();
router.use(authenticate);

router.post('/orders',async(req,res)=>{
  const {shipping_name,shipping_phone,shipping_address}=req.body;
  const items=req.body.items;
  const paymentMethod=String(req.body.payment_method||'CASH').toUpperCase();
  if(!['CASH','STRIPE'].includes(paymentMethod))return res.status(400).json({error:'Payment method must be CASH or STRIPE.'});
  if(!shipping_name||!shipping_phone||!shipping_address||!Array.isArray(items)||!items.length)return res.status(400).json({error:'Shipping and items required.'});
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
  const order=(await sql`INSERT INTO orders(user_id,order_number,status,shipping_name,shipping_phone,shipping_address,total_amount,contact_email,contact_phone,payment_method,payment_status) VALUES(${req.user.id},${number},'PENDING',${shipping_name},${shipping_phone},${shipping_address},${total.toFixed(2)},${req.body.contact_email||req.user.email},${req.body.contact_phone||req.user.phone||shipping_phone},${paymentMethod},'UNPAID') RETURNING *`)[0];
  for(const item of prepared){
    await sql`INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price,subtotal) VALUES(${order.id},${item.product.id},${item.product.name},${item.quantity},${item.product.price},${item.subtotal.toFixed(2)}`;
    await sql`UPDATE products SET stock_quantity=stock_quantity-${item.quantity},updated_at=NOW() WHERE id=${item.product.id}`;
  }
  order.items=await sql`SELECT * FROM order_items WHERE order_id=${order.id}`;
  return res.status(201).json(order);
});

router.get('/orders',async(req,res)=>{const rows=isAdmin(req.user)?await sql`SELECT * FROM orders ORDER BY id DESC`:await sql`SELECT * FROM orders WHERE user_id=${req.user.id} ORDER BY id DESC`;res.set('X-Total-Count',rows.length);return res.json(rows)});
router.get('/orders/:id',async(req,res)=>{const order=(await sql`SELECT * FROM orders WHERE id=${req.params.id}`)[0];if(!order||!isAdmin(req.user)&&String(order.user_id)!==String(req.user.id))return notFound(res,'Order');order.items=await sql`SELECT * FROM order_items WHERE order_id=${order.id}`;return res.json(order)});
router.put('/orders/:id',admin,async(req,res)=>{const status=String(req.body.status||'').toUpperCase();if(!['PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED'].includes(status))return res.status(400).json({error:'Invalid status.'});const rows=await sql`UPDATE orders SET status=${status},updated_at=NOW() WHERE id=${req.params.id} RETURNING *`;return rows[0]?res.json(rows[0]):notFound(res,'Order')});
router.get('/order-items/order/:id',async(req,res)=>{const order=(await sql`SELECT * FROM orders WHERE id=${req.params.id}`)[0];if(!order||!isAdmin(req.user)&&String(order.user_id)!==String(req.user.id))return res.status(403).json({error:'Access denied.'});return res.json(await sql`SELECT * FROM order_items WHERE order_id=${req.params.id}`)});

export default router;
