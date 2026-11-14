import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { validateRegistration } from '../src/services/auth.service.js'
import { createRateLimiter } from '../src/middleware/rateLimit.js'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

describe('registration validation', () => {
  it('accepts a well-formed registration', () => {
    const result = validateRegistration({ name: 'Ada Lovelace', email: 'ada@example.com', password: 'secret1' })
    assert.equal(result.valid, true)
    assert.deepEqual(result.errors, {})
  })

  it('rejects each missing field independently', () => {
    const { valid, errors } = validateRegistration({})
    assert.equal(valid, false)
    assert.ok(errors.name)
    assert.ok(errors.email)
    assert.ok(errors.password)
  })

  it('rejects a short password and a malformed email', () => {
    const { errors } = validateRegistration({ name: 'Ada', email: 'nope', password: '123' })
    assert.match(errors.password, /at least 6/)
    assert.match(errors.email, /valid email/)
  })
})

describe('registration cannot mint a privileged account', () => {
  it('the service assigns the default role itself', () => {
    const source = read('src/services/auth.service.js')
    // The parameter list must not accept a role, or a crafted body could reach it.
    assert.doesNotMatch(source, /export async function register\(\{[^}]*role/)
    assert.match(source, /role: 'student'/)
  })

  it('the controller does not forward a client-supplied role', () => {
    const source = read('src/controllers/auth.controller.js')
    assert.doesNotMatch(source, /req\.body[^\n]*role/)
    assert.match(source, /register\(\{ name, email, password \}\)/)
  })
})

function fakeRes() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
  }
}

function call(limiter, ip) {
  return new Promise((resolve) => {
    const req = { ip, socket: {} }
    const res = fakeRes()
    limiter(req, res, (err) => resolve({ err, res }))
  })
}

describe('auth rate limiter', () => {
  it('allows attempts up to the limit and rejects the next one', async () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 2, name: 'test' })

    assert.equal((await call(limiter, '10.0.0.1')).err, undefined)
    assert.equal((await call(limiter, '10.0.0.1')).err, undefined)

    const blocked = await call(limiter, '10.0.0.1')
    assert.ok(blocked.err, 'the attempt past the limit must be rejected')
    assert.equal(blocked.err.statusCode, 429)
    assert.equal(blocked.res.headers['ratelimit-remaining'], '0')
    assert.ok(Number(blocked.res.headers['retry-after']) >= 1)
  })

  it('counts each client independently', async () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1, name: 'test' })

    assert.equal((await call(limiter, '10.0.0.1')).err, undefined)
    // A different address must not inherit the first address's exhausted bucket.
    assert.equal((await call(limiter, '10.0.0.2')).err, undefined)
    assert.equal((await call(limiter, '10.0.0.1')).err?.statusCode, 429)
  })

  it('reports the limit on every response, including successful ones', async () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 5, name: 'test' })
    const { res } = await call(limiter, '10.0.0.9')
    assert.equal(res.headers['ratelimit-limit'], '5')
    assert.equal(res.headers['ratelimit-remaining'], '4')
  })

  it('the auth routes actually use the limiter', () => {
    const routes = read('src/routes/auth.routes.js')
    assert.match(routes, /router\.post\('\/register', registerRateLimit, registerUser\)/)
    assert.match(routes, /router\.post\('\/login', loginRateLimit, loginUser\)/)
  })
})
