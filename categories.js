import { Router } from 'express'
import sql from './db.js'
import { authenticate, admin } from './auth.js'
import { notFound, page } from './utils.js'

const router = Router()
const resources = {
  categories: ['name', 'slug', 'description', 'display_order', 'is_active'],
  products: ['category_id', 'sku', 'name', 'slug', 'description', 'price', 'stock_quantity', 'image_url', 'is_active'],
}

const legacyImages = (value) => {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.filter((url) => /^https?:\/\//i.test(String(url)))
  } catch {
    // Older products store one URL directly.
  }
  return /^https?:\/\//i.test(String(value)) ? [String(value)] : []
}

const withProductImages = async (rows) => {
  if (!rows.length) return rows
  const ids = rows.map((row) => row.id)
  let mapped = []
  try {
    mapped = await sql.query(
      'SELECT product_id, blob_url, is_primary, sort_order FROM product_images WHERE product_id = ANY($1) ORDER BY is_primary DESC, sort_order, id',
      [ids],
    )
  } catch (error) {
    if (error.code !== '42P01') throw error
  }
  const byProduct = new Map()
  for (const image of mapped) {
    const key = String(image.product_id)
    byProduct.set(key, [...(byProduct.get(key) || []), image.blob_url])
  }
  return rows.map((product) => {
    const images = byProduct.get(String(product.id)) || legacyImages(product.image_url)
    return { ...product, image_url: images[0] || '', images }
  })
}

const withProductDetails = async (rows, req) => {
  rows = await withProductImages(rows)
  if (!rows.length) return rows
  const ids = rows.map((row) => row.id)
  const [colors, descriptions] = await Promise.all([
    sql.query('SELECT id,product_id,color,quantity FROM product_color WHERE product_id=ANY($1) ORDER BY product_id,color,id', [ids]),
    sql.query('SELECT * FROM product_description WHERE product_id=ANY($1)', [ids]),
  ])
  const colorsByProduct = new Map()
  for (const color of colors) colorsByProduct.set(String(color.product_id), [...(colorsByProduct.get(String(color.product_id)) || []), color])
  const descriptionsByProduct = new Map(descriptions.map((description) => [String(description.product_id), description]))
  return rows.map((product) => ({
    ...product,
    colors: colorsByProduct.get(String(product.id)) || [],
    product_description: descriptionsByProduct.get(String(product.id)) || null,
    description_url: descriptionsByProduct.has(String(product.id)) ? `${req.baseUrl}/products/${product.id}/description` : null,
  }))
}

router.get('/banners', async (req, res) => {
  const p = page(req.query)
  const count = await sql.query('SELECT COUNT(*)::int count FROM banners WHERE is_active=true')
  const rows = await sql.query(
    'SELECT * FROM banners WHERE is_active=true ORDER BY sort_order, id LIMIT $1 OFFSET $2',
    [p.limit, p.start],
  )
  res.set('X-Total-Count', count[0].count)
  return res.json(rows)
})

for (const [name, columns] of Object.entries(resources)) {
  router.get(`/${name}`, async (req, res) => {
    const p = page(req.query)
    const count = await sql.query(`SELECT COUNT(*)::int count FROM ${name} WHERE is_active=true`)
    let rows = await sql.query(`SELECT * FROM ${name} WHERE is_active=true ORDER BY id LIMIT $1 OFFSET $2`, [p.limit, p.start])
    if (name === 'products') rows = await withProductDetails(rows, req)
    res.set('X-Total-Count', count[0].count)
    return res.json(rows)
  })

  router.get(`/${name}/:id`, async (req, res) => {
    let rows = await sql.query(`SELECT * FROM ${name} WHERE id=$1 AND is_active=true`, [req.params.id])
    if (name === 'products') rows = await withProductDetails(rows, req)
    return rows[0] ? res.json(rows[0]) : notFound(res, name.slice(0, -1))
  })

  router.post(`/${name}`, authenticate, admin, async (req, res) => {
    const values = columns.map((key) => req.body[key] ?? null)
    const marks = values.map((_, index) => `$${index + 1}`)
    const rows = await sql.query(`INSERT INTO ${name}(${columns.join(',')})VALUES(${marks}) RETURNING *`, values)
    return res.status(201).json(rows[0])
  })

  router.put(`/${name}/:id`, authenticate, admin, async (req, res) => {
    const old = (await sql.query(`SELECT * FROM ${name} WHERE id=$1`, [req.params.id]))[0]
    if (!old) return notFound(res, name.slice(0, -1))
    const values = columns.map((key) => req.body[key] ?? old[key])
    values.push(req.params.id)
    const set = columns.map((key, index) => `${key}=$${index + 1}`).join(',')
    const rows = await sql.query(`UPDATE ${name} SET ${set},updated_at=NOW() WHERE id=$${values.length} RETURNING *`, values)
    return res.json(rows[0])
  })

  router.delete(`/${name}/:id`, authenticate, admin, async (req, res) => {
    const rows = await sql.query(`DELETE FROM ${name} WHERE id=$1 RETURNING *`, [req.params.id])
    return rows[0] ? res.json(rows[0]) : notFound(res, name.slice(0, -1))
  })
}


