import sql from './db.js';

export const reservationMinutes=()=>{
  const configured=Number(process.env.INVENTORY_RESERVATION_MINUTES||5);
  return Number.isFinite(configured)&&configured>=1&&configured<=60?Math.floor(configured):5;
};

export const releaseInventoryReservation=async(orderId,reason='EXPIRED')=>{
  const rows=await sql.query(`
    WITH target AS MATERIALIZED (
      SELECT id,status,payment_status FROM orders
      WHERE id=$1 AND payment_status<>'PAID' AND inventory_reserved_at IS NOT NULL
        AND inventory_released_at IS NULL
      FOR UPDATE
    ), color_totals AS MATERIALIZED (
      SELECT oi.product_color_id,SUM(oi.quantity)::int quantity
      FROM order_items oi JOIN target t ON t.id=oi.order_id
      WHERE oi.product_color_id IS NOT NULL GROUP BY oi.product_color_id
    ), product_totals AS MATERIALIZED (
      SELECT oi.product_id,SUM(oi.quantity)::int quantity
      FROM order_items oi JOIN target t ON t.id=oi.order_id
      WHERE oi.product_color_id IS NULL GROUP BY oi.product_id
    ), restored_colors AS (
      UPDATE product_color pc SET quantity=pc.quantity+c.quantity,updated_at=NOW()
      FROM color_totals c WHERE pc.id=c.product_color_id RETURNING pc.id
    ), restored_products AS (
      UPDATE products p SET stock_quantity=p.stock_quantity+x.quantity,updated_at=NOW()
      FROM product_totals x WHERE p.id=x.product_id RETURNING p.id
    ), released AS (
      UPDATE orders o SET inventory_released_at=NOW(),status='CANCELLED',updated_at=NOW()
      FROM target t WHERE o.id=t.id RETURNING o.*,t.status previous_status
    ), event AS (
      INSERT INTO order_events(order_id,event_type,from_status,to_status,from_payment_status,to_payment_status,actor_type,metadata)
      SELECT id,'INVENTORY_RESERVATION_RELEASED',previous_status,'CANCELLED',payment_status,payment_status,'SYSTEM',
        jsonb_build_object('reason',$2::text) FROM released RETURNING id
    )
    SELECT released.* FROM released WHERE
      (SELECT COUNT(*) FROM restored_colors)>=0 AND (SELECT COUNT(*) FROM restored_products)>=0
      AND (SELECT COUNT(*) FROM event)>0
  `,[orderId,reason]);
  return rows[0]||null;
};

export const releaseExpiredReservations=async()=>{
  const expired=await sql`SELECT id FROM orders WHERE payment_status<>'PAID'
    AND inventory_reserved_at IS NOT NULL AND inventory_released_at IS NULL
    AND inventory_reserved_until<=NOW() ORDER BY id LIMIT 100`;
  const released=[];
  for(const order of expired){
    const result=await releaseInventoryReservation(order.id,'EXPIRED');
    if(result)released.push(result);
  }
  return released;
};
