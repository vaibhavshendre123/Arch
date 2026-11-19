import { dimensionMeta, dimensionOrder } from '../theme/tokens.js'
import { architectureFacts, readMetrics, securityAssessment, evaluateArchitecture, isSignificantBottleneck } from './evaluation.js'

const BELOW_THRESHOLD = 80
const HIGH_SEVERITY = 50
const MED_SEVERITY = 70
const SECURITY_CONTROL_POINTS = 25
const PICK_LIMIT = 3
const CAP = 6

// The eight categories the advisory layer reports. The six evaluation dimensions remain
// the scoring contract; categories are the user-facing lens over the same measurements.
export const RECOMMENDATION_CATEGORIES = [
  'Performance Optimization',
  'Scalability',
  'Security',
  'Reliability',
  'Cost Optimization',
  'Database Optimization',
  'Infrastructure',
  'Architecture Design',
]

const CATEGORY_BY_DIMENSION = {
  performance: 'Performance Optimization',
  scalability: 'Scalability',
  reliability: 'Reliability',
  security: 'Security',
  maintainability: 'Architecture Design',
  processEfficiency: 'Performance Optimization',
}

const PRIORITY_BY_SEVERITY = { high: 'High', med: 'Medium', low: 'Low' }

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const num = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const rate = (v) => clamp(num(v), 0, 1)
// The engine reports memoryUtilization as 0-100, unlike CPU utilisation (0-1).
const pctRate = (v) => clamp(num(v) / 100, 0, 1)
const round1 = (v) => Math.round(v * 10) / 10
const ratio2 = (v) => Math.round(num(v) * 100) / 100
const pct1 = (v) => Math.round(clamp(v, 0, 1) * 1000) / 10
const label = (v, fallback = 'Unlabelled') => (v ? String(v) : fallback)
const labelise = (key) => dimensionMeta[key]?.label || key
const listOf = (items) => (items.length ? items.join(', ') : 'none')
const andList = (items) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0] || 'none'

const severityFor = (value) => (value < HIGH_SEVERITY ? 'high' : value < MED_SEVERITY ? 'med' : 'low')

function asList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim())
  if (value === null || value === undefined || value === '') return []
  return [String(value)]
}

function priorityFor(severity, value, ctx) {
  // readMetrics reports failureRate and dropRate as percentages, not fractions.
  const lossPct = clamp(num(ctx.m.failureRate) + num(ctx.m.dropRate), 0, 100)
  if (severity === 'high' && (num(value) < 35 || lossPct >= 20)) return 'Critical'
  return PRIORITY_BY_SEVERITY[severity] || 'Medium'
}

function confidenceFor(ctx) {
  if (!ctx.simPresent) return 'Low'
  const mined = ctx.mined
  if (!mined.present || mined.stats.available === false || mined.totalCases <= 0) return 'Medium'
  return 'High'
}

function storeNames(ctx) {
  return ctx.facts.stores.map((s) => label(s?.name, String(s?.id || 'a store'))).slice(0, 3)
}

function slowestIsStore(ctx) {
  return ctx.facts.stores.some(
    (s) => s?.id && ctx.slowest.id && s.id === ctx.slowest.id,
  ) || ctx.facts.stores.some((s) => s?.name && ctx.slowest.name === label(s.name))
}

function evidenceFor(category, ctx) {
  const { m, slowest, facts, peaks, security } = ctx
  const common = [
    `Measured ${round1(m.p95)} ms p95 and ${round1(m.p99)} ms p99 over ${m.total} requests at ${round1(m.throughput)} req/s.`,
  ]
  switch (category) {
    case 'Scalability':
      return [
        `Peak utilisation is ${pct1(peaks.peakUtil)}% at ${label(peaks.topUtil?.name, 'the busiest component')}.`,
        `Peak memory use is ${pct1(peaks.peakMemory)}% at ${label(peaks.topMemory?.name, 'the largest memory consumer')}.`,
        `${facts.compute.length} compute node${facts.compute.length === 1 ? '' : 's'} and ${facts.hasLoadBalancer ? 'a' : 'no'} load balancer across ${facts.nodeCount} components.`,
      ]
    case 'Security':
      return [
        `Security assessment scores ${security.score}/100 with ${security.controls.length} of 3 perimeter controls present (${listOf(security.controls)}).`,
        `Missing controls: ${listOf(security.missing)}.`,
        `${security.appNodeCount} application component${security.appNodeCount === 1 ? '' : 's'} ${security.gatewayPenalty ? 'have no entry-point gateway' : 'sit behind an entry-point gateway'}.`,
      ]
    case 'Reliability':
      return [
        `${m.failed} failed and ${m.dropped} dropped of ${m.total} requests (${pct1(m.failureRate)}% failure, ${pct1(m.dropRate)}% drop).`,
        `${ctx.overflows.length} of ${ctx.components.length} measured component${ctx.components.length === 1 ? '' : 's'} reached a configured queue limit.`,
      ]
    case 'Database Optimization':
      return [
        `${facts.stores.length} data store${facts.stores.length === 1 ? '' : 's'} (${listOf(storeNames(ctx))}) serve this workload ${facts.hasCache ? 'with' : 'without'} a cache node.`,
        `${label(slowest.name)} spends ${round1(slowest.wait)} ms waiting and ${round1(slowest.processing)} ms processing per visit at ${pct1(slowest.utilization)}% utilisation.`,
      ]
    case 'Infrastructure':
      return [
        `${facts.hasLoadBalancer ? 'A load balancer is present' : 'No load balancer is present'} for ${facts.compute.length} compute node${facts.compute.length === 1 ? '' : 's'}.`,
        `Peak memory use is ${pct1(peaks.peakMemory)}% and ${ctx.overflows.length} queue${ctx.overflows.length === 1 ? '' : 's'} reached a configured limit.`,
      ]
    case 'Cost Optimization':
      return [
        `Peak utilisation is only ${pct1(peaks.peakUtil)}% and peak memory use is ${pct1(peaks.peakMemory)}%.`,
        `${facts.nodeCount} components currently deliver ${round1(m.throughput)} req/s at ${round1(m.arrivalRate)} req/s offered load.`,
      ]
    case 'Architecture Design':
      return [
        `${facts.nodeCount} component${facts.nodeCount === 1 ? '' : 's'}, ${facts.hasCache ? 1 : 0} cache and ${facts.applicationTypes.size} distinct application-tier type${facts.applicationTypes.size === 1 ? '' : 's'}.`,
        `Slowest hop ${label(slowest.name)} contributes ${round1(slowest.wait)} ms of queue wait per visit.`,
      ]
    case 'Performance Optimization':
    default:
      return [
        ...common,
        `${label(slowest.name)} adds ${round1(slowest.wait)} ms of queue wait ahead of ${round1(slowest.processing)} ms of processing at ${pct1(slowest.utilization)}% utilisation.`,
        `${m.failed} failed and ${m.dropped} dropped requests in the measured run.`,
      ]
  }
}

