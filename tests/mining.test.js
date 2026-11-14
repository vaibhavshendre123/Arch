import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { toContract, expectedPaths, expectedPathModel, archHash, graphOf } from '../src/lib/contract.js'
import { runSimulation } from '../src/lib/engine.js'
import { mineEventLog, miningOptions, miningProvenance, CONFORMANCE_FORMULA } from '../src/lib/mining.js'
import { evaluateArchitecture } from '../src/lib/evaluation.js'
import { buildRecommendations } from '../src/lib/recommendations.js'
import { validateArchitecture, canSimulate } from '../src/lib/validate.js'
import {
  starterArchitecture,
  strongArchitecture,
  weakArchitecture,
  cloneArchitecture,
} from '../src/data/seedArchitectures.js'

const OPTIONS = { maxLoggedCases: 400 }

function pipeline(arch, rate, seed = 20260927) {
  const contract = toContract(arch)
  const hash = archHash(arch)
  const sim = runSimulation(contract, { arrivalRate: rate, duration: 60, seed }, OPTIONS)
  const mining = mineEventLog(sim.eventLog, contract, {
    ...miningOptions(sim),
    provenance: miningProvenance(sim, contract, {
      archHash: hash,
      seed,
      arrivalRate: rate,
      duration: 60,
    }),
  })
  const evaluation = evaluateArchitecture(contract, sim, mining)
  const recommendations = buildRecommendations(contract, sim, mining, evaluation)
  return { contract, sim, mining, evaluation, recommendations, hash }
}

// Same as pipeline, but the caller controls the requested duration so a run can be
// pushed into event-budget truncation on purpose.
function runAt(arch, rate, duration, seed = 20260927) {
  const contract = toContract(arch)
  const sim = runSimulation(contract, { arrivalRate: rate, duration, seed }, OPTIONS)
  const mining = mineEventLog(sim.eventLog, contract, {
    ...miningOptions(sim),
    provenance: miningProvenance(sim, contract, {
      archHash: archHash(arch),
      seed,
      arrivalRate: rate,
      duration,
    }),
  })
  return { contract, sim, mining }
}

// ---------------------------------------------------------------------------
// Synthetic event logs with manually verifiable expected results.
// ---------------------------------------------------------------------------

function syntheticLog(events) {
  return events.map((e, i) => ({
    caseId: e.caseId,
    eventId: i + 1,
    activity: e.activity,
    componentId: e.componentId ?? null,
    componentName: e.componentName ?? null,
    timestamp: e.timestamp ?? i,
    status: e.status ?? 'success',
  }))
}

const LINEAR_CONTRACT = {
  nodes: [
    { id: 'u', type: 'user', name: 'User', parameters: {} },
    { id: 'g', type: 'apiGateway', name: 'Gateway', parameters: {} },
    { id: 's', type: 'server', name: 'Server', parameters: {} },
    { id: 'd', type: 'database', name: 'DB', parameters: {} },
  ],
  edges: [
    { source: 'u', target: 'g' },
    { source: 'g', target: 's' },
    { source: 's', target: 'd' },
  ],
}

// One complete linear case: User > Gateway > Server > DB
function completeCaseEvents(caseId, base = 0) {
  return [
    { caseId, activity: 'REQUEST_ARRIVAL', componentId: 'u', componentName: 'User', timestamp: base + 0 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 'u', componentName: 'User', timestamp: base + 1 },
    { caseId, activity: 'QUEUE_EXIT', componentId: 'u', componentName: 'User', timestamp: base + 2 },
    { caseId, activity: 'PROCESS_START', componentId: 'u', componentName: 'User', timestamp: base + 3 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'u', componentName: 'User', timestamp: base + 4 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 'g', componentName: 'Gateway', timestamp: base + 5 },
    { caseId, activity: 'QUEUE_EXIT', componentId: 'g', componentName: 'Gateway', timestamp: base + 6 },
    { caseId, activity: 'PROCESS_START', componentId: 'g', componentName: 'Gateway', timestamp: base + 7 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'g', componentName: 'Gateway', timestamp: base + 8 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 's', componentName: 'Server', timestamp: base + 9 },
    { caseId, activity: 'QUEUE_EXIT', componentId: 's', componentName: 'Server', timestamp: base + 10 },
    { caseId, activity: 'PROCESS_START', componentId: 's', componentName: 'Server', timestamp: base + 11 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 's', componentName: 'Server', timestamp: base + 12 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 'd', componentName: 'DB', timestamp: base + 13 },
    { caseId, activity: 'QUEUE_EXIT', componentId: 'd', componentName: 'DB', timestamp: base + 14 },
    { caseId, activity: 'PROCESS_START', componentId: 'd', componentName: 'DB', timestamp: base + 15 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'd', componentName: 'DB', timestamp: base + 16 },
    { caseId, activity: 'REQUEST_COMPLETE', componentId: 'd', componentName: 'DB', timestamp: base + 17 },
  ]
}

