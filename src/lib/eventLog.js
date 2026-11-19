/**
 * Detailed execution event log for the Process Mining module.
 *
 * This module deliberately does not change the simulation engine. It enriches the engine's
 * real event log with fields that are derivable from that log, the mined case summaries and
 * the validated architecture. Anything that cannot be derived stays null — a missing value
 * is never replaced with a zero or a guessed label.
 */
import { nodeTypes } from '../data/nodeTypes.js'
import { archHash } from './contract.js'

export const EVENT_TYPE_CATALOG = [
  { key: 'REQUEST_RECEIVED', label: 'Request Received', observed: true },
  { key: 'REQUEST_QUEUED', label: 'Request Queued', observed: true },
  { key: 'PROCESSING_STARTED', label: 'Request Processing Started', observed: true },
  { key: 'PROCESSING_COMPLETED', label: 'Component Processing Completed', observed: true },
  { key: 'CONNECTION_TRAVERSED', label: 'Connection Traversed', observed: false },
  { key: 'DATABASE_QUERY_STARTED', label: 'Database Query Started', observed: true },
  { key: 'DATABASE_QUERY_COMPLETED', label: 'Database Query Completed', observed: true },
  { key: 'AUTHENTICATION_STARTED', label: 'Authentication Started', observed: true },
  { key: 'AUTHENTICATION_SUCCESSFUL', label: 'Authentication Successful', observed: true },
  { key: 'AUTHENTICATION_FAILED', label: 'Authentication Failed', observed: true },
  { key: 'REQUEST_COMPLETED', label: 'Request Completed', observed: true },
  { key: 'REQUEST_FAILED', label: 'Request Failed', observed: true },
  { key: 'REQUEST_DROPPED', label: 'Request Dropped', observed: true },
  { key: 'TIMEOUT_OCCURRED', label: 'Timeout Occurred', observed: false },
  { key: 'RETRY_ATTEMPTED', label: 'Retry Attempted', observed: true },
]

const ACTIVITY_LABELS = {
  REQUEST_ARRIVAL: 'Request Arrival',
  QUEUE_ENTER: 'Queue Enter',
  QUEUE_EXIT: 'Queue Exit',
  PROCESS_START: 'Process Start',
  PROCESS_COMPLETE: 'Process Complete',
  FAILURE: 'Failure',
  RETRY: 'Retry',
  REQUEST_COMPLETE: 'Request Complete',
  REQUEST_DROPPED: 'Request Dropped',
}

const CSV_COLUMNS = [
  ['eventId', 'Event ID'],
  ['caseId', 'Case ID'],
  ['traceId', 'Trace ID'],
  ['sequenceNumber', 'Sequence'],
  ['activity', 'Activity'],
  ['eventType', 'Event Type'],
  ['componentId', 'Component ID'],
  ['componentName', 'Component'],
  ['componentType', 'Component Type'],
  ['timestampMs', 'Timestamp (ms)'],
  ['startTimeMs', 'Start Time (ms)'],
  ['completionTimeMs', 'Completion Time (ms)'],
  ['processingDurationMs', 'Processing Duration (ms)'],
  ['waitingDurationMs', 'Waiting Duration (ms)'],
  ['executionStatus', 'Status'],
  ['rawStatus', 'Engine Status'],
  ['sourceComponent', 'Source Component'],
  ['destinationComponent', 'Destination Component'],
  ['failureReason', 'Failure Reason'],
  ['architectureVersion', 'Architecture Version'],
  ['runId', 'Simulation Run ID'],
]

const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
const text = (v) => (v === null || v === undefined || v === '' ? null : String(v))
const roundMs = (v) => (v === null ? null : Math.round(v * 1000) / 1000)

function componentTypes(architecture) {
  const map = new Map()
  for (const node of architecture?.nodes || []) {
    if (!node || node.id == null) continue
    map.set(String(node.id), node.type || null)
  }
  return map
}

function eventTypeFor(event) {
  const type = event.componentType
  if (event.activity === 'REQUEST_ARRIVAL') return 'REQUEST_RECEIVED'
  if (event.activity === 'QUEUE_ENTER') return 'REQUEST_QUEUED'
  if (event.activity === 'RETRY' || event.status === 'retry') return 'RETRY_ATTEMPTED'
  if (event.activity === 'REQUEST_DROPPED' || event.status === 'dropped') return 'REQUEST_DROPPED'
  if (event.activity === 'REQUEST_COMPLETE') return 'REQUEST_COMPLETED'
  if (type === 'database') {
    if (event.activity === 'PROCESS_START') return 'DATABASE_QUERY_STARTED'
    if (event.activity === 'PROCESS_COMPLETE') return 'DATABASE_QUERY_COMPLETED'
  }
  if (type === 'authentication') {
    if (event.activity === 'PROCESS_START') return 'AUTHENTICATION_STARTED'
    if (event.activity === 'PROCESS_COMPLETE') return event.status === 'failure' ? 'AUTHENTICATION_FAILED' : 'AUTHENTICATION_SUCCESSFUL'
    if (event.activity === 'FAILURE') return 'AUTHENTICATION_FAILED'
  }
  if (event.activity === 'FAILURE' || event.status === 'failure' || event.status === 'aborted') return 'REQUEST_FAILED'
  if (event.activity === 'PROCESS_COMPLETE') return 'PROCESSING_COMPLETED'
  if (event.activity === 'PROCESS_START') return 'PROCESSING_STARTED'
  return null
}