function stepsFor(category, ctx) {
  const { m, slowest, facts, peaks } = ctx
  switch (category) {
    case 'Scalability':
      return [
        facts.hasLoadBalancer
          ? `Keep the existing load balancer and record its current ${round1(m.throughput)} req/s distribution.`
          : `Insert a load balancer in front of the ${facts.compute.length} compute node${facts.compute.length === 1 ? '' : 's'}.`,
        facts.compute.length <= 1
          ? `Add a second compute instance beside ${label(facts.compute[0]?.name, 'the single compute node')}.`
          : `Raise the concurrency budget on ${label(peaks.topUtil?.name, 'the busiest component')} from its measured ${pct1(peaks.peakUtil)}% utilisation.`,
        'Re-run the simulation at the current arrival rate and compare peak utilisation, memory and p95 with this run.',
      ]
    case 'Security':
      return [
        `Record the current perimeter state: ${listOf(ctx.security.controls)} present, ${listOf(ctx.security.missing)} missing.`,
        `Insert ${listOf(ctx.security.missing)} at the front of the ${ctx.security.appNodeCount}-component application tier.`,
        'Re-run the simulation and confirm the added hop keeps p95 inside the existing 200 ms budget.',
      ]
    case 'Reliability':
      return [
        `Capture the ${m.failed} failures and ${m.dropped} drops from this run as the baseline.`,
        `Bound retries on ${label(slowest.name)} and size the queue that currently reaches ${num(ctx.overflows[0]?.max)} waiting.`,
        'Add redundancy behind the entry path, then re-run and compare failure and drop counts.',
      ]
    case 'Database Optimization':
      return [
        `Identify the ${facts.stores.length} data store${facts.stores.length === 1 ? '' : 's'}: ${listOf(storeNames(ctx))}.`,
        facts.hasCache
          ? `Keep the existing cache and check why ${label(slowest.name)} still waits ${round1(slowest.wait)} ms.`
          : `Add a cache between the application tier and ${listOf(storeNames(ctx))} so repeated reads do not reach the data tier.`,
        'Re-run the simulation and compare queue wait at the slowest hop with this run.',
      ]
    case 'Infrastructure':
      return [
        `Note the current ${pct1(peaks.peakMemory)}% peak memory and ${ctx.overflows.length} queue limit${ctx.overflows.length === 1 ? '' : 's'}.`,
        facts.hasLoadBalancer
          ? `Raise capacity or memory on ${label(peaks.topMemory?.name, 'the largest memory consumer')} before the next load increase.`
          : `Place a load balancer in front of the ${facts.compute.length} compute node${facts.compute.length === 1 ? '' : 's'} and give the busiest tier a measured capacity budget.`,
        'Re-run the simulation and verify the queue limit no longer trips under the same workload.',
      ]
    case 'Cost Optimization':
      return [
        `Record the observed ${pct1(peaks.peakUtil)}% peak utilisation and ${pct1(peaks.peakMemory)}% peak memory as the utilisation floor.`,
        'Defer new capacity purchases and keep the current node count as the candidate right-sized shape.',
        'Re-run at the same arrival rate before removing any instance, then compare p95 and queue wait.',
      ]
    case 'Architecture Design':
      return [
        `Document the ${facts.nodeCount} components and the ${facts.applicationTypes.size} application-tier type${facts.applicationTypes.size === 1 ? '' : 's'} as the current baseline.`,
        facts.nodeCount <= 2
          ? `Split ${label(facts.nodes[0]?.name, 'the widest component')} into separately scalable responsibilities.`
          : `Give ${label(slowest.name)} its own capacity budget instead of raising the whole tier.`,
        'Re-run the simulation after the structural change and compare the six dimension scores.',
      ]
    case 'Performance Optimization':
    default:
      return [
        `Record ${round1(m.p95)} ms p95, ${round1(m.p99)} ms p99 and ${round1(slowest.wait)} ms of wait at ${label(slowest.name)}.`,
        `Scale or split ${label(slowest.name)} (${slowest.capacity} concurrent, ${pct1(slowest.utilization)}% utilised) so queue wait falls below its ${round1(slowest.processing)} ms of work.`,
        facts.hasCache
          ? 'Keep the existing cache in the read path and verify repeated reads stay off the data tier.'
          : `Add a cache ahead of the ${facts.stores.length} data store${facts.stores.length === 1 ? '' : 's'} for repeated reads.`,
        'Re-run the simulation and compare p95, p99, failure and drop counts with this run.',
      ]
  }
}

