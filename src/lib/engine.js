import { createRng } from './rng.js'
import { createEventQueue } from './eventQueue.js'
import { graphOf, entryNodeIds, terminalNodeIds } from './contract.js'
import { nodeTypes, resolveParams, nodeMemoryLimit } from '../data/nodeTypes.js'
import {
  clamp,
  createAccumulator,
  createLatencySeries,
  createQueueSeries,
  percentile,
  positiveInt,
  positiveNumber,
  round,
} from './metrics.js'

const MAX_STEPS_PER_CASE = 40
const MAX_PROCESSED_EVENTS = 400000
const SERIES_BUCKETS = 40
const MAX_LATENCY_SAMPLES = 200000
const MAX_QUEUE_SAMPLES = 300000
const QUEUE_COMPACT_THRESHOLD = 2048
const FALLBACK_CAPACITY = 100
const DEFAULT_MAX_LOGGED_CASES = 400

const EVENT_ARRIVAL = 'ARRIVAL'
const EVENT_TRANSIT = 'TRANSIT'
const EVENT_SERVICE_DONE = 'SERVICE_DONE'

const ACTIVITY = {
  ARRIVAL: 'REQUEST_ARRIVAL',
  QUEUE_ENTER: 'QUEUE_ENTER',
  QUEUE_EXIT: 'QUEUE_EXIT',
  START: 'PROCESS_START',
  DONE: 'PROCESS_COMPLETE',
  FAILURE: 'FAILURE',
  RETRY: 'RETRY',
  COMPLETE: 'REQUEST_COMPLETE',
  DROPPED: 'REQUEST_DROPPED',
}

const OUTCOME_COMPLETED = 'completed'
const OUTCOME_FAILED = 'failed'
const OUTCOME_DROPPED = 'dropped'

function buildComponents(graph) {
  const list = []
  const index = new Map()
  const pendingTargets = []
  const nodes = graph.nodes || []
  for (const node of nodes) {
    if (!node) continue
    const id = node.id
    if (typeof id !== 'string' && typeof id !== 'number') continue
    if (id === '' || index.has(id)) continue
    const params = resolveParams(node)
    const capacityConfigured = Number.isFinite(params.capacity) && params.capacity > 0
    const capacity = Math.max(1, Math.floor(positiveNumber(params.capacity, FALLBACK_CAPACITY)))
    const configuredQueue = Math.floor(positiveNumber(params.queueCapacity, 0))
    const memoryMb = positiveNumber(params.memoryMb, 128)
    const memoryPerSessionMb = positiveNumber(params.memoryPerSessionMb, 8)
    const component = {
      id,
      name: typeof node.name === 'string' && node.name ? node.name : String(id),
      type: typeof node.type === 'string' ? node.type : 'unknown',
      category: nodeTypes[node.type]?.cat || 'application',
      params,
      capacity,
      capacityAssumed: !capacityConfigured,
      processingTimeMs: positiveNumber(params.processingTime, 0),
      serviceTimeCv: clamp(positiveNumber(params.serviceTimeCv, 0), 0, 2),
      configuredQueueCapacity: configuredQueue,
      queueCapacity: configuredQueue > 0 ? configuredQueue : Infinity,
      failureProbability: clamp(positiveNumber(params.failureProbability, 0), 0, 1),
      retryLimit: Math.floor(positiveNumber(params.retryLimit, 0)),
      baseLatencyMs: positiveNumber(params.baseLatencyMs, 0),
      memoryMb,
      memoryPerSessionMb,
      memoryLimitMb: nodeMemoryLimit({ ...params, capacity, memoryMb, memoryPerSessionMb }),
      outgoing: [],
      outgoingWeights: [],
      weightedOutgoing: false,
      queue: [],
      queueHead: 0,
      queueLength: 0,
      queueLengthMax: 0,
      busy: 0,
      peakOccupancy: 0,
      busyTimeMs: 0,
      processing: createAccumulator(),
      queueWait: createAccumulator(),
      visits: 0,
      failures: 0,
      retries: 0,
      dropped: 0,
    }
    const targets = graph.outgoing.get(id) || []
    const weights = graph.outgoingWeights?.get(id) || []
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i]
      if (target === id) continue
      const weight = weights[i]
      pendingTargets.push([component, target, typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : null])
    }
    index.set(id, component)
    list.push(component)
  }
  for (const [component, target, weight] of pendingTargets) {
    if (!index.has(target)) continue
    component.outgoing.push(target)
    component.outgoingWeights.push(weight)
  }
  for (const component of list) {
    component.weightedOutgoing = component.outgoingWeights.some((weight) => weight !== null)
  }
  return { list, index }
}