function executionStatusFor(event) {
  if (event.activity === 'REQUEST_DROPPED' || event.status === 'dropped') return 'Dropped'
  if (event.activity === 'FAILURE' || event.status === 'failure' || event.status === 'aborted') return 'Failed'
  if (event.activity === 'RETRY' || event.status === 'retry') return 'Retried'
  if (event.activity === 'QUEUE_ENTER' || event.status === 'waiting') return 'Queued'
  if (event.activity === 'REQUEST_COMPLETE' || event.activity === 'PROCESS_COMPLETE') return 'Completed'
  if (event.status === 'served') return 'Completed'
  return 'In Progress'
}

function failureReasonMap(mining) {
  const map = new Map()
  const deviations = Array.isArray(mining?.deviations) ? mining.deviations : []
  for (const deviation of deviations) {
    if (!deviation?.detail) continue
    const component = text(deviation.component)
    for (const caseId of deviation.caseIds || []) {
      const key = `${caseId}|${component || ''}`
      const current = map.get(key) || []
      if (!current.includes(deviation.detail)) current.push(deviation.detail)
      map.set(key, current.slice(0, 3))
    }
  }
  return map
}

function deviationLinks(mining, events) {
  const byCase = new Map()
  for (const event of events) {
    const key = String(event.caseId)
    const list = byCase.get(key) || []
    list.push(event)
    byCase.set(key, list)
  }
  const deviations = Array.isArray(mining?.deviations) ? mining.deviations : []
  return deviations.map((deviation, index) => {
    const component = text(deviation?.component)
    const ids = []
    for (const caseId of deviation?.caseIds || []) {
      for (const event of byCase.get(String(caseId)) || []) {
        if (component && event.componentName !== component) continue
        ids.push(event.id)
      }
    }
    return {
      ...deviation,
      key: deviation?.key || `deviation-${index}`,
      eventIds: [...new Set(ids)].slice(0, 100),
      eventCount: new Set(ids).size,
    }
  })
}

/**
 * Builds the enriched log from one simulation run only. The run id and architecture version
 * are stamped on every event so two runs can never be silently merged downstream.
 */
