import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { archHash as contractHash, toContract } from '../src/lib/contract.js'
import { runSimulation } from '../src/lib/engine.js'
import { mineEventLog, miningOptions, miningProvenance } from '../src/lib/mining.js'
import { evaluateArchitecture } from '../src/lib/evaluation.js'
import {
  buildRecommendations,
  RECOMMENDATION_CATEGORIES,
} from '../src/lib/recommendations.js'
import {
  buildRecommendationEvidence,
  checkEvidenceFreshness,
  recommendationScope,
} from '../src/lib/recommendationEvidence.js'
import {
  loadRecommendationStatuses,
  saveRecommendationStatus,
} from '../src/lib/recommendationStatus.js'
import {
  normaliseChatAnswer,
  normaliseChatInput,
  normaliseEvidence,
  normaliseRecommendations,
} from '../backend/src/services/recommendation.service.js'
import { starterArchitecture, weakArchitecture } from '../src/data/seedArchitectures.js'

const WORKLOAD = { mode: 'rate', arrivalRate: 100, duration: 60, seed: 7 }

function pipeline(architecture, arrivalRate = 100) {
  const workload = { ...WORKLOAD, arrivalRate }
  const contract = toContract(architecture)
  const sim = runSimulation(contract, workload, { maxLoggedCases: 400 })
  const mining = mineEventLog(sim.eventLog, contract, {
    ...miningOptions(sim),
    provenance: miningProvenance(sim, contract, {
      archHash: contractHash(architecture),
      seed: workload.seed,
      arrivalRate: workload.arrivalRate,
      duration: workload.duration,
      mode: workload.mode,
    }),
  })
  const evaluation = evaluateArchitecture(contract, sim, mining)
  const recommendations = buildRecommendations(contract, sim, mining, evaluation)
  return { architecture, workload, contract, sim, mining, evaluation, recommendations }
}

describe('rich rule-based recommendations', () => {
  it('preserves legacy fields and adds every required advisory field', () => {
    const { contract, sim, mining, evaluation, recommendations } = pipeline(weakArchitecture(), 3000)
    assert.ok(recommendations.length > 0)

    for (const rec of buildRecommendations(contract, sim, mining, evaluation)) {
      for (const key of [
        'id',
        'severity',
        'dimension',
        'title',
        'issue',
        'why',
        'recommendation',
        'effect',
        'expectedImpact',
      ]) {
        assert.ok(key in rec, `legacy field ${key} must remain for Dashboard and Reports`)
      }
      assert.ok(rec.title)
      assert.ok(['Critical', 'High', 'Medium', 'Low'].includes(rec.priority))
      assert.ok(RECOMMENDATION_CATEGORIES.includes(rec.category))
      assert.ok(rec.problem)
      assert.ok(rec.rootCause)
      assert.ok(rec.evidence.length > 0)
      assert.ok(rec.steps.length > 0)
      assert.ok(rec.benefits.length > 0)
      assert.ok(rec.risks.length > 0)
      assert.ok(['High', 'Medium', 'Low'].includes(rec.confidence))
      assert.equal(rec.source, 'rule-based')
    }
  })

  it('covers the requested lenses across real seed architectures', () => {
    const sets = [pipeline(starterArchitecture(), 100), pipeline(weakArchitecture(), 3000)].flatMap((r) =>
      r.recommendations.map((x) => x.category),
    )
    const unique = [...new Set(sets)]
    for (const category of [
      'Performance Optimization',
      'Scalability',
      'Security',
      'Reliability',
      'Database Optimization',
      'Infrastructure',
      'Cost Optimization',
    ]) {
      assert.ok(unique.includes(category), `expected ${category}, got ${unique.join(', ')}`)
    }
    assert.ok(RECOMMENDATION_CATEGORIES.includes('Architecture Design'))
  })

  it('never raises findings for an empty architecture', () => {
    const recs = buildRecommendations({ nodes: [], edges: [] }, null, null, null)
    assert.ok(Array.isArray(recs))
    for (const rec of recs) assert.ok(rec.evidence.length > 0)
  })
})

describe('project-scoped, non-stale evidence', () => {
  it('maps the engine fields the old payload failed to send', () => {
    const run = pipeline(starterArchitecture(), 100)
    const context = buildRecommendationEvidence({
      project: { id: 'p1', name: 'Checkout' },
      architecture: run.architecture,
      workload: run.workload,
      sim: run.sim,
      mining: run.mining,
      evaluation: run.evaluation,
      recommendations: run.recommendations,
      resultKey: 'result-key',
    })

    assert.equal(context.ready, true)
    assert.equal(context.payload.project.name, 'Checkout')
    assert.equal(context.payload.architecture.hash, context.hash)
    assert.equal(context.payload.architecture.nodes.length, run.architecture.nodes.length)
    assert.equal(context.payload.architecture.edges.length, run.architecture.edges.length)
    assert.equal(context.payload.metrics.total, run.sim.metrics.totalRequests)
    assert.equal(context.payload.metrics.failed, run.sim.metrics.failedRequests)
    assert.equal(context.payload.metrics.dropped, run.sim.metrics.droppedRequests)
    assert.equal(context.payload.metrics.throughput, run.sim.metrics.throughputPerSec)
    assert.ok(
      Math.abs(context.payload.metrics.successRate - run.sim.metrics.successRate / 100) < 0.001,
      'successRate must be sent as a 0-1 fraction',
    )
    assert.equal(context.payload.components.length, Object.keys(run.sim.components).length)
    assert.deepEqual(context.payload.evaluation.dimensions, run.evaluation.dimensions)
    assert.equal(context.payload.freshness.stale, false)
  })

  it('refuses results bound to a different architecture version', () => {
    const run = pipeline(starterArchitecture(), 100)
    const freshness = checkEvidenceFreshness({
      hash: 'different-version',
      workload: run.workload,
      sim: run.sim,
      mining: run.mining,
    })
    assert.equal(freshness.stale, true)
    assert.ok(freshness.reasons.some((r) => /different architecture version/.test(r)))

    const blocked = buildRecommendationEvidence({
      architecture: { nodes: [], edges: [] },
      sim: run.sim,
      mining: run.mining,
      evaluation: run.evaluation,
    })
    assert.equal(blocked.ready, false)
    assert.equal(blocked.validation.canSimulate, false)
  })

  it('scopes review status to project, architecture and result', () => {
    const scope = recommendationScope({
      project: { id: 'p1' },
      architecture: starterArchitecture(),
      resultKey: 'k1',
    })
    assert.match(scope, /^p1::/)
    assert.match(scope, /::k1$/)
  })
})

