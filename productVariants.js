import sql from './db.js'

let schemaPromise

export const ensureProductVariantSchema = () => {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const status = (await sql.query(`
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='products' AND column_name='variant_type'
          ) AS variant_column,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='order_items' AND column_name='size'
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname='products_variant_type_check'
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname='product_color_color_check'
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='product_color' AND column_name='color' AND column_default IS NOT NULL
          )
          AND EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname=current_schema() AND p.proname='sync_product_stock_from_colors'
              AND pg_get_functiondef(p.oid) LIKE '%variant_type%'
          ) AS schema_ready
      `))[0]
      if (status.schema_ready && status.variant_column) return
      if (!status.variant_column) {
        await sql.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_type TEXT NOT NULL DEFAULT 'NONE'")
        await sql.query(`
          UPDATE products p SET variant_type = CASE
            WHEN EXISTS (SELECT 1 FROM product_color pc WHERE pc.product_id=p.id AND BTRIM(COALESCE(pc.size,''))<>'') THEN 'BOTH'
            WHEN EXISTS (SELECT 1 FROM product_color pc WHERE pc.product_id=p.id) THEN 'COLOR'
            ELSE 'NONE'
          END
        `)
      }
      await sql.query(`
        DO $$ BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('shilpnsoul:product-variant-schema'));
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='products_variant_type_check') THEN
            ALTER TABLE products ADD CONSTRAINT products_variant_type_check CHECK (variant_type IN ('COLOR','SIZE','BOTH','NONE'));
          END IF;
        END $$
      `)
      await sql.query('ALTER TABLE product_color DROP CONSTRAINT IF EXISTS product_color_color_check')
      await sql.query("ALTER TABLE product_color ALTER COLUMN color SET DEFAULT ''")
      await sql.query('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS size TEXT')
      await sql.query(`
        CREATE OR REPLACE FUNCTION sync_product_stock_from_colors() RETURNS TRIGGER AS $$
        DECLARE affected_product_id BIGINT;
        BEGIN
          affected_product_id := CASE WHEN TG_OP='DELETE' THEN OLD.product_id ELSE NEW.product_id END;
          UPDATE products
          SET stock_quantity=COALESCE((SELECT SUM(quantity) FROM product_color WHERE product_id=affected_product_id),0),updated_at=NOW()
          WHERE id=affected_product_id AND variant_type<>'NONE';
          IF TG_OP='UPDATE' AND OLD.product_id<>NEW.product_id THEN
            UPDATE products
            SET stock_quantity=COALESCE((SELECT SUM(quantity) FROM product_color WHERE product_id=OLD.product_id),0),updated_at=NOW()
            WHERE id=OLD.product_id AND variant_type<>'NONE';
          END IF;
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
      `)
    })().catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  return schemaPromise
}
