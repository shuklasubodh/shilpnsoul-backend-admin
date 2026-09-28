import crypto from 'node:crypto'
import sql from './db.js'

const digest = (value) => crypto.createHash('sha256').update(String(value || 'anonymous')).digest('hex')

export const requestIdentity = (req, value = '') => digest(`${req.ip || req.socket?.remoteAddress || 'unknown'}:${value}`)

export const consumeRateLimit = async ({ scope, identity, maxAttempts, windowSeconds, blockSeconds = windowSeconds }) => {
  const key = `${scope}:${digest(identity)}`
  const rows = await sql.query(`
    INSERT INTO security_rate_limits(rate_key,attempts,window_started_at,blocked_until,updated_at)
    VALUES($1,1,NOW(),NULL,NOW())
    ON CONFLICT(rate_key) DO UPDATE SET
      attempts=CASE WHEN security_rate_limits.window_started_at<=NOW()-($2::int*INTERVAL '1 second') THEN 1 ELSE security_rate_limits.attempts+1 END,
      window_started_at=CASE WHEN security_rate_limits.window_started_at<=NOW()-($2::int*INTERVAL '1 second') THEN NOW() ELSE security_rate_limits.window_started_at END,
      blocked_until=CASE
        WHEN security_rate_limits.blocked_until>NOW() THEN security_rate_limits.blocked_until
        WHEN security_rate_limits.window_started_at>NOW()-($2::int*INTERVAL '1 second') AND security_rate_limits.attempts+1>$3 THEN NOW()+($4::int*INTERVAL '1 second')
        ELSE NULL END,
      updated_at=NOW()
    RETURNING attempts,blocked_until
  `,[key,windowSeconds,maxAttempts,blockSeconds])
  return !rows[0]?.blocked_until || new Date(rows[0].blocked_until) <= new Date()
}

export const rateLimit = ({ scope, maxAttempts, windowSeconds, blockSeconds, value = () => '' }) => async (req, res, next) => {
  try {
    const allowed = await consumeRateLimit({ scope, identity: requestIdentity(req, value(req)), maxAttempts, windowSeconds, blockSeconds })
    if (!allowed) return res.status(429).json({ error: 'Too many requests. Please try again later.' })
    return next()
  } catch (error) {
    console.error('Security rate limit failed',{scope,error:error.message})
    return res.status(503).json({ error: 'Security controls are temporarily unavailable.' })
  }
}