function risksFor(category, ctx) {
  const { m, peaks } = ctx
  switch (category) {
    case 'Scalability':
    case 'Infrastructure':
      return [
        `Extra instances or concurrency add coordination cost; the current p95 is ${round1(m.p95)} ms, so re-check it after the change.`,
        `Raising memory or concurrency can hide a saturated tier; keep watching the measured ${pct1(peaks.peakUtil)}% peak utilisation.`,
      ]
    case 'Security':
      return [
        'Additional perimeter hops add latency; confirm p95 stays inside the existing 200 ms budget after the change.',
        'A new control can reject legitimate traffic if it is introduced without a staged rollout.',
      ]
    case 'Reliability':
      return [
        'More retries can amplify load during a failure; bound attempts rather than removing the limit.',
        'A larger queue trades dropped requests for longer tail latency, so compare p99 after re-running.',
      ]
    case 'Cost Optimization':
      return [
        `Consolidation removes headroom; the measured peak is ${pct1(peaks.peakUtil)}% utilisation and ${pct1(peaks.peakMemory)}% memory.`,
        'Re-run under the same arrival rate before removing capacity, because the estimate is not a saving measurement.',
      ]
    case 'Database Optimization':
      return [
        'Caching can serve stale reads unless invalidation is verified against the data stores.',
        `The cache does not remove the measured ${round1(ctx.slowest.wait)} ms wait if the bottleneck is compute rather than reads.`,
      ]
    default:
      return [
        'The expected effect is directional; re-run the simulation before treating it as measured.',
        'Structural changes move the bottleneck to another component, so re-check the full dimension set.',
      ]
  }
}

function enrich(built, ctx, category, value, extra = {}) {
  const severity = built.severity || 'low'
  const expectedImpact = asList(built.expectedImpact)
  return {
    // Legacy fields are preserved verbatim for Dashboard, Reports and cached results.
    id: built.id,
    severity,
    dimension: built.dimension,
    title: built.title,
    issue: built.issue,
    why: built.why,
    recommendation: built.recommendation,
    effect: built.effect,
    expectedImpact,
    // New advisory fields.
    ...extra,
    category: extra.category || category,
    priority: extra.priority || priorityFor(severity, value, ctx),
    problem: extra.problem || built.problem || built.issue,
    rootCause: extra.rootCause || built.rootCause || built.why,
    evidence: asList(extra.evidence || built.evidence || evidenceFor(category, ctx)),
    solution: extra.solution || built.solution || built.recommendation,
    steps: asList(extra.steps || built.steps || stepsFor(category, ctx)),
    benefits: asList(extra.benefits || built.benefits || [built.effect, ...expectedImpact]),
    risks: asList(extra.risks || built.risks || risksFor(category, ctx)),
    confidence: extra.confidence || built.confidence || confidenceFor(ctx),
    source: extra.source || built.source || 'rule-based',
  }
}

function componentList(sim) {
  const raw = sim?.components && typeof sim.components === 'object' ? Object.values(sim.components) : []
  return raw.filter((c) => c && typeof c === 'object')
}

function slowestComponent(components, mining) {
  const mined = (mining?.bottlenecks || [])[0]
  if (mined?.component) {
    const match = components.find((c) => c.id === mined.componentId || c.name === mined.component)
    return {
      name: label(mined.component),
      id: mined.componentId || match?.id || '',
      utilization: rate(match?.utilization),
      wait: num(mined.waitingMs),
      waitRatio: num(mined.waitRatio),
      processing: num(mined.processingMs),
      capacity: num(match?.capacity),
      visits: num(mined.visits),
      source: 'mining',
    }
  }
  const ranked = components
    .map((c) => ({ c, cost: num(c.avgProcessingMs) + num(c.avgQueueWaitMs) }))
    .sort((a, b) => b.cost - a.cost)
  const top = ranked[0]?.c
  if (!top) {
    return { name: 'the busiest component', id: '', utilization: 0, wait: 0, waitRatio: 0, processing: 0, capacity: 0, visits: 0, source: 'none' }
  }
  const wait = num(top.avgQueueWaitMs)
  const processing = num(top.avgProcessingMs)
  return {
    name: label(top.name),
    id: top.id || '',
    utilization: rate(top.utilization),
    wait,
    waitRatio: processing > 0 ? wait / Math.max(processing, 1) : wait,
    processing,
    capacity: num(top.capacity),
    visits: num(top.visits),
    source: 'sim',
  }
}

function miningFacts(mining) {
  const stats = mining?.statistics && typeof mining.statistics === 'object' ? mining.statistics : {}
  const deviations = Array.isArray(mining?.deviations) ? mining.deviations : []
  const bottlenecks = Array.isArray(mining?.bottlenecks) ? mining.bottlenecks : []
  return {
    present: Boolean(mining && typeof mining === 'object'),
    stats,
    deviations,
    bottlenecks,
    significant: bottlenecks.filter(isSignificantBottleneck),
    conformance: clamp(num(stats.conformanceRate, 1), 0, 1),
    totalCases: num(stats.totalCases),
    droppedCases: num(stats.droppedCases),
    topDeviation: [...deviations].sort(
      (a, b) => num(b?.caseCount) - num(a?.caseCount) || String(a?.type).localeCompare(String(b?.type)),
    )[0] || null,
  }
}

