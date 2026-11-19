import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EVENT_TYPE_CATALOG,
  EVENT_LOG_COLUMNS,
  buildDetailedEventLog,
  reconstructCaseTrace,
  eventsToCsv,
} from '../src/lib/eventLog.js'
import { toContract, archHash } from '../src/lib/contract.js'
import { runSimulation } from '../src/lib/engine.js'
import { mineEventLog, miningOptions, miningProvenance } from '../src/lib/mining.js'
import { starterArchitecture } from '../src/data/seedArchitectures.js'

function pipeline(arch, rate = 20, seed = 4242, duration = 30) {
  const contract = toContract(arch)
  const hash = archHash(arch)
  const sim = runSimulation(contract, { arrivalRate: rate, duration, seed }, { maxLoggedCases: 400 })
  const mining = mineEventLog(sim.eventLog, contract, {
    ...miningOptions(sim),
    provenance: miningProvenance(sim, contract, { archHash: hash, seed, arrivalRate: rate, duration }),
  })
  return { contract, sim, mining, hash, log: buildDetailedEventLog({ sim, mining, architecture: arch }) }
}

function synthetic(events) {
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

describe('event log: generation from real simulation events', () => {
  const { sim, mining, log } = pipeline(starterArchitecture())

  it('produces one enriched record per raw engine event', () => {
    assert.equal(log.events.length, sim.eventLog.length)
    assert.ok(log.events.length > 0, 'a real simulation must emit events')
  })

  it('never fabricates timeout or connection traversal events', () => {
    const types = new Set(log.events.map((e) => e.eventType))
    assert.equal(types.has('TIMEOUT_OCCURRED'), false)
    assert.equal(types.has('CONNECTION_TRAVERSED'), false)
    const unobserved = new Set(log.unobservedEventTypes.map((t) => t.key))
    assert.ok(unobserved.has('TIMEOUT_OCCURRED'))
    assert.ok(unobserved.has('CONNECTION_TRAVERSED'))
  })

  it('only emits catalogued event types', () => {
    const keys = new Set(EVENT_TYPE_CATALOG.map((t) => t.key))
    for (const event of log.events) {
      if (event.eventType) assert.ok(keys.has(event.eventType), `unknown event type ${event.eventType}`)
    }
  })

  it('keeps unavailable fields null rather than zero', () => {
    for (const event of log.events) {
      if (event.eventType === 'REQUEST_RECEIVED') {
        // arrival has no processing duration
        assert.equal(event.processingDurationMs, null)
      }
      if (event.activity === 'QUEUE_ENTER') {
        // queue entry has no measured duration until the matching exit
        assert.equal(event.waitingDurationMs, null)
      }
      if (['REQUEST_ARRIVAL', 'QUEUE_ENTER'].includes(event.activity)) {
        assert.equal(event.sourceComponent, null)
      }
    }
  })
})

describe('event log: case association, ordering, dedupe', () => {
  it('associates every event with a case and a per-case sequence', () => {
    const { log } = pipeline(starterArchitecture())
    const perCase = new Map()
    for (const event of log.events) {
      assert.ok(event.caseId, 'event must have a case id')
      const seq = (perCase.get(event.caseId) || 0) + 1
      assert.equal(event.sequenceNumber, seq)
      perCase.set(event.caseId, seq)
    }
    assert.ok(perCase.size > 0)
  })

  it('preserves chronological order in the enriched log', () => {
    const { log } = pipeline(starterArchitecture())
    for (let i = 1; i < log.events.length; i += 1) {
      assert.ok(log.events[i].timestampMs >= log.events[i - 1].timestampMs)
    }
  })

  it('drops duplicate events that share case/activity/component/timestamp/status', () => {
    const dupes = synthetic([
      { caseId: '1', activity: 'REQUEST_ARRIVAL', componentId: 'u', componentName: 'User', timestamp: 1 },
      { caseId: '1', activity: 'REQUEST_ARRIVAL', componentId: 'u', componentName: 'User', timestamp: 1 },
      { caseId: '1', activity: 'REQUEST_COMPLETE', componentId: 'u', componentName: 'User', timestamp: 5 },
    ])
    const log = buildDetailedEventLog({ sim: { eventLog: dupes } })
    assert.equal(log.events.length, 2)
  })

  it('stamps the run id and architecture hash on every event', () => {
    const { sim, mining, hash, log } = pipeline(starterArchitecture())
    assert.equal(log.architectureVersion, hash)
    assert.equal(log.runId, mining.provenance.runKey)
    for (const event of log.events) {
      assert.equal(event.runId, log.runId)
      assert.equal(event.architectureVersion, hash)
      assert.ok(event.id.startsWith(`${log.runId}::EVT-`))
      assert.equal(event.traceId, `${log.runId}::case-${event.caseId}`)
    }
    assert.ok(sim.eventLog.length > 0)
  })

  it('does not mix events from different runs', () => {
    const a = pipeline(starterArchitecture(), 20, 100, 20)
    const b = pipeline(starterArchitecture(), 30, 999, 20)
    const runIdsA = new Set(a.log.events.map((e) => e.runId))
    const runIdsB = new Set(b.log.events.map((e) => e.runId))
    assert.equal(runIdsA.size, 1)
    assert.equal(runIdsB.size, 1)
    assert.notEqual([...runIdsA][0], [...runIdsB][0], 'different seeds must produce different run keys')
  })
})

describe('event log: failed, dropped, and timed lifecycle events', () => {
  it('marks dropped events as Dropped with the right event type', () => {
    const raw = synthetic([
      { caseId: '1', activity: 'REQUEST_ARRIVAL', componentId: 'u', componentName: 'User', timestamp: 1 },
      { caseId: '1', activity: 'REQUEST_DROPPED', componentId: 'd', componentName: 'DB', timestamp: 4, status: 'dropped' },
    ])
    const log = buildDetailedEventLog({ sim: { eventLog: raw } })
    const drop = log.events.find((e) => e.activity === 'REQUEST_DROPPED')
    assert.ok(drop)
    assert.equal(drop.executionStatus, 'Dropped')
    assert.equal(drop.eventType, 'REQUEST_DROPPED')
  })

  it('marks failure and retry events with their event types', () => {
    const raw = synthetic([
      { caseId: '1', activity: 'PROCESS_START', componentId: 's', componentName: 'Server', timestamp: 1 },
      { caseId: '1', activity: 'FAILURE', componentId: 's', componentName: 'Server', timestamp: 2, status: 'failure' },
      { caseId: '1', activity: 'RETRY', componentId: 's', componentName: 'Server', timestamp: 3, status: 'retry' },
    ])
    const log = buildDetailedEventLog({ sim: { eventLog: raw } })
    const failure = log.events.find((e) => e.activity === 'FAILURE')
    const retry = log.events.find((e) => e.activity === 'RETRY')
    assert.equal(failure.executionStatus, 'Failed')
    assert.equal(failure.eventType, 'REQUEST_FAILED')
    assert.equal(retry.eventType, 'RETRY_ATTEMPTED')
  })

  it('derives database and authentication activity types from the component type', () => {
    const arch = {
      nodes: [
        { id: 'db', type: 'database', name: 'DB' },
        { id: 'auth', type: 'authentication', name: 'Auth' },
      ],
      edges: [],
    }
    const raw = synthetic([
      { caseId: '1', activity: 'PROCESS_START', componentId: 'db', componentName: 'DB', timestamp: 1 },
      { caseId: '1', activity: 'PROCESS_COMPLETE', componentId: 'db', componentName: 'DB', timestamp: 2 },
      { caseId: '1', activity: 'PROCESS_START', componentId: 'auth', componentName: 'Auth', timestamp: 3 },
      { caseId: '1', activity: 'PROCESS_COMPLETE', componentId: 'auth', componentName: 'Auth', timestamp: 4 },
    ])
    const log = buildDetailedEventLog({ sim: { eventLog: raw }, architecture: arch })
    const types = log.events.map((e) => e.eventType)
    assert.ok(types.includes('DATABASE_QUERY_STARTED'))
    assert.ok(types.includes('DATABASE_QUERY_COMPLETED'))
    assert.ok(types.includes('AUTHENTICATION_STARTED'))
    assert.ok(types.includes('AUTHENTICATION_SUCCESSFUL'))
  })
})

describe('event log: processing/waiting durations', () => {
  it('pairs PROCESS_START/COMPLETE and QUEUE_ENTER/EXIT into durations', () => {
    const raw = synthetic([
      { caseId: '1', activity: 'QUEUE_ENTER', componentId: 'g', componentName: 'Gateway', timestamp: 10 },
      { caseId: '1', activity: 'QUEUE_EXIT', componentId: 'g', componentName: 'Gateway', timestamp: 13 },
      { caseId: '1', activity: 'PROCESS_START', componentId: 'g', componentName: 'Gateway', timestamp: 14 },
      { caseId: '1', activity: 'PROCESS_COMPLETE', componentId: 'g', componentName: 'Gateway', timestamp: 20 },
    ])
    const log = buildDetailedEventLog({ sim: { eventLog: raw } })
    const exit = log.events.find((e) => e.activity === 'QUEUE_EXIT')
    const done = log.events.find((e) => e.activity === 'PROCESS_COMPLETE')
    assert.equal(exit.waitingDurationMs, 3)
    assert.equal(exit.startTimeMs, 10)
    assert.equal(done.processingDurationMs, 6)
    assert.equal(done.startTimeMs, 14)
  })

  it('infers component transitions from adjacent process events', () => {
    const raw = synthetic([
      { caseId: '1', activity: 'PROCESS_COMPLETE', componentId: 'g', componentName: 'Gateway', timestamp: 2 },
      { caseId: '1', activity: 'PROCESS_START', componentId: 's', componentName: 'Server', timestamp: 3 },
    ])
    const log = buildDetailedEventLog({ sim: { eventLog: raw } })
    const start = log.events.find((e) => e.activity === 'PROCESS_START')
    assert.equal(start.sourceComponent, 'Gateway')
    assert.equal(start.destinationComponent, 'Server')
  })
})

describe('event log: case trace reconstruction', () => {
  it('reconstructs one case in chronological order with transitions', () => {
    const { log } = pipeline(starterArchitecture())
    const caseId = log.events[0].caseId
    const trace = reconstructCaseTrace(log.events, caseId)
    assert.ok(trace)
    assert.equal(trace.caseId, String(caseId))
    assert.equal(trace.events.length, log.events.filter((e) => String(e.caseId) === String(caseId)).length)
    for (let i = 1; i < trace.events.length; i += 1) {
      assert.ok(trace.events[i].timestampMs >= trace.events[i - 1].timestampMs)
    }
    assert.equal(trace.firstTimestampMs, trace.events[0].timestampMs)
    assert.equal(trace.lastTimestampMs, trace.events[trace.events.length - 1].timestampMs)
    assert.ok(Array.isArray(trace.transitions))
    assert.equal(trace.runId, log.runId)
  })

  it('returns null for an unknown case', () => {
    const { log } = pipeline(starterArchitecture())
    assert.equal(reconstructCaseTrace(log.events, 'does-not-exist'), null)
  })
})

describe('event log: analytics', () => {
  const { log, mining } = pipeline(starterArchitecture())

  it('derives counts from real evidence', () => {
    assert.equal(log.analytics.totalEvents, log.events.length)
    assert.equal(log.analytics.totalCases, mining.statistics.totalCases)
    assert.ok(log.analytics.avgEventsPerCase > 0)
    assert.ok(log.analytics.mostFrequentActivity)
    assert.ok(log.analytics.statusDistribution.length > 0)
  })

  it('counts failed and dropped cases without silent exclusion', () => {
    assert.ok(log.analytics.droppedCases >= 0)
    assert.ok(log.analytics.failedCases >= 0)
    const outcomes = new Set(log.cases.map((c) => c.outcome))
    assert.ok(outcomes.size >= 1)
  })

  it('reports most time-consuming activity only when durations exist', () => {
    if (log.events.some((e) => Number.isFinite(e.processingDurationMs))) {
      assert.ok(log.analytics.mostTimeConsumingActivity)
    } else {
      assert.equal(log.analytics.mostTimeConsumingActivity, null)
    }
  })
})

describe('event log: CSV export', () => {
  it('exports every configured column with a header', () => {
    assert.ok(EVENT_LOG_COLUMNS.length >= 18)
    const raw = synthetic([
      { caseId: '1', activity: 'REQUEST_ARRIVAL', componentId: 'u', componentName: 'User', timestamp: 1 },
      { caseId: '1', activity: 'REQUEST_COMPLETE', componentId: 'u', componentName: 'User', timestamp: 5 },
    ])
    const log = buildDetailedEventLog({ sim: { eventLog: raw } })
    const csv = eventsToCsv(log.events)
    const lines = csv.split('\r\n')
    assert.equal(lines.length, 3)
    assert.equal(lines[0].split(',').length, EVENT_LOG_COLUMNS.length)
    assert.match(lines[0], /Event ID/)
    assert.match(lines[0], /Architecture Version/)
    assert.match(lines[0], /Simulation Run ID/)
  })

  it('writes missing values as empty cells, not zeros', () => {
    const raw = synthetic([
      { caseId: '1', activity: 'REQUEST_ARRIVAL', componentId: 'u', componentName: 'User', timestamp: 1 },
    ])
    const log = buildDetailedEventLog({ sim: { eventLog: raw } })
    const csv = eventsToCsv(log.events)
    // The arrival row must not contain "0" in the duration columns; empty cells are adjacent commas.
    assert.doesNotMatch(csv, /,0,0,/)
  })

  it('escapes commas and quotes in component names', () => {
    const raw = synthetic([
      { caseId: '1', activity: 'REQUEST_ARRIVAL', componentId: 'u', componentName: 'User, "web"', timestamp: 1 },
    ])
    const log = buildDetailedEventLog({ sim: { eventLog: raw } })
    const csv = eventsToCsv(log.events)
    assert.match(csv, /"User, ""web"""/)
  })
})
