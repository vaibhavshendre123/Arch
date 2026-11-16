import { expectedPathModel } from './contract.js'

const QUEUE_ENTER = 'QUEUE_ENTER'
const QUEUE_EXIT = 'QUEUE_EXIT'
const PROCESS_START = 'PROCESS_START'
const PROCESS_COMPLETE = 'PROCESS_COMPLETE'
const FAILURE = 'FAILURE'
const RETRY = 'RETRY'
const REQUEST_COMPLETE = 'REQUEST_COMPLETE'
const REQUEST_DROPPED = 'REQUEST_DROPPED'

const DEFAULTS = {
  minVisits: 3,
  minWaitMs: 5,
  queueDeviationMs: 10,
  maxVariants: 12,
  maxFrequentPaths: 8,
  maxBottlenecks: 8,
  maxExpectedPaths: 6,
  maxAffectedCaseIds: 25,
}

// Deviation classification:
// - `trace`      : the executed activity sequence deviates from the expected
//                  model. These are the findings that make a case non-conforming.
// - `reliability`: a failure, retry or queueing episode was observed, but the
//                  trace itself still walked an expected path when it finished.
//                  These do NOT reduce conformance — a recovered retry is a
//                  reliability signal, not a process-shape violation.
const DEVIATION_CATEGORY = {
  FAILURE: 'reliability',
  RETRY: 'reliability',
  QUEUEING: 'reliability',
  UNEXPECTED_COMPONENT: 'trace',
  SKIPPED_COMPONENT: 'trace',
  DROPPED: 'trace',
  INCOMPLETE_TRACE: 'trace',
}

const DEVIATION_SEVERITY = {
  FAILURE: 'high',
  DROPPED: 'high',
  INCOMPLETE_TRACE: 'high',
  RETRY: 'med',
  QUEUEING: 'med',
  UNEXPECTED_COMPONENT: 'med',
  SKIPPED_COMPONENT: 'low',
}

const ESCALATE_SHARE = 0.25
const EMPTY_VARIANT = 'no-components'
const SINGLE = ['low']
const PAIR = ['med', 'high']

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const share = (part, whole) => (whole > 0 ? part / whole : 0)
const round3 = (v) => Math.round(v * 1000) / 1000
const ms1 = (v) => Math.round(v * 10) / 10
const pct1 = (v) => Math.round(v * 1000) / 10
const name = (v, fallback = 'Unknown') => (v ? String(v) : fallback)

export const CONFORMANCE_FORMULA =
  'conformanceRate = conformingCases / totalCases, where a case conforms only if it completed (REQUEST_COMPLETE), was never dropped, and its ordered activity sequence exactly matches one of the expected paths enumerated from the architecture graph. Dropped, failed (incomplete) and path-mismatched cases are all non-conforming. Reliability findings (failures, retries, queueing) inside a case that still completed an expected path do not reduce conformance.'

function contractPaths(contract, maxPaths) {
  let model = null
  try {
    model = expectedPathModel(contract, maxPaths)
  } catch {
    model = null
  }
  const paths = (model?.paths || []).map((p) => {
    const steps = Array.isArray(p) ? p : []
    return steps.map((s) => {
      if (s && typeof s === 'object') {
        const label = s.name != null && s.name !== '' ? String(s.name) : String(s.id ?? '')
        return { id: s.id != null ? String(s.id) : '', name: label }
      }
      return { id: '', name: String(s ?? '') }
    })
  })
  return {
    paths,
    names: paths.map((s) => s.map((x) => x.name)),
    idSets: paths.map((s) => new Set(s.map((x) => x.id).filter(Boolean))),
    allIds: new Set(paths.flatMap((s) => s.map((x) => x.id).filter(Boolean))),
    truncated: Boolean(model?.truncated),
    limit: model?.limit ?? maxPaths,
    entryIds: Array.isArray(model?.entryIds) ? model.entryIds.map(String) : [],
    terminalIds: Array.isArray(model?.terminalIds) ? model.terminalIds.map(String) : [],
    hasCycles: Boolean(model?.hasCycles),
  }
}

