import {Router} from 'express';
import sql from './db.js';
import {authenticate,isAdmin} from './auth.js';
import {notFound} from './utils.js';

const router=Router();
router.use(authenticate);

router.post('/carts',async(req,res)=>{const rows=await sql`INSERT INTO carts(user_id)VALUES(${req.user.id})RETURNING *`;return res.status(201).json(rows[0])});
router.get('/carts',async(req,res)=>{const rows=isAdmin(req.user)?await sql`SELECT * FROM carts ORDER BY id DESC`:await sql`SELECT * FROM carts WHERE user_id=${req.user.id} ORDER BY id DESC`;res.set('X-Total-Count',rows.length);return res.json(rows)});
router.get('/carts/:id',async(req,res)=>{
  const cart=(await sql`SELECT * FROM carts WHERE id=${req.params.id}`)[0];
  if(!cart||!isAdmin(req.user)&&String(cart.user_id)!==String(req.user.id))return notFound(res,'Cart');
  cart.items=await sql`SELECT ci.*,pc.color,pc.quantity available_quantity,p.name product_name,p.image_url FROM cart_items ci JOIN products p ON p.id=ci.product_id JOIN product_color pc ON pc.id=ci.product_color_id WHERE ci.cart_id=${req.params.id} ORDER BY ci.id`;
  return res.json(cart);
});
router.delete('/carts/:id',async(req,res)=>{const rows=isAdmin(req.user)?await sql`DELETE FROM carts WHERE id=${req.params.id} RETURNING *`:await sql`DELETE FROM carts WHERE id=${req.params.id} AND user_id=${req.user.id} RETURNING *`;return rows[0]?res.json(rows[0]):notFound(res,'Cart')});

router.post('/cart-items',async(req,res)=>{
  const{cart_id,product_id,product_color_id}=req.body,quantity=Number(req.body.quantity);
  const selected=(await sql`SELECT c.user_id,p.price,p.is_active,pc.quantity available_quantity FROM carts c CROSS JOIN products p JOIN product_color pc ON pc.product_id=p.id WHERE c.id=${cart_id} AND p.id=${product_id} AND pc.id=${product_color_id}`)[0];
  if(!selected||!isAdmin(req.user)&&String(selected.user_id)!==String(req.user.id)||!selected.is_active||!Number.isInteger(quantity)||quantity<1)return res.status(400).json({error:'A valid cart item, color, and quantity are required.'});
  if(quantity>selected.available_quantity)return res.status(409).json({error:'Insufficient stock for the selected color.'});
  const rows=await sql`
    INSERT INTO cart_items(cart_id,product_id,product_color_id,quantity,unit_price,subtotal)
    VALUES(${cart_id},${product_id},${product_color_id},${quantity},${selected.price},${(Number(selected.price)*quantity).toFixed(2)})
    ON CONFLICT(cart_id,product_id,product_color_id) WHERE product_color_id IS NOT NULL DO UPDATE
    SET quantity=cart_items.quantity+EXCLUDED.quantity,subtotal=(cart_items.quantity+EXCLUDED.quantity)*cart_items.unit_price,updated_at=NOW()
    WHERE cart_items.quantity+EXCLUDED.quantity<=${selected.available_quantity}
    RETURNING *
  `;
  if(!rows[0])return res.status(409).json({error:'Insufficient stock for the selected color.'});
  return res.status(201).json(rows[0]);
});

router.put('/cart-items/:id',async(req,res)=>{
  const quantity=Number(req.body.quantity),old=(await sql`SELECT ci.*,c.user_id,pc.quantity available_quantity FROM cart_items ci JOIN carts c ON c.id=ci.cart_id JOIN product_color pc ON pc.id=ci.product_color_id WHERE ci.id=${req.params.id}`)[0];
  if(!old||!isAdmin(req.user)&&String(old.user_id)!==String(req.user.id)||!Number.isInteger(quantity)||quantity<1||quantity>old.available_quantity)return res.status(400).json({error:'Invalid quantity for the selected color.'});
  const rows=await sql`UPDATE cart_items SET quantity=${quantity},subtotal=${(Number(old.unit_price)*quantity).toFixed(2)},updated_at=NOW() WHERE id=${req.params.id} RETURNING *`;
  return res.json(rows[0]);
});
router.delete('/cart-items/:id',async(req,res)=>{const old=(await sql`SELECT ci.*,c.user_id FROM cart_items ci JOIN carts c ON c.id=ci.cart_id WHERE ci.id=${req.params.id}`)[0];if(!old||!isAdmin(req.user)&&String(old.user_id)!==String(req.user.id))return notFound(res,'Cart item');const rows=await sql`DELETE FROM cart_items WHERE id=${req.params.id} RETURNING *`;return res.json(rows[0])});

export default router;