function buildPerformance(ctx) {
  const { m, slowest } = ctx
  const budget = 200
  const over = Math.max(0, m.p95 - budget)
  const visits = num(slowest.visits) || m.total
  return {
    title: `Pull p95 latency back under the ${budget} ms budget`,
    issue: `p95 latency reached ${round1(m.p95)} ms (${round1(over)} ms over the ${budget} ms budget), p99 was ${round1(m.p99)} ms, the average was ${round1(m.avg)} ms, and ${m.failed} of ${m.total} requests failed while ${m.dropped} were dropped.`,
    why: `${slowest.name} is the largest cost: it adds ${round1(slowest.wait)} ms of queue wait ahead of ${round1(slowest.processing)} ms of processing across ${visits} visits (${ratio2(slowest.waitRatio)}x wait ratio) while sitting at ${pct1(slowest.utilization)}% utilisation, so every request pays that delay on the way in and again on the way back.`,
    recommendation:
      `Scale out or split ${slowest.name} (capacity ${slowest.capacity} concurrent, ${pct1(slowest.utilization)}% utilised) so the ${round1(slowest.wait)} ms queue wait per visit falls below its ${round1(slowest.processing)} ms of real work, and cache whatever it re-reads across the ${num(ctx.facts.stores.length)} data store${num(ctx.facts.stores.length) === 1 ? '' : 's'}.`,
    effect: `Removing roughly ${round1(slowest.wait)} ms of wait per visit trims the slowest hop out of the ${round1(m.p95)} ms p95 path and lifts the current ${round1(m.throughput)} requests per second.`,
    expectedImpact: ['lower p95 latency', 'shorter queue waits', 'higher throughput'],
  }
}

function buildScalability(ctx) {
  const { m, facts, peaks } = ctx
  const utilName = label(peaks.topUtil?.name, 'the busiest component')
  const memName = label(peaks.topMemory?.name, 'the largest memory consumer')
  const memLimit = num(peaks.topMemory?.memoryLimitMb)
  const memUsed = num(peaks.topMemory?.memoryUsedMb)
  const steps = []
  if (!facts.hasLoadBalancer) {
    steps.push(
      facts.compute.length
        ? `insert a load balancer in front of the ${facts.compute.length} compute node${facts.compute.length === 1 ? '' : 's'} so traffic spreads evenly`
        : `insert a load balancer between ${label(facts.entryGateway?.name, 'the entry point')} and the ${num(facts.applicationTypes.size)} application-tier type${num(facts.applicationTypes.size) === 1 ? '' : 's'} so requests are spread before they reach a single instance`,
    )
  }
  if (facts.compute.length === 0) {
    steps.push(`add a server or microservice node to execute requests, since all ${num(facts.stores.length)} of the current components are non-compute`)
  } else if (facts.compute.length === 1) {
    steps.push(`add a second compute node beside ${label(facts.compute[0]?.name, 'the single server')}`)
  }
  if (peaks.peakUtil > 0.85) steps.push(`raise the concurrency limit on ${utilName}, which is already at ${pct1(peaks.peakUtil)}% utilisation`)
  if (peaks.peakMemory > 0.75) steps.push(`give ${memName} more heap or move sessions out of it, since it holds ${round1(memUsed)} MB of ${round1(memLimit)} MB (${pct1(peaks.peakMemory)}%)`)
  if (!steps.length) steps.push(`watch ${utilName} at ${pct1(peaks.peakUtil)}% and add capacity before it passes 85% at the current ${round1(m.arrivalRate)} requests per second of offered load`)
  const plan = steps
    .slice(0, 3)
    .map((s, i, all) => (i === 0 ? s.charAt(0).toUpperCase() + s.slice(1) : i === all.length - 1 ? `and ${s}` : `then ${s}`))
    .join(', ')
  return {
    title: `Create headroom on the ${pct1(peaks.peakUtil)}% tier before ${round1(m.arrivalRate)} req/s doubles`,
    issue: `peak utilisation is ${pct1(peaks.peakUtil)}% at ${utilName} and peak memory use is ${pct1(peaks.peakMemory)}% at ${memName} (${round1(memUsed)} MB of ${round1(memLimit)} MB), with ${facts.hasLoadBalancer ? 'a' : 'no'} load balancer and ${facts.compute.length} compute node${facts.compute.length === 1 ? '' : 's'} across ${facts.nodeCount} components.`,
    why: `A single saturated tier sets the ceiling for everyone behind it: at ${pct1(peaks.peakUtil)}% utilisation ${utilName} has only ${round1((1 - peaks.peakUtil) * 100)}% of its capacity left, and ${pct1(peaks.peakMemory)}% memory on ${memName} means an out-of-memory failure long before the load doubles.`,
    recommendation: `${plan}.`,
    effect: `Balance ${utilName} across ${Math.max(2, facts.compute.length)} instances and keep ${memName} under ${pct1(0.6)}% memory, which protects the ${round1(m.throughput)} requests per second already delivered as offered load grows.`,
    expectedImpact: ['more concurrent users per node', 'lower peak utilisation', 'no memory ceiling breach'],
  }
}