router.get('/products/:id/description', async (req, res) => {
  const rows = await sql.query('SELECT pd.* FROM product_description pd JOIN products p ON p.id=pd.product_id WHERE pd.product_id=$1 AND p.is_active=true', [req.params.id])
  return rows[0] ? res.json(rows[0]) : notFound(res, 'Product description')
})

router.get('/product-colors', authenticate, admin, async (req, res) => {
  const rows = await sql.query('SELECT pc.*,p.name product_name,p.sku FROM product_color pc JOIN products p ON p.id=pc.product_id ORDER BY p.name,pc.color,pc.id')
  res.set('X-Total-Count', rows.length)
  return res.json(rows)
})

router.get('/products/:id/colors', authenticate, admin, async (req, res) => {
  const rows = await sql.query('SELECT * FROM product_color WHERE product_id=$1 ORDER BY color,id', [req.params.id])
  res.set('X-Total-Count', rows.length)
  return res.json(rows)
})

router.post('/product-colors', authenticate, admin, async (req, res) => {
  const quantity = Number(req.body.quantity)
  if (!Number.isInteger(quantity) || quantity < 0 || !String(req.body.color || '').trim()) return res.status(400).json({ error: 'Color and a non-negative whole-number quantity are required.' })
  const rows = await sql.query('INSERT INTO product_color(product_id,color,quantity) VALUES($1,$2,$3) RETURNING *', [req.body.product_id, String(req.body.color).trim(), quantity])
  return res.status(201).json(rows[0])
})

router.put('/product-colors/:id', authenticate, admin, async (req, res) => {
  const old = (await sql.query('SELECT * FROM product_color WHERE id=$1', [req.params.id]))[0]
  if (!old) return notFound(res, 'Product color')
  const quantity = Number(req.body.quantity ?? old.quantity), color = String(req.body.color ?? old.color).trim()
  if (!Number.isInteger(quantity) || quantity < 0 || !color) return res.status(400).json({ error: 'Color and a non-negative whole-number quantity are required.' })
  const rows = await sql.query('UPDATE product_color SET color=$1,quantity=$2,updated_at=NOW() WHERE id=$3 RETURNING *', [color, quantity, req.params.id])
  return res.json(rows[0])
})

router.delete('/product-colors/:id', authenticate, admin, async (req, res) => {
  const rows = await sql.query('DELETE FROM product_color WHERE id=$1 RETURNING *', [req.params.id])
  return rows[0] ? res.json(rows[0]) : notFound(res, 'Product color')
})

router.put('/product-descriptions/:productId', authenticate, admin, async (req, res) => {
  const fields = ['title','dimensions','color_description','pattern_craft','catalogue_description','festive_note']
  const old = (await sql.query('SELECT * FROM product_description WHERE product_id=$1', [req.params.productId]))[0]
  const values = fields.map((field) => req.body[field] ?? old?.[field] ?? null)
  if (!String(values[0] || '').trim()) return res.status(400).json({ error: 'A description title is required.' })
  const rows = await sql.query(`INSERT INTO product_description(product_id,${fields.join(',')}) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(product_id) DO UPDATE SET ${fields.map((field,index)=>`${field}=$${index+2}`).join(',')},updated_at=NOW() RETURNING *`, [req.params.productId,...values])
  return res.json(rows[0])
})

export default router
