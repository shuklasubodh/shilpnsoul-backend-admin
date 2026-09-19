import { Router } from 'express'
import sharp from 'sharp'

const router = Router()
const widths = new Set([480, 960])

router.get('/images/mobile', async (req, res) => {
  let source
  try {
    source = new URL(String(req.query.url || ''))
  } catch {
    return res.status(400).json({ error: 'A valid product image URL is required.' })
  }
  const width = Number(req.query.width)
  if (source.protocol !== 'https:' || !source.hostname.endsWith('.public.blob.vercel-storage.com') || !source.pathname.startsWith('/products/') || !widths.has(width)) {
    return res.status(400).json({ error: 'Only product images in Vercel Blob and supported mobile widths are allowed.' })
  }
  try {
    const result = await fetch(source, { signal: AbortSignal.timeout(15000) })
    if (!result.ok) return res.status(502).json({ error: 'The source image could not be loaded.' })
    const contentLength = Number(result.headers.get('content-length') || 0)
    if (contentLength > 20 * 1024 * 1024) return res.status(413).json({ error: 'Source image exceeds 20 MB.' })
    const original = Buffer.from(await result.arrayBuffer())
    if (original.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'Source image exceeds 20 MB.' })
    const image = await sharp(original, { failOn: 'none', limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 72, effort: 4 })
      .toBuffer()
    res.set('Content-Type', 'image/webp')
    res.set('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable')
    return res.send(image)
  } catch (error) {
    console.error('[mobile-image] Optimization failed:', error)
    return res.status(502).json({ error: 'The product image could not be optimized.' })
  }
})

export default router