describe('status tracking', () => {
  it('stores review decisions per scope and survives invalid data', () => {
    const store = new Map()
    globalThis.window = { localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
    } }
    try {
      const a = saveRecommendationStatus('scope-a', 'rec-1', 'accepted')
      assert.equal(a['rec-1'], 'accepted')
      assert.deepEqual(loadRecommendationStatuses('scope-b'), {})
      saveRecommendationStatus('scope-a', 'rec-1', 'bogus')
      assert.deepEqual(loadRecommendationStatuses('scope-a'), a)
      store.set('archai.recommendations.status.v1:scope-a', 'not-json')
      assert.deepEqual(loadRecommendationStatuses('scope-a'), {})
    } finally {
      delete globalThis.window
    }
  })
})

describe('backend advisor contract', () => {
  it('accepts the nested evidence payload from the recommendations page', () => {
    const run = pipeline(starterArchitecture(), 100)
    const context = buildRecommendationEvidence({
      project: { id: 'p1', name: 'Checkout' },
      architecture: run.architecture,
      workload: run.workload,
      sim: run.sim,
      mining: run.mining,
      evaluation: run.evaluation,
      recommendations: run.recommendations,
      resultKey: 'result-key',
    })
    const normalised = normaliseEvidence(context.payload)

    assert.equal(normalised.scoredDimensions.performance, run.evaluation.dimensions.performance)
    assert.equal(normalised.metrics.total, run.sim.metrics.totalRequests)
    assert.equal(normalised.architecture.nodes.length, run.architecture.nodes.length)
    assert.equal(normalised.architecture.edges.length, run.architecture.edges.length)
    assert.equal(normalised.components.length, Object.keys(run.sim.components).length)
    assert.equal(normalised.freshness.stale, false)
    assert.equal(normalised.project.name, 'Checkout')
    assert.equal(normalised.analysis.dimensionNotes.performance.length > 0, true)
  })

  it('converts model output into all rich recommendation fields', () => {
    const out = normaliseRecommendations(
      {
        recommendations: [
          {
            dimension: 'performance',
            severity: 'high',
            title: 'Real finding',
            priority: 'Critical',
            category: 'Database Optimization',
            confidence: 'High',
            evidence: ['p95 measured 900 ms'],
            steps: ['Add a cache', 'Re-run the simulation'],
            risks: ['Cache invalidation'],
          },
        ],
      },
      { scoredDimensions: { performance: 30 }, analysis: { totalCases: 10, conformanceRate: 1 } },
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].priority, 'Critical')
    assert.equal(out[0].category, 'Database Optimization')
    assert.equal(out[0].confidence, 'High')
    assert.deepEqual(out[0].evidence, ['p95 measured 900 ms'])
    assert.deepEqual(out[0].steps, ['Add a cache', 'Re-run the simulation'])
    assert.ok(out[0].problem)
    assert.ok(out[0].rootCause)
    assert.ok(out[0].benefits.length > 0)
    assert.equal(out[0].source, 'gemini')

    const fallback = normaliseRecommendations({
      recommendations: [{ dimension: 'security', severity: 'high', title: 'No details' }],
    })
    assert.equal(fallback[0].priority, 'High')
    assert.equal(fallback[0].category, 'Security')
    assert.ok(fallback[0].evidence.length > 0)
    assert.ok(fallback[0].steps.length > 0)
    assert.ok(fallback[0].risks.length > 0)
  })

  it('validates conversational input and answers before they reach the prompt', () => {
    assert.throws(() => normaliseChatInput({ question: '   ' }))
    const chat = normaliseChatInput({
      question: 'What is the biggest bottleneck?',
      history: [{ role: 'user', content: 'hello' }, { role: 'model', content: 'hi' }],
    })
    assert.equal(chat.history[1].role, 'assistant')
    const answer = normaliseChatAnswer({ answer: 'Use the measured p95.', bullets: ['Re-run'], caveats: [] })
    assert.equal(answer.answer, 'Use the measured p95.')
    assert.deepEqual(answer.bullets, ['Re-run'])
    assert.throws(() => normaliseChatAnswer({ answer: '' }))
  })
})