function buildReliability(ctx) {
  const { m, facts, components, overflows } = ctx
  const topFailure = [...components].sort((a, b) => num(b.failures) - num(a.failures))[0]
  const withoutRetry = facts.nodes.filter((n) => num(facts.params.get(n.id)?.retryLimit) <= 0)
  const overflowName = label(overflows[0]?.c?.name, 'the deepest component')
  return {
    title: `Stop the ${pct1(m.failureRate + m.dropRate)}% request loss`,
    issue: `${m.failed} of ${m.total} requests failed (${pct1(m.failureRate)}% failure rate) and ${m.dropped} were dropped (${pct1(m.dropRate)}%), leaving a ${pct1(m.successRate)}% success rate; ${overflows.length} of ${components.length} queues hit their configured limit${overflows.length === 1 ? '' : 's'} and ${withoutRetry.length} of ${facts.nodeCount} components have no retry limit.`,
    why: `Losses concentrate where there is no redundancy: ${label(topFailure?.name, 'the busiest component')} raised ${num(topFailure?.failures)} failure${num(topFailure?.failures) === 1 ? '' : 's'} and ${num(topFailure?.retries)} retries, so every one of those requests turned into a ${round1(m.avg)} ms wait followed by an error for the caller.`,
    recommendation: `Bound the blast radius of ${label(topFailure?.name, 'the failing component')}: cap retries at 1-2 attempts with backoff, keep a spare ${facts.compute.length > 1 ? 'instance behind the load balancer' : 'compute node behind a new load balancer'}, and size the queue on ${overflowName} so it stops rejecting at ${num(overflows[0]?.max)} of ${num(overflows[0]?.cap)} waiting.`,
    effect: `Halving the observed ${pct1(m.failureRate)}% failure rate and clearing the ${pct1(m.dropRate)}% drop rate lifts the success rate from ${pct1(m.successRate)}% and returns roughly ${m.failed + m.dropped} of ${m.total} requests per run.`,
    expectedImpact: ['fewer failed requests', 'no dropped requests', 'bounded retry storms'],
  }
}

function buildSecurity(ctx) {
  const { security, facts } = ctx
  const appLabel = `${security.appNodeCount} application component${security.appNodeCount === 1 ? '' : 's'}`
  const projected = clamp(security.score + security.missing.length * SECURITY_CONTROL_POINTS, 0, 100)
  const present = security.controls.length
  const missing = security.missing.length
  const gatewayClause = security.gatewayPenalty
    ? `the unfronted application tier costs ${security.gatewayPenalty} points on its own`
    : `the entry-point gateway is already in place, so only the ${missing} missing control${missing === 1 ? '' : 's'} stand between this design and a perfect score`
  return {
    title: missing === 0 ? 'Tighten the perimeter controls that are already present' : `Add the ${missing} missing perimeter control${missing === 1 ? '' : 's'}`,
    issue: `Of the 3 perimeter controls this scoring looks for, ${present} ${present === 1 ? 'is' : 'are'} present (${listOf(security.controls)}) and ${missing} ${missing === 1 ? 'is' : 'are'} missing (${listOf(security.missing)}); the ${facts.nodeCount}-node design places ${appLabel} with ${security.gatewayPenalty ? 'no gateway in front of them' : 'an entry-point gateway in front of them'}.`,
    why: `Each missing control leaves a real gap: without ${andList(security.missing)}, traffic reaches the ${appLabel} unauthenticated and unfiltered, and ${gatewayClause}.`,
    recommendation:
      missing === 0
        ? `Keep the ${andList(security.controls)} chain intact and place a second authentication node behind the entry gateway so the ${appLabel} is never reachable directly.`
        : `Insert ${security.missing.map((c, i) => (i === 0 ? c : c)).join(', then ')} at the front of the ${appLabel}, then re-run the simulation to confirm the added hop latency stays inside the ${round1(ctx.m.p95)} ms p95.`,
    effect: `Restoring all ${missing} missing control${missing === 1 ? '' : 's'} takes the security score from ${security.score} to a projected ${projected}${security.gatewayPenalty ? ` and gives back the ${security.gatewayPenalty} point unfronted-tier penalty` : ''}.`,
    expectedImpact: ['authenticated entry point', 'filtered perimeter traffic', 'higher security score'],
  }
}

