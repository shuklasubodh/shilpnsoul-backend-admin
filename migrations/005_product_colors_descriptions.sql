CREATE TABLE IF NOT EXISTS product_color (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color TEXT NOT NULL CHECK (BTRIM(color) <> ''),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS product_color_product_color_uidx
  ON product_color(product_id, LOWER(BTRIM(color)));
CREATE INDEX IF NOT EXISTS product_color_product_idx ON product_color(product_id, id);

CREATE OR REPLACE FUNCTION sync_product_stock_from_colors() RETURNS TRIGGER AS $$
DECLARE affected_product_id BIGINT;
BEGIN
  affected_product_id := CASE WHEN TG_OP='DELETE' THEN OLD.product_id ELSE NEW.product_id END;
  UPDATE products
  SET stock_quantity = COALESCE((SELECT SUM(quantity) FROM product_color WHERE product_id=affected_product_id), 0),
      updated_at = NOW()
  WHERE id=affected_product_id;
  IF TG_OP='UPDATE' AND OLD.product_id<>NEW.product_id THEN
    UPDATE products SET stock_quantity=COALESCE((SELECT SUM(quantity) FROM product_color WHERE product_id=OLD.product_id),0),updated_at=NOW() WHERE id=OLD.product_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_color_sync_stock ON product_color;
CREATE TRIGGER product_color_sync_stock AFTER INSERT OR UPDATE OR DELETE ON product_color
  FOR EACH ROW EXECUTE FUNCTION sync_product_stock_from_colors();

ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS product_color_id BIGINT REFERENCES product_color(id) ON DELETE RESTRICT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_color_id BIGINT REFERENCES product_color(id) ON DELETE RESTRICT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS color TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS cart_items_cart_product_color_uidx ON cart_items(cart_id, product_id, product_color_id) WHERE product_color_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_items_product_color_idx ON order_items(product_color_id);

CREATE TABLE IF NOT EXISTS product_description (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  dimensions TEXT,
  color_description TEXT,
  pattern_craft TEXT,
  catalogue_description TEXT,
  festive_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Product descriptions transcribed from ShilpNSoul_SP_Product_Descriptions.docx.
WITH source(sku,title,dimensions,color_description,pattern_craft,catalogue_description,festive_note) AS (VALUES
('SP-1','Potli Bag Zari Embroidery','9X9 in','Assorted festive shades including pink, orange, navy, green and cream','Zari embroidery, Embroidery','Zari Embroidery Potli Bag','The rich embroidery and metallic detailing reflect the opulent visual language often seen in Rajasthan’s festive craft markets. It is an easy way to add traditional elegance to Diwali celebrations, wedding functions, return gifts or festive hampers.'),
('SP-2','Potli Bag Sequence Embroidery Velvet','9X9 in','Assorted bright shades including yellow, red, pink and cream','Sequin embroidery, Embroidery','Sequence Embroidery Velvet Potli Bag','The rich embroidery and metallic detailing reflect the opulent visual language often seen in Rajasthan’s festive craft markets. It is an easy way to add traditional elegance to Diwali celebrations, wedding functions, return gifts or festive hampers.'),
('SP-15','Potli Bag Gota Work','9 X 8.5 in','Assorted red, pink, orange, green and gold-toned combinations','Gota work','Gota Work Potli Bag','Gota work is a signature embellishment seen widely in Rajasthani festive and wedding craft. Its metallic sparkle makes this piece especially suitable for Diwali, weddings, puja gifting and traditional celebrations.'),
('SP-38','Clutches Patola Printed','9.5 X 5.5 in','Assorted pastel and jewel tones, including pink, green, cream and multicolor','Patola-inspired print','Patola Printed Clutches','The colorful geometric textile print gives this Rajasthan-sourced piece a strong Indian festive character. Its vibrant surface makes it a distinctive accessory or gift for Diwali, weddings, family functions and seasonal celebrations.'),
('SP-43','Clutches Patola Embroidery','9.5x5.5 in (Excel master; matching code not found in PDF)','Not identifiable in the supplied PDF catalogue','Patola-inspired print, Embroidery','Matching SP code not found in the supplied PDF catalogue; product name retained from the Excel master.','The rich embroidery and metallic detailing reflect the opulent visual language often seen in Rajasthan’s festive craft markets. It is an easy way to add traditional elegance to Diwali celebrations, wedding functions, return gifts or festive hampers.'),
('SP-51','Tote Bags','12 X 9.5 in','Assorted floral shades including red, peach, cream and multicolor','Thread embroidery, Embroidery','Thread Embroidery Work Handbags/Tote Bags','The rich embroidery and metallic detailing reflect the opulent visual language often seen in Rajasthan’s festive craft markets. It is an easy way to add traditional elegance to Diwali celebrations, wedding functions, return gifts or festive hampers.'),
('SP-56','Gota Work Handbags With Round Handle','12 X 9 in','Assorted red, pink, green, peach and orange','Gota work','Gota Work Handbags With Round Handle','Gota work is a signature embellishment seen widely in Rajasthani festive and wedding craft. Its metallic sparkle makes this piece especially suitable for Diwali, weddings, puja gifting and traditional celebrations.'),
('SP-59','Envelopes Gota Work','8 X 4 in','Green, yellow, red and pink variants with gold trim','Gota work','Gota Work Envelopes','Gota work is a signature embellishment seen widely in Rajasthani festive and wedding craft. Its metallic sparkle makes this piece especially suitable for Diwali, weddings, puja gifting and traditional celebrations.'),
('SP-61','Travel Pouches With Zipper Gota Work Bandhini Fabric','10 X 7 in','Assorted red, green, blue and pink Bandhani-style colors','Gota work, Bandhani/Bandhini','Gota Work Bandhini Fabric Travel Pouches With Zipper','Bandhani/Bandhej-style dotted patterns are closely associated with Rajasthan’s colorful textile heritage. The lively pattern makes this piece an attractive festive accessory or gift that adds a handcrafted Indian touch to celebrations.'),
('SP-62','Envelopes Gota Work Checks Pattern','8 X 4 in','Assorted red, green, yellow, pink, orange and beige','Gota work, Checks pattern','Gota Work Checks Pattern Envelopes','Gota work is a signature embellishment seen widely in Rajasthani festive and wedding craft. Its metallic sparkle makes this piece especially suitable for Diwali, weddings, puja gifting and traditional celebrations.'),
('SP-83','Gift Box - Pichwai printed','8 X 4 in','Assorted pink, green, yellow and orange Pichwai-style prints','Pichwai print','Pichwai printed cash boxes','Pichwai art has deep roots in Rajasthan, especially the Nathdwara tradition, and is known for devotional and nature-inspired imagery. This makes the piece meaningful as well as decorative - a thoughtful choice for festive gifting and auspicious occasions.'),
('SP-84','Gift boxes Pichwai printed small','4 X 4 in','Assorted pink, yellow, green and multicolor Pichwai-style prints','Pichwai print','Pichwai printed cash boxes','Pichwai art has deep roots in Rajasthan, especially the Nathdwara tradition, and is known for devotional and nature-inspired imagery. This makes the piece meaningful as well as decorative - a thoughtful choice for festive gifting and auspicious occasions.'),
('SP-94','Gift boxes Golden Brocade','8 X 4 in','Festive brocade shades such as red, pink and gold','Golden brocade','Golden Brocade cash boxes','The rich embroidery and metallic detailing reflect the opulent visual language often seen in Rajasthan’s festive craft markets. It is an easy way to add traditional elegance to Diwali celebrations, wedding functions, return gifts or festive hampers.'),
('SP-99','Clutches Bag Bandhej with gotta Work','8 X 4 in','Bright Bandhej shades including red, pink, orange and aqua with metallic trim','Gota work, Bandhej','Bandhej with gotta Work Clutch Bag','Bandhani/Bandhej-style dotted patterns are closely associated with Rajasthan’s colorful textile heritage. The lively pattern makes this piece an attractive festive accessory or gift that adds a handcrafted Indian touch to celebrations.'),
('SP-102','Potli bags Thread Embroidery Work Potli bags with Pearl Handle','8.5 X 9 in','Assorted jewel tones including red, green, blue, orange and pink','Thread embroidery, Embroidery','Matching SP code not found in the supplied PDF catalogue; product name retained from the Excel master.','The rich embroidery and metallic detailing reflect the opulent visual language often seen in Rajasthan’s festive craft markets. It is an easy way to add traditional elegance to Diwali celebrations, wedding functions, return gifts or festive hampers.'),
('SP-103','Potli bags Golden Peacock Embroidery Work Potli bags with Pearl Handle','8.5 X 9 in','Assorted yellow, blue, pink, cream and maroon with gold peacock embroidery','Peacock motif, Embroidery','Golden Peacock Embroidery Work Potli bags with Pearl Handle','The peacock is a beloved Indian decorative motif and appears frequently in Rajasthan-inspired craft and festive design. Its rich embroidery gives the piece a celebratory statement look, ideal for weddings, Diwali parties and special gifting.'),
('SP-106','Bandhini Fabric Bangle Handle Bags','10 X 8.5 in','Assorted blue, pink, green, cream and red Bandhani shades','Bandhani/Bandhini','Bandhini Fabric Bangle Handle Bags','Bandhani/Bandhej-style dotted patterns are closely associated with Rajasthan’s colorful textile heritage. The lively pattern makes this piece an attractive festive accessory or gift that adds a handcrafted Indian touch to celebrations.'),
('SP-123','Gift boxes Laharia Printed','4 X 4 in','Assorted yellow, pink, orange and red Lahariya-style prints','Leheriya/Lahariya','Laharia Printed cash boxes','Leheriya is strongly associated with Rajasthan’s vibrant textile tradition and festive dressing. Its flowing diagonal stripes bring an energetic, celebratory look that works beautifully for Diwali gifting, weddings and family gatherings.'),
('SP-124','Gift boxes Laharia Printed','4 X 4 in','Assorted bright Lahariya-style colors','Leheriya/Lahariya','Laharia Printed cash boxes','Leheriya is strongly associated with Rajasthan’s vibrant textile tradition and festive dressing. Its flowing diagonal stripes bring an energetic, celebratory look that works beautifully for Diwali gifting, weddings and family gatherings.'),
('SP-153','Gift box Embroidery work','8X 4in','Assorted embroidered gift-box colors; exact variants may vary','Embroidery','Embroidery work cash box, Gift box','The rich embroidery and metallic detailing reflect the opulent visual language often seen in Rajasthan’s festive craft markets. It is an easy way to add traditional elegance to Diwali celebrations, wedding functions, return gifts or festive hampers.')
)
INSERT INTO product_description(product_id,title,dimensions,color_description,pattern_craft,catalogue_description,festive_note)
SELECT p.id,s.title,s.dimensions,s.color_description,s.pattern_craft,s.catalogue_description,s.festive_note FROM source s JOIN products p ON LOWER(p.sku)=LOWER(s.sku)
ON CONFLICT(product_id) DO UPDATE SET title=EXCLUDED.title,dimensions=EXCLUDED.dimensions,color_description=EXCLUDED.color_description,pattern_craft=EXCLUDED.pattern_craft,catalogue_description=EXCLUDED.catalogue_description,festive_note=EXCLUDED.festive_note,updated_at=NOW();
