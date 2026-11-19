import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'

import { toContract, archHash } from '../src/lib/contract.js'
import { runSimulation } from '../src/lib/engine.js'
import { mineEventLog, miningOptions, miningProvenance } from '../src/lib/mining.js'
import { evaluateArchitecture, gradeFor } from '../src/lib/evaluation.js'
import {
  loadEvaluationHistory,
  recordEvaluation,
  clearEvaluationHistory,
  compareEvaluations,
} from '../src/lib/evaluationHistory.js'
import { evaluationToCsv, evaluationReportHtml } from '../src/lib/evaluationExport.js'
import {
  starterArchitecture,
  strongArchitecture,
  weakArchitecture,
} from '../src/data/seedArchitectures.js'

const OPTIONS = { maxLoggedCases: 400 }

function pipeline(arch, rate = 20, seed = 4242, duration = 30) {
  const contract = toContract(arch)
  const hash = archHash(arch)
  const sim = runSimulation(contract, { arrivalRate: rate, duration, seed }, OPTIONS)
  const mining = mineEventLog(sim.eventLog, contract, {
    ...miningOptions(sim),
    provenance: miningProvenance(sim, contract, { archHash: hash, seed, arrivalRate: rate, duration }),
  })
  const evaluation = evaluateArchitecture(contract, sim, mining)
  return { contract, sim, mining, evaluation, hash }
}

const DETAIL_KEYS = [
  'performance',
  'scalability',
  'reliability',
  'security',
  'maintainability',
  'resourceEfficiency',
  'costEfficiency',
  'processConformance',
]

describe('evaluation: legacy contract is preserved', () => {
  it('still returns dimensions, weights, healthScore and notes', () => {
    const { evaluation } = pipeline(starterArchitecture())
    assert.ok(evaluation.dimensions && typeof evaluation.dimensions === 'object')
    assert.ok(evaluation.weights && typeof evaluation.weights === 'object')
    assert.equal(typeof evaluation.healthScore, 'number')
    assert.ok(evaluation.notes && typeof evaluation.notes === 'object')
    for (const key of ['performance', 'scalability', 'reliability', 'security', 'maintainability', 'processEfficiency']) {
      assert.equal(typeof evaluation.dimensions[key], 'number')
      assert.equal(typeof evaluation.weights[key], 'number')
      assert.equal(typeof evaluation.notes[key], 'string')
    }
  })

  it('adds a report without changing the legacy health score', () => {
    const { evaluation } = pipeline(starterArchitecture())
    const legacy = {
      dimensions: evaluation.dimensions,
      weights: evaluation.weights,
      healthScore: evaluation.healthScore,
      notes: evaluation.notes,
    }
    const weighted = Object.entries(legacy.weights).reduce(
      (sum, [key]) => sum + legacy.dimensions[key] * legacy.weights[key],
      0,
    )
    assert.equal(legacy.healthScore, Math.round(weighted))
    assert.ok(evaluation.report)
  })
})

describe('evaluation: eight categories and transparent weights', () => {
  const { evaluation } = pipeline(starterArchitecture())
  const report = evaluation.report

  it('exposes all eight categories in a stable order', () => {
    assert.deepEqual(report.categories.map((c) => c.key), DETAIL_KEYS)
  })

  it('normalizes evaluated weights to sum to 1', () => {
    const evaluated = report.categories.filter((c) => c.status === 'evaluated')
    assert.ok(evaluated.length > 0)
    const sum = evaluated.reduce((s, c) => s + c.normalizedWeight, 0)
    assert.ok(Math.abs(sum - 1) < 1e-6, `normalized weights sum to ${sum}`)
  })

  it('excludes Not Evaluated categories from the overall score', () => {
    const evaluated = report.categories.filter((c) => c.status === 'evaluated' && Number.isFinite(c.score))
    const expected = Math.round(evaluated.reduce((s, c) => s + c.score * c.normalizedWeight, 0))
    assert.equal(report.overallScore, expected)
  })

  it('marks cost efficiency Not Evaluated rather than inventing a cost', () => {
    const cost = report.categories.find((c) => c.key === 'costEfficiency')
    assert.equal(cost.status, 'not_evaluated')
    assert.equal(cost.score, null)
    assert.match(cost.reason, /pricing model/i)
    assert.ok(cost.measured.some((m) => m.label === 'Pricing model'))
  })

  it('documents methodology, thresholds and double-counting', () => {
    assert.ok(report.methodology.weights)
    assert.ok(report.methodology.normalizedWeights)
    assert.ok(report.methodology.gradeBands.length >= 5)
    assert.ok(report.methodology.thresholds.latencyBudgetMs > 0)
    assert.match(report.methodology.normalization, /renormal/i)
    assert.match(report.methodology.doubleCounting, /primary category/i)
  })

  it('attaches evidence tags and measured values to each category', () => {
    for (const category of report.categories) {
      assert.ok(Array.isArray(category.evidence) && category.evidence.length > 0, `${category.key} evidence`)
      assert.ok(Array.isArray(category.criteria) && category.criteria.length > 0, `${category.key} criteria`)
      assert.ok(Array.isArray(category.measured), `${category.key} measured`)
      assert.ok(Array.isArray(category.improvements) && category.improvements.length > 0, `${category.key} improvements`)
    }
  })

  it('stamps the report with architecture version and run id', () => {
    const { hash, mining } = pipeline(starterArchitecture())
    const fresh = pipeline(starterArchitecture()).evaluation.report
    assert.equal(fresh.provenance.architectureVersion, hash)
    assert.equal(fresh.provenance.runId, mining.provenance.runKey)
    assert.ok(fresh.provenance.evaluatedAt > 0)
  })
})

