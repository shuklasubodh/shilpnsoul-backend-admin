ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS inventory_reserved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS inventory_reserved_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS inventory_released_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_active_inventory_reservations
  ON orders(inventory_reserved_until)
  WHERE payment_status = 'UNPAID' AND inventory_released_at IS NULL;
