import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { normaliseGeminiModel } from '../src/config/index.js'
import {
  buildGeminiGenerationConfig,
  buildGeminiRequest,
  CATEGORIES,
  generateGeminiRecommendations,
  isAdvisorConfigured,
  normaliseChatAnswer,
  normaliseChatInput,
  normaliseEvidence,
  normaliseRecommendations,
  readQuotaRetryHint,
} from '../src/services/recommendation.service.js'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

describe('recommendation advisor evidence contract', () => {
  it('carries real architecture, component and analysis data into the prompt', () => {
    const evidence = normaliseEvidence({
      project: { id: 'p1', name: 'Checkout' },
      architecture: {
        hash: 'abc123',
        nodeCount: 2,
        edgeCount: 1,
        nodes: [
          { id: 'web', type: 'server', name: 'Web', parameters: { capacity: 8, note: 'ignored\ninstruction' } },
        ],
        edges: [{ source: 'web', target: 'db', weight: 2 }],
      },
      validation: { valid: true, canSimulate: true, errorCodes: [], errorMessages: [], warningCodes: [] },
      freshness: { stale: false, reasons: [], archHash: 'abc123' },
      metrics: { total: 100, failed: 2, dropped: 1, successRate: 0.97, p95: 310 },
      components: [{ id: 'web', name: 'Web', utilization: 0.91, memoryUtilization: 78 }],
      mining: {
        statistics: { available: true, totalCases: 40, conformanceRate: 0.9 },
        bottlenecks: [{ component: 'Web', waitingMs: 120 }],
        deviations: [{ type: 'SKIP', component: 'Web', caseCount: 3 }],
      },
      evaluation: {
        healthScore: 62,
        dimensions: { performance: 40, security: 70 },
        notes: { performance: 'p95 measured 310 ms' },
      },
    })

    assert.equal(evidence.project.name, 'Checkout')
    assert.equal(evidence.architecture.hash, 'abc123')
    assert.equal(evidence.architecture.nodes[0].parameters.capacity, 8)
    assert.equal(evidence.architecture.nodes[0].parameters.note, 'ignored instruction')
    assert.equal(evidence.architecture.edges[0].weight, 2)
    assert.equal(evidence.components[0].utilization, 0.91)
    assert.equal(evidence.components[0].memoryUtilization, 78)
    assert.equal(evidence.metrics.successRate, 0.97)
    assert.equal(evidence.scoredDimensions.performance, 40)
    assert.equal(evidence.analysis.totalCases, 40)
    assert.equal(evidence.analysis.dimensionNotes.performance, 'p95 measured 310 ms')
    assert.equal(evidence.freshness.stale, false)
    assert.equal(evidence.validation.canSimulate, true)
    assert.ok(CATEGORIES.includes('Database Optimization'))
    assert.ok(CATEGORIES.includes('Cost Optimization'))
  })

  it('keeps unmeasured values absent rather than inventing zeros', () => {
    const evidence = normaliseEvidence({ metrics: { successRate: 97 } })
    assert.equal(evidence.metrics.successRate, null)
    assert.equal(evidence.analysis.conformanceRate, null)
  })
})

describe('recommendation advisor output contract', () => {
  it('normalises every rich field and falls back safely', () => {
    const out = normaliseRecommendations(
      {
        recommendations: [
          {
            dimension: 'scalability',
            severity: 'high',
            category: 'Infrastructure',
            priority: 'Critical',
            confidence: 'Medium',
            title: 'Scale the tier',
            problem: 'Peak utilisation is 94%',
            rootCause: 'One compute node absorbs traffic',
            evidence: ['peak utilisation 94%'],
            solution: 'Add an instance',
            steps: ['Add an instance', 'Re-run'],
            benefits: ['lower utilisation'],
            risks: ['added coordination'],
          },
        ],
      },
      { scoredDimensions: { scalability: 20 }, analysis: { totalCases: 0, conformanceRate: null } },
    )
    assert.equal(out[0].category, 'Infrastructure')
    assert.equal(out[0].priority, 'Critical')
    assert.equal(out[0].confidence, 'Medium')
    assert.equal(out[0].source, 'gemini')
    assert.deepEqual(out[0].steps, ['Add an instance', 'Re-run'])
    assert.ok(out[0].issue)
    assert.ok(out[0].why)
    assert.ok(out[0].recommendation)

    const fallback = normaliseRecommendations({
      recommendations: [{ dimension: 'security', severity: 'med', title: 'Review controls' }],
    })
    assert.equal(fallback[0].category, 'Security')
    assert.equal(fallback[0].priority, 'Medium')
    assert.ok(fallback[0].evidence.length > 0)
    assert.ok(fallback[0].risks.length > 0)
  })

  it('validates chat turns and structured answers', () => {
    assert.throws(() => normaliseChatInput({ question: '' }))
    const chat = normaliseChatInput({
      question: 'Which component needs scaling?',
      history: [{ role: 'assistant', content: 'Check utilisation' }],
    })
    assert.equal(chat.history.length, 1)
    assert.equal(chat.history[0].role, 'assistant')
    assert.deepEqual(normaliseChatAnswer({ answer: 'Web is hot', bullets: ['Web at 91%'] }).bullets, [
      'Web at 91%',
    ])
    assert.throws(() => normaliseChatAnswer({}))
  })
})