describe('evaluation: grade calculation', () => {
  it('maps score bands to grades', () => {
    assert.equal(gradeFor(95).letter, 'A')
    assert.equal(gradeFor(85).letter, 'B')
    assert.equal(gradeFor(72).letter, 'C')
    assert.equal(gradeFor(63).letter, 'D')
    assert.equal(gradeFor(51).letter, 'E')
    assert.equal(gradeFor(10).letter, 'F')
  })

  it('returns Not Evaluated for null', () => {
    assert.equal(gradeFor(null).label, 'Not Evaluated')
    assert.equal(gradeFor(undefined).label, 'Not Evaluated')
  })
})

describe('evaluation: missing metric handling', () => {
  it('marks simulation categories Not Evaluated when there is no simulation', () => {
    const contract = toContract(starterArchitecture())
    const evaluation = evaluateArchitecture(contract, undefined, undefined)
    const report = evaluation.report
    for (const key of ['performance', 'reliability', 'resourceEfficiency', 'processConformance']) {
      const category = report.categories.find((c) => c.key === key)
      assert.equal(category.status, 'not_evaluated', `${key} should be Not Evaluated`)
      assert.equal(category.score, null)
      assert.ok(category.reason)
    }
    // Static categories are still evaluated without a simulation.
    const security = report.categories.find((c) => c.key === 'security')
    assert.equal(security.status, 'evaluated')
    const maintainability = report.categories.find((c) => c.key === 'maintainability')
    assert.equal(maintainability.status, 'evaluated')
  })

  it('never emits a null score as a zero', () => {
    const contract = toContract(starterArchitecture())
    const evaluation = evaluateArchitecture(contract, undefined, undefined)
    for (const category of evaluation.report.categories) {
      if (category.status === 'not_evaluated') assert.equal(category.score, null)
    }
  })
})

describe('evaluation: invalid architecture handling', () => {
  it('returns all Not Evaluated for an empty architecture', () => {
    const evaluation = evaluateArchitecture({ nodes: [], edges: [] }, undefined, undefined)
    assert.equal(evaluation.healthScore, 0)
    assert.equal(evaluation.report.overallScore, null)
    assert.equal(evaluation.report.status, 'not_evaluated')
    assert.equal(evaluation.report.categories.length, 8)
    for (const category of evaluation.report.categories) {
      assert.equal(category.status, 'not_evaluated')
      assert.equal(category.score, null)
    }
  })
})

describe('evaluation: evidence quality and findings', () => {
  it('scores a weak architecture lower than a strong one', () => {
    const weak = pipeline(weakArchitecture(), 200).evaluation.report.overallScore
    const strong = pipeline(strongArchitecture(), 20).evaluation.report.overallScore
    assert.ok(weak != null && strong != null)
    assert.ok(strong > weak, `strong ${strong} should beat weak ${weak}`)
  })

  it('de-duplicates identical issue text across categories', () => {
    const report = pipeline(weakArchitecture(), 120).evaluation.report
    const all = [
      ...report.findings.critical,
      ...report.findings.high,
      ...report.findings.medium,
      ...report.findings.low,
    ].map((f) => f.text.toLowerCase())
    assert.equal(new Set(all).size, all.length)
  })

  it('keeps findings grouped by severity', () => {
    const report = pipeline(weakArchitecture(), 120).evaluation.report
    for (const bucket of ['critical', 'high', 'medium', 'low', 'positive']) {
      assert.ok(Array.isArray(report.findings[bucket]))
    }
  })
})

// ---------------------------------------------------------------------------
// History and comparison (localStorage is mocked for the test process).
// ---------------------------------------------------------------------------

function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}