// Case dropped at DB after walking User > Gateway > Server.
function droppedCaseEvents(caseId, base = 0) {
  return [
    { caseId, activity: 'REQUEST_ARRIVAL', componentId: 'u', componentName: 'User', timestamp: base + 0 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 'u', componentName: 'User', timestamp: base + 1 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'u', componentName: 'User', timestamp: base + 4 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 'g', componentName: 'Gateway', timestamp: base + 5 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'g', componentName: 'Gateway', timestamp: base + 8 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 's', componentName: 'Server', timestamp: base + 9 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 's', componentName: 'Server', timestamp: base + 12 },
    { caseId, activity: 'REQUEST_DROPPED', componentId: 'd', componentName: 'DB', timestamp: base + 13 },
  ]
}

// Case that fails mid-way with no terminal COMPLETE or DROPPED event.
function incompleteCaseEvents(caseId, base = 0) {
  return [
    { caseId, activity: 'REQUEST_ARRIVAL', componentId: 'u', componentName: 'User', timestamp: base + 0 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 'u', componentName: 'User', timestamp: base + 1 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'u', componentName: 'User', timestamp: base + 4 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 'g', componentName: 'Gateway', timestamp: base + 5 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'g', componentName: 'Gateway', timestamp: base + 8 },
    { caseId, activity: 'FAILURE', componentId: 'g', componentName: 'Gateway', timestamp: base + 9 },
  ]
}

// Failure + retry that still completes the expected path (reliability finding).
function retryThenCompleteEvents(caseId, base = 0) {
  return [
    { caseId, activity: 'REQUEST_ARRIVAL', componentId: 'u', componentName: 'User', timestamp: base + 0 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 'u', componentName: 'User', timestamp: base + 1 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'u', componentName: 'User', timestamp: base + 4 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 'g', componentName: 'Gateway', timestamp: base + 5 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'g', componentName: 'Gateway', timestamp: base + 8 },
    { caseId, activity: 'FAILURE', componentId: 'g', componentName: 'Gateway', timestamp: base + 9 },
    { caseId, activity: 'RETRY', componentId: 'g', componentName: 'Gateway', timestamp: base + 10 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 'g', componentName: 'Gateway', timestamp: base + 11 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'g', componentName: 'Gateway', timestamp: base + 14 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 's', componentName: 'Server', timestamp: base + 15 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 's', componentName: 'Server', timestamp: base + 18 },
    { caseId, activity: 'QUEUE_ENTER', componentId: 'd', componentName: 'DB', timestamp: base + 19 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'd', componentName: 'DB', timestamp: base + 22 },
    { caseId, activity: 'REQUEST_COMPLETE', componentId: 'd', componentName: 'DB', timestamp: base + 23 },
  ]
}

// A completed case that visits a component not on any expected path.
function unexpectedComponentEvents(caseId, base = 0) {
  return [
    { caseId, activity: 'REQUEST_ARRIVAL', componentId: 'u', componentName: 'User', timestamp: base + 0 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'u', componentName: 'User', timestamp: base + 4 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'g', componentName: 'Gateway', timestamp: base + 8 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'rogue', componentName: 'Rogue', timestamp: base + 10 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 's', componentName: 'Server', timestamp: base + 14 },
    { caseId, activity: 'PROCESS_COMPLETE', componentId: 'd', componentName: 'DB', timestamp: base + 18 },
    { caseId, activity: 'REQUEST_COMPLETE', componentId: 'd', componentName: 'DB', timestamp: base + 19 },
  ]
}

describe('mining: one valid linear process', () => {
  it('reports one variant, full conformance, and the expected path', () => {
    const log = syntheticLog([...completeCaseEvents(1), ...completeCaseEvents(2, 100), ...completeCaseEvents(3, 200)])
    const mining = mineEventLog(log, LINEAR_CONTRACT, {})
    assert.equal(mining.statistics.totalCases, 3)
    assert.equal(mining.statistics.completedCases, 3)
    assert.equal(mining.statistics.variants, 1)
    assert.equal(mining.statistics.conformanceRate, 1)
    assert.equal(mining.statistics.conformingCases, 3)
    assert.equal(mining.statistics.nonConformingCases, 0)
    assert.deepEqual(mining.variants[0].path, ['User', 'Gateway', 'Server', 'DB'])
    assert.equal(mining.variants[0].count, 3)
    assert.equal(mining.variants[0].support, 1)
    assert.deepEqual(mining.expectedPaths[0].map((s) => s.name ?? s), ['User', 'Gateway', 'Server', 'DB'])
  })

  it('derives a linear architecture end-to-end from the real engine', () => {
    const { mining, sim } = pipeline(starterArchitecture(), 100)
    assert.ok(sim.metrics.totalRequests > 0)
    assert.equal(mining.statistics.totalCases, 400)
    assert.equal(mining.statistics.completedCases, 400)
    assert.equal(mining.statistics.variants, 1)
    assert.equal(mining.statistics.conformanceRate, 1)
    assert.deepEqual(mining.expectedPaths[0].map((s) => s.name ?? s), ['User', 'API Gateway', 'App Server', 'Database'])
  })
})

