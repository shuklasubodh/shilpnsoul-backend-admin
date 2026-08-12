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
    if (name === 'products') rows = await withProductImages(rows)
    res.set('X-Total-Count', count[0].count)
    return res.json(rows)
  })

  router.get(`/${name}/:id`, async (req, res) => {
    let rows = await sql.query(`SELECT * FROM ${name} WHERE id=$1 AND is_active=true`, [req.params.id])
    if (name === 'products') rows = await withProductImages(rows)
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

export default router