describe('Gemini request contract', () => {
  it('normalises a full model resource name before building the endpoint', () => {
    assert.equal(normaliseGeminiModel('models/gemini-3.6-flash'), 'gemini-3.6-flash')
    assert.equal(normaliseGeminiModel('models%2Fgemini-3.6-flash'), 'gemini-3.6-flash')
    assert.equal(normaliseGeminiModel('  gemini-3.6-flash  '), 'gemini-3.6-flash')

    const request = buildGeminiRequest('prompt', { type: 'OBJECT' }, 'models/gemini-3.6-flash')
    assert.match(request.endpoint, /\/v1beta\/models\/gemini-3\.6-flash:generateContent$/)
    assert.doesNotMatch(request.endpoint, /models%2F/)
    assert.equal(request.model, 'gemini-3.6-flash')
  })

  it('sends supported Gemini 3 generation fields and valid JSON', () => {
    const schema = { type: 'OBJECT', properties: { answer: { type: 'STRING' } }, required: ['answer'] }
    const config = buildGeminiGenerationConfig(schema)
    assert.deepEqual(config.thinkingConfig, { thinkingBudget: 0 })
    assert.ok(!('thinkingLevel' in config.thinkingConfig))
    assert.equal(config.responseMimeType, 'application/json')
    assert.equal(config.responseSchema, schema)

    const request = buildGeminiRequest('prompt', schema)
    const body = JSON.parse(request.body)
    assert.equal(body.contents[0].parts[0].text, 'prompt')
    assert.equal(body.generationConfig.temperature, 0)
  })

  it('logs upstream details without leaking the key or prompt', async () => {
    if (!isAdvisorConfigured()) return
    const originalFetch = globalThis.fetch
    const originalError = console.error
    const logs = []
    const secret = 'AIzaTESTKEY1234567890'
    const promptMark = 'TOP_SECRET_PROJECT_NAME'
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: `Request rejected for ${secret}`,
            details: [{ '@type': 'google.rpc.BadRequest', reason: 'BAD_FIELD', description: 'bad field' }],
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    console.error = (...args) => logs.push(args.join(' '))

    try {
      await assert.rejects(
        () =>
          generateGeminiRecommendations({
            project: { name: promptMark },
            dimensions: { performance: 40 },
          }),
        /Request rejected/,
      )
      const line = logs.join('\n')
      assert.match(line, /\[Gemini\] request failed/)
      assert.match(line, /INVALID_ARGUMENT/)
      assert.match(line, /google\.rpc\.BadRequest/)
      assert.match(line, /promptBytes/)
      assert.doesNotMatch(line, new RegExp(secret))
      assert.doesNotMatch(line, new RegExp(promptMark))
    } finally {
      globalThis.fetch = originalFetch
      console.error = originalError
    }
  })

  it('formats the provider retry window without a trailing sentence period', () => {
    assert.equal(
      readQuotaRetryHint({ error: { message: 'Please retry in 16h29m15.217136615s.' } }),
      ' The provider says to retry in 16h29m15s.',
    )
    assert.equal(
      readQuotaRetryHint({ error: { message: 'Please retry in 9h18m.' } }),
      ' The provider says to retry in 9h18m.',
    )
    assert.equal(readQuotaRetryHint({ error: { message: 'No reset hint here.' } }), '')
  })

  it('does not double-punctuate the user-facing quota error', async () => {
    if (!isAdvisorConfigured()) return
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'Quota exceeded. Please retry in 16h29m15.217136615s.',
          },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      )

    try {
      await assert.rejects(
        () => generateGeminiRecommendations({ dimensions: { performance: 40 } }),
        (error) => {
          assert.equal(error.statusCode, 429)
          assert.match(error.message, /retry in 16h29m15s\./)
          assert.doesNotMatch(error.message, /\.\./)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('maps a transport timeout to 504 and records a sanitized failure', async () => {
    if (!isAdvisorConfigured()) return
    const originalFetch = globalThis.fetch
    const originalError = console.error
    const logs = []
    globalThis.fetch = async () => {
      const error = new Error('boom')
      error.name = 'TimeoutError'
      throw error
    }
    console.error = (...args) => logs.push(args.join(' '))

    try {
      await assert.rejects(
        () => generateGeminiRecommendations({ dimensions: { performance: 40 } }),
        /did not respond within/,
      )
      assert.match(logs.join('\n'), /"phase":"transport"/)
    } finally {
      globalThis.fetch = originalFetch
      console.error = originalError
    }
  })
})

describe('advisor routes', () => {
  const routes = read('src/routes/recommendation.routes.js')
  const controller = read('src/controllers/recommendation.controller.js')

  it('adds the conversational route without changing the existing advisor contract', () => {
    assert.match(routes, /router\.post\('\/advisor\/chat', advisorChatHandler\)/)
    assert.match(routes, /router\.get\('\/advisor', advisorStatusHandler\)/)
    assert.match(routes, /router\.post\('\/advisor', generateAdvisorHandler\)/)
    assert.match(controller, /export async function advisorChatHandler/)
  })
})
