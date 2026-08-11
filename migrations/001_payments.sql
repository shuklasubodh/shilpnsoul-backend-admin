ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_method varchar(20) NOT NULL DEFAULT 'CASH',
  ADD COLUMN IF NOT EXISTS payment_status varchar(20) NOT NULL DEFAULT 'UNPAID';

CREATE TABLE IF NOT EXISTS payments (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id),
  user_id bigint NOT NULL REFERENCES users(id),
  provider varchar(20) NOT NULL,
  method varchar(30) NOT NULL,
  status varchar(20) NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL,
  stripe_checkout_session_id varchar(255) UNIQUE,
  stripe_payment_intent_id varchar(255),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_order_id_idx ON payments(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_paid_per_order_idx ON payments(order_id) WHERE status='PAID';