function resolveEntries(architecture, graph, index) {
  const primary = entryNodeIds(architecture).filter((id) => index.has(id))
  if (primary.length) return primary
  const roots = []
  for (const node of graph.nodes || []) {
    if (!node) continue
    if ((graph.incoming.get(node.id) || []).length === 0 && index.has(node.id)) roots.push(node.id)
  }
  if (roots.length) return roots
  return [...index.keys()]
}

export function runSimulation(contract, workload, options) {
  const settings = options && typeof options === 'object' ? options : {}
  const load = workload && typeof workload === 'object' ? workload : {}
  const architecture = contract && typeof contract === 'object' ? contract : { nodes: [], edges: [] }
  const maxLoggedCases = positiveInt(settings.maxLoggedCases, DEFAULT_MAX_LOGGED_CASES)
  const mode = load.mode === 'closed' ? 'closed' : 'rate'
  const closedLoop = mode === 'closed'
  const arrivalRate = positiveNumber(load.arrivalRate, 0)
  const duration = positiveNumber(load.duration, 0)
  const population = closedLoop ? Math.max(1, positiveInt(load.concurrentUsers, 1)) : 0
  const seed = load.seed ?? 0
  const windowMs = Math.max(0, duration) * 1000
  const rng = createRng(seed)

  // How many arrivals the run window is expected to produce. This sets the sampling
  // stride for the event log so the logged cases are spread across the entire duration
  // instead of clustered at its start. A closed loop recycles a fixed population, so
  // its sampling budget is spread by time instead (see shouldLogCase).
  const expectedCases = closedLoop
    ? Math.max(1, population)
    : Math.max(1, Math.round(arrivalRate * duration))
  const sampleEvery = closedLoop ? 1 : Math.max(1, Math.floor(expectedCases / maxLoggedCases))

  const graph = graphOf(architecture)
  const { list: componentList, index: componentIndex } = buildComponents(graph)
  const entries = resolveEntries(architecture, graph, componentIndex)
  const terminalIds = terminalNodeIds(architecture).filter((id) => componentIndex.has(id))

  const queue = createEventQueue()
  const latencies = []
  const latencyPairs = []
  const queueHistory = new Map()
  const eventLog = []
  const finishedCaseIds = new Set()
  // Case ids admitted to the sample by the stride. A subset may never finish before the
  // event budget stops the run; their partial traces stay in the log (see trim below).
  const loggedCaseIds = new Set()

  let now = 0
  let lastEventTime = 0
  let processedEvents = 0
  let nextCaseId = 0
  let loggedCaseSlots = 0
  let nextEventId = 0
  let totalActivities = 0
  let totalRequests = 0
  let completedRequests = 0
  let failedRequests = 0
  let droppedRequests = 0
  let inFlight = 0
  let latencyTotal = 0
  let queueSamples = 0
  let nextArrivalTime = 0
  let stepsCappedCases = 0

  const record = (simCase, activity, component, status) => {
    totalActivities += 1
    if (!simCase || !simCase.logged) return
    nextEventId += 1
    eventLog.push({
      caseId: simCase.id,
      eventId: nextEventId,
      activity,
      componentId: component ? component.id : null,
      componentName: component ? component.name : null,
      timestamp: round(now, 3),
      status,
    })
  }

  const trackQueueDepth = (component) => {
    let history = queueHistory.get(component.name)
    if (!history) {
      history = []
      queueHistory.set(component.name, history)
    }
    if (queueSamples < MAX_QUEUE_SAMPLES) {
      history.push(now, component.queueLength)
      queueSamples += 1
    } else if (history.length >= 2) {
      history[history.length - 2] = now
      history[history.length - 1] = component.queueLength
    } else {
      history.push(now, component.queueLength)
    }
  }

  const compactQueue = (component) => {
    if (component.queueHead < QUEUE_COMPACT_THRESHOLD) return
    if (component.queueHead * 2 < component.queue.length) return
    component.queue = component.queue.slice(component.queueHead)
    component.queueHead = 0
  }

  const finishCase = (simCase, outcome, component) => {
    finishedCaseIds.add(simCase.id)
    inFlight -= 1
    if (outcome === OUTCOME_COMPLETED) {
      completedRequests += 1
      record(simCase, ACTIVITY.COMPLETE, component, 'success')
    } else if (outcome === OUTCOME_FAILED) {
      failedRequests += 1
    }
    const latency = now - simCase.startTime
    if (Number.isFinite(latency) && latency >= 0) {
      latencies.push(latency)
      latencyTotal += latency
      if (latencyPairs.length < MAX_LATENCY_SAMPLES * 2) {
        latencyPairs.push(now, latency)
      } else {
        latencyPairs[latencyPairs.length - 2] = now
        latencyPairs[latencyPairs.length - 1] = latency
      }
    }
    // A closed loop recycles its population: the user whose request just ended issues
    // the next one. Queuing an ARRIVAL keeps equal-timestamp ordering deterministic.
    if (closedLoop && now < windowMs) {
      queue.push({ time: now, type: EVENT_ARRIVAL, payload: null })
    }
  }

  const dropCase = (simCase, component) => {
    droppedRequests += 1
    if (component) component.dropped += 1
    record(simCase, ACTIVITY.DROPPED, component, 'dropped')
    finishCase(simCase, OUTCOME_DROPPED, component)
  }

  // Service duration is drawn from a gamma distribution only when a coefficient of
  // variation is configured. At the default cv = 0 this returns the configured duration
  // without touching the RNG, so existing runs and their seeds reproduce exactly.
  const sampleServiceDuration = (component) => {
    const mean = component.processingTimeMs
    const cv = component.serviceTimeCv
    if (!(cv > 0) || !(mean > 0)) return mean
    const shape = 1 / (cv * cv)
    const scale = mean * cv * cv
    return rng.gamma(shape, scale)
  }

  const startService = (simCase, component) => {
    component.busy += 1
    if (component.busy > component.peakOccupancy) component.peakOccupancy = component.busy
    component.visits += 1
    simCase.steps += 1
    record(simCase, ACTIVITY.QUEUE_EXIT, component, 'success')
    record(simCase, ACTIVITY.START, component, 'success')
    queue.push({
      time: now + sampleServiceDuration(component),
      type: EVENT_SERVICE_DONE,
      payload: { simCase, component, startedAt: now },
    })
  }

  const serveNextWaiting = (component) => {
    if (component.queueHead >= component.queue.length) return
    const waiting = component.queue[component.queueHead]
    component.queue[component.queueHead] = null
    component.queueHead += 1
    component.queueLength -= 1
    compactQueue(component)
    trackQueueDepth(component)
    if (!waiting) return
    component.queueWait.add(now - waiting.queuedAt)
    startService(waiting, component)
  }

  const releaseSlot = (component) => {
    component.busy -= 1
    if (component.busy < 0) component.busy = 0
    serveNextWaiting(component)
  }

  const enterNode = (simCase, component) => {
    if (!component) {
      dropCase(simCase, null)
      return
    }
    if (component.busy >= component.capacity && component.queueLength >= component.queueCapacity) {
      dropCase(simCase, component)
      return
    }
    const mustQueue = component.busy >= component.capacity
    record(simCase, ACTIVITY.QUEUE_ENTER, component, mustQueue ? 'waiting' : 'served')
    if (!mustQueue) {
      startService(simCase, component)
      return
    }
    simCase.queuedAt = now
    component.queue.push(simCase)
    component.queueLength += 1
    if (component.queueLength > component.queueLengthMax) component.queueLengthMax = component.queueLength
    trackQueueDepth(component)
  }

  const pickWeightedTarget = (targets, weights) => {
    let total = 0
    for (let i = 0; i < targets.length; i += 1) {
      const weight = weights[i]
      total += typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 1
    }
    if (!(total > 0)) return rng.pick(targets)
    let draw = rng.next() * total
    for (let i = 0; i < targets.length; i += 1) {
      const weight = weights[i]
      draw -= typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 1
      if (draw < 0) return targets[i]
    }
    return targets[targets.length - 1]
  }

  const routeForward = (simCase, component) => {
    const targets = component.outgoing
    if (!targets.length) {
      finishCase(simCase, OUTCOME_COMPLETED, component)
      return
    }
    if (simCase.steps >= MAX_STEPS_PER_CASE) {
      stepsCappedCases += 1
      record(simCase, ACTIVITY.FAILURE, component, 'aborted')
      finishCase(simCase, OUTCOME_FAILED, component)
      return
    }
    const targetId =
      targets.length === 1
        ? targets[0]
        : // Explicit weights split traffic proportionally. Without any weight the
          // original equal-share pick is preserved, including its RNG consumption.
          component.weightedOutgoing
          ? pickWeightedTarget(targets, component.outgoingWeights)
          : rng.pick(targets)
    const target = componentIndex.get(targetId)
    simCase.retries = 0
    const delay = target ? target.baseLatencyMs : 0
    if (delay > 0) {
      queue.push({ time: now + delay, type: EVENT_TRANSIT, payload: { simCase, component: target } })
    } else {
      enterNode(simCase, target)
    }
  }

  const completeService = (payload) => {
    const simCase = payload?.simCase
    const component = payload?.component
    if (!simCase || !component) return
    const startedAt = Number.isFinite(payload.startedAt) ? payload.startedAt : now
    const elapsed = Math.max(0, now - startedAt)
    component.busyTimeMs += elapsed
    component.processing.add(elapsed)
    const failed = component.failureProbability > 0 && rng.next() < component.failureProbability
    record(simCase, ACTIVITY.DONE, component, failed ? 'failure' : 'success')
    releaseSlot(component)
    if (failed) {
      component.failures += 1
      record(simCase, ACTIVITY.FAILURE, component, 'failure')
      if (simCase.retries < component.retryLimit) {
        simCase.retries += 1
        component.retries += 1
        record(simCase, ACTIVITY.RETRY, component, 'retry')
        enterNode(simCase, component)
        return
      }
      finishCase(simCase, OUTCOME_FAILED, component)
      return
    }
    routeForward(simCase, component)
  }

  const shouldLogCase = () => {
    if (loggedCaseSlots >= maxLoggedCases) return false
    if (closedLoop) {
      // A closed loop recycles a fixed population, so the opening burst contains far more
      // cases than the logging budget. Spending the budget by elapsed time samples the
      // whole run instead of only its first moments.
      const expected = windowMs > 0 ? (now / windowMs) * maxLoggedCases : maxLoggedCases
      return loggedCaseSlots < Math.floor(expected) + 1
    }
    return nextCaseId % sampleEvery === 0
  }

  const startCase = (entryId) => {
    const component = componentIndex.get(entryId)
    nextCaseId += 1
    totalRequests += 1
    inFlight += 1
    const simCase = { id: nextCaseId, startTime: now, queuedAt: now, steps: 0, retries: 0, logged: false }
    // Sample every Nth arrival rather than the first N. Logging only the opening
    // requests meant the event log covered the first 400/arrivalRate seconds of the run
    // and nothing after it, so at 300 req/s a 100 s run was represented by its first
    // 1.3 s. Spreading the same budget across the whole window keeps the replay
    // timeline aligned with the configured duration. Deterministic for a given seed,
    // and still capped at maxLoggedCases so memory stays bounded.
    if (shouldLogCase()) {
      simCase.logged = true
      loggedCaseSlots += 1
      loggedCaseIds.add(simCase.id)
    }
    record(simCase, ACTIVITY.ARRIVAL, component, 'success')
    enterNode(simCase, component)
  }

  const pushArrival = () => {
    queue.push({ time: nextArrivalTime, type: EVENT_ARRIVAL, payload: null })
    nextArrivalTime += rng.exponential(1000 / arrivalRate)
  }

  if (closedLoop) {
    if (windowMs > 0 && entries.length > 0) {
      // Every simulated user starts with one request at t = 0. Re-issues are queued when
      // each request finishes, so the population stays fixed for the whole window.
      for (let i = 0; i < population; i += 1) {
        queue.push({ time: 0, type: EVENT_ARRIVAL, payload: null })
      }
    }
  } else if (arrivalRate > 0 && windowMs > 0 && entries.length > 0) {
    nextArrivalTime = rng.exponential(1000 / arrivalRate)
    if (nextArrivalTime <= windowMs) pushArrival()
  }

  while (queue.size > 0 && processedEvents < MAX_PROCESSED_EVENTS) {
    const event = queue.pop()
    if (!event) break
    now = event.time
    lastEventTime = now
    processedEvents += 1
    if (event.type === EVENT_ARRIVAL) {
      startCase(entries.length === 1 ? entries[0] : rng.pick(entries))
      if (!closedLoop && nextArrivalTime <= windowMs) pushArrival()
    } else if (event.type === EVENT_TRANSIT) {
      const transit = event.payload || {}
      enterNode(transit.simCase, transit.component)
    } else if (event.type === EVENT_SERVICE_DONE) {
      completeService(event.payload)
    }
  }

  failedRequests += inFlight
  inFlight = 0

  // Keep every sampled case's events, including cases still in flight when the event
  // budget stops the run. Dropping them silently hid the very traces the mining report
  // classifies as INCOMPLETE_TRACE, so the sample showed zero incomplete cases no matter
  // how much work the budget abandoned. Unsampled in-flight cases still contribute no
  // events, matching the sampling stride.
  const retainedCaseIds = new Set()
  const unfinishedLoggedCaseIds = new Set()
  const trimmedLog = []
  let firstLoggedTs = 0
  let lastLoggedTs = 0
  for (let i = 0; i < eventLog.length; i += 1) {
    const event = eventLog[i]
    if (!finishedCaseIds.has(event.caseId) && !loggedCaseIds.has(event.caseId)) continue
    event.eventId = trimmedLog.length + 1
    retainedCaseIds.add(event.caseId)
    if (!finishedCaseIds.has(event.caseId)) unfinishedLoggedCaseIds.add(event.caseId)
    if (!trimmedLog.length) firstLoggedTs = event.timestamp
    lastLoggedTs = event.timestamp
    trimmedLog.push(event)
  }

// The span that was genuinely simulated, not the span that was asked for. A heavy
// workload exhausts MAX_PROCESSED_EVENTS before the arrival window closes, and using
// windowMs there divided every busyTime by a span that never ran, understating
// utilisation (a run truncated at half its window reported roughly half the real load).
const truncated = processedEvents >= MAX_PROCESSED_EVENTS && lastEventTime < windowMs
const truncation = {
  eventCapReached: processedEvents >= MAX_PROCESSED_EVENTS,
  eventCap: MAX_PROCESSED_EVENTS,
  stepsCappedCases,
  maxStepsPerCase: MAX_STEPS_PER_CASE,
}
const simulatedRaw = Math.max(lastEventTime > 0 ? lastEventTime : windowMs, 0)
const simulatedMs = round(simulatedRaw, 3)
  const denominator = simulatedRaw > 0 ? simulatedRaw / 1000 : 1
  const finishedCount = latencies.length
  latencies.sort((a, b) => a - b)

  const latencyBuilder = createLatencySeries({ buckets: SERIES_BUCKETS, spanMs: simulatedMs })
  for (let i = 0; i + 1 < latencyPairs.length; i += 2) latencyBuilder.add(latencyPairs[i], latencyPairs[i + 1])
  const latencySeries = latencyBuilder.points()

  const queueBuilder = createQueueSeries({
    buckets: SERIES_BUCKETS,
    spanMs: simulatedMs,
    names: componentList.map((component) => component.name),
  })
  for (const name of queueHistory.keys()) {
    const history = queueHistory.get(name) || []
    for (let i = 0; i + 1 < history.length; i += 2) queueBuilder.record(history[i], name, history[i + 1])
  }
  const queueSeries = queueBuilder.points()

  const safeTotal = Math.max(1, totalRequests)
  const avgLatencyMs = finishedCount > 0 ? latencyTotal / finishedCount : 0
  const littleLawConcurrency = (arrivalRate * avgLatencyMs) / 1000
  // In a closed loop the achieved arrival rate is an output, not an input: it is the
  // rate the recycled population actually sustained over the simulated span.
  const effectiveArrivalRate = closedLoop
    ? denominator > 0
      ? totalRequests / denominator
      : 0
    : arrivalRate

  const metrics = {
    totalRequests,
    completedRequests,
    droppedRequests,
    failedRequests,
    avgLatencyMs: round(avgLatencyMs, 3),
    p50: round(percentile(latencies, 50), 3),
    p90: round(percentile(latencies, 90), 3),
    p95: round(percentile(latencies, 95), 3),
    p99: round(percentile(latencies, 99), 3),
    maxLatencyMs: round(finishedCount > 0 ? latencies[finishedCount - 1] : 0, 3),
    throughputPerSec: round(completedRequests / denominator, 4),
    successRate: round((completedRequests / safeTotal) * 100, 3),
    failureRate: round((failedRequests / safeTotal) * 100, 3),
    dropRate: round((droppedRequests / safeTotal) * 100, 3),
    simulatedMs,
    // True when the event budget stopped the run before the requested duration elapsed.
    // The UI must say so rather than presenting a short run as a full one.
    truncated,
    littleLawConcurrency: round(littleLawConcurrency, 4),
  }

  const components = {}
  for (const component of componentList) {
    const memoryUsedMb = component.memoryMb + component.memoryPerSessionMb * component.peakOccupancy
    components[component.id] = {
      id: component.id,
      name: component.name,
      type: component.type,
      category: component.category,
      capacity: component.capacity,
      capacityAssumed: component.capacityAssumed,
      processingTimeMs: round(component.processingTimeMs, 3),
      queueCapacity: component.configuredQueueCapacity,
      busyTimeMs: round(component.busyTimeMs, 3),
      utilization: simulatedMs > 0 ? round(component.busyTimeMs / (component.capacity * simulatedMs), 5) : 0,
      avgQueueWaitMs: round(component.queueWait.count > 0 ? component.queueWait.mean : 0, 3),
      avgProcessingMs: round(component.processing.count > 0 ? component.processing.mean : 0, 3),
      queueLengthMax: component.queueLengthMax,
      memoryUsedMb: round(memoryUsedMb, 3),
      memoryLimitMb: round(component.memoryLimitMb, 3),
      memoryUtilization: component.memoryLimitMb > 0 ? round((memoryUsedMb / component.memoryLimitMb) * 100, 3) : 0,
      throughputPerSec: round(component.visits / denominator, 4),
      visits: component.visits,
      failures: component.failures,
      retries: component.retries,
      dropped: component.dropped,
    }
  }

  const assumptions = componentList
    .filter((component) => component.capacityAssumed)
    .map((component) => ({
      componentId: component.id,
      component: component.name,
      parameter: 'capacity',
      value: component.capacity,
      reason: 'No positive capacity was configured, so the engine used its built-in fallback.',
    }))

  return {
    seed,
    mode,
    population: closedLoop ? population : null,
    arrivalRate,
    effectiveArrivalRate: round(effectiveArrivalRate, 4),
    duration,
    concurrentUsers: closedLoop ? population : round(littleLawConcurrency, 4),
    // The span actually simulated, in ms. Lower than duration * 1000 only when the event
    // budget cut the run short.
    simulatedMs,
    truncated,
    truncation,
    // Inputs the engine had to assume rather than read from the architecture. Reported so
    // a fallback capacity can never be mistaken for a configured one.
    assumptions,
    metrics,
    components,
    eventLog: trimmedLog,
    latencySeries,
    queueSeries,
    loggingStats: {
      totalEvents: totalActivities,
      loggedEvents: trimmedLog.length,
      sampledCases: retainedCaseIds.size,
      // Sampled cases still in flight when the event budget stopped the run. Their
      // partial traces stay in the log and surface as incomplete traces in mining.
      unfinishedSampledCases: unfinishedLoggedCaseIds.size,
      totalCases: totalRequests,
      // Open loop logs a deterministic stride of cases; a closed loop spends a time-based
      // budget so its recycled population is sampled across the window.
      samplingMode: closedLoop ? 'time' : 'stride',
      sampleEvery,
      expectedCases,
      loggedWindowMs: trimmedLog.length ? lastLoggedTs - firstLoggedTs : 0,
    },
    entryIds: entries,
    terminalIds,
  }
}