describe('mining: multiple legitimate paths', () => {
  it('enumerates every branch of a forked graph', () => {
    const forked = {
      nodes: [
        { id: 'u', type: 'user', name: 'User', parameters: {} },
        { id: 'a', type: 'server', name: 'A', parameters: {} },
        { id: 'b', type: 'server', name: 'B', parameters: {} },
        { id: 'db', type: 'database', name: 'DB', parameters: {} },
      ],
      edges: [
        { source: 'u', target: 'a' },
        { source: 'u', target: 'b' },
        { source: 'a', target: 'db' },
        { source: 'b', target: 'db' },
      ],
    }
    const paths = expectedPaths(forked, 10)
    assert.equal(paths.length, 2)
    const names = paths.map((p) => p.map((s) => s.name).join('>')).sort()
    assert.deepEqual(names, ['User>A>DB', 'User>B>DB'])
  })

  it('surfaces multiple observed variants when routing branches', () => {
    const { mining } = pipeline(strongArchitecture(), 300)
    assert.ok(mining.variants.length >= 2, `expected branching variants, got ${mining.variants.length}`)
    assert.equal(mining.statistics.conformanceRate, 1)
  })

  it('handles multiple entry nodes and multiple terminal nodes', () => {
    const multi = {
      nodes: [
        { id: 'u1', type: 'user', name: 'User1', parameters: {} },
        { id: 'u2', type: 'user', name: 'User2', parameters: {} },
        { id: 'g', type: 'apiGateway', name: 'GW', parameters: {} },
        { id: 'db', type: 'database', name: 'DB', parameters: {} },
        { id: 'fs', type: 'fileStorage', name: 'FS', parameters: {} },
      ],
      edges: [
        { source: 'u1', target: 'g' },
        { source: 'u2', target: 'g' },
        { source: 'g', target: 'db' },
        { source: 'g', target: 'fs' },
      ],
    }
    const model = expectedPathModel(multi, 10)
    assert.equal(model.entryIds.length, 2)
    assert.equal(model.terminalIds.length, 2)
    assert.equal(model.paths.length, 4)
    assert.equal(model.truncated, false)
  })
})

describe('mining: multiple observed variants', () => {
  it('groups cases by their actual ordered sequences and computes support', () => {
    // Case 1 and 2 walk User>Gateway>Server>DB; case 3 walks User>Gateway>Server only (incomplete).
    const log = syntheticLog([
      ...completeCaseEvents(1),
      ...completeCaseEvents(2, 100),
      ...incompleteCaseEvents(3, 200),
    ])
    const mining = mineEventLog(log, LINEAR_CONTRACT, {})
    assert.equal(mining.statistics.variants, 2)
    const completeVariant = mining.variants.find((v) => v.count === 2)
    const incompleteVariant = mining.variants.find((v) => v.count === 1)
    assert.ok(completeVariant, 'expected a 2-case complete variant')
    assert.ok(incompleteVariant, 'expected a 1-case incomplete variant')
    assert.equal(completeVariant.support, round3ish(2 / 3))
    assert.equal(incompleteVariant.support, round3ish(1 / 3))
  })
})

function round3ish(v) {
  return Math.round(v * 1000) / 1000
}

