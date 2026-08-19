import {Router,raw} from 'express';
import Stripe from 'stripe';
import sql from './db.js';
import {authenticate,admin} from './auth.js';
import {isId,notFound} from './utils.js';

let client;
let accountVerification;
const stripeClient=()=>{
  if(!process.env.STRIPE_SECRET_KEY)throw Object.assign(new Error('Stripe is not configured.'),{code:'STRIPE_CONFIG_MISSING'});
  return client||(client=new Stripe(process.env.STRIPE_SECRET_KEY));
};
const verifiedStripeClient=async()=>{
  const expected=String(process.env.STRIPE_ACCOUNT_ID||'').trim();
  if(!/^acct_[A-Za-z0-9]+$/.test(expected))throw Object.assign(new Error('STRIPE_ACCOUNT_ID is not configured.'),{code:'STRIPE_CONFIG_MISSING'});
  const stripe=stripeClient();
  accountVerification||=stripe.accounts.retrieve().then(account=>{
    if(account.id!==expected)throw Object.assign(new Error('Stripe secret key does not belong to the approved Stripe account.'),{code:'STRIPE_ACCOUNT_MISMATCH'});
    return stripe;
  }).catch(error=>{accountVerification=undefined;throw error});
  return accountVerification;
};
const currency=()=>String(process.env.STRIPE_CURRENCY||'sgd').toLowerCase();
const minorUnits=value=>Math.round(Number(value)*100);

export const stripeWebhook=Router();
stripeWebhook.post('/',raw({type:'application/json',limit:'256kb'}),async(req,res)=>{
  if(!process.env.STRIPE_WEBHOOK_SECRET)return res.status(503).json({error:'Stripe webhook is not configured.'});
  const signature=req.get('stripe-signature');
  if(!signature)return res.status(400).json({error:'Missing Stripe signature.'});
  const stripe=await verifiedStripeClient();
  let event;
  try{event=stripe.webhooks.constructEvent(req.body,signature,process.env.STRIPE_WEBHOOK_SECRET)}
  catch{return res.status(400).json({error:'Invalid Stripe signature.'})}

  const session=event.data.object;
  if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)){
    const orderId=session.metadata?.order_id;
    const order=isId(orderId)?(await sql`SELECT id,total_amount,payment_status FROM orders WHERE id=${orderId}`)[0]:null;
    const payment=order?(await sql`SELECT id FROM payments WHERE order_id=${order.id} AND stripe_checkout_session_id=${session.id}`)[0]:null;
    const valid=order&&payment&&session.mode==='payment'&&session.payment_status==='paid'&&
      session.currency===currency()&&session.amount_total===minorUnits(order.total_amount);
    if(valid){
      await sql`UPDATE payments SET status='PAID',stripe_payment_intent_id=${String(session.payment_intent||'')},paid_at=NOW(),updated_at=NOW() WHERE order_id=${order.id} AND stripe_checkout_session_id=${session.id} AND status<>'PAID'`;
      await sql`
        WITH paid AS (
          UPDATE orders SET payment_status='PAID',status=CASE WHEN status='PENDING' THEN 'CONFIRMED' ELSE status END,updated_at=NOW()
          WHERE id=${order.id} AND payment_status<>'PAID' RETURNING id,status
        )
        INSERT INTO order_events(order_id,event_type,from_payment_status,to_payment_status,to_status,actor_type,metadata)
        SELECT id,'PAYMENT_STATUS_CHANGED',${order.payment_status},'PAID',status,'SYSTEM',jsonb_build_object('provider','STRIPE','stripe_event_id',${event.id}) FROM paid
      `;
    }
  }else if(event.type==='checkout.session.async_payment_failed'||event.type==='checkout.session.expired'){
    await sql`UPDATE payments SET status=${event.type.endsWith('expired')?'EXPIRED':'FAILED'},updated_at=NOW() WHERE stripe_checkout_session_id=${session.id} AND status<>'PAID'`;
  }
  return res.json({received:true});
});

