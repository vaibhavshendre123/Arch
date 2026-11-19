import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const service = read('backend/src/services/recommendation.service.js')
const config = read('backend/src/config/index.js')
const api = read('src/services/api.js')

describe('advisor timeouts are durations, not ports', () => {
  it('does not reuse the port validator for a timeout', () => {
    // toPort rejects anything >= 65536, so routing a timeout through it silently reset
    // GEMINI_TIMEOUT_MS to the 20 s default for every value the user could plausibly try.
    assert.match(config, /function toDuration\(/)
    assert.match(config, /geminiTimeoutMs: toDuration\(process\.env\.GEMINI_TIMEOUT_MS/)
    assert.doesNotMatch(config, /geminiTimeoutMs: toPort\(/)
  })

  it('allows a timeout far beyond the 16-bit port ceiling', () => {
    const body = config.slice(config.indexOf('function toDuration'))
    const fn = body.slice(0, body.indexOf('\n}'))
    assert.doesNotMatch(fn, /65536/, 'a duration limit must not be a port limit')
    assert.match(fn, /10 \* 60 \* 1000/)
  })

  it('keeps the port validator for actual ports', () => {
    assert.match(config, /port: toPort\(process\.env\.PORT/)
    assert.match(config, /apiPrefix: process\.env\.API_PREFIX/)
  })
})

describe('the browser waits longer than the backend', () => {
  // The client file explains in a comment why the old message was wrong, so assertions run
  // against the code with comments stripped.
  const code = api.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('no longer uses a 20 s axios timeout', () => {
    // The advisor proxies a language-model call. At 20 s the browser gave up first and
    // reported "Is the backend running?" while the backend was still working.
    assert.doesNotMatch(code, /timeout:\s*20000/)
    assert.match(code, /timeout: Number\(import\.meta\.env\.VITE_API_TIMEOUT_MS\) \|\| 120000/)
  })

  it('does not blame the backend for a slow model', () => {
    assert.doesNotMatch(code, /Request timed out\. Is the backend running\?/)
    assert.match(code, /The Gemini advisor can take a minute under load/)
  })

  it('still reports an unreachable backend clearly', () => {
    assert.match(code, /Cannot reach the backend/)
  })
})

describe('the advisor retries only what retrying can fix', () => {
  it('retries 503 high demand', () => {
    // Measured: the free tier answers "high demand" on most 3.8-flash calls and it clears
    // within seconds, so backing off turns a failure into a slower success.
    assert.match(service, /const RETRY_STATUS = new Set\(\[500, 503, 504\]\)/)
  })

  it('does not retry a quota rejection', () => {
    // A 429 does not clear in seconds. Retrying it three more times inside a few seconds
    // burns more of the quota it is already out of and hides the error the user needs.
    const set = service.slice(service.indexOf('const RETRY_STATUS'))
    assert.doesNotMatch(set.slice(0, set.indexOf(']')), /429/)
  })

  it('uses jittered exponential backoff over several attempts', () => {
    assert.match(service, /1000 \* 2 \*\* \(attempts - 1\)/)
    assert.match(service, /0\.8 \+ Math\.random\(\) \* 0\.4/)
    assert.match(service, /geminiMaxAttempts/)
  })

  it('reads the retry budget from configuration', () => {
    assert.match(config, /geminiMaxAttempts: toDuration\(process\.env\.GEMINI_MAX_ATTEMPTS/)
  })
})

describe('the advisor prompt sends a verified Gemini 3 generation config', () => {
  it('keeps zero thinking for the configured model', () => {
    // Verified with a live generateContent call: thinkingBudget 0 returns structured JSON
    // immediately, while thinkingLevel variants made the same real payload time out.
    assert.match(service, /thinkingConfig: \{ thinkingBudget: 0 \}/)
  })

  it('keeps enough output budget for six written findings', () => {
    assert.match(service, /maxOutputTokens: 8192/)
  })

  it('normalises a full models/... resource name before building the endpoint', () => {
    assert.match(config, /export function normaliseGeminiModel/)
    assert.match(config, /model\.startsWith\('models\/'\)/)
    assert.match(service, /encodeURIComponent\(\s*modelId,\s*\)/)
  })

  it('logs failures without the prompt, key or evidence', () => {
    assert.match(service, /console\.error\('\[Gemini\] request failed'/)
    assert.ok(service.includes('AIza[0-9A-Za-z_-]'))
    assert.match(service, /promptBytes: promptText \? Buffer\.byteLength\(promptText\) : 0/)
    assert.doesNotMatch(service, /console\.(log|error)\([^)]*requestBody[^)]*\)/)
  })
})

describe('failure messages name the real cause', () => {
  it('a timeout suggests what to do about it', () => {
    assert.match(service, /did not respond within/)
    assert.match(service, /less busy model/)
  })

  it('a 503 names the model and the attempt count', () => {
    assert.match(service, /at capacity after \$\{attempts\} attempt/)
    assert.match(service, /less busy one such as/)
  })

  it('a 429 quotes the provider reset hint instead of guessing the window', () => {
    // The free tier enforces both a per-minute and a per-day cap; only the provider knows
    // which one was hit.
    assert.match(service, /function readQuotaRetryHint/)
    assert.match(service, /function formatRetryWindow/)
    assert.match(service, /The provider says to retry in \$\{formatRetryWindow\(match\[1\]\)\}\./)
    assert.doesNotMatch(service, /\[\\dhms\.\]\+/)
    assert.match(service, /used up its free-tier quota for \$\{env\.geminiModel\}/)
  })
})

describe('the rule-based baseline stays the fallback', () => {
  const page = read('src/pages/Recommendations.jsx')

  it('the baseline never depends on the Gemini arm', () => {
    // The deterministic rules are the point of the page: they must render whether or not
    // the AI arm is configured, quota-exhausted or broken.
    assert.match(page, /The baseline below is unaffected\./)
  })

  it('still reports when Gemini is not configured', () => {
    assert.match(page, /advisor\.state === 'unconfigured'/)
  })
})