describe('mining: conformance and deviation analysis', () => {
  it('keeps conformance at 100% when a failure recovers via retry (non-blocking reliability finding)', () => {
    const log = syntheticLog([...completeCaseEvents(1), ...retryThenCompleteEvents(2, 100)])
    const mining = mineEventLog(log, LINEAR_CONTRACT, {})
    assert.equal(mining.statistics.conformanceRate, 1, 'a recovered retry must not reduce conformance')
    assert.equal(mining.statistics.conformingCases, 2)
    assert.ok(mining.reliabilityFindings.length > 0, 'the retry/failure should still be reported')
    for (const f of mining.reliabilityFindings) {
      assert.equal(f.category, 'reliability')
    }
    assert.equal(mining.traceDeviations.length, 0)
  })

  it('reduces conformance for a dropped case', () => {
    const log = syntheticLog([...completeCaseEvents(1), ...droppedCaseEvents(2, 100)])
    const mining = mineEventLog(log, LINEAR_CONTRACT, {})
    assert.equal(mining.statistics.totalCases, 2)
    assert.equal(mining.statistics.conformingCases, 1)
    assert.equal(mining.statistics.nonConformingCases, 1)
    assert.equal(mining.statistics.conformanceRate, 0.5)
    const drop = mining.traceDeviations.find((d) => d.type === 'DROPPED')
    assert.ok(drop, 'expected a DROPPED trace deviation')
    assert.equal(drop.caseCount, 1)
    assert.ok(drop.caseIds.includes('2'))
  })

  it('reduces conformance for an incomplete (failed) case', () => {
    const log = syntheticLog([...completeCaseEvents(1), ...incompleteCaseEvents(2, 100)])
    const mining = mineEventLog(log, LINEAR_CONTRACT, {})
    assert.equal(mining.statistics.conformingCases, 1)
    assert.equal(mining.statistics.incompleteCases, 1)
    assert.equal(mining.statistics.conformanceRate, 0.5)
    const incomplete = mining.traceDeviations.find((d) => d.type === 'INCOMPLETE_TRACE')
    assert.ok(incomplete, 'expected an INCOMPLETE_TRACE deviation')
    assert.equal(incomplete.category, 'trace')
  })

  it('reduces conformance when an unexpected component is visited', () => {
    const log = syntheticLog([...completeCaseEvents(1), ...unexpectedComponentEvents(2, 100)])
    const mining = mineEventLog(log, LINEAR_CONTRACT, {})
    assert.equal(mining.statistics.conformingCases, 1)
    assert.equal(mining.statistics.conformanceRate, 0.5)
    const unexpected = mining.traceDeviations.find((d) => d.type === 'UNEXPECTED_COMPONENT')
    assert.ok(unexpected, 'expected an UNEXPECTED_COMPONENT deviation')
    assert.equal(unexpected.component, 'Rogue')
  })

  it('publishes a conformance formula that matches the computed value', () => {
    const log = syntheticLog([...completeCaseEvents(1), ...droppedCaseEvents(2, 100), ...completeCaseEvents(3, 200)])
    const mining = mineEventLog(log, LINEAR_CONTRACT, {})
    assert.equal(typeof mining.conformanceFormula, 'string')
    assert.ok(mining.conformanceFormula.includes('conformingCases / totalCases'))
    assert.equal(mining.conformanceFormula, CONFORMANCE_FORMULA)
    // 2 conforming (cases 1 and 3) of 3 total = 0.667; case 2 was dropped.
    assert.equal(mining.statistics.conformanceRate, round3ish(2 / 3))
    assert.equal(mining.statistics.conformingCases, 2)
    assert.equal(mining.statistics.totalCases, 3)
  })

  it('keeps the historical starter-architecture figure consistent: 100% conformance can coexist with reliability findings', () => {
    const { mining } = pipeline(starterArchitecture(), 100)
    assert.equal(mining.statistics.conformanceRate, 1)
    assert.ok(mining.reliabilityFindings.length > 0, 'the seeded engine run produces recovered failures/retries')
    for (const f of mining.reliabilityFindings) assert.notEqual(f.category, 'trace')
  })
})

describe('mining: missing, incomplete and empty traces', () => {
  it('returns an unavailable state for an empty event log', () => {
    const mining = mineEventLog([], LINEAR_CONTRACT, {})
    assert.equal(mining.statistics.available, false)
    assert.equal(mining.statistics.totalCases, 0)
    assert.equal(mining.statistics.conformanceRate, null)
    assert.deepEqual(mining.variants, [])
    assert.deepEqual(mining.deviations, [])
    assert.deepEqual(mining.traceDeviations, [])
  })

  it('returns an unavailable state when the log is not an array', () => {
    const mining = mineEventLog(null, LINEAR_CONTRACT, {})
    assert.equal(mining.statistics.available, false)
    assert.equal(mining.statistics.conformanceRate, null)
  })

  it('collapses exact duplicate events without losing legitimate repeats', () => {
    const base = completeCaseEvents(1)
    const withDupes = syntheticLog([...base, ...base.map((e) => ({ ...e }))])
    const mining = mineEventLog(withDupes, LINEAR_CONTRACT, {})
    assert.equal(mining.statistics.totalCases, 1)
    const summary = mining.caseSummaries[0]
    assert.equal(summary.eventCount, base.length, 'exact duplicates must be collapsed')
    assert.equal(summary.outcome, 'completed')
  })

  it('handles missing timestamps by preserving original order', () => {
    const noTs = syntheticLog([
      { caseId: 1, activity: 'REQUEST_ARRIVAL', componentId: 'u', componentName: 'User' },
      { caseId: 1, activity: 'PROCESS_COMPLETE', componentId: 'u', componentName: 'User' },
      { caseId: 1, activity: 'PROCESS_COMPLETE', componentId: 'g', componentName: 'Gateway' },
      { caseId: 1, activity: 'PROCESS_COMPLETE', componentId: 's', componentName: 'Server' },
      { caseId: 1, activity: 'PROCESS_COMPLETE', componentId: 'd', componentName: 'DB' },
      { caseId: 1, activity: 'REQUEST_COMPLETE', componentId: 'd', componentName: 'DB' },
    ])
    const mining = mineEventLog(noTs, LINEAR_CONTRACT, {})
    assert.equal(mining.statistics.totalCases, 1)
    assert.equal(mining.statistics.conformanceRate, 1)
  })
})

describe('mining: failed and dropped cases in the engine', () => {
  it('counts dropped engine cases as non-conforming', () => {
    const { mining, sim } = pipeline(weakArchitecture(), 3000)
    assert.ok(sim.metrics.droppedRequests > 0, 'expected drops at 3000 req/s')
    assert.ok(mining.statistics.droppedCases > 0, 'sampled log should contain dropped cases')
    assert.ok(
      mining.statistics.conformanceRate < 1,
      `dropped cases must reduce conformance, got ${mining.statistics.conformanceRate}`,
    )
    assert.equal(
      mining.statistics.conformingCases + mining.statistics.nonConformingCases,
      mining.statistics.totalCases,
    )
    const drop = mining.traceDeviations.find((d) => d.type === 'DROPPED')
    assert.ok(drop, 'expected a DROPPED deviation group')
  })

  it('exposes incomplete counts when the engine abandons in-flight cases', () => {
    const { mining } = pipeline(weakArchitecture(), 3000)
    assert.equal(typeof mining.statistics.incompleteCases, 'number')
    assert.ok(mining.statistics.incompleteCases >= 0)
  })
})