function buildMaintainability(ctx) {
  const { facts, m } = ctx
  const widest = [...facts.nodes].sort((a, b) => num(facts.params.get(b.id)?.capacity) - num(facts.params.get(a.id)?.capacity))[0]
  const widestName = label(widest?.name)
  const widestCapacity = num(facts.params.get(widest?.id)?.capacity)
  const sizeWord = facts.nodeCount <= 2 ? 'a coupling risk' : facts.nodeCount > 10 ? 'a monolith risk' : 'a workable size'
  return {
    title: `Keep ${facts.nodeCount} components at ${sizeWord}`,
    issue: `The design has ${facts.nodeCount} component${facts.nodeCount === 1 ? '' : 's'} (${sizeWord}), ${facts.hasCache ? 1 : 0} cache${facts.hasCache ? '' : 's'} and ${facts.applicationTypes.size} distinct application-tier type${facts.applicationTypes.size === 1 ? '' : 's'}, with the widest node "${widestName}" configured for ${widestCapacity} concurrent sessions.`,
    why: `Shape drives change cost: at ${facts.nodeCount} nodes the change surface spans ${round1(m.throughput)} requests per second, and ${facts.hasCache ? `the cache keeps repeated reads off the data tier` : `every read still goes to the data tier, which is where ${round1(ctx.slowest.wait)} ms of the slowest hop is spent`}.`,
    recommendation:
      facts.nodeCount <= 2
        ? `Split "${widestName}" into an API gateway plus a service so its ${widestCapacity}-session ceiling has its own scaling limit, then add a cache in front of the ${facts.stores.length > 1 ? 'stores' : 'store'}.`
        : facts.nodeCount > 10
          ? `Collapse the ${facts.nodeCount} nodes into bounded services behind the ${label(facts.entryGateway?.name, 'entry point')}, keep a cache in front of the data tier, and remember that ${round1(ctx.slowest.wait)} ms of wait at ${ctx.slowest.name} makes every extra hop expensive.`
          : `Keep the ${facts.applicationTypes.size} application type${facts.applicationTypes.size === 1 ? '' : 's'} separate and give "${widestName}" its own ${widestCapacity}-session capacity budget rather than raising the whole tier.`,
    effect: `Holding ${facts.nodeCount} components with ${facts.hasCache ? 'a' : 'no'} cache keeps change blast radius small while ${round1(ctx.slowest.wait)} ms of queue wait at ${ctx.slowest.name} stays attributable to a single component.`,
    expectedImpact: ['smaller change blast radius', 'independent component scaling', 'clearer ownership'],
  }
}

function buildProcessEfficiency(ctx) {
  const { mined, slowest } = ctx
  const dev = mined.topDeviation
  const bottleneck = mined.bottlenecks[0]
  const nonConforming = pct1(1 - mined.conformance)
  const conforming = mined.conformance >= 1
  const routeClause = conforming
    ? `every logged case follows the modelled route, so the remaining ${mined.deviations.length} deviation group${mined.deviations.length === 1 ? '' : 's'} are runtime events rather than routing errors`
    : `${nonConforming}% of cases take a route you did not design`
  const queueClause = bottleneck
    ? `${label(bottleneck.component)} waits ${round1(bottleneck.waitingMs)} ms per visit at a ${ratio2(bottleneck.waitRatio)}x wait ratio, which is the queueing the log is measuring`
    : `no component queued for 5 ms or more, so the slowest hop (${label(slowest.name)} at ${round1(slowest.processing)} ms of processing) is service time rather than queueing`
  return {
    title:
      mined.deviations.length === 0
        ? 'Keep the modelled process aligned with the log'
        : `Close ${mined.deviations.length} process deviation${mined.deviations.length === 1 ? '' : 's'}`,
    issue: `${pct1(mined.conformance)}% of ${mined.totalCases} logged cases matched an expected path, so ${nonConforming}% diverged; the log shows ${mined.deviations.length} deviation group${mined.deviations.length === 1 ? '' : 's'} and ${mined.bottlenecks.length} bottleneck${mined.bottlenecks.length === 1 ? '' : 's'}, led by ${dev ? `${dev.type} at ${label(dev.component)} in ${num(dev.caseCount)} case${num(dev.caseCount) === 1 ? '' : 's'}` : `queue wait of ${round1(slowest.wait)} ms at ${slowest.name}`}.`,
    why: `The logged process does not match the model you drew: ${routeClause}, and ${queueClause}.`,
    recommendation: dev
      ? `Fix the ${dev.type} deviation at ${label(dev.component)}: ${dev.detail.replace(/\.$/, '')}, then re-run the process mining view to confirm it clears from the ${mined.deviations.length} group${mined.deviations.length === 1 ? '' : 's'}.`
      : `Instrument the ${mined.bottlenecks.length} bottleneck${mined.bottlenecks.length === 1 ? '' : 's'} in the log and re-check ${label(slowest.name)} so its ${round1(slowest.wait)} ms wait stays under the ${round1(slowest.processing)} ms it spends working.`,
    effect: `Clearing the ${mined.deviations.length} deviation group${mined.deviations.length === 1 ? '' : 's'} and the ${mined.significant.length} bottleneck${mined.significant.length === 1 ? '' : 's'} of 50 ms or more affects the ${mined.totalCases} logged case${mined.totalCases === 1 ? '' : 's'} of this run and lifts process efficiency from ${ctx.processScore} towards 100.`,
    expectedImpact: ['higher conformance rate', 'fewer deviations in the log', 'shorter case cycle time'],
  }
}

/** Category-specific findings that are not tied to a single evaluation dimension. */

function buildDatabase(ctx) {
  const { facts, m, slowest } = ctx
  if (!facts.nodeCount || !facts.stores.length || (facts.hasCache && !slowestIsStore(ctx))) return null
  const names = listOf(storeNames(ctx))
  const issue = `${facts.stores.length} data store${facts.stores.length === 1 ? '' : 's'} (${names}) serve ${m.total} requests ${facts.hasCache ? 'with a cache node' : 'without a cache node'}, while ${label(slowest.name)} spends ${round1(slowest.wait)} ms waiting against ${round1(slowest.processing)} ms of processing.`
  return {
    id: 'rec-database',
    severity: slowestIsStore(ctx) && slowest.wait > slowest.processing ? 'high' : 'med',
    dimension: 'performance',
    category: 'Database Optimization',
    priority: slowestIsStore(ctx) && slowest.wait > slowest.processing ? 'High' : 'Medium',
    title: `Take repeated reads off ${names}`,
    issue,
    why: `The measured wait at ${label(slowest.name)} (${pct1(slowest.utilization)}% utilisation, ${num(slowest.visits)} visits) is spent before real work happens; with ${facts.hasCache ? 'a cache already present' : 'no cache in the graph'}, repeated reads still compete with writes at the data tier.`,
    recommendation: `Put a read-through cache between the application tier and ${names}, then verify that the ${round1(slowest.wait)} ms of wait at ${label(slowest.name)} falls in the re-run.`,
    effect: `Shifting repeated reads off the data tier targets the ${round1(slowest.wait)} ms queue wait that currently sits in the ${round1(m.p95)} ms p95 path.`,
    expectedImpact: ['fewer synchronous data-tier reads', 'shorter queue wait', 'lower p95 latency'],
  }
}