function contractEdges(contract) {
  const edges = Array.isArray(contract?.edges) ? contract.edges : []
  const ids = new Set((contract?.nodes || []).map((n) => n?.id).filter(Boolean))
  const out = new Set()
  const hasIncoming = new Set()
  for (const e of edges) {
    if (!e?.source || !e?.target) continue
    if (ids.size && (!ids.has(e.source) || !ids.has(e.target))) continue
    out.add(`${e.source}>${e.target}`)
    hasIncoming.add(e.target)
  }
  return { out, hasIncoming }
}

function normaliseEvents(eventLog) {
  const list = Array.isArray(eventLog) ? eventLog : []
  const out = []
  const seen = new Set()
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i]
    if (!e || typeof e !== 'object') continue
    const tsRaw = Number(e.timestamp)
    const ts = Number.isFinite(tsRaw) ? tsRaw : 0
    const caseId = e.caseId == null || e.caseId === '' ? 'case-0' : String(e.caseId)
    const activity = e.activity == null ? '' : String(e.activity)
    const componentId = e.componentId == null ? '' : String(e.componentId)
    // Collapse exact duplicates (same case, activity, component and timestamp)
    // that a re-emitted or replayed log can contain. Order is preserved so a
    // legitimate A-then-A sequence at different timestamps survives.
    const dedupeKey = `${caseId}|${activity}|${componentId}|${ts}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push({
      order: i,
      caseId,
      activity,
      componentId,
      componentName: e.componentName == null ? '' : String(e.componentName),
      timestamp: ts,
      status: e.status == null ? '' : String(e.status),
    })
  }
  // Stable sort: timestamp first, original order as tie-break. Missing timestamps
  // were coerced to 0 above and keep their relative order via `order`.
  return out.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order)
}

function groupCases(events) {
  const groups = new Map()
  for (const e of events) {
    if (!groups.has(e.caseId)) groups.set(e.caseId, [])
    groups.get(e.caseId).push(e)
  }
  return [...groups.entries()]
    .map(([caseId, list]) => ({ caseId, events: list }))
    .sort((a, b) => a.caseId.localeCompare(b.caseId, undefined, { numeric: true }))
}

function readCase(c) {
  const steps = []
  const path = []
  const idPath = []
  const waited = new Map()
  const processed = new Map()
  const depth = new Map()
  const depthMax = new Map()
  const visits = new Map()
  const queues = []
  const retries = new Map()
  const failures = new Map()
  const openStarts = new Map()
  const openEnters = new Map()
  let lastExit = null
  let completed = false
  let dropped = false
  let droppedAt = ''
  let firstTs = null
  let lastTs = null

  const push = (e) => {
    if (!e.componentName) return
    const last = steps[steps.length - 1]
    if (last && last.name === e.componentName) {
      if (!last.id && e.componentId) last.id = e.componentId
      return
    }
    steps.push({ id: e.componentId, name: e.componentName })
    visits.set(e.componentName, (visits.get(e.componentName) || 0) + 1)
  }

  const addWait = (key, value) => {
    if (!(value > 0)) return
    const rec = waited.get(key) || { total: 0, max: 0, count: 0 }
    rec.total += value
    rec.max = Math.max(rec.max, value)
    rec.count += 1
    waited.set(key, rec)
  }

  const addProcessing = (key, value) => {
    if (!(value > 0)) return
    processed.set(key, (processed.get(key) || 0) + value)
  }

  for (const e of c.events) {
    if (firstTs == null) firstTs = e.timestamp
    lastTs = e.timestamp
    if (e.activity === REQUEST_COMPLETE) {
      completed = true
      push(e)
      continue
    }
    if (e.activity === REQUEST_DROPPED) {
      dropped = true
      droppedAt = e.componentName || droppedAt
      push(e)
      continue
    }
    if (e.activity === QUEUE_ENTER) {
      const key = e.componentName || e.componentId
      const gap = lastExit ? e.timestamp - lastExit.ts : 0
      const enters = openEnters.get(key) || []
      enters.push(e.timestamp)
      openEnters.set(key, enters)
      queues.push({ from: lastExit?.name || '', fromId: lastExit?.id || '', to: key, toId: e.componentId, wait: gap })
      lastExit = null
      const d = (depth.get(key) || 0) + 1
      depth.set(key, d)
      depthMax.set(key, Math.max(depthMax.get(key) || 0, d))
      push(e)
      continue
    }
    if (e.activity === QUEUE_EXIT) {
      const key = e.componentName || e.componentId
      const enters = openEnters.get(key)
      const enteredAt = enters?.length ? enters.shift() : null
      if (enteredAt != null) {
        const residence = e.timestamp - enteredAt
        if (residence > 0) {
          addWait(key, residence)
          const rec = waited.get(key) || { total: 0, max: 0, count: 0 }
          rec.max = Math.max(rec.max, residence)
          waited.set(key, rec)
        }
      }
      depth.set(key, Math.max(0, (depth.get(key) || 0) - 1))
      push(e)
      continue
    }
    if (e.activity === PROCESS_START) {
      const key = e.componentName || e.componentId
      lastExit = null
      if (!openStarts.has(key)) openStarts.set(key, [])
      openStarts.get(key).push(e.timestamp)
      push(e)
      continue
    }
    if (e.activity === PROCESS_COMPLETE) {
      const key = e.componentName || e.componentId
      const starts = openStarts.get(key)
      if (starts?.length) addProcessing(key, e.timestamp - starts.shift())
      else addProcessing(key, 0)
      lastExit = { ts: e.timestamp, name: key, id: e.componentId }
      push(e)
      continue
    }
    if (e.activity === FAILURE) {
      failures.set(e.componentName, (failures.get(e.componentName) || 0) + 1)
      push(e)
      continue
    }
    if (e.activity === RETRY) {
      retries.set(e.componentName, (retries.get(e.componentName) || 0) + 1)
      push(e)
      continue
    }
    push(e)
  }

  path.push(...steps.map((s) => s.name))
  idPath.push(...steps.map((s) => s.id).filter(Boolean))

  // A case with no terminal event (no REQUEST_COMPLETE and no REQUEST_DROPPED)
  // is incomplete: the engine stopped following it (budget exhausted mid-flight)
  // or it failed past its retry limit without a drop record.
  const incomplete = !completed && !dropped

  return {
    caseId: c.caseId,
    eventCount: c.events.length,
    steps,
    path,
    idPath,
    waited,
    processed,
    depthMax,
    visits,
    queues,
    retries,
    failures,
    completed,
    dropped,
    droppedAt,
    incomplete,
    durationMs: firstTs != null && lastTs != null ? Math.max(0, lastTs - firstTs) : 0,
  }
}

function bestExpectedIndex(model, record) {
  let best = -1
  let bestScore = -1
  for (let i = 0; i < model.idSets.length; i += 1) {
    const set = model.idSets[i]
    if (!set.size) continue
    let hit = 0
    for (const id of record.idPath) if (set.has(id)) hit += 1
    if (hit > bestScore) {
      bestScore = hit
      best = i
    }
  }
  if (best >= 0) return best
  let nameBest = -1
  let nameScore = -1
  for (let i = 0; i < model.names.length; i += 1) {
    const steps = model.names[i]
    if (!steps.length) continue
    const hit = record.path.filter((n) => steps.includes(n)).length
    if (hit > nameScore) {
      nameScore = hit
      nameBest = i
    }
  }
  return nameBest
}

function deviationGroup(store, type, key, component, record) {
  const id = `${type}|${key}`
  if (!store.has(id)) {
    store.set(id, {
      type,
      key,
      component,
      cases: new Set(),
      caseIds: [],
      events: 0,
      wait: 0,
      hops: new Map(),
    })
  }
  const group = store.get(id)
  group.cases.add(record.caseId)
  if (group.caseIds.length < DEFAULTS.maxAffectedCaseIds) group.caseIds.push(record.caseId)
  return group
}

function collectDeviations(records, model, edges, options) {
  const store = new Map()
  for (const record of records) {
    const expectedIndex = bestExpectedIndex(model, record)
    const expectedNames = expectedIndex >= 0 ? model.names[expectedIndex] || [] : []
    const pathMatches =
      expectedIndex >= 0 && variantKey(record.path) === variantKey(model.names[expectedIndex] || [])

    for (const q of record.queues) {
      if (q.wait < options.queueDeviationMs) continue
      const routedDirectly = q.from
        ? Boolean(q.fromId && q.toId && edges.out.has(`${q.fromId}>${q.toId}`))
        : !edges.hasIncoming.has(q.toId) || (model.names[expectedIndex] || [])[0] === q.to
      if (!routedDirectly) continue
      const group = deviationGroup(store, 'QUEUEING', q.to || q.toId, name(q.to), record)
      group.events += 1
      group.wait += q.wait
      const hop = q.from ? `${q.from} → ${q.to}` : `entry → ${q.to}`
      group.hops.set(hop, (group.hops.get(hop) || 0) + 1)
    }

    for (const [key, count] of record.retries) {
      const group = deviationGroup(store, 'RETRY', key, name(key), record)
      group.events += count
    }

    for (const [key, count] of record.failures) {
      const group = deviationGroup(store, 'FAILURE', key, name(key), record)
      group.events += count
    }

    for (const step of record.steps) {
      if (!step.id) continue
      if (model.allIds.size && !model.allIds.has(step.id)) {
        const group = deviationGroup(store, 'UNEXPECTED_COMPONENT', step.id, name(step.name), record)
        group.events += 1
      }
    }

    const seenNames = new Set(record.path)
    if (expectedNames.length && !record.dropped && !record.incomplete) {
      for (const missing of expectedNames) {
        if (missing && !seenNames.has(missing)) {
          const group = deviationGroup(store, 'SKIPPED_COMPONENT', missing, missing, record)
          group.events += 1
        }
      }
    }

    if (record.dropped) {
      const key = record.droppedAt || 'entry'
      const group = deviationGroup(store, 'DROPPED', key, name(record.droppedAt, 'Entry point'), record)
      group.events += 1
    }

    // Incomplete traces (failed past retry limit, or abandoned by the engine
    // budget) never reached a terminal event. They are trace deviations because
    // the observed sequence cannot be certified as an expected path.
    if (record.incomplete && record.path.length > 0) {
      const lastStep = record.path[record.path.length - 1]
      const group = deviationGroup(store, 'INCOMPLETE_TRACE', lastStep || 'unknown', name(lastStep, 'unknown'), record)
      group.events += 1
      group.expectedIndex = expectedIndex
    }

    // A completed case whose collapsed path does not match any expected path is
    // a shape deviation even if no single component is "unexpected" in isolation
    // (e.g. the right components in the wrong order, or a subset).
    if (record.completed && !pathMatches && model.names.length) {
      const expected = expectedIndex >= 0 ? model.names[expectedIndex] : []
      const group = deviationGroup(store, 'PATH_MISMATCH', record.path.join(' > ') || EMPTY_VARIANT, record.path.join(' > ') || EMPTY_VARIANT, record)
      group.events += 1
      group.expectedPath = expected
      group.observedPath = record.path.slice()
    }
  }
  return store
}

DEVIATION_CATEGORY.PATH_MISMATCH = 'trace'
DEVIATION_SEVERITY.PATH_MISMATCH = 'med'

function deviationDetail(group, totalCases) {
  const pct = pct1(share(group.cases.size, totalCases))
  const label = group.component
  if (group.type === 'QUEUEING') {
    const hops = [...group.hops.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const hop = hops[0] ? hops[0][0] : 'the modelled route'
    return `${label} queued work on the direct ${hop} hop in ${group.cases.size} of ${totalCases} cases (${pct}%), averaging ${ms1(group.wait / Math.max(1, group.events))} ms of wait across ${group.events} queueing episodes.`
  }
  if (group.type === 'RETRY') {
    return `${label} retried in ${group.cases.size} of ${totalCases} cases (${pct}%), logging ${group.events} retry events. Retries that still completed an expected path do not reduce conformance.`
  }
  if (group.type === 'FAILURE') {
    return `${label} failed in ${group.cases.size} of ${totalCases} cases (${pct}%), logging ${group.events} failure events. A failure that recovered via retry still conforms if the trace finished an expected path.`
  }
  if (group.type === 'UNEXPECTED_COMPONENT') {
    return `${label} appears on no expected path yet ${group.cases.size} of ${totalCases} cases (${pct}%) visited it ${group.events} times. This is a trace deviation and reduces conformance for those cases.`
  }
  if (group.type === 'SKIPPED_COMPONENT') {
    return `${label} is on the expected path but was skipped by ${group.cases.size} of ${totalCases} cases (${pct}%). This is a trace deviation and reduces conformance for those cases.`
  }
  if (group.type === 'DROPPED') {
    return `${group.cases.size} of ${totalCases} cases (${pct}%) were dropped before completion${label === 'Entry point' ? '' : ` at ${label}`}. Dropped cases are non-conforming.`
  }
  if (group.type === 'INCOMPLETE_TRACE') {
    return `${group.cases.size} of ${totalCases} cases (${pct}%) stopped after ${label} without a completion or drop event, so their traces cannot be certified against the expected model. Incomplete traces are non-conforming.`
  }
  if (group.type === 'PATH_MISMATCH') {
    const expected = Array.isArray(group.expectedPath) && group.expectedPath.length ? group.expectedPath.join(' → ') : 'an expected path'
    return `${group.cases.size} of ${totalCases} cases (${pct}%) completed with the sequence "${group.component}" which does not match ${expected}. This is a trace deviation and reduces conformance for those cases.`
  }
  return `${label} deviated in ${group.cases.size} of ${totalCases} cases (${pct}%).`
}

function rankDeviations(store, totalCases) {
  const list = [...store.values()].map((group) => {
    const base = DEVIATION_SEVERITY[group.type] || 'low'
    const order = PAIR.indexOf(base) >= 0 ? PAIR : SINGLE
    const shareValue = share(group.cases.size, totalCases)
    const severity = shareValue >= ESCALATE_SHARE ? order[order.length - 1] : base
    const category = DEVIATION_CATEGORY[group.type] || 'reliability'
    return {
      type: group.type,
      category,
      component: group.component,
      detail: deviationDetail(group, totalCases),
      severity,
      caseCount: group.cases.size,
      caseIds: group.caseIds.slice(0, DEFAULTS.maxAffectedCaseIds),
      expectedActivity:
        group.type === 'SKIPPED_COMPONENT'
          ? group.component
          : group.type === 'PATH_MISMATCH' || group.type === 'INCOMPLETE_TRACE'
            ? Array.isArray(group.expectedPath) && group.expectedPath.length
              ? group.expectedPath.join(' → ')
              : 'an expected path'
            : undefined,
      observedActivity:
        group.type === 'PATH_MISMATCH'
          ? Array.isArray(group.observedPath)
            ? group.observedPath.join(' → ')
            : group.component
          : group.type === 'DROPPED' || group.type === 'INCOMPLETE_TRACE'
            ? group.component
            : undefined,
    }
  })
  const weight = { high: 0, med: 1, low: 2 }
  return list.sort(
    (a, b) =>
      (a.category === b.category ? 0 : a.category === 'trace' ? -1 : 1) ||
      weight[a.severity] - weight[b.severity] ||
      b.caseCount - a.caseCount ||
      a.type.localeCompare(b.type) ||
      a.component.localeCompare(b.component),
  )
}

function severityFor(waitRatio, utilisation) {
  if (waitRatio > 3 || utilisation > 0.85) return 'high'
  if (waitRatio > 1.5 || utilisation > 0.65) return 'med'
  return 'low'
}

function bottleneckNote(component, stats) {
  const util = stats.derived
    ? `, with a peak queue of ${stats.queueDepthMax}; utilisation is unavailable because it cannot be recovered from an event log prefix`
    : ` and a peak queue of ${stats.queueDepthMax}, at ${pct1(stats.utilisation)}% supplied utilisation`
  const assumed =
    stats.assumedCapacity != null
      ? ` Capacity was assumed at ${stats.assumedCapacity} because none was configured, so utilisation is relative to that assumption.`
      : ''
  return `${component} makes requests wait ${stats.waitingMs} ms on average against ${stats.processingMs} ms of processing, a wait ratio of ${stats.waitRatio}x over ${stats.visits} visits${util}.${assumed}`
}

function buildBottlenecks(records, options) {
  const waits = new Map()
  const procs = new Map()
  const visits = new Map()
  const depths = new Map()
  const ids = new Map()

  for (const record of records) {
    for (const [key, rec] of record.waited) {
      const cur = waits.get(key) || { total: 0, max: 0, count: 0 }
      cur.total += rec.total
      cur.count += rec.count
      cur.max = Math.max(cur.max, rec.max)
      waits.set(key, cur)
    }
    for (const [key, total] of record.processed) procs.set(key, (procs.get(key) || 0) + total)
    for (const [key, count] of record.visits) {
      visits.set(key, (visits.get(key) || 0) + count)
      const step = record.steps.find((s) => s.name === key)
      if (step?.id && !ids.has(key)) ids.set(key, step.id)
    }
    for (const [key, depth] of record.depthMax) depths.set(key, Math.max(depths.get(key) || 0, depth))
  }

  const supplied = options?.utilization && typeof options.utilization === 'object' ? options.utilization : null
  const list = []
  for (const [key, wait] of waits) {
    const visitsCount = visits.get(key) || wait.count
    if (visitsCount < options.minVisits) continue
    if (wait.count <= 0) continue
    const avgWait = wait.total / wait.count
    if (avgWait < options.minWaitMs) continue
    const avgProcessing = (procs.get(key) || 0) / Math.max(1, visitsCount)
    // Compute the ratio from the same 1-decimal values the UI displays, so a reader can
    // verify "1932.4 ms / 30.0 ms = 64.41x" without hitting a rounding mismatch.
    const waitingMs = ms1(avgWait)
    const processingMs = ms1(avgProcessing)
    const waitRatio = round3(waitingMs / Math.max(processingMs, 1))
    const componentId = ids.get(key) || key
    const measured = supplied ? supplied[componentId] ?? supplied[key] : undefined
    const utilisation = clamp(measured != null ? Number(measured) : 0, 0, 1)
    const suppliedDepth = options.queueDepth ? options.queueDepth[componentId] ?? options.queueDepth[key] : undefined
    const assumption =
      options.assumptions && typeof options.assumptions === 'object'
        ? options.assumptions[componentId] ?? options.assumptions[key]
        : null
    const assumedCapacity =
      assumption?.capacity?.assumed && Number.isFinite(Number(assumption.capacity.value))
        ? Number(assumption.capacity.value)
        : null
    const stats = {
      componentId,
      component: key,
      avgWait,
      avgProcessing,
      waitRatio,
      waitingMs,
      processingMs,
      // The engine's queueLengthMax is the true depth. A per-case reconstruction
      // can only ever see 0 or 1, because QUEUE_ENTER and QUEUE_EXIT are logged
      // at the same instant whenever a server slot is already free.
      queueDepthMax: suppliedDepth != null ? Number(suppliedDepth) : depths.get(key) || 0,
      visits: visitsCount,
      utilisation,
      derived: measured == null,
      assumedCapacity,
    }
    list.push({
      componentId,
      component: key,
      waitingMs,
      processingMs,
      waitRatio,
      queueDepthMax: stats.queueDepthMax,
      visits: visitsCount,
      capacityAssumed: assumedCapacity,
      severity: severityFor(waitRatio, utilisation),
      note: bottleneckNote(key, stats),
    })
  }

  const weight = { high: 0, med: 1, low: 2 }
  list.sort(
    (a, b) =>
      weight[a.severity] - weight[b.severity] ||
      b.waitRatio - a.waitRatio ||
      b.waitingMs - a.waitingMs ||
      a.component.localeCompare(b.component),
  )
  return list.slice(0, options.maxBottlenecks)
}

function variantKey(path) {
  return path.join(' > ')
}

// Utilisation and true queue depth cannot be recovered from an event log prefix.
// The engine already measures both per component, so hand them over as options
// and the miner can rank bottlenecks on real evidence.
export function miningOptions(sim) {
  const components = sim?.components && typeof sim.components === 'object' ? sim.components : null
  const options = {}
  if (!components) return options
  const utilization = {}
  const queueDepth = {}
  const assumptions = {}
  for (const [id, c] of Object.entries(components)) {
    if (!c || typeof c !== 'object') continue
    const util = Number(c.utilization)
    utilization[id] = Number.isFinite(util) ? clamp(util, 0, 1) : 0
    const depth = Number(c.queueLengthMax)
    queueDepth[id] = Number.isFinite(depth) ? depth : 0
    if (c.capacityAssumed) {
      assumptions[id] = { capacity: { assumed: true, value: Number(c.capacity) || null } }
    }
  }
  options.utilization = utilization
  options.queueDepth = queueDepth
  if (Object.keys(assumptions).length) options.assumptions = assumptions
  return options
}

/**
 * Build the provenance record that ties a mining result to the exact simulation
 * run and architecture version that produced its event log. Two runs that differ
 * in architecture hash, seed, arrival rate or duration must never be mixed.
 */
export function miningProvenance(sim, contract, extra = {}) {
  const hash = typeof extra.archHash === 'string' && extra.archHash ? extra.archHash : null
  const seed = sim?.seed ?? extra.seed ?? null
  const arrivalRate = sim?.arrivalRate ?? extra.arrivalRate ?? null
  const duration = sim?.duration ?? extra.duration ?? null
  const mode = sim?.mode === 'closed' || extra.mode === 'closed' ? 'closed' : 'rate'
  const population = sim?.population ?? extra.population ?? null
  const runKey = hash
    ? mode === 'closed'
      ? `${hash}::closed-${population}::dur-${duration}::seed-${seed}`
      : `${hash}::rate-${arrivalRate}::dur-${duration}::seed-${seed}`
    : null
  return {
    archHash: hash,
    seed,
    mode,
    population,
    arrivalRate,
    duration,
    runKey,
    totalRequests: sim?.metrics?.totalRequests ?? null,
    sampledCases: sim?.loggingStats?.sampledCases ?? null,
    sampleEvery: sim?.loggingStats?.sampleEvery ?? null,
    // The event budget can cut a run short of its requested duration. Surfacing both
    // numbers keeps a truncated run from reading as a full one.
    simulatedMs: sim?.simulatedMs ?? null,
    truncated: Boolean(sim?.truncated),
    unfinishedSampledCases: sim?.loggingStats?.unfinishedSampledCases ?? null,
    generatedAt: Date.now(),
  }
}

function unavailableStatistics(extra = {}) {
  return {
    available: false,
    totalCases: 0,
    completedCases: 0,
    droppedCases: 0,
    failedCases: 0,
    incompleteCases: 0,
    conformingCases: 0,
    nonConformingCases: 0,
    avgCaseLength: 0,
    variants: 0,
    conformanceRate: null,
    maxWaitMs: 0,
    loggedCases: 0,
    totalRequests: extra.totalRequests ?? null,
  }
}

export function mineEventLog(eventLog, contract, options) {
  const opts = { ...DEFAULTS, ...(options && typeof options === 'object' ? options : {}) }
  const events = normaliseEvents(eventLog)
  const cases = groupCases(events).map(readCase)
  const model = contractPaths(contract, opts.maxExpectedPaths)
  const edges = contractEdges(contract)
  const provenance = opts.provenance && typeof opts.provenance === 'object' ? opts.provenance : null

  const totalCases = cases.length
  const completedCases = cases.filter((c) => c.completed && !c.dropped).length
  const droppedCases = cases.filter((c) => c.dropped).length
  const incompleteCases = cases.filter((c) => c.incomplete).length
  const failedCases = incompleteCases
  const loggedCases = cases.filter((c) => c.eventCount > 0).length

  // Empty or missing log: report an explicit unavailable state rather than
  // fabricating 100% conformance or zero-value metrics.
  if (totalCases === 0) {
    return {
      frequentPaths: [],
      variants: [],
      bottlenecks: [],
      deviations: [],
      traceDeviations: [],
      reliabilityFindings: [],
      waitingTimes: {},
      caseSummaries: [],
      statistics: unavailableStatistics({ totalRequests: provenance?.totalRequests }),
      expectedPaths: [],
      expectedPathMeta: {
        truncated: model.truncated,
        limit: model.limit,
        entryCount: model.entryIds.length,
        terminalCount: model.terminalIds.length,
        hasCycles: model.hasCycles,
      },
      conformanceFormula: CONFORMANCE_FORMULA,
      provenance,
    }
  }

  const conformKeys = new Set()
  for (const i of model.names) conformKeys.add(variantKey(i))

  // Conformance (fitness): a case conforms only when it completed, was never
  // dropped, and its ordered activity sequence exactly matches an expected path.
  // Dropped and incomplete (failed) cases are non-conforming — they are counted
  // in the denominator so a run where half the sampled requests died cannot
  // still report 100% conformance.
  let conformingCases = 0
  const caseConform = new Map()
  for (const record of cases) {
    const conforms = record.completed && !record.dropped && conformKeys.has(variantKey(record.path))
    caseConform.set(record.caseId, conforms)
    if (conforms) conformingCases += 1
  }
  const nonConformingCases = totalCases - conformingCases

  const buckets = new Map()
  for (const record of cases) {
    const key = variantKey(record.path) || EMPTY_VARIANT
    if (!buckets.has(key)) buckets.set(key, { path: record.path.slice(), count: 0, caseIds: [] })
    const bucket = buckets.get(key)
    bucket.count += 1
    bucket.caseIds.push(record.caseId)
  }

  const rawVariants = [...buckets.values()]

  const deviationStore = collectDeviations(cases, model, edges, opts)
  const deviations = rankDeviations(deviationStore, totalCases)
  const traceDeviations = deviations.filter((d) => d.category === 'trace')
  const reliabilityFindings = deviations.filter((d) => d.category === 'reliability')

  const affected = new Map()
  for (const record of cases) {
    const key = variantKey(record.path) || EMPTY_VARIANT
    const hit = affected.get(key) || new Set()
    for (const [id, group] of deviationStore) {
      if (group.cases.has(record.caseId)) hit.add(id)
    }
    if (hit.size) affected.set(key, hit)
  }

  const ordered = rawVariants.sort(
    (a, b) => b.count - a.count || a.path.length - b.path.length || variantKey(a.path).localeCompare(variantKey(b.path)),
  )

  const variants = ordered.slice(0, opts.maxVariants).map((v) => ({
    path: v.path,
    count: v.count,
    support: round3(share(v.count, totalCases)),
    deviates: (affected.get(variantKey(v.path) || EMPTY_VARIANT) || new Set()).size,
    caseIds: v.caseIds,
  }))

  const frequentPaths = variants
    .slice(0, opts.maxFrequentPaths)
    .map((v) => ({ path: v.path, count: v.count, support: v.support }))

  const bottlenecks = buildBottlenecks(cases, opts)

  const waitingTimes = {}
  let maxWaitMs = 0
  for (const record of cases) {
    for (const [key, rec] of record.waited) {
      const cur = waitingTimes[key] || { total: 0, avg: 0, max: 0, count: 0 }
      cur.total += rec.total
      cur.count += rec.count
      cur.max = Math.max(cur.max, rec.max)
      cur.avg = round3(cur.total / cur.count)
      waitingTimes[key] = cur
      maxWaitMs = Math.max(maxWaitMs, rec.max)
    }
  }

  const expectedNames = model.names.map((steps) => steps.slice())
  const totalLength = cases.reduce((sum, c) => sum + c.path.length, 0)

  // Per-case summaries power the deviation drill-down and trace inspector. Event
  // timelines stay in sim.eventLog; duplicating them here would double memory.
  const caseSummaries = cases.map((record) => {
    const deviationTypes = []
    for (const group of deviationStore.values()) {
      if (group.cases.has(record.caseId)) deviationTypes.push(group.type)
    }
    return {
      caseId: record.caseId,
      outcome: record.completed ? 'completed' : record.dropped ? 'dropped' : 'incomplete',
      path: record.path.slice(),
      activityCount: record.path.length,
      eventCount: record.eventCount,
      durationMs: ms1(record.durationMs),
      conforms: Boolean(caseConform.get(record.caseId)),
      deviationTypes: deviationTypes.sort(),
    }
  })

  return {
    frequentPaths,
    variants,
    bottlenecks,
    deviations,
    traceDeviations,
    reliabilityFindings,
    waitingTimes,
    caseSummaries,
    statistics: {
      available: true,
      totalCases,
      completedCases,
      droppedCases,
      failedCases,
      incompleteCases,
      conformingCases,
      nonConformingCases,
      avgCaseLength: round3(share(totalLength, totalCases)),
      variants: rawVariants.length,
      // null (not 0) when nothing can be assessed, so the UI shows an
      // unavailable state instead of a fabricated percentage.
      conformanceRate: totalCases > 0 ? round3(share(conformingCases, totalCases)) : null,
      maxWaitMs: ms1(maxWaitMs),
      loggedCases,
      totalRequests: provenance?.totalRequests ?? null,
    },
    expectedPaths: expectedNames,
    expectedPathMeta: {
      truncated: model.truncated,
      limit: model.limit,
      entryCount: model.entryIds.length,
      terminalCount: model.terminalIds.length,
      hasCycles: model.hasCycles,
    },
    conformanceFormula: CONFORMANCE_FORMULA,
    provenance,
  }
}