describe('mining: repeated simulation runs never mix events', () => {
  it('produces identical results for the same seed and different results across seeds', () => {
    const a = pipeline(starterArchitecture(), 200, 1)
    const b = pipeline(starterArchitecture(), 200, 1)
    const c = pipeline(starterArchitecture(), 200, 2)
    assert.deepEqual(a.mining.statistics, b.mining.statistics)
    assert.deepEqual(a.mining.variants, b.mining.variants)
    assert.notEqual(a.hash, null)
    assert.equal(a.hash, b.hash)
    assert.equal(a.mining.provenance.seed, 1)
    assert.equal(c.mining.provenance.seed, 2)
    assert.notEqual(a.mining.provenance.runKey, c.mining.provenance.runKey)
  })

  it('binds every mining result to its architecture hash and workload', () => {
    const { mining, hash } = pipeline(starterArchitecture(), 100)
    assert.equal(mining.provenance.archHash, hash)
    assert.equal(mining.provenance.arrivalRate, 100)
    assert.equal(mining.provenance.duration, 60)
    assert.ok(mining.provenance.runKey.includes(hash))
  })
})

describe('mining: cyclic architecture graphs', () => {
  it('terminates enumeration on a cycle and reports it', () => {
    const cyclic = {
      nodes: [
        { id: 'u', type: 'user', name: 'User', parameters: {} },
        { id: 'a', type: 'server', name: 'A', parameters: {} },
        { id: 'b', type: 'server', name: 'B', parameters: {} },
        { id: 'db', type: 'database', name: 'DB', parameters: {} },
      ],
      edges: [
        { source: 'u', target: 'a' },
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
        { source: 'b', target: 'db' },
      ],
    }
    const model = expectedPathModel(cyclic, 10)
    assert.equal(model.hasCycles, true)
    assert.ok(model.paths.length >= 1, 'at least the exit path must be found')
    // The walk must never re-enter A while A is already on the path.
    for (const p of model.paths) {
      const ids = p.map((s) => s.id)
      assert.equal(new Set(ids).size, ids.length, `path ${ids.join('>')} revisited a node`)
    }
  })

  it('cyclic graphs with exits still mine without hanging', () => {
    const cyclicArch = {
      nodes: [
        { id: 'user-1', type: 'user', name: 'User', parameters: {} },
        { id: 'gw-1', type: 'apiGateway', name: 'GW', parameters: { processingTime: 1, capacity: 500 } },
        { id: 'srv-1', type: 'server', name: 'S1', parameters: { processingTime: 1, capacity: 500 } },
        { id: 'srv-2', type: 'server', name: 'S2', parameters: { processingTime: 1, capacity: 500 } },
        { id: 'db-1', type: 'database', name: 'DB', parameters: { processingTime: 1, capacity: 500 } },
      ],
      edges: [
        { source: 'user-1', target: 'gw-1' },
        { source: 'gw-1', target: 'srv-1' },
        { source: 'srv-1', target: 'srv-2' },
        { source: 'srv-2', target: 'srv-1' },
        { source: 'srv-2', target: 'db-1' },
      ],
    }
    const validation = validateArchitecture(cyclicArch)
    // A cycle is a warning, not a blocking error.
    assert.ok(validation.warnings.some((w) => w.code === 'CYCLE_DETECTED'))
    const { mining, sim } = pipeline(cyclicArch, 50)
    assert.ok(sim.metrics.totalRequests > 0)
    assert.ok(mining.statistics.totalCases > 0)
    assert.ok(mining.expectedPathMeta.hasCycles)
  })
})

describe('mining: expected-path truncation is reported', () => {
  it('flags truncation when the path budget is hit', () => {
    // 8 parallel branches → 8 paths; budget of 3 must truncate.
    const nodes = [{ id: 'u', type: 'user', name: 'User', parameters: {} }]
    const edges = []
    for (let i = 0; i < 8; i += 1) {
      nodes.push({ id: `b${i}`, type: 'server', name: `B${i}`, parameters: {} })
      nodes.push({ id: `d${i}`, type: 'database', name: `D${i}`, parameters: {} })
      edges.push({ source: 'u', target: `b${i}` })
      edges.push({ source: `b${i}`, target: `d${i}` })
    }
    const wide = { nodes, edges }
    const model = expectedPathModel(wide, 3)
    assert.equal(model.paths.length, 3)
    assert.equal(model.truncated, true)
    assert.equal(model.limit, 3)
  })
})