/**
 * Reliability lens for request loss that the three lowest dimension scores can crowd out.
 * It only fires when the run actually lost requests or overflowed a bounded queue.
 */
function buildReliabilityLoss(ctx) {
  const { m, overflows } = ctx
  const lossPct = num(m.failureRate) + num(m.dropRate)
  if (lossPct < 1 && !overflows.length) return null
  const built = buildReliability(ctx)
  const severity = lossPct >= 20 || overflows.length ? 'high' : 'med'
  const topFailure = [...ctx.components].sort((a, b) => num(b.failures) - num(a.failures))[0]
  const failingName = label(topFailure?.name, 'the failing component')
  // The generic reliability builder always mentions a full queue. If this run lost
  // requests without overflowing one, do not point the user at a 0-of-0 queue.
  const noOverflowFix = overflows.length
    ? {}
    : {
        recommendation: `Cap retries at 1-2 attempts with backoff on ${failingName}, keep a spare compute node behind a load balancer, then re-run and compare failure and drop counts with this run.`,
        steps: [
          `Capture the ${m.failed} failures and ${m.dropped} drops from this run as the baseline.`,
          `Bound retries on ${failingName} and add a spare compute node behind the entry path.`,
          'Re-run the simulation and compare failure and drop counts with this run.',
        ],
      }
  return {
    id: 'rec-reliability-loss',
    ...built,
    ...noOverflowFix,
    effect: `Reducing the observed ${pct1(lossPct)}% request loss would raise the ${pct1(m.successRate)}% success rate; verify the change with a new simulation run.`,
    severity,
    dimension: 'reliability',
    category: 'Reliability',
    priority: severity === 'high' ? 'High' : 'Medium',
  }
}

function buildInfrastructure(ctx) {
  const { facts, m, peaks, overflows, components } = ctx
  if (!facts.nodeCount || (facts.hasLoadBalancer && peaks.peakMemory <= 0.75 && !overflows.length)) return null
  const memName = label(peaks.topMemory?.name, 'the largest memory consumer')
  const utilName = label(peaks.topUtil?.name, 'the busiest component')
  const issue = `${facts.hasLoadBalancer ? 'A load balancer is present' : 'No load balancer fronts the application tier'}, peak memory is ${pct1(peaks.peakMemory)}% at ${memName} (${round1(num(peaks.topMemory?.memoryUsedMb))} MB of ${round1(num(peaks.topMemory?.memoryLimitMb))} MB), and ${overflows.length} of ${components.length} measured components reached a queue limit.`
  return {
    id: 'rec-infrastructure',
    severity: overflows.length || peaks.peakMemory > 0.85 ? 'high' : 'med',
    dimension: 'scalability',
    category: 'Infrastructure',
    title: `Give ${utilName} a measured capacity budget`,
    issue,
    why: `Infrastructure capacity is the ceiling for the ${round1(m.throughput)} req/s actually delivered: ${utilName} is at ${pct1(peaks.peakUtil)}% utilisation and ${memName} has ${pct1(1 - peaks.peakMemory)}% memory headroom at the current ${round1(m.arrivalRate)} req/s offered load.`,
    recommendation: `${facts.hasLoadBalancer ? 'Keep the load balancer and distribute traffic evenly' : 'Insert a load balancer before the application tier'}, then size ${utilName} and ${memName} against the measured ${pct1(peaks.peakUtil)}% utilisation and ${pct1(peaks.peakMemory)}% memory use.`,
    effect: `Removing the queue and memory ceiling protects the ${round1(m.throughput)} req/s already delivered as offered load grows.`,
    expectedImpact: ['balanced traffic', 'fewer queue overflows', 'more memory headroom'],
  }
}

function buildCost(ctx) {
  const { facts, m, peaks } = ctx
  if (!facts.nodeCount || !ctx.simPresent || facts.nodeCount < 4) return null
  if (peaks.peakUtil >= 0.4 || peaks.peakMemory >= 0.5 || m.throughput <= 0) return null
  return {
    id: 'rec-cost',
    severity: 'low',
    dimension: 'scalability',
    category: 'Cost Optimization',
    priority: 'Low',
    title: `Right-size the ${facts.nodeCount}-component tier at ${pct1(peaks.peakUtil)}% peak utilisation`,
    issue: `The ${facts.nodeCount} components deliver ${round1(m.throughput)} req/s while peaking at only ${pct1(peaks.peakUtil)}% utilisation and ${pct1(peaks.peakMemory)}% memory use.`,
    why: `The measured headroom (${pct1(1 - peaks.peakUtil)}% utilisation and ${pct1(1 - peaks.peakMemory)}% memory left) means new instances are not justified by this run; no saving is claimed because none was measured.`,
    recommendation: `Hold the current ${facts.nodeCount}-component shape, defer additional instances, and re-run at ${round1(m.arrivalRate)} req/s before consolidating any node.`,
    effect: `Keeping the present shape avoids unmeasured spend while preserving the observed ${round1(m.p95)} ms p95 and ${round1(m.throughput)} req/s.`,
    expectedImpact: ['avoided speculative capacity', 'headroom documented from measurement', 'no change to observed throughput'],
  }
}

