-- Keep the database constraint aligned with every state used by the order
-- lifecycle, including customer cancellation and return reviews.

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS chk_orders_status;

ALTER TABLE orders
  ADD CONSTRAINT chk_orders_status CHECK (
    status IN ('PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED',
               'CANCEL_REVIEW', 'RETURN_REVIEW', 'CANCELLED', 'RETURNED')
  );
