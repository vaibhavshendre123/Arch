import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ApiError, errorHandler } from '../src/middleware/errorHandler.js'

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}

function run(err, req = { method: 'GET', originalUrl: '/api/x', id: 'req-1' }) {
  const res = fakeRes()
  const originalError = console.error
  const logged = []
  // Keep the test output readable: errorHandler logs every 5xx.
  console.error = (line) => logged.push(String(line))
  try {
    errorHandler(err, req, res, () => {})
  } finally {
    console.error = originalError
  }
  return { res, logged }
}

describe('error handler', () => {
  it('never exposes an unexpected 5xx message to the caller', () => {
    const err = new Error('mongodb://user:password@host exploded')
    const { res } = run(err)
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.error.message, 'Internal server error')
    assert.equal(res.body.error.requestId, 'req-1')
  })

  it('logs only the message and the request id, never the error object', () => {
    const err = new Error('driver detail with credentials')
    err.stack = 'STACK WITH SECRETS'
    const { logged } = run(err)
    const line = logged.join('\n')
    assert.match(line, /driver detail with credentials/)
    assert.match(line, /req-1/)
    assert.doesNotMatch(line, /STACK WITH SECRETS/)
  })

  it('passes an operational 4xx message and its field details through', () => {
    const err = new ApiError(400, 'Validation failed', { email: 'Email is required.' })
    const { res } = run(err)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error.message, 'Validation failed')
    assert.deepEqual(res.body.error.details, { email: 'Email is required.' })
  })

  it('includes the request id on a 404 so the caller can quote it', () => {
    const { res } = run(new ApiError(404, 'Route not found'), { method: 'GET', originalUrl: '/nope', id: 'abc' })
    assert.equal(res.body.error.requestId, 'abc')
  })
})