describe('evaluation: history', () => {
  let originalWindow
  beforeEach(() => {
    originalWindow = globalThis.window
    globalThis.window = { localStorage: makeStorage() }
  })
  afterEach(() => {
    globalThis.window = originalWindow
  })

  it('records a snapshot and loads it back', () => {
    const { evaluation } = pipeline(starterArchitecture())
    const entries = recordEvaluation('project-1', evaluation, { projectName: 'Test' })
    assert.equal(entries.length, 1)
    const loaded = loadEvaluationHistory('project-1')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].overallScore, evaluation.report.overallScore)
    assert.equal(loaded[0].categories.length, 8)
    assert.ok(loaded[0].architectureVersion)
    assert.ok(loaded[0].runId)
  })

  it('does not duplicate the same run and score', () => {
    const { evaluation } = pipeline(starterArchitecture())
    recordEvaluation('project-1', evaluation)
    const entries = recordEvaluation('project-1', evaluation)
    assert.equal(entries.length, 1)
  })

  it('keeps separate entries for different runs', () => {
    const a = pipeline(starterArchitecture(), 20, 100).evaluation
    const b = pipeline(starterArchitecture(), 30, 200).evaluation
    recordEvaluation('project-1', a)
    const entries = recordEvaluation('project-1', b)
    assert.equal(entries.length, 2)
  })

  it('scopes history per project', () => {
    const { evaluation } = pipeline(starterArchitecture())
    recordEvaluation('project-1', evaluation)
    assert.equal(loadEvaluationHistory('project-2').length, 0)
    assert.equal(loadEvaluationHistory('project-1').length, 1)
  })

  it('clears history', () => {
    const { evaluation } = pipeline(starterArchitecture())
    recordEvaluation('project-1', evaluation)
    clearEvaluationHistory('project-1')
    assert.equal(loadEvaluationHistory('project-1').length, 0)
  })

  it('compares two runs and reports deltas, introduced and resolved issues', () => {
    const older = pipeline(starterArchitecture(), 10, 1).evaluation
    const newer = pipeline(weakArchitecture(), 200, 2).evaluation
    recordEvaluation('project-1', older)
    recordEvaluation('project-1', newer)
    const [latest, previous] = loadEvaluationHistory('project-1')
    const comparison = compareEvaluations(previous, latest)
    assert.ok(comparison)
    assert.equal(comparison.sameArchitecture, false)
    assert.ok(comparison.warning)
    assert.equal(comparison.deltas.length, 8)
    assert.ok(Array.isArray(comparison.introduced))
    assert.ok(Array.isArray(comparison.resolved))
    assert.equal(
      comparison.overallDelta,
      latest.overallScore - previous.overallScore,
    )
  })

  it('flags a different run on the same architecture', () => {
    const a = pipeline(starterArchitecture(), 20, 100).evaluation
    const b = pipeline(starterArchitecture(), 20, 999).evaluation
    const comparison = compareEvaluations(
      { architectureVersion: a.report.provenance.architectureVersion, runId: a.report.provenance.runId, categories: a.report.categories, findings: a.report.findings, overallScore: a.report.overallScore },
      { architectureVersion: b.report.provenance.architectureVersion, runId: b.report.provenance.runId, categories: b.report.categories, findings: b.report.findings, overallScore: b.report.overallScore },
    )
    assert.equal(comparison.sameArchitecture, true)
    assert.equal(comparison.sameRun, false)
    assert.match(comparison.warning, /different simulation run/i)
  })
})

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe('evaluation: exports', () => {
  const { evaluation } = pipeline(starterArchitecture())

  it('CSV includes the overall score, categories, methodology and provenance', () => {
    const csv = evaluationToCsv(evaluation, { projectName: 'Test' })
    assert.match(csv, /Overall Architecture Score/)
    assert.match(csv, /Performance/)
    assert.match(csv, /Cost Efficiency/)
    assert.match(csv, /Methodology/)
    assert.match(csv, /Architecture version/)
    assert.match(csv, /Simulation run/)
    assert.match(csv, /Evaluation timestamp/)
    const lines = csv.split('\r\n')
    assert.ok(lines.length >= 10)
  })

  it('CSV writes Not Evaluated without a fake numeric score', () => {
    const csv = evaluationToCsv(evaluation, {})
    const costLine = csv.split('\r\n').find((l) => l.includes('Cost Efficiency'))
    assert.ok(costLine)
    assert.match(costLine, /not_evaluated/)
    assert.match(costLine, /Not Evaluated/)
  })

  it('HTML report includes findings, methodology, evidence and provenance', () => {
    const html = evaluationReportHtml(evaluation, { projectName: 'Test' })
    assert.match(html, /Architecture Evaluation Report/)
    assert.match(html, /Methodology/)
    assert.match(html, /Provenance/)
    assert.match(html, /Category analysis/)
    assert.match(html, /Findings/)
    assert.match(html, /Improvement recommendations/)
  })
})

describe('integration: evaluation consumes the mined evidence', () => {
  it('process conformance reflects the mined case statistics', () => {
    const { evaluation, mining } = pipeline(starterArchitecture())
    const category = evaluation.report.categories.find((c) => c.key === 'processConformance')
    assert.equal(category.status, 'evaluated')
    const conformance = category.measured.find((m) => m.label === 'Conformance rate')
    assert.ok(conformance)
    assert.equal(conformance.value, Math.round(Number(mining.statistics.conformanceRate) * 1000) / 10)
  })

  it('the report provenance matches the mining provenance', () => {
    const { evaluation, mining } = pipeline(starterArchitecture())
    assert.equal(evaluation.report.provenance.runId, mining.provenance.runKey)
    assert.equal(evaluation.report.provenance.architectureVersion, mining.provenance.archHash)
    assert.equal(evaluation.report.provenance.seed, mining.provenance.seed)
  })
})
