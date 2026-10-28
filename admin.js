import { neon } from '@neondatabase/serverless'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { handleUpload } from '@vercel/blob/client'
import { del as deleteBlob, get as getBlob, list as listBlobs, rename as renameBlob } from '@vercel/blob'
import { sendInvitationEmail } from './email.js'
import { verifyPassword as verifyAccountPassword } from './auth.js'
import { ensureProductVariantSchema } from './productVariants.js'

const BCRYPT_ROUNDS = 12
const bcryptHashPattern = /^\$2[aby]\$\d{2}\$.{53}$/
const adminOrderStatuses = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED']
let orderStatusConstraintPromise

const ensureOrderStatusConstraint = (sql) => {
  if (!orderStatusConstraintPromise) {
    orderStatusConstraintPromise = sql.query(`
      DO $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('shilpnsoul:orders:status-constraint'));
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'orders'::regclass
            AND conname = 'chk_orders_status'
            AND pg_get_constraintdef(oid) LIKE '%PROCESSING%'
            AND pg_get_constraintdef(oid) LIKE '%DELIVERED%'
            AND pg_get_constraintdef(oid) LIKE '%CANCEL_REVIEW%'
            AND pg_get_constraintdef(oid) LIKE '%RETURN_REVIEW%'
        ) THEN
          ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_status;
          ALTER TABLE orders ADD CONSTRAINT chk_orders_status CHECK (
            status IN ('PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED',
                       'CANCEL_REVIEW', 'RETURN_REVIEW', 'CANCELLED', 'RETURNED')
          );
        END IF;
      END $$;
    `).catch((error) => {
      orderStatusConstraintPromise = null
      throw error
    })
  }
  return orderStatusConstraintPromise
}

const resources = {
  users: {
    table: 'users',
    columns: ['first_name', 'last_name', 'email', 'password_hash', 'country_code', 'phone', 'whatsapp_number', 'role', 'is_active', 'preferred_notification_channel', 'return_window_days'],
    publicColumns: ['id', 'first_name', 'last_name', 'email', 'country_code', 'phone', 'whatsapp_number', 'role', 'is_active', 'email_verified_at', 'phone_verified_at', 'whatsapp_verified_at', 'preferred_notification_channel', 'return_window_days', 'created_at', 'updated_at'],
    searchColumns: ['first_name', 'last_name', 'email', 'phone', 'whatsapp_number', 'role'],
    responseKey: 'user',
  },
  products: {
    table: 'products',
    columns: ['name', 'slug', 'sku', 'category_id', 'description', 'place', 'dimension', 'price', 'stock_quantity', 'image_url', 'is_active', 'latest', 'variant_type', 'optimize_for_mobile'],
    publicColumns: ['id', 'name', 'slug', 'sku', 'category_id', 'description', 'place', 'dimension', 'price', 'stock_quantity', 'image_url', 'is_active', 'latest', 'variant_type', 'optimize_for_mobile', 'created_at', 'updated_at'],
    searchColumns: ['name', 'slug', 'sku', 'description', 'place', 'dimension'],
    responseKey: 'product',
  },
  categories: {
    table: 'categories',
    columns: ['name', 'slug', 'description', 'is_active'],
    publicColumns: ['id', 'name', 'slug', 'description', 'is_active', 'created_at', 'updated_at'],
    searchColumns: ['name', 'slug', 'description'],
    responseKey: 'category',
  },
  orders: {
    table: 'orders',
    columns: ['order_number', 'user_id', 'status', 'total_amount', 'shipping_address', 'payment_status'],
    publicColumns: ['id', 'order_number', 'user_id', 'status', 'total_amount', 'shipping_address', 'payment_status', 'customer_hidden_at', 'archived_at', 'created_at', 'updated_at'],
    searchColumns: ['order_number', 'status', 'shipping_address', 'payment_status'],
    responseKey: 'order',
  },
  'product-descriptions': {
    table: 'product_description',
    columns: ['product_id', 'title', 'dimensions', 'color_description', 'pattern_craft', 'catalogue_description', 'festive_note'],
    publicColumns: ['id', 'product_id', 'title', 'dimensions', 'color_description', 'pattern_craft', 'catalogue_description', 'festive_note', 'created_at', 'updated_at'],
    searchColumns: ['title', 'dimensions', 'color_description', 'pattern_craft', 'catalogue_description', 'festive_note'],
    responseKey: 'product_description',
  },
  products_desccription: {
    table: 'product_description',
    columns: ['product_id', 'title', 'dimensions', 'color_description', 'pattern_craft', 'catalogue_description', 'festive_note'],
    publicColumns: ['id', 'product_id', 'title', 'dimensions', 'color_description', 'pattern_craft', 'catalogue_description', 'festive_note', 'created_at', 'updated_at'],
    searchColumns: ['title', 'dimensions', 'color_description', 'pattern_craft', 'catalogue_description', 'festive_note'],
    responseKey: 'product_description',
  },
  'product-colors': {
    table: 'product_color',
    columns: ['product_id', 'color', 'size', 'quantity'],
    publicColumns: ['id', 'product_id', 'color', 'size', 'quantity', 'created_at', 'updated_at'],
    searchColumns: ['color', 'size'],
    responseKey: 'product_color',
  },
}

const json = (response, status, body) => response.status(status).json(body)
const positiveId = (value) => /^\d+$/.test(String(value)) && Number(value) > 0
const retentionDays = (value) => Math.min(3650, Math.max(1, Number.parseInt(value, 10) || 30))
const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
const orderArchiveWhere = `
  (o.payment_status = 'PAID' OR o.status IN ('CANCELLED', 'RETURNED'))
  AND o.updated_at <= NOW() - ($1::int * INTERVAL '1 day')
`
const slugify = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

const uniqueProductSlug = async (sql, requestedSlug, sku, productId) => {
  const base = slugify(requestedSlug) || slugify(sku) || 'product'
  const skuSuffix = slugify(sku)
  let candidate = base
  let suffix = 2

  while (true) {
    const conflict = await sql.query(
      'SELECT id FROM products WHERE LOWER(slug) = LOWER($1) AND ($2::bigint IS NULL OR id <> $2::bigint) LIMIT 1',
      [candidate, productId || null],
    )
    if (!conflict.length) return candidate
    candidate = `${base}-${skuSuffix || suffix}`
    if (suffix > 2) candidate += `-${suffix}`
    suffix += 1
  }
}

const matchesLegacyPassword = (password, storedValue) => {
  const supplied = Buffer.from(String(password))
  const stored = Buffer.from(String(storedValue))
  return supplied.length === stored.length && timingSafeEqual(supplied, stored)
}

const prepareValues = async (resourceName, columns, body) => Promise.all(
  columns.map(async (column) => {
    const value = body[column]
    if (resourceName !== 'users' || column !== 'password_hash' || bcryptHashPattern.test(String(value))) return value
    return bcrypt.hash(String(value), BCRYPT_ROUNDS)
  }),
)