describe('mining: architecture edits after a simulation', () => {
  it('changes the architecture hash and therefore the result key', () => {
    const before = starterArchitecture()
    const beforeKey = archHash(before)
    const after = cloneArchitecture(before)
    after.nodes.push({
      id: 'cache-1',
      type: 'cache',
      name: 'Cache',
      position: { x: 100, y: 100 },
      parameters: {},
    })
    after.edges.push({ id: 'e4', source: 'srv-1', target: 'cache-1' })
    const afterKey = archHash(after)
    assert.notEqual(beforeKey, afterKey, 'an architecture edit must change the hash')
  })

  it('keeps historical mining results bound to their original hash', () => {
    const v1 = pipeline(starterArchitecture(), 100)
    const edited = cloneArchitecture(starterArchitecture())
    edited.nodes[3].name = 'Database Renamed'
    const v2 = pipeline(edited, 100)
    assert.notEqual(v1.hash, v2.hash)
    assert.equal(v1.mining.provenance.archHash, v1.hash)
    assert.equal(v2.mining.provenance.archHash, v2.hash)
    assert.notEqual(v1.mining.provenance.runKey, v2.mining.provenance.runKey)
    // v1's mined path still names the original database.
    const v1Path = v1.mining.expectedPaths[0].map((s) => s.name ?? s)
    assert.ok(v1Path.includes('Database'))
    const v2Path = v2.mining.expectedPaths[0].map((s) => s.name ?? s)
    assert.ok(v2Path.includes('Database Renamed'))
  })
})

describe('mining: invalid architectures are blocked from simulation', () => {
  it('rejects an empty architecture', () => {
    const result = validateArchitecture({ nodes: [], edges: [] })
    assert.equal(result.canSimulate, false)
    assert.equal(canSimulate({ nodes: [], edges: [] }), false)
  })

  it('rejects an architecture with a dangling edge', () => {
    const dangling = {
      nodes: [{ id: 'u', type: 'user', name: 'User', parameters: {} }],
      edges: [{ id: 'e1', source: 'u', target: 'ghost' }],
    }
    const result = validateArchitecture(dangling)
    assert.equal(result.canSimulate, false)
    assert.ok(result.errors.some((e) => e.code === 'DANGLING_EDGE'))
  })

  it('rejects an architecture whose client bypasses the application layer', () => {
    const bypass = {
      nodes: [
        { id: 'u', type: 'user', name: 'User', parameters: {} },
        { id: 'db', type: 'database', name: 'DB', parameters: {} },
      ],
      edges: [{ id: 'e1', source: 'u', target: 'db' }],
    }
    const result = validateArchitecture(bypass)
    assert.equal(result.canSimulate, false)
  })

  it('accepts the three seed architectures', () => {
    for (const arch of [starterArchitecture(), strongArchitecture(), weakArchitecture()]) {
      assert.equal(canSimulate(arch), true)
    }
  })
})

describe('mining: case summaries and drill-down data', () => {
  it('records outcome, path, conformance and deviation types per case', () => {
    const log = syntheticLog([
      ...completeCaseEvents(1),
      ...droppedCaseEvents(2, 100),
      ...retryThenCompleteEvents(3, 200),
    ])
    const mining = mineEventLog(log, LINEAR_CONTRACT, {})
    assert.equal(mining.caseSummaries.length, 3)
    const c1 = mining.caseSummaries.find((c) => c.caseId === '1')
    const c2 = mining.caseSummaries.find((c) => c.caseId === '2')
    const c3 = mining.caseSummaries.find((c) => c.caseId === '3')
    assert.equal(c1.outcome, 'completed')
    assert.equal(c1.conforms, true)
    assert.equal(c2.outcome, 'dropped')
    assert.equal(c2.conforms, false)
    assert.ok(c2.deviationTypes.includes('DROPPED'))
    assert.equal(c3.outcome, 'completed')
    assert.equal(c3.conforms, true)
    assert.ok(c3.deviationTypes.includes('FAILURE') || c3.deviationTypes.includes('RETRY'))
  })

  it('attaches affected case ids to deviation groups for drill-down', () => {
    const log = syntheticLog([...completeCaseEvents(1), ...droppedCaseEvents(2, 100), ...droppedCaseEvents(3, 200)])
    const mining = mineEventLog(log, LINEAR_CONTRACT, {})
    const drop = mining.traceDeviations.find((d) => d.type === 'DROPPED')
    assert.ok(drop.caseIds.includes('2'))
    assert.ok(drop.caseIds.includes('3'))
    assert.equal(drop.caseCount, 2)
  })
})

describe('mining: downstream consumers still work', () => {
  it('evaluation scores process efficiency from the new statistics shape', () => {
    const { evaluation, mining } = pipeline(weakArchitecture(), 3000)
    assert.equal(typeof evaluation.dimensions.processEfficiency, 'number')
    assert.ok(evaluation.dimensions.processEfficiency >= 0)
    assert.ok(evaluation.notes.processEfficiency.includes('conformance'))
    assert.ok(mining.statistics.available)
  })

  it('recommendations build without inventing data', () => {
    const { recommendations } = pipeline(starterArchitecture(), 100)
    assert.ok(Array.isArray(recommendations))
    for (const r of recommendations) {
      assert.ok(r.id)
      assert.ok(r.title)
    }
  })

  it('engine-based mining still surfaces bottlenecks under saturation', () => {
    const { mining } = pipeline(weakArchitecture(), 3000)
    assert.ok(mining.bottlenecks.length > 0)
  })
})