export function buildDetailedEventLog({ sim, mining, architecture, project } = {}) {
  const types = componentTypes(architecture)
  const provenance = mining?.provenance || null
  const runId =
    text(provenance?.runKey) ||
    text(sim?.resultKey) ||
    (provenance?.archHash
      ? `${provenance.archHash}::rate-${sim?.arrivalRate ?? provenance.arrivalRate}::dur-${sim?.duration ?? provenance.duration}::seed-${sim?.seed ?? provenance.seed}`
      : null) ||
    text(project?.id) ||
    'unknown-run'
  const architectureVersion = text(provenance?.archHash) || text(archHash(architecture)) || null
  const reasons = failureReasonMap(mining)

  const raw = Array.isArray(sim?.eventLog) ? sim.eventLog : []
  const seen = new Set()
  const ordered = raw
    .filter((event) => event && event.caseId != null)
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => {
      const key = [
        event.caseId,
        event.activity,
        event.componentId ?? event.componentName ?? '',
        event.timestamp ?? '',
        event.status ?? '',
      ].join('|')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => {
      const t = (finite(a.event.timestamp) ?? 0) - (finite(b.event.timestamp) ?? 0)
      return t || (finite(a.event.eventId) ?? a.index) - (finite(b.event.eventId) ?? b.index)
    })

  const pendingProcess = new Map()
  const pendingQueue = new Map()
  const lastCompleted = new Map()
  const sequence = new Map()

  const events = ordered.map(({ event, index }) => {
    const caseId = text(event.caseId)
    const componentId = text(event.componentId)
    const timestamp = finite(event.timestamp)
    const base = {
      eventId: finite(event.eventId) ?? index + 1,
      caseId,
      traceId: `${runId}::case-${caseId}`,
      sequenceNumber: (sequence.get(caseId) || 0) + 1,
      activity: text(event.activity) || 'UNKNOWN_ACTIVITY',
      activityLabel: ACTIVITY_LABELS[event.activity] || text(event.activity) || 'Unknown activity',
      componentId,
      componentName: text(event.componentName) || text(componentId),
      componentType: types.get(componentId) || null,
      timestampMs: roundMs(timestamp),
      startTimeMs: null,
      completionTimeMs: null,
      processingDurationMs: null,
      waitingDurationMs: null,
      executionStatus: null,
      rawStatus: text(event.status),
      sourceComponent: null,
      destinationComponent: null,
      failureReason: null,
      architectureVersion,
      runId,
    }
    sequence.set(caseId, base.sequenceNumber)

    if (base.activity === 'PROCESS_START') {
      const key = `${caseId}|${componentId ?? base.componentName ?? ''}`
      const stack = pendingProcess.get(key) || []
      stack.push(timestamp)
      pendingProcess.set(key, stack)
      const source = lastCompleted.get(caseId)
      if (source && source !== base.componentName) {
        base.sourceComponent = source
        base.destinationComponent = base.componentName
      }
    } else if (base.activity === 'PROCESS_COMPLETE') {
      const key = `${caseId}|${componentId ?? base.componentName ?? ''}`
      const stack = pendingProcess.get(key) || []
      const start = stack.pop()
      if (start !== undefined) {
        pendingProcess.set(key, stack)
        base.startTimeMs = roundMs(start)
        base.completionTimeMs = base.timestampMs
        base.processingDurationMs = roundMs(Math.max(0, timestamp - start))
      }
      lastCompleted.set(caseId, base.componentName)
    } else if (base.activity === 'QUEUE_ENTER') {
      const key = `${caseId}|${componentId ?? base.componentName ?? ''}`
      const stack = pendingQueue.get(key) || []
      stack.push(timestamp)
      pendingQueue.set(key, stack)
    } else if (base.activity === 'QUEUE_EXIT') {
      const key = `${caseId}|${componentId ?? base.componentName ?? ''}`
      const stack = pendingQueue.get(key) || []
      const start = stack.pop()
      if (start !== undefined) {
        pendingQueue.set(key, stack)
        base.startTimeMs = roundMs(start)
        base.completionTimeMs = base.timestampMs
        base.waitingDurationMs = roundMs(Math.max(0, timestamp - start))
      }
    }

    base.executionStatus = executionStatusFor(base)
    base.eventType = eventTypeFor(base)
    base.id = `${runId}::EVT-${base.eventId}`

    if (base.executionStatus === 'Failed' || base.executionStatus === 'Dropped') {
      const key = `${caseId}|${base.componentName || ''}`
      const found = reasons.get(key) || reasons.get(`${caseId}|`) || []
      base.failureReason = found.length ? found.join(' · ') : null
    }
    return base
  })

  const cases = reconstructAllCases(events, mining)
  const analytics = buildAnalytics(events, cases, mining)
  const deviations = deviationLinks(mining, events)
  const unobservedEventTypes = EVENT_TYPE_CATALOG.filter((t) => !t.observed).map((t) => ({
    ...t,
    reason:
      t.key === 'CONNECTION_TRAVERSED'
        ? 'The engine does not log a separate transit event; component transitions are derived from adjacent process events.'
        : 'The engine emits no explicit timeout event; incomplete traces are reported instead.',
  }))

  return {
    runId,
    architectureVersion,
    provenance,
    events,
    cases,
    analytics,
    deviations,
    unobservedEventTypes,
  }
}