const router=Router();
router.use(authenticate);
router.post('/orders/:id/checkout',async(req,res)=>{
  if(!isId(req.params.id))return notFound(res,'Order');
  const order=(await sql`SELECT id,user_id,order_number,total_amount,contact_email,payment_method,payment_status,status FROM orders WHERE id=${req.params.id} AND user_id=${req.user.id}`)[0];
  if(!order)return notFound(res,'Order');
  if(order.payment_status==='PAID')return res.status(409).json({error:'Order is already paid.'});
  if(order.status==='CANCELLED')return res.status(409).json({error:'Cancelled orders cannot be paid.'});
  const successUrl=process.env.PAYMENT_SUCCESS_URL,cancelUrl=process.env.PAYMENT_CANCEL_URL;
  if(!successUrl||!cancelUrl)throw Object.assign(new Error('Payment return URLs are not configured.'),{code:'STRIPE_CONFIG_MISSING'});
  const stripe=await verifiedStripeClient();

  const existing=(await sql`SELECT stripe_checkout_session_id FROM payments WHERE order_id=${order.id} AND status='PENDING' ORDER BY id DESC LIMIT 1`)[0];
  if(existing){
    const previous=await stripe.checkout.sessions.retrieve(existing.stripe_checkout_session_id);
    if(previous.status==='open'&&previous.url)return res.json({checkout_url:previous.url,session_id:previous.id});
  }
  const attempts=(await sql`SELECT COUNT(*)::int AS count FROM payments WHERE order_id=${order.id}`)[0].count;
  const session=await stripe.checkout.sessions.create({
    mode:'payment',
    payment_method_types:['card','paynow'],
    customer_email:order.contact_email||req.user.email,
    client_reference_id:String(order.id),
    metadata:{order_id:String(order.id),order_number:order.order_number,user_id:String(req.user.id)},
    line_items:[{quantity:1,price_data:{currency:currency(),unit_amount:minorUnits(order.total_amount),product_data:{name:`Order ${order.order_number}`}}}],
    success_url:successUrl,
    cancel_url:cancelUrl,
  },{idempotencyKey:`order-${order.id}-checkout-${attempts+1}`});
  await sql`INSERT INTO payments(order_id,user_id,provider,method,status,amount,currency,stripe_checkout_session_id) VALUES(${order.id},${req.user.id},'STRIPE','ONLINE','PENDING',${order.total_amount},${currency().toUpperCase()},${session.id}) ON CONFLICT(stripe_checkout_session_id) DO NOTHING`;
  await sql`UPDATE orders SET payment_method='STRIPE',updated_at=NOW() WHERE id=${order.id}`;
  return res.status(201).json({checkout_url:session.url,session_id:session.id});
});

router.get('/orders/:id/payment',async(req,res)=>{
  const order=(await sql`SELECT id,user_id,payment_method,payment_status FROM orders WHERE id=${req.params.id} AND user_id=${req.user.id}`)[0];
  if(!order)return notFound(res,'Order');
  const payment=(await sql`SELECT provider,method,status,amount,currency,paid_at,created_at,updated_at FROM payments WHERE order_id=${order.id} ORDER BY id DESC LIMIT 1`)[0]||null;
  return res.json({order_id:order.id,payment_method:order.payment_method,payment_status:order.payment_status,payment});
});

router.put('/orders/:id/cash',admin,async(req,res)=>{
  if(!isId(req.params.id))return notFound(res,'Order');
  const order=(await sql`SELECT id,user_id,total_amount,payment_method,payment_status,status FROM orders WHERE id=${req.params.id}`)[0];
  if(!order)return notFound(res,'Order');
  if(order.payment_method!=='CASH')return res.status(409).json({error:'This order is not a cash order.'});
  if(order.status==='CANCELLED')return res.status(409).json({error:'Cancelled orders cannot be paid.'});
  if(order.payment_status!=='PAID'){
    await sql`INSERT INTO payments(order_id,user_id,provider,method,status,amount,currency,paid_at) VALUES(${order.id},${order.user_id},'CASH','CASH','PAID',${order.total_amount},${currency().toUpperCase()},NOW()) ON CONFLICT (order_id) WHERE status='PAID' DO NOTHING`;
    await sql`
      WITH paid AS (
        UPDATE orders SET payment_status='PAID',status=CASE WHEN status='PENDING' THEN 'CONFIRMED' ELSE status END,updated_at=NOW()
        WHERE id=${order.id} AND payment_status<>'PAID' RETURNING id,status
      )
      INSERT INTO order_events(order_id,event_type,from_payment_status,to_payment_status,to_status,actor_type,actor_id,metadata)
      SELECT id,'PAYMENT_STATUS_CHANGED',${order.payment_status},'PAID',status,'ADMIN',${req.user.id},jsonb_build_object('provider','CASH') FROM paid
    `;
  }
  return res.json((await sql`SELECT * FROM orders WHERE id=${order.id}`)[0]);
});

export default router;
