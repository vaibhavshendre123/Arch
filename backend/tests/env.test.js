import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { assertEnv, envProblems } from '../src/config/index.js'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

describe('boot-time environment validation', () => {
  it('accepts an environment where every optional value is unset', () => {
    // A bare clone must still boot: defaults cover the absent values.
    assert.deepEqual(envProblems({}), [])
  })

  it('accepts a fully valid production configuration', () => {
    const problems = envProblems({
      NODE_ENV: 'production',
      PORT: '5000',
      API_PREFIX: '/api',
      LOG_REQUESTS: 'false',
      CLIENT_URL: 'https://arch.example.edu',
      CORS_ORIGINS: 'https://arch.example.edu, http://localhost:5173',
      JWT_SECRET: 'x'.repeat(64),
      MONGO_URI: 'mongodb+srv://user:pass@cluster.example.net/archai',
      MONGO_DNS_SERVERS: '1.1.1.1,8.8.8.8',
      AUTH_RATE_MAX: '20',
      GEMINI_TIMEOUT_MS: '90000',
    })
    assert.deepEqual(problems, [])
  })

  it('rejects a port that is not a usable port number', () => {
    for (const port of ['50o0', '0', '70000', '-1', 'five']) {
      const problems = envProblems({ PORT: port })
      assert.equal(problems.length, 1, `PORT=${port} should be rejected`)
      assert.match(problems[0], /^PORT /)
    }
  })

  it('rejects an unknown NODE_ENV', () => {
    assert.match(envProblems({ NODE_ENV: 'staging' })[0], /^NODE_ENV /)
  })

  it('rejects a prefix that does not start with a slash', () => {
    assert.match(envProblems({ API_PREFIX: 'api' })[0], /^API_PREFIX /)
  })

  it('rejects LOG_REQUESTS values that are not true or false', () => {
    assert.equal(envProblems({ LOG_REQUESTS: 'yes' }).length, 1)
    assert.deepEqual(envProblems({ LOG_REQUESTS: 'false' }), [])
  })

  it('rejects a malformed origin', () => {
    assert.match(envProblems({ CLIENT_URL: 'localhost:5173' })[0], /^CLIENT_URL /)
    assert.match(envProblems({ CORS_ORIGINS: 'http://ok.example, nope' })[0], /^CORS_ORIGINS /)
    assert.deepEqual(envProblems({ CORS_ORIGINS: '*' }), [])
  })

  it('rejects a JWT secret that is present but too short to be worth having', () => {
    assert.match(envProblems({ JWT_SECRET: 'short' })[0], /JWT_SECRET must be at least 16/)
  })

  it('requires the secrets in production that development can do without', () => {
    const problems = envProblems({ NODE_ENV: 'production' })
    assert.ok(problems.some((p) => p.includes('JWT_SECRET')))
    assert.ok(problems.some((p) => p.includes('MONGO_URI')))
  })

  it('reports every problem at once rather than one per restart', () => {
    const problems = envProblems({ NODE_ENV: 'staging', PORT: 'no', LOG_REQUESTS: 'on' })
    assert.equal(problems.length, 3)
  })

  it('assertEnv throws with the problems listed', () => {
    assert.throws(
      () => assertEnv({ PORT: 'abc', NODE_ENV: 'staging' }),
      (error) => {
        assert.match(error.message, /Invalid environment configuration/)
        assert.match(error.message, /PORT /)
        assert.match(error.message, /NODE_ENV /)
        return true
      },
    )
    // Must not throw on a good environment.
    assert.doesNotThrow(() => assertEnv({ PORT: '5000' }))
  })

  it('the server refuses to start before it touches the database', () => {
    const server = read('src/server.js')
    const assertIndex = server.indexOf('assertEnv()')
    const connectIndex = server.indexOf('connectDatabase()')
    assert.ok(assertIndex > -1, 'server.js must call assertEnv()')
    assert.ok(
      assertIndex < connectIndex,
      'the env check must run before the database connection is attempted',
    )
  })
})