function reconstructAllCases(events, mining) {
  const byCase = new Map()
  for (const event of events) {
    const list = byCase.get(event.caseId) || []
    list.push(event)
    byCase.set(event.caseId, list)
  }
  const summaryById = new Map(
    (Array.isArray(mining?.caseSummaries) ? mining.caseSummaries : []).map((c) => [String(c.caseId), c]),
  )
  return [...byCase.entries()].map(([caseId, list]) => {
    const summary = summaryById.get(String(caseId))
    const ordered = [...list].sort(
      (a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || a.sequenceNumber - b.sequenceNumber,
    )
    const transitions = []
    for (let i = 1; i < ordered.length; i += 1) {
      const from = ordered[i - 1]
      const to = ordered[i]
      if (from.destinationComponent || (from.componentName && to.componentName && from.componentName !== to.componentName)) {
        transitions.push({
          from: from.destinationComponent || from.componentName,
          to: to.destinationComponent || to.componentName,
          atMs: to.timestampMs,
          eventId: to.id,
        })
      }
    }
    return {
      caseId,
      traceId: ordered[0]?.traceId || null,
      outcome: summary?.outcome || (ordered.some((e) => e.executionStatus === 'Dropped') ? 'dropped' : 'incomplete'),
      conforms: summary?.conforms ?? null,
      deviationTypes: summary?.deviationTypes || [],
      path: summary?.path || [],
      durationMs: summary?.durationMs ?? null,
      events: ordered,
      transitions,
      firstTimestampMs: ordered[0]?.timestampMs ?? null,
      lastTimestampMs: ordered[ordered.length - 1]?.timestampMs ?? null,
      failures: ordered.filter((e) => e.executionStatus === 'Failed').length,
      drops: ordered.filter((e) => e.executionStatus === 'Dropped').length,
    }
  })
}

/** Full chronological history for one case, including derived transitions and errors. */
export function reconstructCaseTrace(events, caseId) {
  const wanted = String(caseId)
  const list = (Array.isArray(events) ? events : []).filter((e) => String(e?.caseId) === wanted)
  if (!list.length) return null
  const ordered = [...list].sort(
    (a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || a.sequenceNumber - b.sequenceNumber,
  )
  const transitions = []
  for (let i = 1; i < ordered.length; i += 1) {
    const from = ordered[i - 1]
    const to = ordered[i]
    if (from.componentName && to.componentName && from.componentName !== to.componentName) {
      transitions.push({
        from: from.componentName,
        to: to.componentName,
        atMs: to.timestampMs,
        eventId: to.id,
      })
    }
  }
  return {
    caseId: wanted,
    traceId: ordered[0].traceId || null,
    runId: ordered[0].runId || null,
    architectureVersion: ordered[0].architectureVersion || null,
    events: ordered,
    transitions,
    firstTimestampMs: ordered[0].timestampMs ?? null,
    lastTimestampMs: ordered[ordered.length - 1].timestampMs ?? null,
  }
}

function mean(values) {
  const usable = values.filter((v) => Number.isFinite(v))
  if (!usable.length) return null
  return roundMs(usable.reduce((sum, v) => sum + v, 0) / usable.length)
}

function topCount(map) {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
  return entries.length ? { label: entries[0][0], count: entries[0][1] } : null
}

function buildAnalytics(events, cases, mining) {
  const stats = mining?.statistics || {}
  const activityCounts = new Map()
  const activityDuration = new Map()
  const statusCounts = new Map()
  const typeCounts = new Map()
  const failureCounts = new Map()

  for (const event of events) {
    const activity = event.activityLabel || event.activity
    activityCounts.set(activity, (activityCounts.get(activity) || 0) + 1)
    if (Number.isFinite(event.processingDurationMs)) {
      activityDuration.set(activity, (activityDuration.get(activity) || 0) + event.processingDurationMs)
    }
    statusCounts.set(event.executionStatus, (statusCounts.get(event.executionStatus) || 0) + 1)
    if (event.eventType) typeCounts.set(event.eventType, (typeCounts.get(event.eventType) || 0) + 1)
    if (event.executionStatus === 'Failed') {
      const name = event.componentName || 'unknown component'
      failureCounts.set(name, (failureCounts.get(name) || 0) + 1)
    }
  }

  const totalCases = Number(stats.totalCases) || cases.length || 0
  const topDuration = [...activityDuration.entries()].sort((a, b) => b[1] - a[1])[0] || null

  return {
    totalEvents: events.length,
    totalCases,
    completedCases: Number(stats.completedCases) || cases.filter((c) => c.outcome === 'completed').length,
    failedCases: Number(stats.failedCases ?? stats.incompleteCases) || cases.filter((c) => c.outcome !== 'completed' && c.outcome !== 'dropped').length,
    droppedCases: Number(stats.droppedCases) || cases.filter((c) => c.outcome === 'dropped').length,
    avgEventsPerCase: totalCases ? roundMs(events.length / totalCases) : null,
    avgProcessingDurationMs: mean(events.map((e) => e.processingDurationMs)),
    avgWaitingDurationMs: mean(events.map((e) => e.waitingDurationMs)),
    mostFrequentActivity: topCount(activityCounts),
    mostTimeConsumingActivity: topDuration
      ? { label: topDuration[0], totalMs: roundMs(topDuration[1]) }
      : null,
    failureFrequencyByComponent: [...failureCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    statusDistribution: [...statusCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    eventTypeDistribution: [...typeCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  }
}

function csvCell(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Unlike the UI, missing values are exported as empty cells, never as a zero. */
export function eventsToCsv(events) {
  const header = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(',')
  const rows = (Array.isArray(events) ? events : []).map((event) =>
    CSV_COLUMNS.map(([key]) => csvCell(event[key] ?? null)).join(','),
  )
  return [header, ...rows].join('\r\n')
}

export const EVENT_LOG_COLUMNS = CSV_COLUMNS