const normalizedResourceBody = (resourceName, source = {}) => {
  if (resourceName === 'users') {
    const countryCode=`+${String(source.country_code||'').replace(/\D/g,'')}`
    const international=(value)=>{
      const raw=String(value||'').trim()
      if(raw.startsWith('+'))return raw
      const local=raw.replace(/\D/g,'').replace(/^0+/,'')
      return local&&/^\+[1-9]\d{0,3}$/.test(countryCode)?`${countryCode}${local}`:raw
    }
    return {...source,country_code:countryCode,phone:source.phone===undefined?undefined:(international(source.phone)||null),whatsapp_number:source.whatsapp_number===undefined?undefined:(international(source.whatsapp_number)||null)}
  }
  if (resourceName === 'products') {
    const latest = source.latest === undefined
      ? undefined
      : ['T', 'TRUE', '1', 'Y'].includes(String(source.latest).trim().toUpperCase()) ? 'T' : 'F'
    const variantType = source.variant_type === undefined ? undefined : String(source.variant_type).trim().toUpperCase()
    return {
      ...source,
      latest,
      variant_type: variantType === undefined ? undefined : ['COLOR', 'SIZE', 'BOTH', 'NONE'].includes(variantType) ? variantType : 'NONE',
    }
  }
  if (!['product-descriptions', 'products_desccription'].includes(resourceName)) return source
  return {
    ...source,
    title: source.title ?? source.name_of_product ?? source.product_name,
    color_description: source.color_description ?? source.color ?? source.colour,
    catalogue_description: source.catalogue_description ?? source.description,
  }
}

const normalizeProductVariantRecord = async (sql, source, current = {}) => {
  const productId = source.product_id ?? current.product_id
  const product = (await sql.query('SELECT id,variant_type FROM products WHERE id=$1', [productId]))[0]
  if (!product) return { error: 'A valid product is required.' }
  const variantType = String(product.variant_type || 'NONE').toUpperCase()
  const color = String(source.color ?? current.color ?? '').trim()
  const size = String(source.size ?? current.size ?? '').trim()
  const quantity = Number(source.quantity ?? current.quantity)
  if (variantType === 'NONE') return { error: 'This product does not use color or size variants.' }
  if ((variantType === 'COLOR' || variantType === 'BOTH') && !color) return { error: 'Color is required for this product.' }
  if ((variantType === 'SIZE' || variantType === 'BOTH') && !size) return { error: 'Size is required for this product.' }
  if (!Number.isInteger(quantity) || quantity < 0) return { error: 'A non-negative whole-number quantity is required.' }
  return { ...source, product_id: product.id, color: variantType === 'SIZE' ? '' : color, size: variantType === 'COLOR' ? '' : size, quantity }
}

