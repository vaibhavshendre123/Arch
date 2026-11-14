import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
export const backendRoot = path.resolve(here, '..', '..')

dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true })

function toPort(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback
}

/**
 * Millisecond durations. Deliberately separate from toPort: a port can never exceed 65535,
 * but a timeout legitimately can. Routing GEMINI_TIMEOUT_MS through toPort meant any value
 * of 65536 ms or more was silently rejected and reset to the 20 s default, so raising the
 * advisor timeout above ~65 s appeared to have no effect at all.
 */
function toDuration(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 10 * 60 * 1000 ? parsed : fallback
}

/**
 * Small positive integer counts. Separate from toDuration because a retry count is not a
 * duration and must not be capped like one.
 */
function toCount(value, fallback, max = 100000) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback
}

function toList(value) {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function toDnsServers(value) {
  const list = toList(value)
  const valid = list.filter((server) => /^\d{1,3}(\.\d{1,3}){3}$/.test(server))
  return valid.length ? valid : null
}

function isOrigin(value) {
  if (value === '*') return true
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const nodeEnv = process.env.NODE_ENV || 'development'
const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'

const defaultDevOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]

export const env = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: toPort(process.env.PORT, 5000),
  apiPrefix: process.env.API_PREFIX || '/api',
  clientUrl,
  corsOrigins: toList(process.env.CORS_ORIGINS).length
    ? toList(process.env.CORS_ORIGINS)
    : [...defaultDevOrigins, clientUrl],
  logRequests: process.env.LOG_REQUESTS !== 'false',
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017',
  dbName: process.env.DB_NAME || 'archai',
  mongoServerSelectionTimeoutMs: toPort(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 10000),
  dnsServers: toDnsServers(process.env.MONGO_DNS_SERVERS),
  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  bcryptRounds: toPort(process.env.BCRYPT_ROUNDS, 10),
  // Unauthenticated auth routes are the cheapest surface to brute-force. A fixed window
  // per IP is deliberately generous: it blunts credential stuffing without locking out a
  // shared office or campus NAT after a handful of typos. Test harnesses raise the max.
  authRateWindowMs: toDuration(process.env.AUTH_RATE_WINDOW_MS, 10 * 60 * 1000),
  authRateMax: toCount(process.env.AUTH_RATE_MAX, 20),
  // Read only from the backend environment. Anything prefixed VITE_ is compiled into
  // the public browser bundle, so the key must never live there.
  geminiApiKey: (process.env.GEMINI_API_KEY || '').trim(),
  geminiModel: (process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim(),
  // A reasoning model can spend well over 20 s on a cold call, and the free tier answers
  // 503 under demand, so this budget has to cover retries as well as a single attempt.
  geminiTimeoutMs: toDuration(process.env.GEMINI_TIMEOUT_MS, 90000),
  // Transient 503/429 answers are retried with jittered exponential backoff.
  geminiMaxAttempts: toDuration(process.env.GEMINI_MAX_ATTEMPTS, 4),
  advisorWindowMs: toDuration(process.env.ADVISOR_WINDOW_MS, 60000),
  advisorMaxPerWindow: toDuration(process.env.ADVISOR_MAX_PER_WINDOW, 10),
})

/**
 * Configuration problems that must stop the process rather than be silently replaced by a
 * default.
 *
 * The parsers above deliberately fall back when a value is absent, so a bare clone still
 * boots. But a value that IS set and cannot be understood is a typo the operator needs to
 * see: silently serving on port 5000 because PORT was "50o0" is worse than refusing to
 * start. This runs from server.js at boot, not at import, so a test that imports config
 * is never affected.
 */
export function envProblems(source = process.env) {
  const problems = []

  const whenSet = (name, check, expectation) => {
    const raw = source[name]
    if (raw === undefined || raw === '') return
    if (!check(String(raw))) problems.push(`${name} ${expectation} (got "${raw}")`)
  }
  const intIn = (min, max) => (raw) => {
    const n = Number(raw)
    return Number.isInteger(n) && n >= min && n <= max
  }

  whenSet('NODE_ENV', (v) => ['development', 'production', 'test'].includes(v), 'must be development, production or test')
  whenSet('PORT', intIn(1, 65535), 'must be an integer between 1 and 65535')
  whenSet('API_PREFIX', (v) => v.startsWith('/'), 'must start with "/"')
  whenSet('LOG_REQUESTS', (v) => v === 'true' || v === 'false', 'must be "true" or "false"')
  whenSet('BCRYPT_ROUNDS', intIn(4, 31), 'must be an integer between 4 and 31')
  whenSet('MONGO_SERVER_SELECTION_TIMEOUT_MS', intIn(1, 600000), 'must be a positive integer of at most 600000')
  whenSet('AUTH_RATE_WINDOW_MS', intIn(1, 600000), 'must be a positive integer of at most 600000')
  whenSet('AUTH_RATE_MAX', intIn(1, 100000), 'must be an integer between 1 and 100000')
  whenSet('GEMINI_TIMEOUT_MS', intIn(1, 600000), 'must be a positive integer of at most 600000')
  whenSet('GEMINI_MAX_ATTEMPTS', intIn(1, 10), 'must be an integer between 1 and 10')
  whenSet('ADVISOR_WINDOW_MS', intIn(1, 600000), 'must be a positive integer of at most 600000')
  whenSet('ADVISOR_MAX_PER_WINDOW', intIn(1, 10000), 'must be an integer between 1 and 10000')
  whenSet('CLIENT_URL', isOrigin, 'must be an http(s) origin')
  whenSet(
    'CORS_ORIGINS',
    (v) => v.split(',').every((item) => isOrigin(item.trim())),
    'must be a comma-separated list of http(s) origins',
  )
  whenSet(
    'MONGO_DNS_SERVERS',
    (v) => v.split(',').every((item) => /^\d{1,3}(\.\d{1,3}){3}$/.test(item.trim())),
    'must be a comma-separated list of IPv4 addresses',
  )

  // A secret that is present but trivially short is worse than no secret at all, because it
  // looks configured.
  if (source.JWT_SECRET && source.JWT_SECRET.length < 16) {
    problems.push('JWT_SECRET must be at least 16 characters')
  }

  if (source.NODE_ENV === 'production') {
    if (!source.JWT_SECRET) problems.push('JWT_SECRET is required in production')
    if (!source.MONGO_URI) problems.push('MONGO_URI is required in production')
  }

  return problems
}

export function assertEnv(source = process.env) {
  const problems = envProblems(source)
  if (problems.length) {
    throw new Error(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`)
  }
}