describe('mining: provenance helper', () => {
  it('builds a run key from hash, rate, duration and seed', () => {
    const contract = toContract(starterArchitecture())
    const sim = runSimulation(contract, { arrivalRate: 100, duration: 30, seed: 7 }, { maxLoggedCases: 10 })
    const prov = miningProvenance(sim, contract, { archHash: 'abc', seed: 7, arrivalRate: 100, duration: 30 })
    assert.equal(prov.archHash, 'abc')
    assert.equal(prov.seed, 7)
    assert.equal(prov.arrivalRate, 100)
    assert.equal(prov.duration, 30)
    assert.equal(prov.runKey, 'abc::rate-100::dur-30::seed-7')
    assert.equal(prov.totalRequests, sim.metrics.totalRequests)
  })
})

describe('contract: expectedPathModel backward compatibility', () => {
  it('expectedPaths still returns a plain array of steps', () => {
    const paths = expectedPaths(starterArchitecture(), 6)
    assert.ok(Array.isArray(paths))
    assert.equal(paths.length, 1)
    assert.equal(paths[0].length, 4)
    assert.equal(paths[0][0].name, 'User')
  })

  it('graphOf still exposes outgoing and incoming maps', () => {
    const g = graphOf(starterArchitecture())
    assert.ok(g.outgoing.get('user-1').includes('gw-1'))
    assert.ok(g.incoming.get('db-1').includes('srv-1'))
  })
})

// ---------------------------------------------------------------------------
// Regression: the five dashboard-visibility defects found in the audit.
// ---------------------------------------------------------------------------

describe('regression: FAILURE events surface as reliability findings, not trace deviations', () => {
  it('a sampled case that fails and recovers keeps conformance at 100%', () => {
    const log = syntheticLog([
      ...retryThenCompleteEvents(1, 0),
      ...completeCaseEvents(2, 100),
      ...completeCaseEvents(3, 200),
    ])
    const mining = mineEventLog(log, LINEAR_CONTRACT, {})
    assert.equal(mining.statistics.conformanceRate, 1)
    const fail = (mining.reliabilityFindings || []).find((d) => d.type === 'FAILURE')
    assert.ok(fail, 'a FAILURE event in a sampled case must produce a reliability finding')
    assert.equal(fail.category, 'reliability')
    assert.equal((mining.traceDeviations || []).filter((d) => d.type === 'FAILURE').length, 0)
  })

  it('the engine run with real failures reports FAILURE findings on the mined log', () => {
    const { mining, sim } = pipeline(weakArchitecture(), 3000)
    assert.ok(
      sim.eventLog.some((e) => e.activity === 'FAILURE'),
      'the weak architecture at 3000 req/s must emit FAILURE events',
    )
    const fail = (mining.reliabilityFindings || []).find((d) => d.type === 'FAILURE')
    assert.ok(fail, 'expected a FAILURE reliability group from the engine run')
    assert.ok(fail.caseIds?.length > 0, 'the finding must name affected case ids')
  })

  it('recovered failures in a real run do not reduce conformance below 100%', () => {
    const { mining, sim } = pipeline(starterArchitecture(), 100)
    assert.ok(
      sim.eventLog.some((e) => e.activity === 'FAILURE'),
      'the starter architecture at 100 req/s emits recoverable failures',
    )
    assert.ok(
      (mining.reliabilityFindings || []).some((d) => d.type === 'FAILURE'),
      'those failures must still be reported as reliability findings',
    )
    assert.equal(mining.statistics.conformanceRate, 1)
  })

  it('an architecture with no failures reports no FAILURE findings', () => {
    const silent = {
      nodes: [
        { id: 'u', type: 'user', name: 'User', parameters: { failureProbability: 0 } },
        { id: 'g', type: 'apiGateway', name: 'Gateway', parameters: { failureProbability: 0 } },
        { id: 's', type: 'server', name: 'Server', parameters: { failureProbability: 0 } },
        { id: 'd', type: 'database', name: 'DB', parameters: { failureProbability: 0 } },
      ],
      edges: [
        { source: 'u', target: 'g' },
        { source: 'g', target: 's' },
        { source: 's', target: 'd' },
      ],
    }
    const { mining, sim } = pipeline(silent, 50)
    assert.equal(sim.eventLog.some((e) => e.activity === 'FAILURE'), false)
    assert.equal((mining.reliabilityFindings || []).filter((d) => d.type === 'FAILURE').length, 0)
  })
})