const BUILDERS = {
  performance: buildPerformance,
  scalability: buildScalability,
  reliability: buildReliability,
  security: buildSecurity,
  maintainability: buildMaintainability,
  processEfficiency: buildProcessEfficiency,
}

function buildContext(contract, sim, mining, evaluation) {
  const facts = architectureFacts(contract)
  const components = componentList(sim)
  const topUtil = [...components].sort((a, b) => rate(b.utilization) - rate(a.utilization))[0] || null
  const topMemory = [...components].sort((a, b) => rate(b.memoryUtilization) - rate(a.memoryUtilization))[0] || null
  return {
    facts,
    m: readMetrics(sim),
    simPresent: Boolean(sim?.metrics && num(sim.metrics.totalRequests) > 0),
    components,
    peaks: {
      topUtil,
      topMemory,
      peakUtil: rate(topUtil?.utilization),
      peakMemory: pctRate(topMemory?.memoryUtilization),
    },
    overflows: components
      .map((c) => ({ c, cap: num(c.queueCapacity, -1), max: num(c.queueLengthMax) }))
      .filter((x) => x.cap > 0 && x.max >= x.cap),
    slowest: slowestComponent(components, mining),
    security: securityAssessment(contract),
    mined: miningFacts(mining),
    processScore: num(evaluation?.dimensions?.processEfficiency),
  }
}

function positiveFinding(contract, sim, mining, evaluation) {
  const ctx = buildContext(contract, sim, mining, evaluation)
  const dims = evaluation?.dimensions || {}
  const weakest = dimensionOrder
    .map((key) => ({ key, value: num(dims[key]) }))
    .sort((a, b) => a.value - b.value || dimensionOrder.indexOf(a.key) - dimensionOrder.indexOf(b.key))[0]
  return {
    id: 'rec-architecture-strength',
    severity: 'low',
    dimension: weakest?.key || 'performance',
    title: `${labelise(weakest?.key)} is the thinnest dimension at ${num(weakest?.value)}/100`,
    issue: `Every dimension scores at or above ${BELOW_THRESHOLD}: ${dimensionOrder.map((k) => `${labelise(k)} ${num(dims[k])}`).join(', ')}, with a weighted health score of ${num(evaluation?.healthScore)}/100 across ${ctx.m.total} simulated requests.`,
    why: `Nothing here is a bottleneck: ${ctx.slowest.name} is the slowest hop at ${round1(ctx.slowest.wait)} ms of wait for ${round1(ctx.slowest.processing)} ms of work (${pct1(ctx.slowest.utilization)}% utilisation), and ${pct1(ctx.mined.conformance)}% of logged cases matched the expected path.`,
    recommendation: `Lock the current shape of the ${ctx.facts.nodeCount} components in as a baseline, then raise the bar on ${labelise(weakest?.key)} (${num(weakest?.value)}/100) before adding load, since ${ctx.m.dropped} drops and ${ctx.m.failed} failures are already low.`,
    effect: `Holding p95 at ${round1(ctx.m.p95)} ms and conformance at ${pct1(ctx.mined.conformance)} keeps the health score near ${num(evaluation?.healthScore)} while the workload grows beyond ${round1(ctx.m.arrivalRate)} requests per second.`,
    expectedImpact: ['no regressions as load grows', 'stable p95 latency', 'preserved conformance'],
  }
}

function categoryForDimension(key) {
  return CATEGORY_BY_DIMENSION[key] || 'Architecture Design'
}

function extraFindings(ctx) {
  if (!ctx.simPresent || !ctx.facts.nodeCount) return []
  return [buildReliabilityLoss, buildDatabase, buildInfrastructure, buildCost]
    .map((builder) => builder(ctx))
    .filter(Boolean)
    .map((built) => enrich(built, ctx, built.category, undefined, { priority: built.priority }))
}

export function buildRecommendations(contract, sim, mining, evaluation) {
  const evaluationResult =
    evaluation && typeof evaluation === 'object' && evaluation.dimensions
      ? evaluation
      : evaluateArchitecture(contract, sim, mining)
  const dimensions = evaluationResult.dimensions || {}
  const ctx = buildContext(contract, sim, mining, evaluationResult)

  const ordered = dimensionOrder
    .map((key) => ({ key, value: num(dimensions[key]) }))
    .sort((a, b) => a.value - b.value || dimensionOrder.indexOf(a.key) - dimensionOrder.indexOf(b.key))

  const picked = ordered.filter((d) => d.value < BELOW_THRESHOLD).slice(0, PICK_LIMIT)
  const base = picked.map(({ key, value }) => {
    const built = BUILDERS[key](ctx)
    return enrich(
      {
        ...built,
        id: `rec-${key}`,
        severity: severityFor(value),
        dimension: key,
      },
      ctx,
      categoryForDimension(key),
      value,
    )
  })

  const all = [...base, ...extraFindings(ctx)].slice(0, CAP)
  if (all.length) return all

  const positive = positiveFinding(contract, sim, mining, evaluationResult)
  return [
    enrich(
      positive,
      ctx,
      categoryForDimension(positive.dimension),
      num(dimensions[positive.dimension]),
    ),
  ]
}