const parseJson = (value, fallback) => {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

const productImages = (value) => {
  if (!value) return []
  if (Array.isArray(value)) return value.filter((url) => /^https?:\/\//i.test(String(url)))
  const parsed = parseJson(value, null)
  return Array.isArray(parsed) ? parsed.filter((url) => /^https?:\/\//i.test(String(url))) : (/^https?:\/\//i.test(String(value)) ? [String(value)] : [])
}

const publicRecord = (resourceName, record) => {
  if (resourceName !== 'products' || !record) return record
  const images = productImages(record.image_url)
  return { ...record, image_url: images[0] || '', images }
}

const validBlobUrl = (value) => {
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' && url.hostname.endsWith('.blob.vercel-storage.com')
  } catch { return false }
}

const blobFileName = (blobUrl, blobPathname = '') => {
  const pathname = String(blobPathname || decodeURIComponent(new URL(String(blobUrl)).pathname)).replace(/^\/+/, '')
  return pathname.split('/').filter(Boolean).at(-1)
}

const moveBlobToFolder = async (blobUrl, blobPathname, folder) => {
  const fileName = blobFileName(blobUrl, blobPathname)
  if (!fileName) throw new Error('The Blob pathname does not contain a filename.')
  const targetPathname = `products/${folder}/${fileName}`
  const sourcePathname = String(blobPathname || decodeURIComponent(new URL(String(blobUrl)).pathname)).replace(/^\/+/, '')
  if (sourcePathname === targetPathname) return { url: String(blobUrl), pathname: targetPathname }
  const moved = await renameBlob(String(blobUrl), targetPathname, {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
  })
  return { url: moved.url, pathname: moved.pathname }
}

const ensureProductImagesTable = async (sql) => {
  // Older deployments used a short VARCHAR for one image. Multiple public Blob
  // URLs are stored as JSON, so upgrade the existing column without data loss.
  await sql.query('ALTER TABLE products ALTER COLUMN image_url TYPE TEXT USING image_url::text')
  await sql.query(`
    CREATE TABLE IF NOT EXISTS product_images (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      blob_url TEXT NOT NULL,
      blob_pathname TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
      is_primary BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (product_id, blob_url)
    )
  `)
  // CREATE TABLE IF NOT EXISTS does not add constraints to an older table.
  // Normalize legacy rows before adding the indexes required by upserts.
  await sql.query(`
    DELETE FROM product_images older
    USING product_images newer
    WHERE older.product_id = newer.product_id
      AND older.blob_url = newer.blob_url
      AND older.id > newer.id
  `)
  await sql.query(`
    UPDATE product_images
    SET is_primary = FALSE, updated_at = NOW()
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY id) AS position
        FROM product_images
        WHERE is_primary = TRUE
      ) ranked
      WHERE position > 1
    )
  `)
  await sql.query('CREATE INDEX IF NOT EXISTS product_images_product_id_idx ON product_images(product_id, sort_order, id)')
  await sql.query('CREATE UNIQUE INDEX IF NOT EXISTS product_images_product_blob_idx ON product_images(product_id, blob_url)')
  await sql.query('CREATE UNIQUE INDEX IF NOT EXISTS product_images_one_primary_idx ON product_images(product_id) WHERE is_primary')
}

const ensureBannersTable = async (sql) => {
  await sql.query(`
    CREATE TABLE IF NOT EXISTS banners (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      alt_text TEXT NOT NULL DEFAULT '',
      place_of_origin TEXT NOT NULL DEFAULT '',
      link_url TEXT NOT NULL DEFAULT '',
      blob_url TEXT NOT NULL UNIQUE,
      blob_pathname TEXT NOT NULL UNIQUE CHECK (blob_pathname LIKE 'banner/%'),
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await sql.query("ALTER TABLE banners ADD COLUMN IF NOT EXISTS place_of_origin TEXT NOT NULL DEFAULT ''")
  await sql.query('CREATE INDEX IF NOT EXISTS banners_display_idx ON banners(is_active, sort_order, id)')
  await sql.query('CREATE INDEX IF NOT EXISTS banners_place_of_origin_idx ON banners(place_of_origin, is_active, sort_order)')
}

const allProductBlobs = async () => {
  const blobs = []
  let cursor
  do {
    const page = await listBlobs({ prefix: 'products/', limit: 1000, cursor })
    blobs.push(...page.blobs)
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)
  return blobs
}

const syncProductImageUrls = async (sql, productId) => {
  let rows = await sql.query('SELECT id, blob_url, is_primary FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, sort_order, id', [productId])
  if (rows.length && !rows.some((row) => row.is_primary)) {
    await sql.query('UPDATE product_images SET is_primary = (id = $1), updated_at = NOW() WHERE product_id = $2', [rows[0].id, productId])
    rows = await sql.query('SELECT id, blob_url, is_primary FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, sort_order, id', [productId])
  }
  const urls = [...new Set(rows.map((row) => row.blob_url).filter((url) => validBlobUrl(url)))]
  await sql.query('UPDATE products SET image_url = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(urls), productId])
  return urls
}

const databaseError = (response, error) => {
  console.error('Database request failed:', error)
  if (error.name?.includes('Blob') || /vercel blob|blob store/i.test(String(error.message))) {
    return json(response, 503, { error: `Vercel Blob: ${error.message || 'storage request failed'}` })
  }
  if (error.code === '42P01' || error.code === '42703') {
    return json(response, 500, { error: 'The database schema does not match this resource configuration.' })
  }
  if (error.code === '23505') return json(response, 409, { error: 'A record with that unique value already exists.' })
  if (error.code === '23503') return json(response, 409, { error: 'This record is referenced by another record.' })
  if (error.code === '23502' || error.code === '23514' || error.code === '22P02') return json(response, 400, { error: 'A required field is missing or invalid.' })
  if (error.code === '22001') return json(response, 400, { error: 'A database text column is too short for the uploaded value. Deploy the latest image-storage schema migration.' })
  return json(response, 500, { error: 'Database request failed.' })
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept,Authorization')
  response.setHeader('Access-Control-Expose-Headers', 'X-Total-Count')
  if (request.method === 'OPTIONS') return response.status(204).end()

  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!connectionString) return json(response, 500, { error: 'DATABASE_URL is not configured for this deployment.' })
  const authSecret = String(process.env.ADMIN_JWT_SECRET || '')
  if (authSecret.length < 32) return json(response, 503, { error: 'ADMIN_JWT_SECRET must be configured with at least 32 characters.' })
  const route = String(request.query.route || '').replace(/^\/+|\/+$/g, '')
  const [resourceName, id, ...extra] = route.split('/')
  const sql = neon(connectionString)
  const verifyAdminSession = async rawToken => {
    const claims = jwt.verify(rawToken || '', authSecret, { algorithms: ['HS256'], issuer: 'shilpnsoul-admin', audience: 'shilpnsoul-admin-web' })
    if (claims.role !== 'ADMIN' || !claims.sid || !/^\d+$/.test(String(claims.sub || claims.id))) throw new Error('Administrator access is required.')
    const idleMinutes = Math.max(5, Math.min(60, Number(process.env.ADMIN_IDLE_MINUTES) || 15))
    const rows = await sql.query(`
      UPDATE admin_auth_sessions AS s SET last_seen_at=NOW()
      FROM users AS u
      WHERE s.session_id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL
        AND s.expires_at>NOW() AND s.last_seen_at>NOW()-($3::int*INTERVAL '1 minute')
        AND u.id=s.user_id AND u.is_active=TRUE AND UPPER(u.role)='ADMIN'
      RETURNING s.session_id
    `, [claims.sid, claims.sub || claims.id, idleMinutes])
    if (!rows.length) throw new Error('Administrator session is no longer active.')
    return { ...claims, id: String(claims.sub || claims.id) }
  }

  try {
    if (resourceName === 'blob-upload' && !id && !extra.length && request.method === 'POST') {
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return json(response, 503, { error: 'BLOB_READ_WRITE_TOKEN is not configured in the backend deployment.' })
      }
      try {
        const result = await handleUpload({
          token: process.env.BLOB_READ_WRITE_TOKEN,
          request,
          body: request.body,
          onBeforeGenerateToken: async (pathname, clientPayload) => {
            const { adminToken, uploadType = 'product' } = parseJson(clientPayload, {})
            await verifyAdminSession(adminToken)
            const allowedPrefix = uploadType === 'banner' ? 'banner/' : 'products/'
            if (!String(pathname).startsWith(allowedPrefix)) throw new Error(`Uploads of this type must be stored under ${allowedPrefix}.`)
            return {
              allowedContentTypes: ['image/*'],
              addRandomSuffix: false,
            }
          },
          onUploadCompleted: async () => {},
        })
        return json(response, 200, result)
      } catch (error) {
        console.error('[blob-upload] Failed to issue or complete an upload token:', error)
        return json(response, 400, { error: error.message || 'Image upload authorization failed.' })
      }
    }

    if (resourceName === 'auth' && id === 'login' && !extra.length && request.method === 'POST') {
      const { email, password } = request.body || {}
      if (!email || !password) return json(response, 400, { error: 'Email and password are required.' })
      const rows = await sql.query(
        'SELECT id, first_name, last_name, email, password_hash, role, is_active FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [String(email).trim()],
      )
      const user = rows[0]
      const active = user && ['true', '1', 'y'].includes(String(user.is_active).toLowerCase())
      const admin = user && String(user.role).toUpperCase() === 'ADMIN'
      let passwordMatches = false
      if (user?.password_hash) {
        passwordMatches = bcryptHashPattern.test(user.password_hash) || String(user.password_hash).startsWith('scrypt$')
          ? await verifyAccountPassword(String(password), user.password_hash)
          : matchesLegacyPassword(password, user.password_hash)
      }
      if (!user || !active || !admin || !passwordMatches) {
        return json(response, 401, { error: 'Invalid credentials or administrator access is not permitted.' })
      }
      if (!bcryptHashPattern.test(user.password_hash) && !String(user.password_hash).startsWith('scrypt$')) {
        const migratedHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS)
        await sql.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [migratedHash, user.id])
      }
      const identity = { id: String(user.id), fullName: `${user.first_name} ${user.last_name}`.trim(), email: user.email, role: 'ADMIN' }
      const sessionId = randomUUID(), sessionHours = Math.max(1, Math.min(24, Number(process.env.ADMIN_SESSION_HOURS) || 8))
      await sql.query('INSERT INTO admin_auth_sessions(session_id,user_id,expires_at) VALUES($1,$2,NOW()+($3::int*INTERVAL \'1 hour\'))', [sessionId, user.id, sessionHours])
      const configuredLifetime = String(process.env.ADMIN_JWT_EXPIRES_IN || '30m').trim().match(/^(\d+)(m|h)$/)
      const configuredMinutes = configuredLifetime ? Number(configuredLifetime[1]) * (configuredLifetime[2] === 'h' ? 60 : 1) : 30
      const tokenMinutes = Math.max(5, Math.min(60, configuredMinutes))
      const token = jwt.sign({ ...identity, sid: sessionId }, authSecret, { algorithm: 'HS256', subject: String(user.id), expiresIn: `${tokenMinutes}m`, issuer: 'shilpnsoul-admin', audience: 'shilpnsoul-admin-web' })
      return json(response, 200, { token, user: identity })
    }

    const authorization = request.headers.authorization || ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    let adminSession
    try {
      adminSession = await verifyAdminSession(token)
    } catch {
      return json(response, 401, { error: 'Authentication is required.' })
    }

    if (resourceName === 'products' || resourceName === 'product-colors') {
      await ensureProductVariantSchema()
    }

    if (resourceName === 'auth' && id === 'logout' && !extra.length && request.method === 'POST') {
      await sql.query('UPDATE admin_auth_sessions SET revoked_at=NOW() WHERE session_id=$1 AND user_id=$2', [adminSession.sid, adminSession.id])
      return response.status(204).end()
    }

    if (resourceName === 'order-archive' && id === 'eligible' && !extra.length && request.method === 'GET') {
      const days = retentionDays(request.query.retention_days)
      const rows = await sql.query(`SELECT COUNT(*)::int AS count FROM orders o WHERE ${orderArchiveWhere} AND o.archived_at IS NULL`, [days])
      return json(response, 200, { retention_days: days, eligible_count: rows[0].count })
    }

    if (resourceName === 'order-archive' && id === 'archive' && !extra.length && request.method === 'POST') {
      const days = retentionDays(request.body?.retention_days)
      const rows = await sql.query(`
        WITH archived AS (
          UPDATE orders o SET archived_at = NOW(), updated_at = NOW()
          WHERE ${orderArchiveWhere} AND o.archived_at IS NULL
          RETURNING o.id
        )
        INSERT INTO order_events(order_id,event_type,actor_type,actor_id,metadata)
        SELECT id,'ARCHIVED','ADMIN',$2,jsonb_build_object('retention_days',$1) FROM archived
        RETURNING order_id
      `, [days, adminSession.id])
      return json(response, 200, { retention_days: days, archived_count: rows.length })
    }

    if (resourceName === 'order-archive' && id === 'export' && !extra.length && request.method === 'GET') {
      const rows = await sql.query(`
        SELECT o.id,o.order_number,o.user_id,o.status,o.payment_status,o.payment_method,o.total_amount,
          o.shipping_name,o.shipping_phone,o.shipping_address,o.contact_email,o.contact_phone,
          o.customer_hidden_at,o.archived_at,o.created_at,o.updated_at,
          COALESCE(string_agg(oi.product_name || ' x' || oi.quantity, ' | ' ORDER BY oi.id),'') AS items
        FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id
        WHERE o.archived_at IS NOT NULL
        GROUP BY o.id ORDER BY o.archived_at,o.id
      `)
      const columns = ['id','order_number','user_id','status','payment_status','payment_method','total_amount','items','shipping_name','shipping_phone','shipping_address','contact_email','contact_phone','customer_hidden_at','archived_at','created_at','updated_at']
      const csv = [columns.map(csvCell).join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\r\n')
      response.setHeader('Content-Type', 'text/csv; charset=utf-8')
      response.setHeader('Content-Disposition', `attachment; filename="order-archive-${new Date().toISOString().slice(0, 10)}.csv"`)
      return response.status(200).send(`\uFEFF${csv}`)
    }

    if (resourceName === 'blob-images' && !id && !extra.length) {
      if (request.method === 'GET') {
        const result = await listBlobs({ prefix: 'products/', limit: 1000, cursor: request.query.cursor || undefined })
        return json(response, 200, result)
      }
      if (request.method === 'DELETE') {
        const blobUrl = request.body?.blob_url
        if (!validBlobUrl(blobUrl)) return json(response, 400, { error: 'A valid Vercel Blob URL is required.' })
        let blobAlreadyMissing = false
        try {
          await deleteBlob(String(blobUrl))
        } catch (deleteError) {
          if (deleteError?.name === 'BlobNotFoundError' || /requested blob does not exist/i.test(String(deleteError?.message))) blobAlreadyMissing = true
          else throw deleteError
        }
        await ensureProductImagesTable(sql)
        const removedMappings = await sql.query('DELETE FROM product_images WHERE blob_url = $1 RETURNING id', [String(blobUrl)])
        const affectedProducts = await sql.query('SELECT id, image_url FROM products WHERE image_url LIKE $1', [`%${String(blobUrl)}%`])
        let updatedProducts = 0
        for (const product of affectedProducts) {
          const remainingImages = productImages(product.image_url).filter((url) => url !== String(blobUrl))
          await sql.query('UPDATE products SET image_url = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(remainingImages), product.id])
          updatedProducts += 1
        }
        return json(response, 200, { deleted: !blobAlreadyMissing, blob_already_missing: blobAlreadyMissing, removed_mappings: removedMappings.length, updated_products: updatedProducts })
      }
      return json(response, 405, { error: 'Method not allowed.' })
    }

    if (resourceName === 'banners' && !extra.length) {
      await ensureBannersTable(sql)
      if (request.method === 'GET' && !id) {
        const rows = await sql.query('SELECT * FROM banners ORDER BY sort_order, id')
        return json(response, 200, rows)
      }
      if (request.method === 'POST' && !id) {
        const { title = '', alt_text: altText = '', place_of_origin: placeOfOrigin = '', link_url: linkUrl = '', blob_url: blobUrl, blob_pathname: blobPathname, sort_order: sortOrder = 0, is_active: isActive = true } = request.body || {}
        if (!validBlobUrl(blobUrl) || !String(blobPathname || '').startsWith('banner/')) {
          return json(response, 400, { error: 'A valid Vercel Blob image stored under banner/ is required.' })
        }
        if (!String(placeOfOrigin).trim() || String(placeOfOrigin).trim().length > 120) return json(response, 400, { error: 'A valid place of origin is required.' })
        const rows = await sql.query(`
          INSERT INTO banners (title, alt_text, place_of_origin, link_url, blob_url, blob_pathname, sort_order, is_active)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
        `, [String(title).trim(), String(altText).trim(), String(placeOfOrigin).trim(), String(linkUrl).trim(), String(blobUrl), String(blobPathname), Math.max(0, Math.floor(Number(sortOrder) || 0)), Boolean(isActive)])
        return json(response, 201, rows[0])
      }
      if (request.method === 'PUT' && id && positiveId(id)) {
        const { title = '', alt_text: altText = '', place_of_origin: placeOfOrigin = '', link_url: linkUrl = '', sort_order: sortOrder = 0, is_active: isActive = true } = request.body || {}
        if (!String(placeOfOrigin).trim() || String(placeOfOrigin).trim().length > 120) return json(response, 400, { error: 'A valid place of origin is required.' })
        const rows = await sql.query(`
          UPDATE banners SET title = $1, alt_text = $2, place_of_origin = $3, link_url = $4, sort_order = $5, is_active = $6, updated_at = NOW()
          WHERE id = $7 RETURNING *
        `, [String(title).trim(), String(altText).trim(), String(placeOfOrigin).trim(), String(linkUrl).trim(), Math.max(0, Math.floor(Number(sortOrder) || 0)), Boolean(isActive), id])
        if (!rows.length) return json(response, 404, { error: 'Banner not found.' })
        return json(response, 200, rows[0])
      }
      if (request.method === 'DELETE' && id && positiveId(id)) {
        const rows = await sql.query('SELECT * FROM banners WHERE id = $1', [id])
        if (!rows.length) return json(response, 404, { error: 'Banner not found.' })
        await deleteBlob(rows[0].blob_url)
        await sql.query('DELETE FROM banners WHERE id = $1', [id])
        return json(response, 200, rows[0])
      }
      return json(response, 405, { error: 'Method not allowed.' })
    }

    if (resourceName === 'image-repair' && !id && !extra.length && request.method === 'POST') {
      await ensureProductImagesTable(sql)
      const blobs = await allProductBlobs()
      const blobByPath = new Map(blobs.map((blob) => [blob.pathname, blob]))
      const blobByUrl = new Map(blobs.map((blob) => [blob.url, blob]))
      const products = await sql.query('SELECT id, slug, image_url FROM products ORDER BY id')
      let repairedMappings = 0
      let removedStaleMappings = 0
      let createdMappings = 0
      let updatedProducts = 0
      let assignedPrimaries = 0

      const brokenMappings = await sql.query('SELECT id, product_id, blob_url, blob_pathname FROM product_images')
      for (const mapping of brokenMappings) {
        if (blobByUrl.has(mapping.blob_url)) continue
        const replacement = blobByPath.get(mapping.blob_pathname)
        if (!replacement) {
          await sql.query('DELETE FROM product_images WHERE id = $1', [mapping.id])
          removedStaleMappings += 1
          continue
        }
        const duplicate = await sql.query('SELECT id FROM product_images WHERE product_id = $1 AND blob_url = $2 AND id <> $3 LIMIT 1', [mapping.product_id, replacement.url, mapping.id])
        if (duplicate.length) await sql.query('DELETE FROM product_images WHERE id = $1', [mapping.id])
        else await sql.query('UPDATE product_images SET blob_url = $1, updated_at = NOW() WHERE id = $2', [replacement.url, mapping.id])
        repairedMappings += 1
      }

      for (const product of products) {
        const existingRows = await sql.query('SELECT id, blob_url, blob_pathname, sort_order, is_primary FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, sort_order, id', [product.id])
        const knownUrls = new Set(existingRows.map((row) => row.blob_url).filter((url) => blobByUrl.has(url)))
        const candidates = []
        for (const legacyUrl of productImages(product.image_url)) if (blobByUrl.has(legacyUrl)) candidates.push(blobByUrl.get(legacyUrl))
        const productPrefix = `products/${product.slug}/`
        for (const blob of blobs) if (blob.pathname.startsWith(productPrefix)) candidates.push(blob)
        for (const blob of candidates) {
          if (knownUrls.has(blob.url)) continue
          await sql.query(`
            INSERT INTO product_images (product_id, blob_url, blob_pathname, sort_order, is_primary)
            VALUES ($1, $2, $3, $4, FALSE)
            ON CONFLICT (product_id, blob_url) DO NOTHING
          `, [product.id, blob.url, blob.pathname, knownUrls.size])
          knownUrls.add(blob.url)
          createdMappings += 1
        }
        const validRows = await sql.query('SELECT id, blob_url, is_primary FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, sort_order, id', [product.id])
        const validImages = [...new Set(validRows.map((row) => row.blob_url).filter((url) => blobByUrl.has(url)))]
        if (validImages.length && !validRows.some((row) => row.is_primary && blobByUrl.has(row.blob_url))) {
          await sql.query('UPDATE product_images SET is_primary = (id = $1), updated_at = NOW() WHERE product_id = $2', [validRows.find((row) => blobByUrl.has(row.blob_url)).id, product.id])
          assignedPrimaries += 1
        }
        const storedImages = productImages(product.image_url)
        if (JSON.stringify(storedImages) !== JSON.stringify(validImages)) {
          await sql.query('UPDATE products SET image_url = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(validImages), product.id])
          updatedProducts += 1
        }
      }
      return json(response, 200, {
        blobs_found: blobs.length,
        repaired_mappings: repairedMappings,
        removed_stale_mappings: removedStaleMappings,
        created_mappings: createdMappings,
        updated_products: updatedProducts,
        assigned_primaries: assignedPrimaries,
      })
    }

    if (resourceName === 'blob-content' && !id && !extra.length && request.method === 'GET') {
      const blobUrl = String(request.query.url || '')
      if (!validBlobUrl(blobUrl)) return json(response, 400, { error: 'A valid Vercel Blob URL is required.' })
      const preferredAccess = blobUrl.includes('.private.blob.vercel-storage.com') ? 'private' : 'public'
      let blobResult
      let firstError
      try {
        blobResult = await getBlob(blobUrl, { access: preferredAccess })
      } catch (error) {
        firstError = error
        try {
          blobResult = await getBlob(blobUrl, { access: preferredAccess === 'private' ? 'public' : 'private' })
        } catch (retryError) {
          console.error('[blob-content] Blob could not be read using public or private access:', firstError, retryError)
          return json(response, 502, { error: 'The configured Blob credentials cannot read this image. Confirm this project is connected to the Blob store containing the listed files.' })
        }
      }
      if (!blobResult) return json(response, 404, { error: 'Blob image not found.' })
      if (blobResult.statusCode === 304) return response.status(304).end()
      const bytes = Buffer.from(await new Response(blobResult.stream).arrayBuffer())
      response.setHeader('Content-Type', blobResult.blob.contentType || 'application/octet-stream')
      response.setHeader('Cache-Control', 'private, max-age=300')
      return response.status(200).send(bytes)
    }

    if (resourceName === 'product-images' && !extra.length) {
      await ensureProductImagesTable(sql)
      if (request.method === 'GET' && !id) {
        const rows = await sql.query(`
          SELECT pi.*, p.name AS product_name, p.sku AS product_sku
          FROM product_images pi
          JOIN products p ON p.id = pi.product_id
          ORDER BY p.name, pi.sort_order, pi.id
        `)
        return json(response, 200, rows)
      }
      if (request.method === 'POST' && !id) {
        const { product_id: productId, blob_url: blobUrl, blob_pathname: blobPathname = '', sort_order: sortOrder = 0, is_primary: isPrimary = false } = request.body || {}
        if (!positiveId(productId) || !validBlobUrl(blobUrl)) return json(response, 400, { error: 'A valid product and public Vercel Blob URL are required.' })
        const products = await sql.query('SELECT id, slug FROM products WHERE id = $1', [productId])
        if (!products.length) return json(response, 404, { error: 'Product not found.' })
        const movedBlob = await moveBlobToFolder(blobUrl, blobPathname, products[0].slug)
        const previousMappings = await sql.query(
          'DELETE FROM product_images WHERE blob_url = $1 OR ($2 <> \'\' AND blob_pathname = $2) RETURNING product_id',
          [String(blobUrl), String(blobPathname)],
        )
        if (isPrimary) await sql.query('UPDATE product_images SET is_primary = FALSE, updated_at = NOW() WHERE product_id = $1', [productId])
        const rows = await sql.query(`
          INSERT INTO product_images (product_id, blob_url, blob_pathname, sort_order, is_primary)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (product_id, blob_url) DO UPDATE SET
            blob_pathname = EXCLUDED.blob_pathname,
            sort_order = EXCLUDED.sort_order,
            is_primary = EXCLUDED.is_primary,
            updated_at = NOW()
          RETURNING *
        `, [productId, movedBlob.url, movedBlob.pathname, Math.max(0, Math.floor(Number(sortOrder) || 0)), Boolean(isPrimary)])
        for (const previousProductId of new Set(previousMappings.map((mapping) => mapping.product_id))) {
          if (Number(previousProductId) !== Number(productId)) await syncProductImageUrls(sql, previousProductId)
        }
        await syncProductImageUrls(sql, productId)
        return json(response, 200, rows[0])
      }
      if (request.method === 'DELETE' && id && positiveId(id)) {
        const existingRows = await sql.query('SELECT id, product_id, blob_url, blob_pathname FROM product_images WHERE id = $1', [id])
        if (!existingRows.length) return json(response, 404, { error: 'Image mapping not found.' })
        const movedBlob = await moveBlobToFolder(existingRows[0].blob_url, existingRows[0].blob_pathname, 'unmapped')
        const rows = await sql.query(
          'DELETE FROM product_images WHERE blob_url = $1 OR (blob_pathname <> \'\' AND blob_pathname = $2) RETURNING id, product_id',
          [existingRows[0].blob_url, existingRows[0].blob_pathname],
        )
        if (!rows.length) return json(response, 404, { error: 'Image mapping not found.' })
        for (const affectedProductId of new Set(rows.map((mapping) => mapping.product_id))) await syncProductImageUrls(sql, affectedProductId)
        return json(response, 200, { ...rows[0], blob_url: movedBlob.url, blob_pathname: movedBlob.pathname })
      }
      return json(response, 405, { error: 'Method not allowed.' })
    }

    if (resourceName === 'bulk-import' && !id && !extra.length && request.method === 'POST') {
      const categories = Array.isArray(request.body?.categories) ? request.body.categories : []
      const products = Array.isArray(request.body?.products) ? request.body.products : []
      if (!categories.length && !products.length) return json(response, 400, { error: 'At least one category or product is required.' })
      if (categories.length > 500 || products.length > 2000) return json(response, 400, { error: 'A single upload is limited to 500 categories and 2,000 products.' })

      const invalidCategory = categories.find((item) => !item?.name || !item?.slug)
      const invalidProduct = products.find((item) => !item?.name || !item?.slug || !item?.sku || !item?.category_slug || Number(item.price) < 0 || Number(item.stock_quantity) < 0 || item.optimize_for_mobile === false)
      if (invalidCategory || invalidProduct) return json(response, 400, { error: 'The upload contains missing or invalid required fields.' })

      const categoryIds = new Map()
      const categoryResult = { created: 0, updated: 0 }
      const productResult = { created: 0, updated: 0 }
      if (products.length) {
        await ensureProductImagesTable(sql)
      }

      for (const category of categories) {
        const existing = await sql.query('SELECT id FROM categories WHERE LOWER(slug) = LOWER($1) OR LOWER(name) = LOWER($2) LIMIT 1', [String(category.slug).trim(), String(category.name).trim()])
        if (existing.length) {
          await sql.query(
            'UPDATE categories SET name = $1, slug = $2, description = $3, is_active = $4, updated_at = NOW() WHERE id = $5',
            [String(category.name).trim(), String(category.slug).trim(), String(category.description || ''), category.is_active !== false, existing[0].id],
          )
          categoryIds.set(String(category.slug).toLowerCase(), existing[0].id)
          categoryResult.updated += 1
        } else {
          const created = await sql.query(
            'INSERT INTO categories (name, slug, description, is_active) VALUES ($1, $2, $3, $4) RETURNING id',
            [String(category.name).trim(), String(category.slug).trim(), String(category.description || ''), category.is_active !== false],
          )
          categoryIds.set(String(category.slug).toLowerCase(), created[0].id)
          categoryResult.created += 1
        }
      }

      for (const product of products) {
        const categoryKey = String(product.category_slug).toLowerCase()
        let categoryId = categoryIds.get(categoryKey)
        if (!categoryId) {
          const category = await sql.query('SELECT id FROM categories WHERE LOWER(slug) = LOWER($1) LIMIT 1', [categoryKey])
          categoryId = category[0]?.id
        }
        if (!categoryId) return json(response, 400, { error: `No category was found for product SKU ${product.sku}.` })

        const incomingImages = productImages(product.image_urls?.length ? product.image_urls : product.image_url)
        const normalizedSku = String(product.sku).trim()
        const existing = await sql.query('SELECT id, image_url, latest, variant_type FROM products WHERE LOWER(sku) = LOWER($1) LIMIT 1', [normalizedSku])
        const resolvedSlug = await uniqueProductSlug(sql, product.slug, normalizedSku, existing[0]?.id)
        const latest = product.latest === undefined || String(product.latest).trim() === ''
          ? existing[0]?.latest || 'F'
          : ['T', 'TRUE', '1', 'Y'].includes(String(product.latest).trim().toUpperCase()) ? 'T' : 'F'
        const requestedVariantType = String(product.variant_type || '').trim().toUpperCase()
        const variantType = ['COLOR', 'SIZE', 'BOTH', 'NONE'].includes(requestedVariantType)
          ? requestedVariantType
          : existing[0]?.variant_type || 'NONE'
        const values = [
          String(product.name).trim(), resolvedSlug, normalizedSku, categoryId,
          String(product.description || ''), String(product.place || ''), String(product.dimension || ''), Number(product.price), Math.floor(Number(product.stock_quantity)),
          JSON.stringify(incomingImages), product.is_active !== false, latest, variantType,
        ]
        let productId
        let mergedImages = incomingImages
        if (existing.length) {
          mergedImages = [...new Set([...productImages(existing[0].image_url), ...incomingImages])]
          values[9] = JSON.stringify(mergedImages)
          await sql.query(
            'UPDATE products SET name = $1, slug = $2, sku = $3, category_id = $4, description = $5, place = $6, dimension = $7, price = $8, stock_quantity = $9, image_url = $10, is_active = $11, latest = $12, variant_type = $13, updated_at = NOW() WHERE id = $14',
            [...values, existing[0].id],
          )
          productId = existing[0].id
          productResult.updated += 1
        } else {
          const created = await sql.query(
            'INSERT INTO products (name, slug, sku, category_id, description, place, dimension, price, stock_quantity, image_url, is_active, latest, variant_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id',
            values,
          )
          productId = created[0].id
          productResult.created += 1
        }

        if (mergedImages.length) {
          const blobPathByUrl = new Map((Array.isArray(product.image_blobs) ? product.image_blobs : []).map((blob) => [blob.url, blob.pathname || '']))
          for (let imageIndex = 0; imageIndex < mergedImages.length; imageIndex += 1) {
            const imageUrl = mergedImages[imageIndex]
            await sql.query(`
              INSERT INTO product_images (product_id, blob_url, blob_pathname, sort_order, is_primary)
              VALUES ($1, $2, $3, $4, FALSE)
              ON CONFLICT (product_id, blob_url) DO UPDATE SET
                blob_pathname = CASE WHEN EXCLUDED.blob_pathname <> '' THEN EXCLUDED.blob_pathname ELSE product_images.blob_pathname END,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW()
            `, [productId, imageUrl, blobPathByUrl.get(imageUrl) || '', imageIndex])
          }
        }
      }

      return json(response, 200, { message: 'Bulk import completed.', categories: categoryResult, products: productResult })
    }

    const resource = resources[resourceName]
    if (!resource || extra.length || (id && !positiveId(id))) return json(response, 404, { error: 'API route not found.' })

    const schemaColumns = await sql.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
      [resource.table],
    )
    if (!schemaColumns.length) return json(response, 404, { error: `Database table "${resource.table}" does not exist.` })
    const availableColumns = schemaColumns.map(({ column_name }) => column_name)
    const readableColumns = availableColumns.filter((column) => column !== 'password_hash')
    const selectColumns = readableColumns.map((column) => `"${column}"`).join(', ')

    if (request.method === 'GET' && id) {
      const rows = await sql.query(`SELECT ${selectColumns} FROM "${resource.table}" WHERE id = $1`, [id])
      if (!rows.length) return json(response, 404, { error: 'Record not found.' })
      const record = publicRecord(resourceName, rows[0])
      if (resourceName === 'orders') {
        const items = await sql.query(`
          SELECT oi.*,
            COALESCE(NULLIF(oi.product_name, ''), p.name) AS product_name,
            p.sku,
            p.image_url
          FROM order_items oi
          LEFT JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = $1
          ORDER BY oi.id
        `, [id])
        record.items = items.map((item) => ({
          ...item,
          image_url: productImages(item.image_url)[0] || '',
        }))
      }
      return json(response, 200, record)
    }

    if (request.method === 'GET') {
      const filter = parseJson(request.query.filter, {})
      const sort = parseJson(request.query.sort, [request.query._sort || 'id', request.query._order || 'ASC'])
      const range = parseJson(request.query.range, [request.query._start || 0, (request.query._end || 10) - 1])
      const start = Math.max(0, Number(range[0]) || 0)
      const end = Math.max(start, Number(range[1]) || start + 9)
      const sortField = readableColumns.includes(sort[0]) ? sort[0] : (readableColumns.includes('id') ? 'id' : readableColumns[0])
      const sortOrder = String(sort[1]).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
      const clauses = []
      const values = []
      const q = filter.q ?? request.query._q

      if (['products', 'categories'].includes(resourceName) && availableColumns.includes('is_active') && !Object.hasOwn(filter, 'is_active')) {
        values.push(true)
        clauses.push(`"is_active" = $${values.length}`)
      }

      if (q) {
        const searchableColumns = resource.searchColumns.filter((column) => readableColumns.includes(column))
        if (searchableColumns.length) {
          values.push(`%${q}%`)
          clauses.push(`(${searchableColumns.map((column) => `CAST("${column}" AS TEXT) ILIKE $${values.length}`).join(' OR ')})`)
        }
      }
      for (const [key, value] of Object.entries(filter)) {
        if (key === 'q' || !readableColumns.includes(key) || value === '' || value == null) continue
        if (Array.isArray(value)) {
          values.push(value)
          clauses.push(`"${key}" = ANY($${values.length})`)
        } else {
          values.push(value)
          clauses.push(`"${key}" = $${values.length}`)
        }
      }

      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
      const [{ count }] = await sql.query(`SELECT COUNT(*)::int AS count FROM "${resource.table}"${where}`, values)
      const listValues = [...values, end - start + 1, start]
      const rows = await sql.query(
        `SELECT ${selectColumns} FROM "${resource.table}"${where} ORDER BY "${sortField}" ${sortOrder} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        listValues,
      )
      response.setHeader('X-Total-Count', String(count))
      return json(response, 200, rows.map((record) => publicRecord(resourceName, record)))
    }

    if (request.method === 'POST' && !id) {
      let body = normalizedResourceBody(resourceName, request.body || {})
      if (resourceName === 'product-colors') {
        body = await normalizeProductVariantRecord(sql, body)
        if (body.error) return json(response, 400, { error: body.error })
      }
      if (resourceName === 'products' && body.optimize_for_mobile === false) return json(response, 400, { error: 'Mobile image optimization is required for products.' })
      if (resourceName === 'users') {
        const requiredFields = ['first_name', 'last_name', 'email', 'country_code', 'role']
        const missingFields = requiredFields.filter((field) => body[field] === undefined || body[field] === '')
        if (missingFields.length) return json(response, 400, { error: `Missing required fields: ${missingFields.join(', ')}.` })
        const duplicate = await sql.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1) OR ($2::text IS NOT NULL AND (phone=$2 OR whatsapp_number=$2)) OR ($3::text IS NOT NULL AND (phone=$3 OR whatsapp_number=$3)) LIMIT 1', [body.email, body.phone, body.whatsapp_number])
        if (duplicate.length) return json(response, 409, { error: 'A user with one of these contact details already exists.' })
        body.password_hash = randomBytes(32).toString('hex')
        body.is_active = false
        body.preferred_notification_channel = 'EMAIL'
      }
      const columns = resource.columns.filter((column) => availableColumns.includes(column) && body[column] !== undefined && (body[column] !== '' || (resourceName === 'product-colors' && ['color', 'size'].includes(column))))
      if (!columns.length) return json(response, 400, { error: 'At least one valid field is required.' })
      const values = await prepareValues(resourceName, columns, body)
      const placeholders = values.map((_, index) => `$${index + 1}`).join(', ')
      const rows = await sql.query(
        `INSERT INTO "${resource.table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${placeholders}) RETURNING ${selectColumns}`,
        values,
      )
      if (resourceName === 'users') {
        const user=rows[0],token=randomBytes(32).toString('base64url')
        const invitation=(await sql.query(`INSERT INTO user_invitations(user_id,token_hash,expires_at,created_by) VALUES($1,$2,NOW()+CASE WHEN UPPER($4)='ADMIN' THEN INTERVAL '1 hour' ELSE INTERVAL '48 hours' END,$3) RETURNING id`,[user.id,createHash('sha256').update(token).digest('hex'),adminSession.id,user.role]))[0]
        const appUrl=String(process.env.CUSTOMER_APP_URL||'http://localhost:5173').replace(/\/$/,'')
        try {
          await sendInvitationEmail({to:user.email,name:`${user.first_name} ${user.last_name}`.trim(),invitationUrl:`${appUrl}/#invitation=${encodeURIComponent(token)}`,invitationId:invitation.id})
        } catch (error) {
          await sql.query('DELETE FROM users WHERE id=$1 AND is_active=FALSE',[user.id])
          throw error
        }
      }
      return json(response, 201, { message: 'Record created successfully.', [resource.responseKey]: publicRecord(resourceName, rows[0]) })
    }

    if (request.method === 'PUT' && id) {
      let body = normalizedResourceBody(resourceName, request.body || {})
      if (resourceName === 'product-colors') {
        const current = (await sql.query('SELECT * FROM product_color WHERE id=$1', [id]))[0]
        if (!current) return json(response, 404, { error: 'Record not found.' })
        body = await normalizeProductVariantRecord(sql, body, current)
        if (body.error) return json(response, 400, { error: body.error })
      }
      if (resourceName === 'products' && body.optimize_for_mobile === false) return json(response, 400, { error: 'Mobile image optimization is required for products.' })
      if (resourceName === 'orders' && body.status !== undefined) {
        const status = String(body.status).toUpperCase()
        if (!adminOrderStatuses.includes(status)) return json(response, 400, { error: 'Invalid order status.' })
        await ensureOrderStatusConstraint(sql)
        const currentRows = await sql.query('SELECT * FROM orders WHERE id = $1', [id])
        if (!currentRows.length) return json(response, 404, { error: 'Record not found.' })
        const current = currentRows[0]
        if (current.status === status) return json(response, 200, { message: 'Order status is unchanged.', order: current })
        if (['CANCEL_REVIEW', 'RETURN_REVIEW'].includes(current.status)) return json(response, 409, { error: 'Decide the open cancellation or return request before changing this order.' })
        if (current.status === 'CANCELLED') return json(response, 409, { error: 'Cancelled orders cannot be reopened.' })
        const rows = await sql.query(`
          WITH changed AS (
            UPDATE orders SET status=$1::text,delivered_at=CASE WHEN $1::text='DELIVERED' THEN COALESCE(delivered_at,NOW()) ELSE delivered_at END,updated_at=NOW() WHERE id=$2 AND status NOT IN ('CANCELLED','RETURNED') RETURNING *
          ), quantities AS (
            SELECT oi.product_color_id,SUM(oi.quantity)::integer AS quantity FROM order_items oi JOIN changed c ON c.id=oi.order_id
            WHERE $1::text='CANCELLED' AND oi.product_color_id IS NOT NULL GROUP BY oi.product_color_id
          ), restored AS (
            UPDATE product_color p SET quantity=p.quantity+q.quantity,updated_at=NOW()
            FROM quantities q WHERE p.id=q.product_color_id RETURNING p.id
          ), legacy_quantities AS (
            SELECT oi.product_id,SUM(oi.quantity)::integer quantity FROM order_items oi JOIN changed c ON c.id=oi.order_id
            WHERE $1::text='CANCELLED' AND oi.product_color_id IS NULL GROUP BY oi.product_id
          ), restored_legacy AS (
            UPDATE products p SET stock_quantity=p.stock_quantity+q.quantity,updated_at=NOW() FROM legacy_quantities q WHERE p.id=q.product_id RETURNING p.id
          )
          INSERT INTO order_events(order_id,event_type,from_status,to_status,actor_type,actor_id)
          SELECT id,'STATUS_CHANGED',$3,$1::text,'ADMIN',$4 FROM changed
          RETURNING (SELECT row_to_json(c) FROM changed c) AS order
        `, [status, id, current.status, adminSession.id])
        if (!rows[0]?.order) return json(response, 409, { error: 'Order status changed during this request. Refresh and try again.' })
        return json(response, 200, { message: 'Order updated successfully.', order: rows[0].order })
      }
      if (resourceName === 'users') {
        const current=(await sql.query('SELECT email,phone,whatsapp_number FROM users WHERE id=$1',[id]))[0]
        if (!current) return json(response, 404, { error: 'Record not found.' })
        const email=String(body.email??current.email).trim().toLowerCase(),phone=body.phone===undefined?current.phone:body.phone,whatsapp=body.whatsapp_number===undefined?current.whatsapp_number:body.whatsapp_number
        const duplicate=await sql.query('SELECT id FROM users WHERE id<>$1 AND (LOWER(email)=LOWER($2) OR ($3::text IS NOT NULL AND (phone=$3 OR whatsapp_number=$3)) OR ($4::text IS NOT NULL AND (phone=$4 OR whatsapp_number=$4))) LIMIT 1',[id,email,phone,whatsapp])
        if(duplicate.length)return json(response,409,{error:'A user with one of these contact details already exists.'})
        if(body.preferred_notification_channel==='SMS'&&!phone)return json(response,400,{error:'SMS cannot be preferred without an SMS number.'})
        if(body.preferred_notification_channel==='WHATSAPP'&&!whatsapp)return json(response,400,{error:'WhatsApp cannot be preferred without a WhatsApp number.'})
      }
      const columns = resource.columns.filter((column) => availableColumns.includes(column) && body[column] !== undefined && (body[column] !== '' || (resourceName === 'product-colors' && ['color', 'size'].includes(column))))
      if (!columns.length) return json(response, 400, { error: 'At least one valid field is required.' })
      const values = await prepareValues(resourceName, columns, body)
      values.push(id)
      const assignments = columns.map((column, index) => `"${column}" = $${index + 1}`)
      if (resourceName === 'users' && columns.includes('email')) assignments.push('"email_verified_at" = CASE WHEN LOWER(email)<>LOWER($'+(columns.indexOf('email')+1)+') THEN NULL ELSE email_verified_at END')
      if (resourceName === 'users' && columns.includes('phone')) assignments.push('"phone_verified_at" = CASE WHEN phone IS DISTINCT FROM $'+(columns.indexOf('phone')+1)+' THEN NULL ELSE phone_verified_at END')
      if (resourceName === 'users' && columns.includes('whatsapp_number')) assignments.push('"whatsapp_verified_at" = CASE WHEN whatsapp_number IS DISTINCT FROM $'+(columns.indexOf('whatsapp_number')+1)+' THEN NULL ELSE whatsapp_verified_at END')
      if (availableColumns.includes('updated_at')) assignments.push('"updated_at" = NOW()')
      const rows = await sql.query(
        `UPDATE "${resource.table}" SET ${assignments.join(', ')} WHERE id = $${values.length} RETURNING ${selectColumns}`,
        values,
      )
      if (!rows.length) return json(response, 404, { error: 'Record not found.' })
      if (resourceName === 'users' && columns.some(column => ['password_hash', 'role', 'is_active', 'email'].includes(column))) await sql.query('UPDATE admin_auth_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [id])
      return json(response, 200, { message: 'Record updated successfully.', [resource.responseKey]: publicRecord(resourceName, rows[0]) })
    }

    if (request.method === 'DELETE' && id) {
      if (resourceName === 'orders') return json(response, 409, { error: 'Orders are retained for audit and cannot be deleted by administrators.' })
      if (['products', 'categories'].includes(resourceName) && availableColumns.includes('is_active')) {
        const updatedAt = availableColumns.includes('updated_at') ? ', "updated_at" = NOW()' : ''
        const rows = await sql.query(`UPDATE "${resource.table}" SET "is_active" = FALSE${updatedAt} WHERE id = $1 RETURNING id`, [id])
        if (!rows.length) return json(response, 404, { error: 'Record not found.' })
        const label = resourceName === 'products' ? 'Product' : 'Category'
        return json(response, 200, { message: `${label} archived successfully.`, id: rows[0].id })
      }
      const rows = await sql.query(`DELETE FROM "${resource.table}" WHERE id = $1 RETURNING id`, [id])
      if (!rows.length) return json(response, 404, { error: 'Record not found.' })
      return json(response, 200, { message: 'Record deleted successfully.', id: rows[0].id })
    }

    response.setHeader('Allow', 'GET,POST,PUT,DELETE,OPTIONS')
    return json(response, 405, { error: 'Method not allowed.' })
  } catch (error) {
    return databaseError(response, error)
  }
}