describe('regression: a truncated run keeps unfinished sampled cases as incomplete traces', () => {
  it('starter at 4500 req/s truncates, and unfinished sampled cases are not silently dropped', () => {
    const { sim, mining } = runAt(starterArchitecture(), 4500, 45)
    assert.equal(sim.truncated, true, 'this workload must exhaust the event budget')
    assert.ok(sim.simulatedMs < 45 * 1000, 'the simulated span must be shorter than the request')

    const unfinished = sim.loggingStats.unfinishedSampledCases
    assert.ok(unfinished > 0, 'the event budget must abandon at least one sampled case')

    // Every sampled case admitted to the log is still present after trimming.
    const distinctLogged = new Set(sim.eventLog.map((e) => e.caseId)).size
    assert.equal(distinctLogged, sim.loggingStats.sampledCases)

    // Mining sees the abandoned cases as incomplete traces, not as vanished data.
    assert.ok(
      mining.statistics.incompleteCases >= unfinished,
      `expected at least ${unfinished} incomplete traces, got ${mining.statistics.incompleteCases}`,
    )
    assert.ok(mining.statistics.conformanceRate < 1, 'abandoned traces must reduce conformance')
    const incomplete = mining.traceDeviations.find((d) => d.type === 'INCOMPLETE_TRACE')
    assert.ok(incomplete, 'expected an INCOMPLETE_TRACE deviation group')

    // The provenance carries the truncation so the UI can disclose it.
    assert.equal(mining.provenance.truncated, true)
    assert.ok(mining.provenance.simulatedMs > 0)
    assert.ok(mining.provenance.simulatedMs < 45 * 1000)
    assert.equal(mining.provenance.unfinishedSampledCases, unfinished)
  })

  it('a run that is not truncated reports no unfinished cases and no truncation flag', () => {
    const { sim, mining } = runAt(starterArchitecture(), 100, 60)
    assert.equal(sim.truncated, false)
    assert.equal(sim.loggingStats.unfinishedSampledCases, 0)
    assert.equal(mining.statistics.incompleteCases, 0)
    assert.equal(mining.provenance.truncated, false)
  })
})

describe('regression: the wait ratio is the displayed waiting ms divided by the displayed processing ms', () => {
  it('every bottleneck ratio is derivable from the one-decimal ms values it shows', () => {
    const { mining } = pipeline(weakArchitecture(), 3000)
    assert.ok(mining.bottlenecks.length > 0)
    for (const b of mining.bottlenecks) {
      const expected = Math.round((b.waitingMs / Math.max(b.processingMs, 1)) * 1000) / 1000
      assert.ok(
        Math.abs(b.waitRatio - expected) < 0.002,
        `${b.component}: ratio ${b.waitRatio} is not ${b.waitingMs} / ${b.processingMs} = ${expected}`,
      )
      assert.equal(b.waitRatio.toFixed(2), expected.toFixed(2))
    }
  })

  it('the pages display the ratio with an x suffix, never as a percentage via toPct', () => {
    const pm = readFileSync(new URL('../src/pages/ProcessMining.jsx', import.meta.url), 'utf8')
    const reports = readFileSync(new URL('../src/pages/Reports.jsx', import.meta.url), 'utf8')
    assert.doesNotMatch(pm, /toPct\(b\.waitRatio\)/, 'ProcessMining must not run the ratio through toPct')
    assert.doesNotMatch(pm, /%\s*wait ratio/, 'the ratio must not be labelled as a percentage')
    assert.doesNotMatch(reports, /toPct\(b\.waitRatio\)/, 'Reports must not run the ratio through toPct')
    assert.match(pm, /toFixed\(2\)\}x/, 'ProcessMining must render the ratio with an x suffix')
    assert.match(reports, /num\(b\.waitRatio, 2\)\}x/, 'Reports must render the ratio with an x suffix')
  })

  it('the bottleneck share card plots share of total waiting time, matching its title', () => {
    const pm = readFileSync(new URL('../src/pages/ProcessMining.jsx', import.meta.url), 'utf8')
    assert.match(pm, /share of total waiting time/)
    assert.doesNotMatch(
      pm,
      /right=\{`\$\{toPct\(b\.waitRatio\)\}/,
      'the share bar must not label the raw ratio as a percentage',
    )
  })
})

describe('regression: sample outcome coverage is disclosed, including zeros', () => {
  it('the Cases card always renders completed, dropped and incomplete counts explicitly', () => {
    const pm = readFileSync(new URL('../src/pages/ProcessMining.jsx', import.meta.url), 'utf8')
    assert.match(pm, /completed/)
    assert.match(pm, /dropped/)
    assert.match(pm, /incomplete/)
    const { mining } = pipeline(starterArchitecture(), 100)
    // A healthy sample really has zero dropped and zero incomplete; the card must say so.
    assert.equal(mining.statistics.droppedCases, 0)
    assert.equal(mining.statistics.incompleteCases, 0)
    assert.ok(Number.isFinite(mining.statistics.completedCases))
    assert.ok(mining.statistics.completedCases > 0)
  })

  it('engine loggingStats disclose the unfinished count the UI needs', () => {
    const { sim } = runAt(weakArchitecture(), 3000, 60)
    assert.equal(typeof sim.loggingStats.unfinishedSampledCases, 'number')
    assert.ok(sim.loggingStats.unfinishedSampledCases >= 0)
  })
})
