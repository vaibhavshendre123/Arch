import { env } from '../config/index.js'
import { ApiError } from './errorHandler.js'

// A bucket map is only swept once it grows past this, so the common path costs one lookup.
const SWEEP_THRESHOLD = 10000

/**
 * Fixed-window, in-process rate limiter.
 *
 * This is a single-instance control, not a distributed quota: it exists to blunt
 * credential-stuffing and account-enumeration bursts against the two unauthenticated auth
 * routes. If the backend is ever run as more than one instance, this has to move to a
 * shared store, because each instance would otherwise count independently.
 *
 * The key is the client IP. `app.set('trust proxy', 1)` is already in place, so the IP is
 * the one the proxy saw rather than the proxy itself.
 */
export function createRateLimiter({ windowMs, max, name }) {
  const buckets = new Map()

  function sweep(now) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key)
    }
  }

  return function rateLimit(req, res, next) {
    const now = Date.now()
    const client = req.ip || req.socket?.remoteAddress || 'unknown'
    const key = `${name}:${client}`

    let bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      buckets.set(key, bucket)
      if (buckets.size > SWEEP_THRESHOLD) sweep(now)
    }

    bucket.count += 1
    const remaining = Math.max(0, max - bucket.count)
    res.setHeader('RateLimit-Limit', String(max))
    res.setHeader('RateLimit-Remaining', String(remaining))
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)))

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      res.setHeader('Retry-After', String(retryAfter))
      next(new ApiError(429, 'Too many attempts. Please wait and try again.'))
      return
    }

    next()
  }
}

/**
 * The two unauthenticated auth routes get independent buckets, so a login burst cannot
 * lock out registration (or the reverse).
 */
export const registerRateLimit = createRateLimiter({
  windowMs: env.authRateWindowMs,
  max: env.authRateMax,
  name: 'register',
})

export const loginRateLimit = createRateLimiter({
  windowMs: env.authRateWindowMs,
  max: env.authRateMax,
  name: 'login',
})
