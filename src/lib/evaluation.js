import { dimensionMeta, dimensionOrder } from '../theme/tokens.js'
import { resolveParams, isCompute, isStore, isClient } from '../data/nodeTypes.js'
import { categoryOf } from './contract.js'

const LATENCY_BUDGET_MS = 200
const LATENCY_P95_WEIGHT = 0.7
const LATENCY_P99_WEIGHT = 0.3
// Score at exactly the budget, and how fast the score falls past it.
const LATENCY_WITHIN_BUDGET_FLOOR = 0.55
const LATENCY_DECAY_RATE = 1.2
const PERFORMANCE_ERROR_CEILING = 0.1
const PERFORMANCE_ERROR_WEIGHT = 0.3
const SCALABILITY_UTIL_FREE = 0.6
const SCALABILITY_UTIL_SPAN = 0.4
const SCALABILITY_HEADROOM_TARGET = 0.4
const SCALABILITY_UTIL_WEIGHT = 0.6
const SCALABILITY_HEADROOM_WEIGHT = 0.4
const SCALABILITY_LB_BONUS = 10
const SCALABILITY_REPLICA_BONUS = 10
const RELIABILITY_FAILURE_CEILING = 0.05
const RELIABILITY_DROP_CEILING = 0.05
const RELIABILITY_OVERFLOW_CEILING = 3
const RELIABILITY_WEIGHTS = { failure: 0.3, drop: 0.25, overflow: 0.25, retry: 0.2 }
const RELIABILITY_REPLICA_BONUS = 10
const SECURITY_BASE = 20
const SECURITY_CONTROL_POINTS = 25
const SECURITY_NO_GATEWAY_PENALTY = 20
const MAINTAINABILITY_IDEAL_MIN = 4
const MAINTAINABILITY_IDEAL_MAX = 10
const MAINTAINABILITY_HEAVY = 18
const MAINTAINABILITY_WEIGHTS = { count: 0.55, cache: 0.25, modular: 0.2 }
const PROCESS_CONFORMANCE_SHARE = 60
const PROCESS_DEVIATION_PENALTY = 5
const PROCESS_DEVIATION_CAP = 50
const PROCESS_BOTTLENECK_PENALTY = 8
const PROCESS_BOTTLENECK_CAP = 30
const PROCESS_BOTTLENECK_FLOOR_MS = 50
const PROCESS_SIGNIFICANT_SEVERITIES = new Set(['high', 'med'])
const APPLICATION_TYPES = ['apiGateway', 'loadBalancer', 'server', 'microservice']

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const num = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const rate = (v) => clamp(num(v), 0, 1)
// The engine reports failureRate, dropRate and memoryUtilization as percentages
// (0-100). Scoring compares them against ceilings expressed as 0-1 fractions, so
// they must be converted before the comparison or every value saturates.
const pctRate = (v) => clamp(num(v) / 100, 0, 1)
const round1 = (v) => Math.round(v * 10) / 10
const round2 = (v) => Math.round(v * 100) / 100
const pct1 = (v) => Math.round(clamp(v, 0, 1) * 1000) / 10
const score = (v) => Math.round(clamp(v, 0, 100))
const label = (v, fallback = 'Unnamed') => (v ? String(v) : fallback)
const listOf = (items) => (items.length ? items.join(', ') : 'none')

export function architectureFacts(architecture) {
  const nodes = (architecture?.nodes || []).filter((n) => n && n.id != null)
  const edges = (architecture?.edges || []).filter((e) => e && e.source && e.target)
  const ids = new Set(nodes.map((n) => n.id))
  const incoming = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    incoming.get(e.target).push(e.source)
  }
  const clients = nodes.filter((n) => isClient(n))
  const compute = nodes.filter((n) => isCompute(n))
  const stores = nodes.filter((n) => isStore(n))
  const types = new Set(nodes.map((n) => n.type))
  const applicationTypes = new Set(nodes.filter((n) => categoryOf(n) === 'application').map((n) => n.type))
  const gateways = nodes.filter((n) => n.type === 'apiGateway' || n.type === 'loadBalancer')
  const entryGateway = gateways.find((n) => !hasApplicationAncestor(n.id, incoming, byId(nodes))) || null
  const params = new Map(nodes.map((n) => [n.id, resolveParams(n)]))
  return {
    nodes,
    edges,
    ids,
    incoming,
    clients,
    compute,
    stores,
    types,
    applicationTypes,
    gateways,
    entryGateway,
    params,
    nodeCount: nodes.length,
    hasLoadBalancer: types.has('loadBalancer'),
    hasAuthentication: types.has('authentication'),
    hasFirewall: types.has('firewall'),
    hasCache: types.has('cache'),
    hasAuthNode: nodes.some((n) => n.type === 'authentication'),
    hasFirewallNode: nodes.some((n) => n.type === 'firewall'),
    hasEntryGateway: Boolean(entryGateway),
  }
}

function byId(nodes) {
  return new Map(nodes.map((n) => [n.id, n]))
}

function hasApplicationAncestor(id, incoming, nodes) {
  const seen = new Set([id])
  const stack = [...(incoming.get(id) || [])]
  while (stack.length) {
    const current = stack.pop()
    if (seen.has(current)) continue
    seen.add(current)
    const node = nodes.get(current)
    if (node && categoryOf(node) === 'application') return true
    for (const parent of incoming.get(current) || []) stack.push(parent)
  }
  return false
}

export function securityAssessment(architecture) {
  const facts = architectureFacts(architecture)
  const controls = []
  if (facts.hasAuthNode) controls.push('authentication')
  if (facts.hasFirewallNode) controls.push('firewall')
  if (facts.hasEntryGateway) controls.push(`entry-point ${facts.entryGateway.name}`)
  const missing = []
  if (!facts.hasAuthNode) missing.push('an authentication node')
  if (!facts.hasFirewallNode) missing.push('a firewall')
  if (!facts.hasEntryGateway) missing.push('an entry-point gateway')
  const appNodes = facts.nodes.filter((n) => APPLICATION_TYPES.includes(n.type))
  const gatewayPenalty = !facts.hasEntryGateway && appNodes.length ? SECURITY_NO_GATEWAY_PENALTY : 0
  const value = SECURITY_BASE + controls.length * SECURITY_CONTROL_POINTS - gatewayPenalty
  return {
    score: score(value),
    controls,
    missing,
    gatewayPenalty,
    appNodeCount: appNodes.length,
    nodeCount: facts.nodeCount,
  }
}

function simComponents(sim) {
  const raw = sim?.components && typeof sim.components === 'object' ? Object.values(sim.components) : []
  return raw.filter((c) => c && typeof c === 'object')
}

export function readMetrics(sim) {
  const m = sim?.metrics && typeof sim.metrics === 'object' ? sim.metrics : {}
  return {
    total: num(m.totalRequests),
    completed: num(m.completedRequests),
    dropped: num(m.droppedRequests),
    failed: num(m.failedRequests),
    avg: num(m.avgLatencyMs),
    p95: num(m.p95),
    p99: num(m.p99),
    max: num(m.maxLatencyMs),
    throughput: num(m.throughputPerSec),
    failureRate: pctRate(m.failureRate),
    dropRate: pctRate(m.dropRate),
    successRate: pctRate(m.successRate),
    arrivalRate: num(m.arrivalRate ?? sim?.arrivalRate),
    concurrent: num(m.concurrentUsers ?? sim?.concurrentUsers),
  }
}

function peakComponents(components) {
  const byUtil = components
    .map((c) => ({ c, utilization: rate(c.utilization) }))
    .sort((a, b) => b.utilization - a.utilization)
  const byMemory = components
    .map((c) => ({ c, used: pctRate(c.memoryUtilization) }))
    .sort((a, b) => b.used - a.used)
  return {
    topUtil: byUtil[0] || null,
    topMemory: byMemory[0] || null,
    peakUtil: byUtil[0]?.utilization || 0,
    peakMemory: byMemory[0]?.used || 0,
  }
}

function latencyScore(valueMs) {
  const v = num(valueMs)
  if (!(v > 0)) return 100
  // Linear inside the budget so every millisecond counts, then an exponential
  // tail out to LATENCY_DECAY_BUDGETS so heavily overloaded runs still separate
  // instead of both clamping to zero.
  const budget = LATENCY_BUDGET_MS
  if (v <= budget) return 100 * (1 - (v / budget) * (1 - LATENCY_WITHIN_BUDGET_FLOOR))
  const over = (v - budget) / budget
  const tail = Math.exp(-LATENCY_DECAY_RATE * over)
  return 100 * LATENCY_WITHIN_BUDGET_FLOOR * clamp(tail, 0, 1)
}

function performance(sim) {
  const m = readMetrics(sim)
  const p95Score = latencyScore(m.p95)
  const p99Score = latencyScore(m.p99)
  const latency = LATENCY_P95_WEIGHT * p95Score + LATENCY_P99_WEIGHT * p99Score
  const loss = clamp(m.failureRate + m.dropRate, 0, 1)
  const errorFree = 100 * (1 - clamp(loss / PERFORMANCE_ERROR_CEILING, 0, 1))
  const value = (1 - PERFORMANCE_ERROR_WEIGHT) * latency + PERFORMANCE_ERROR_WEIGHT * errorFree
  const overBudget = m.p95 > LATENCY_BUDGET_MS
  return {
    value: score(value),
    note: `p95 latency measured ${round1(m.p95)} ms against a ${LATENCY_BUDGET_MS} ms budget (p99 ${round1(m.p99)} ms, average ${round1(m.avg)} ms), and ${pct1(loss)}% of ${m.total} requests were lost to failures (${pct1(m.failureRate)}%) or drops (${pct1(m.dropRate)}%); latency is scored ${Math.round(LATENCY_P95_WEIGHT * 100)}% p95 / ${Math.round(LATENCY_P99_WEIGHT * 100)}% p99 on a linear-inside-budget curve that decays exponentially past it, and the remaining ${Math.round(PERFORMANCE_ERROR_WEIGHT * 100)}% treats ${pct1(PERFORMANCE_ERROR_CEILING)}% combined loss as zero${overBudget ? `, so p95 is ${round1(m.p95 - LATENCY_BUDGET_MS)} ms over budget` : ', so p95 sits inside budget'}.`,
  }
}

function scalability(sim, facts) {
  const components = simComponents(sim)
  const peaks = peakComponents(components)
  const util = 100 * (1 - clamp((peaks.peakUtil - SCALABILITY_UTIL_FREE) / SCALABILITY_UTIL_SPAN, 0, 1))
  const headroom = 100 * clamp((1 - peaks.peakMemory) / SCALABILITY_HEADROOM_TARGET, 0, 1)
  const base = SCALABILITY_UTIL_WEIGHT * util + SCALABILITY_HEADROOM_WEIGHT * headroom
  const bonus = (facts.hasLoadBalancer ? SCALABILITY_LB_BONUS : 0) + (facts.compute.length > 1 ? SCALABILITY_REPLICA_BONUS : 0)
  const utilName = label(peaks.topUtil?.c?.name, 'no measured component')
  const memName = label(peaks.topMemory?.c?.name, 'no measured component')
  return {
    value: score(base + bonus),
    note: `peak utilisation is ${pct1(peaks.peakUtil)}% at ${utilName} (scored ${Math.round(util)}% where ${pct1(SCALABILITY_UTIL_FREE)}% is free and 100% is zero) and peak memory use is ${pct1(peaks.peakMemory)}% at ${memName}, leaving ${pct1(1 - peaks.peakMemory)}% headroom (scored ${Math.round(headroom)}% against a ${pct1(SCALABILITY_HEADROOM_TARGET)}% target), weighted ${Math.round(SCALABILITY_UTIL_WEIGHT * 100)}/${Math.round(SCALABILITY_HEADROOM_WEIGHT * 100)} and then ${bonus > 0 ? `plus ${bonus} points for ${facts.hasLoadBalancer ? 'a load balancer' : 'no load balancer'} and ${facts.compute.length} compute node${facts.compute.length === 1 ? '' : 's'}` : 'no structural bonus because there is no load balancer and only 1 compute node'}.`,
  }
}

function reliability(sim, facts) {
  const m = readMetrics(sim)
  const components = simComponents(sim)
  const failure = 100 * (1 - clamp(m.failureRate / RELIABILITY_FAILURE_CEILING, 0, 1))
  const drop = 100 * (1 - clamp(m.dropRate / RELIABILITY_DROP_CEILING, 0, 1))
  const overflows = components
    .map((c) => ({ c, cap: num(c.queueCapacity, -1), max: num(c.queueLengthMax) }))
    .filter((x) => x.cap > 0 && x.max >= x.cap)
  const overflow = 100 * (1 - clamp(overflows.length / RELIABILITY_OVERFLOW_CEILING, 0, 1))
  const retryNodes = facts.nodes.filter((n) => num(facts.params.get(n.id)?.retryLimit) > 0)
  const retry = 100 * (retryNodes.length / Math.max(1, facts.nodeCount))
  const w = RELIABILITY_WEIGHTS
  const base = w.failure * failure + w.drop * drop + w.overflow * overflow + w.retry * retry
  const bonus = facts.compute.length > 1 ? RELIABILITY_REPLICA_BONUS : 0
  const overflowNames = listOf(overflows.map((x) => `${label(x.c.name)} at ${x.max}/${x.cap}`))
  return {
    value: score(base + bonus),
    note: `${m.failed} of ${m.total} requests failed (${pct1(m.failureRate)}% against a ${pct1(RELIABILITY_FAILURE_CEILING)}% ceiling) and ${m.dropped} were dropped (${pct1(m.dropRate)}%), ${overflows.length} queue${overflows.length === 1 ? '' : 's'} hit their configured limit (${overflowNames}, zeroed at ${RELIABILITY_OVERFLOW_CEILING}), and ${retryNodes.length} of ${facts.nodeCount} components carry a retry limit; the four parts weigh ${Math.round(w.failure * 100)}/${Math.round(w.drop * 100)}/${Math.round(w.overflow * 100)}/${Math.round(w.retry * 100)} with ${bonus > 0 ? `+${bonus} for ${facts.compute.length} compute nodes` : 'no replica bonus because there is only 1 compute node'}.`,
  }
}

function security(architecture) {
  const s = securityAssessment(architecture)
  return {
    value: s.score,
    note: `rule-based: ${SECURITY_BASE} base points, +${SECURITY_CONTROL_POINTS} each for the ${s.controls.length} of 3 perimeter controls found (${listOf(s.controls)}), and ${s.gatewayPenalty ? `-${s.gatewayPenalty} because no entry-point gateway fronts the ${s.appNodeCount}-node application tier` : 'no gateway penalty because an entry-point gateway fronts the application tier'}.`,
  }
}

function maintainabilityScore(count) {
  if (count <= 1) return 40
  if (count === 2) return 55
  if (count === 3) return 75
  if (count <= MAINTAINABILITY_IDEAL_MAX) return 100
  if (count <= MAINTAINABILITY_HEAVY) return 100 - (count - MAINTAINABILITY_IDEAL_MAX) * 5
  return 30
}

function maintainability(facts) {
  const w = MAINTAINABILITY_WEIGHTS
  const countScore = maintainabilityScore(facts.nodeCount)
  const cacheScore = facts.hasCache ? 100 : 40
  const modular = facts.applicationTypes.size >= 2 || facts.compute.length >= 2
  const modularScore = modular ? 100 : 50
  const value = w.count * countScore + w.cache * cacheScore + w.modular * modularScore
  const largest = [...facts.nodes].sort((a, b) => String(b.name).length - String(a.name).length)[0]
  return {
    value: score(value),
    note: `${facts.nodeCount} component${facts.nodeCount === 1 ? '' : 's'} scores ${countScore}/100 for size (${MAINTAINABILITY_IDEAL_MIN}-${MAINTAINABILITY_IDEAL_MAX} is the sweet spot, 1-2 is coupling risk, over ${MAINTAINABILITY_HEAVY} is monolith risk), the cache scores ${cacheScore}/100 because one is ${facts.hasCache ? 'present' : 'absent'}, and the application tier scores ${modularScore}/100 because it has ${facts.applicationTypes.size} distinct component type${facts.applicationTypes.size === 1 ? '' : 's'}; weighted ${Math.round(w.count * 100)}/${Math.round(w.cache * 100)}/${Math.round(w.modular * 100)} with the widest name being "${label(largest?.name)}".`,
  }
}

export function isSignificantBottleneck(bottleneck) {
  return PROCESS_SIGNIFICANT_SEVERITIES.has(bottleneck?.severity) && num(bottleneck?.waitingMs) >= PROCESS_BOTTLENECK_FLOOR_MS
}

function processEfficiency(mining) {
  if (!mining || typeof mining !== 'object') {
    return {
      value: score(100),
      note: 'no event log was mined, so 0 deviation groups and 0 bottlenecks are counted and conformance is treated as 100%, giving the full 100 points.',
    }
  }
  const stats = mining.statistics && typeof mining.statistics === 'object' ? mining.statistics : {}
  const deviations = Array.isArray(mining.deviations) ? mining.deviations : []
  const traceDeviations = Array.isArray(mining.traceDeviations)
    ? mining.traceDeviations
    : deviations.filter((d) => d?.category === 'trace')
  const reliabilityFindings = Array.isArray(mining.reliabilityFindings)
    ? mining.reliabilityFindings
    : deviations.filter((d) => d?.category === 'reliability')
  const bottlenecks = Array.isArray(mining.bottlenecks) ? mining.bottlenecks : []
  const significant = bottlenecks.filter(isSignificantBottleneck)
  const totalCases = num(stats.totalCases)
  if (totalCases <= 0) {
    return {
      value: 0,
      note: `the log contains ${totalCases} cases, so the process was never observed and this dimension scores 0 rather than guessing at conformance.`,
    }
  }
  // Conformance is null when nothing could be assessed; treat that as zero
  // evidence rather than inventing a perfect score.
  const conformance = stats.conformanceRate == null ? 0 : clamp(num(stats.conformanceRate, 0), 0, 1)
  const deviationPenalty = Math.min(PROCESS_DEVIATION_CAP, PROCESS_DEVIATION_PENALTY * deviations.length)
  const bottleneckPenalty = Math.min(PROCESS_BOTTLENECK_CAP, PROCESS_BOTTLENECK_PENALTY * significant.length)
  const value = 100 - PROCESS_CONFORMANCE_SHARE * (1 - conformance) - deviationPenalty - bottleneckPenalty
  const byType = new Map()
  for (const d of deviations) {
    const key = d?.type || 'UNKNOWN'
    byType.set(key, (byType.get(key) || 0) + 1)
  }
  const types = [...byType.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} x${v}`)
  return {
    value: score(value),
    note: `${pct1(conformance)}% of ${totalCases} sampled cases completed an expected path (conformance counts drops and incomplete traces as non-conforming; recovered failures and retries inside a conforming trace do not reduce it), with ${traceDeviations.length} trace deviation group${traceDeviations.length === 1 ? '' : 's'} and ${reliabilityFindings.length} reliability finding${reliabilityFindings.length === 1 ? '' : 's'} (${listOf(types)}) across ${deviations.length} total group${deviations.length === 1 ? '' : 's'}, plus ${significant.length} bottleneck${significant.length === 1 ? '' : 's'} of at least ${PROCESS_BOTTLENECK_FLOOR_MS} ms per visit; the score is 100 minus ${PROCESS_CONFORMANCE_SHARE} points for the non-conforming share, ${round1(deviationPenalty)} for deviation groups (${PROCESS_DEVIATION_PENALTY} each, capped at ${PROCESS_DEVIATION_CAP}) and ${round1(bottleneckPenalty)} for high/medium bottlenecks of ${PROCESS_BOTTLENECK_FLOOR_MS} ms or more (${PROCESS_BOTTLENECK_PENALTY} each, capped at ${PROCESS_BOTTLENECK_CAP}).`,
  }
}

// ---------------------------------------------------------------------------
// Detailed, transparent evaluation report.
//
// This is additive: the legacy six-dimension `dimensions` / `weights` /
// `healthScore` / `notes` contract above is unchanged so recommendations,
// the dashboard, reports and the sidebar keep working exactly as before.
// The report exposes eight categories with documented weights, measured
// values, evidence tags, deductions and improvements. Only evaluated
// categories contribute to `overallScore`, and their weights are renormalised
// so a missing metric never silently dilutes a score.
// ---------------------------------------------------------------------------

const DETAIL_WEIGHTS = {
  performance: 0.18,
  scalability: 0.15,
  reliability: 0.15,
  security: 0.14,
  maintainability: 0.12,
  resourceEfficiency: 0.1,
  costEfficiency: 0.06,
  processConformance: 0.1,
}

const DETAIL_ORDER = [
  'performance',
  'scalability',
  'reliability',
  'security',
  'maintainability',
  'resourceEfficiency',
  'costEfficiency',
  'processConformance',
]

const DETAIL_META = {
  performance: {
    label: 'Performance',
    evidence: ['simulation'],
    criteria: [
      'Average response time',
      'P95 and P99 latency',
      'Throughput',
      'Component processing duration',
      'Queue waiting time',
      'Database response time',
      'Resource saturation',
    ],
  },
  scalability: {
    label: 'Scalability',
    evidence: ['simulation', 'static'],
    criteria: [
      'Horizontal and vertical scalability',
      'Load distribution',
      'Single points of saturation',
      'Traffic handling capacity',
      'Component scaling configuration',
    ],
  },
  reliability: {
    label: 'Reliability',
    evidence: ['simulation', 'static'],
    criteria: [
      'Component failure rates',
      'Request failure rates',
      'Dropped requests',
      'Timeout frequency',
      'Fault tolerance',
      'Redundancy and recovery',
      'Single points of failure',
    ],
  },
  security: {
    label: 'Security',
    evidence: ['static'],
    criteria: [
      'Authentication mechanisms',
      'Authorization configuration where represented',
      'Firewall presence',
      'Secure communication where represented',
      'Exposed components',
      'Security-related architecture weaknesses',
    ],
  },
  maintainability: {
    label: 'Maintainability',
    evidence: ['static'],
    criteria: [
      'Architecture complexity',
      'Component coupling',
      'Dependency structure',
      'Reusability and modularity',
      'Connection complexity',
    ],
  },
  resourceEfficiency: {
    label: 'Resource Efficiency',
    evidence: ['simulation'],
    criteria: [
      'Resource allocation',
      'CPU requirements',
      'Memory requirements',
      'Infrastructure usage',
      'Over-provisioning',
      'Under-utilization',
    ],
  },
  costEfficiency: {
    label: 'Cost Efficiency',
    evidence: ['static'],
    criteria: [
      'Resource allocation',
      'CPU and memory requirements',
      'Infrastructure usage',
      'Over-provisioning',
      'Under-utilization',
    ],
  },
  processConformance: {
    label: 'Process Conformance',
    evidence: ['mining'],
    criteria: [
      'Expected versus observed paths',
      'Conformance percentage',
      'Deviations',
      'Failed cases',
      'Incomplete cases',
      'Unexpected component transitions',
    ],
  },
}

const GRADE_BANDS = [
  { min: 90, letter: 'A', label: 'Excellent', tone: 'green' },
  { min: 80, letter: 'B', label: 'Good', tone: 'green' },
  { min: 70, letter: 'C', label: 'Fair', tone: 'amber' },
  { min: 60, letter: 'D', label: 'Weak', tone: 'amber' },
  { min: 50, letter: 'E', label: 'Poor', tone: 'red' },
  { min: 0, letter: 'F', label: 'Critical', tone: 'red' },
]

// Over/under-utilisation band for Resource Efficiency. Saturation (the high
// tail) is owned by Scalability; this category owns waste (the low tail), so
// the same utilisation number is never penalised twice.
const RESOURCE_WASTE_FLOOR = 0.05
const RESOURCE_EFFICIENT_TARGET = 0.35
const RESOURCE_SATURATED = 0.9

const round4 = (v) => Math.round(v * 10000) / 10000

function meanOf(values) {
  const usable = values.filter((v) => Number.isFinite(v))
  if (!usable.length) return null
  return usable.reduce((sum, v) => sum + v, 0) / usable.length
}

export function gradeFor(scoreValue) {
  const v = Number(scoreValue)
  if (scoreValue == null || !Number.isFinite(v)) return { letter: '—', label: 'Not Evaluated', tone: 'dim' }
  for (const band of GRADE_BANDS) if (v >= band.min) return band
  return GRADE_BANDS[GRADE_BANDS.length - 1]
}

function baseCategory(key, fields) {
  return {
    key,
    label: DETAIL_META[key].label,
    evidence: DETAIL_META[key].evidence,
    criteria: DETAIL_META[key].criteria,
    status: 'evaluated',
    score: null,
    grade: gradeFor(null),
    weight: DETAIL_WEIGHTS[key],
    normalizedWeight: 0,
    measured: [],
    issues: [],
    positives: [],
    deductions: [],
    improvements: [],
    note: '',
    ...fields,
  }
}

function notEvaluatedCategory(key, reason, fields = {}) {
  return baseCategory(key, {
    status: 'not_evaluated',
    score: null,
    grade: gradeFor(null),
    reason,
    ...fields,
  })
}

function detailPerformance(sim) {
  const m = readMetrics(sim)
  if (!(m.total > 0)) {
    return notEvaluatedCategory('performance', 'The simulation recorded no requests, so latency cannot be measured.')
  }
  const components = simComponents(sim)
  const dbComponents = components.filter((c) => c.type === 'database')
  const dbAvg = dbComponents.length ? meanOf(dbComponents.map((c) => num(c.avgProcessingMs))) : null
  const maxQueueWait = components.length ? Math.max(...components.map((c) => num(c.avgQueueWaitMs))) : null
  const p95Score = latencyScore(m.p95)
  const p99Score = latencyScore(m.p99)
  const value = score(LATENCY_P95_WEIGHT * p95Score + LATENCY_P99_WEIGHT * p99Score)
  const issues = []
  const positives = []
  const deductions = []
  if (m.p95 > LATENCY_BUDGET_MS) {
    issues.push({
      severity: m.p95 > LATENCY_BUDGET_MS * 2 ? 'high' : 'medium',
      text: `p95 latency ${round1(m.p95)} ms exceeds the ${LATENCY_BUDGET_MS} ms budget by ${round1(m.p95 - LATENCY_BUDGET_MS)} ms.`,
    })
    deductions.push(`p95 contributes ${Math.round(LATENCY_P95_WEIGHT * 100)}% of the latency score and is ${round1(m.p95)} ms against a ${LATENCY_BUDGET_MS} ms budget.`)
  } else {
    positives.push(`p95 latency ${round1(m.p95)} ms is within the ${LATENCY_BUDGET_MS} ms budget.`)
  }
  if (m.p99 > LATENCY_BUDGET_MS) {
    issues.push({
      severity: m.p99 > LATENCY_BUDGET_MS * 2 ? 'high' : 'low',
      text: `p99 latency ${round1(m.p99)} ms exceeds the ${LATENCY_BUDGET_MS} ms budget.`,
    })
    deductions.push(`p99 contributes ${Math.round(LATENCY_P99_WEIGHT * 100)}% of the latency score and is ${round1(m.p99)} ms.`)
  } else {
    positives.push(`p99 latency ${round1(m.p99)} ms is within budget.`)
  }
  if (Number.isFinite(maxQueueWait) && maxQueueWait > 0) {
    deductions.push(`The largest average queue wait is ${round1(maxQueueWait)} ms; queueing is measured, not inferred.`)
  }
  const measured = [
    { label: 'Average response time', value: round1(m.avg), unit: 'ms', expected: `<= ${LATENCY_BUDGET_MS} ms`, met: m.avg <= LATENCY_BUDGET_MS },
    { label: 'P95 latency', value: round1(m.p95), unit: 'ms', expected: `<= ${LATENCY_BUDGET_MS} ms`, met: m.p95 <= LATENCY_BUDGET_MS },
    { label: 'P99 latency', value: round1(m.p99), unit: 'ms', expected: `<= ${LATENCY_BUDGET_MS} ms`, met: m.p99 <= LATENCY_BUDGET_MS },
    { label: 'Throughput', value: round1(m.throughput), unit: 'req/s', expected: 'workload dependent', met: null },
  ]
  if (dbAvg != null) {
    measured.push({ label: 'Mean database processing', value: round1(dbAvg), unit: 'ms', expected: 'reference only', met: null })
  }
  if (Number.isFinite(maxQueueWait)) {
    measured.push({ label: 'Max average queue wait', value: round1(maxQueueWait), unit: 'ms', expected: 'lower is better', met: null })
  }
  const improvements = []
  if (m.p95 > LATENCY_BUDGET_MS) improvements.push('Review the slowest components on the critical path and reduce processing time or queueing.')
  if (m.p99 > m.p95 * 2 && m.p99 > LATENCY_BUDGET_MS) improvements.push('Investigate tail latency: p99 far above p95 usually points at queueing or a saturated component.')
  if (Number.isFinite(maxQueueWait) && maxQueueWait > 50) improvements.push('Evaluate caching or extra capacity at the component with the largest queue wait.')
  if (!improvements.length) improvements.push('No latency-specific action is required; keep monitoring p95/p99 as load changes.')
  return baseCategory('performance', {
    score: value,
    grade: gradeFor(value),
    measured,
    issues,
    positives,
    deductions,
    improvements,
    note: `Latency-only lens: p95 ${round1(m.p95)} ms and p99 ${round1(m.p99)} ms scored ${Math.round(LATENCY_P95_WEIGHT * 100)}/${Math.round(LATENCY_P99_WEIGHT * 100)} against a ${LATENCY_BUDGET_MS} ms budget. Failure and drop losses are scored under Reliability so the same issue is not counted twice.`,
  })
}

function detailScalability(sim, facts, legacyPart) {
  const components = simComponents(sim)
  if (!components.length) {
    return notEvaluatedCategory(
      'scalability',
      'No simulation component metrics are available, so utilisation, headroom and load distribution cannot be measured.',
    )
  }
  const peaks = peakComponents(components)
  const value = legacyPart ? legacyPart.value : score(0)
  const issues = []
  const positives = []
  const deductions = []
  if (peaks.peakUtil > SCALABILITY_UTIL_FREE) {
    issues.push({
      severity: peaks.peakUtil > 0.9 ? 'high' : 'medium',
      text: `Peak utilisation reaches ${pct1(peaks.peakUtil)}% at ${label(peaks.topUtil?.c?.name)}, above the ${pct1(SCALABILITY_UTIL_FREE)}% free-capacity threshold.`,
    })
    deductions.push(`Peak utilisation of ${pct1(peaks.peakUtil)}% leaves ${pct1(1 - peaks.peakUtil)}% headroom at the busiest component.`)
  } else if (components.length) {
    positives.push(`Peak utilisation ${pct1(peaks.peakUtil)}% stays below the ${pct1(SCALABILITY_UTIL_FREE)}% free-capacity threshold.`)
  }
  if (peaks.peakMemory > 0.9) {
    issues.push({ severity: 'high', text: `Peak memory utilisation reaches ${pct1(peaks.peakMemory)}% at ${label(peaks.topMemory?.c?.name)}.` })
  }
  if (!facts.hasLoadBalancer) {
    issues.push({ severity: 'medium', text: 'No load balancer is present, so traffic cannot be spread across replicas.' })
    deductions.push('No load-balancer bonus was applied.')
  } else {
    positives.push('A load balancer distributes traffic across the application tier.')
  }
  if (facts.compute.length <= 1) {
    issues.push({ severity: 'medium', text: `Only ${facts.compute.length} compute node${facts.compute.length === 1 ? '' : 's'} can absorb load; a single node is a saturation point.` })
  } else {
    positives.push(`${facts.compute.length} compute nodes provide horizontal scaling headroom.`)
  }
  const measured = [
    { label: 'Peak utilisation', value: pct1(peaks.peakUtil), unit: '%', expected: `<= ${pct1(SCALABILITY_UTIL_FREE)}%`, met: peaks.peakUtil <= SCALABILITY_UTIL_FREE },
    { label: 'Peak memory utilisation', value: pct1(peaks.peakMemory), unit: '%', expected: '<= 90%', met: peaks.peakMemory <= 0.9 },
    { label: 'Load balancer', value: facts.hasLoadBalancer ? 'present' : 'absent', unit: '', expected: 'present', met: facts.hasLoadBalancer },
    { label: 'Compute nodes', value: facts.compute.length, unit: '', expected: '>= 2', met: facts.compute.length >= 2 },
  ]
  const improvements = []
  if (peaks.peakUtil > SCALABILITY_UTIL_FREE) improvements.push(`Add capacity or replicas at ${label(peaks.topUtil?.c?.name)} to restore headroom.`)
  if (!facts.hasLoadBalancer) improvements.push('Introduce a load balancer in front of the application tier so replicas can share load.')
  if (facts.compute.length <= 1) improvements.push('Run at least two compute nodes to remove the single saturation point.')
  if (!improvements.length) improvements.push('Scalability headroom is healthy; re-check under the expected peak workload.')
  return baseCategory('scalability', {
    score: value,
    grade: gradeFor(value),
    measured,
    issues,
    positives,
    deductions,
    improvements,
    note: legacyPart?.note || 'Scalability is scored from peak utilisation, memory headroom and structural scaling controls.',
  })
}

function detailReliability(sim, facts, legacyPart) {
  const m = readMetrics(sim)
  if (!(m.total > 0)) {
    return notEvaluatedCategory(
      'reliability',
      'No simulation traffic was recorded, so failure and drop rates cannot be measured. Static retry and redundancy controls are reported as evidence but are not scored without runtime data.',
    )
  }
  const components = simComponents(sim)
  const overflows = components
    .map((c) => ({ c, cap: num(c.queueCapacity, -1), max: num(c.queueLengthMax) }))
    .filter((x) => x.cap > 0 && x.max >= x.cap)
  const retryNodes = facts.nodes.filter((n) => num(facts.params.get(n.id)?.retryLimit) > 0)
  const value = legacyPart ? legacyPart.value : score(0)
  const issues = []
  const positives = []
  const deductions = []
  if (m.failureRate > RELIABILITY_FAILURE_CEILING) {
    issues.push({
      severity: m.failureRate > RELIABILITY_FAILURE_CEILING * 2 ? 'high' : 'medium',
      text: `Request failure rate ${pct1(m.failureRate)}% exceeds the ${pct1(RELIABILITY_FAILURE_CEILING)}% ceiling.`,
    })
    deductions.push(`${pct1(m.failureRate)}% failure rate against a ${pct1(RELIABILITY_FAILURE_CEILING)}% ceiling.`)
  } else if (m.total > 0) {
    positives.push(`Request failure rate ${pct1(m.failureRate)}% is within the ${pct1(RELIABILITY_FAILURE_CEILING)}% ceiling.`)
  }
  if (m.dropRate > RELIABILITY_DROP_CEILING) {
    issues.push({
      severity: m.dropRate > RELIABILITY_DROP_CEILING * 2 ? 'high' : 'medium',
      text: `Drop rate ${pct1(m.dropRate)}% exceeds the ${pct1(RELIABILITY_DROP_CEILING)}% ceiling.`,
    })
    deductions.push(`${pct1(m.dropRate)}% of requests were dropped.`)
  } else if (m.total > 0) {
    positives.push(`Drop rate ${pct1(m.dropRate)}% is within the ${pct1(RELIABILITY_DROP_CEILING)}% ceiling.`)
  }
  if (overflows.length) {
    issues.push({
      severity: overflows.length >= RELIABILITY_OVERFLOW_CEILING ? 'high' : 'medium',
      text: `${overflows.length} queue${overflows.length === 1 ? '' : 's'} reached the configured limit (${listOf(overflows.map((x) => `${label(x.c.name)} at ${x.max}/${x.cap}`))}).`,
    })
    deductions.push(`${overflows.length} queue overflow event${overflows.length === 1 ? '' : 's'} detected.`)
  }
  if (retryNodes.length) {
    positives.push(`${retryNodes.length} of ${facts.nodeCount} components carry a retry limit.`)
  } else {
    issues.push({ severity: 'medium', text: 'No component is configured with a retry limit, so transient failures are not retried.' })
  }
  if (facts.compute.length > 1) {
    positives.push(`${facts.compute.length} compute nodes provide redundancy.`)
  }
  const measured = [
    { label: 'Failure rate', value: pct1(m.failureRate), unit: '%', expected: `<= ${pct1(RELIABILITY_FAILURE_CEILING)}%`, met: m.failureRate <= RELIABILITY_FAILURE_CEILING },
    { label: 'Drop rate', value: pct1(m.dropRate), unit: '%', expected: `<= ${pct1(RELIABILITY_DROP_CEILING)}%`, met: m.dropRate <= RELIABILITY_DROP_CEILING },
    { label: 'Queue overflows', value: overflows.length, unit: '', expected: '0', met: overflows.length === 0 },
    { label: 'Retry-configured components', value: retryNodes.length, unit: '', expected: '> 0', met: retryNodes.length > 0 },
    { label: 'Timeout events', value: 'not observed', unit: '', expected: 'n/a', met: null },
  ]
  const improvements = []
  if (m.failureRate > RELIABILITY_FAILURE_CEILING) improvements.push('Lower component failure probability and add retries or fallbacks on the critical path.')
  if (m.dropRate > RELIABILITY_DROP_CEILING) improvements.push('Increase queue capacity or capacity at the dropping component.')
  if (overflows.length) improvements.push('Raise queue capacity where queues saturate, or add upstream back-pressure.')
  if (!retryNodes.length) improvements.push('Configure a retry limit on components that can recover from transient failures.')
  if (!improvements.length) improvements.push('Reliability controls are healthy; keep retries and redundancy in place.')
  return baseCategory('reliability', {
    score: value,
    grade: gradeFor(value),
    measured,
    issues,
    positives,
    deductions,
    improvements,
    note: legacyPart?.note || 'Reliability is scored from failure, drop, overflow and retry evidence.',
  })
}

function detailSecurity(contract, legacyPart) {
  const s = securityAssessment(contract)
  const value = legacyPart ? legacyPart.value : s.score
  const issues = []
  const positives = []
  if (s.controls.length) positives.push(`Perimeter controls present: ${listOf(s.controls)}.`)
  if (!s.controls.includes('authentication')) issues.push({ severity: 'high', text: 'No authentication node is present.' })
  if (!s.controls.includes('firewall')) issues.push({ severity: 'high', text: 'No firewall node is present.' })
  if (s.gatewayPenalty) issues.push({ severity: 'medium', text: `No entry-point gateway fronts the ${s.appNodeCount}-node application tier.` })
  const measured = [
    { label: 'Authentication node', value: s.controls.includes('authentication') ? 'present' : 'absent', unit: '', expected: 'present', met: s.controls.includes('authentication') },
    { label: 'Firewall node', value: s.controls.includes('firewall') ? 'present' : 'absent', unit: '', expected: 'present', met: s.controls.includes('firewall') },
    { label: 'Entry-point gateway', value: s.controls.includes('authentication') || s.controls.some((c) => c.startsWith('entry-point')) ? 'present' : 'absent', unit: '', expected: 'present', met: !s.gatewayPenalty },
    { label: 'Perimeter controls', value: `${s.controls.length} of 3`, unit: '', expected: '3 of 3', met: s.controls.length === 3 },
  ]
  const improvements = []
  if (!s.controls.includes('authentication')) improvements.push('Add an authentication node at the perimeter.')
  if (!s.controls.includes('firewall')) improvements.push('Add a firewall node in front of the application tier.')
  if (s.gatewayPenalty) improvements.push('Place an API gateway or load balancer at the entry point.')
  if (!improvements.length) improvements.push('Perimeter controls are present; this is a structural check, not a security audit.')
  return baseCategory('security', {
    score: value,
    grade: gradeFor(value),
    measured,
    issues,
    positives,
    deductions: s.controls.length ? [`${s.controls.length} of 3 perimeter controls found.`] : ['No perimeter controls found.'],
    improvements,
    note: 'Static rule-based check over the architecture graph. This is not a security audit or vulnerability scan and must not be read as one.',
  })
}

function detailMaintainability(facts, legacyPart) {
  if (!facts.nodeCount) {
    return notEvaluatedCategory('maintainability', 'The architecture has no components to assess.')
  }
  const value = legacyPart ? legacyPart.value : score(0)
  const countScore = maintainabilityScore(facts.nodeCount)
  const cacheScore = facts.hasCache ? 100 : 40
  const modular = facts.applicationTypes.size >= 2 || facts.compute.length >= 2
  const issues = []
  const positives = []
  if (facts.nodeCount < MAINTAINABILITY_IDEAL_MIN) {
    issues.push({ severity: 'medium', text: `${facts.nodeCount} component${facts.nodeCount === 1 ? '' : 's'} is below the ${MAINTAINABILITY_IDEAL_MIN}-${MAINTAINABILITY_IDEAL_MAX} ideal band, which can indicate tight coupling.` })
  } else if (facts.nodeCount > MAINTAINABILITY_HEAVY) {
    issues.push({ severity: 'high', text: `${facts.nodeCount} components exceeds the ${MAINTAINABILITY_HEAVY}-component threshold, indicating monolith risk.` })
  } else if (facts.nodeCount > MAINTAINABILITY_IDEAL_MAX) {
    issues.push({ severity: 'low', text: `${facts.nodeCount} components is above the ${MAINTAINABILITY_IDEAL_MAX}-component ideal band.` })
  } else {
    positives.push(`${facts.nodeCount} components sit in the ${MAINTAINABILITY_IDEAL_MIN}-${MAINTAINABILITY_IDEAL_MAX} maintainability band.`)
  }
  if (facts.hasCache) positives.push('A cache node is present, which supports reuse and reduces repeated work.')
  else issues.push({ severity: 'low', text: 'No cache node is present.' })
  if (modular) positives.push(`The application tier has ${facts.applicationTypes.size} distinct component type${facts.applicationTypes.size === 1 ? '' : 's'} and ${facts.compute.length} compute node${facts.compute.length === 1 ? '' : 's'}.`)
  else issues.push({ severity: 'medium', text: 'The application tier has a single component type and a single compute node, which limits modularity.' })
  const measured = [
    { label: 'Component count', value: facts.nodeCount, unit: '', expected: `${MAINTAINABILITY_IDEAL_MIN}-${MAINTAINABILITY_IDEAL_MAX}`, met: facts.nodeCount >= MAINTAINABILITY_IDEAL_MIN && facts.nodeCount <= MAINTAINABILITY_HEAVY },
    { label: 'Connection count', value: facts.edges.length, unit: '', expected: 'lower is better', met: null },
    { label: 'Distinct application types', value: facts.applicationTypes.size, unit: '', expected: '>= 2', met: facts.applicationTypes.size >= 2 },
    { label: 'Cache present', value: facts.hasCache ? 'yes' : 'no', unit: '', expected: 'yes', met: facts.hasCache },
  ]
  const improvements = []
  if (facts.nodeCount > MAINTAINABILITY_HEAVY) improvements.push('Split the monolith into smaller services with clear ownership boundaries.')
  if (facts.nodeCount < MAINTAINABILITY_IDEAL_MIN) improvements.push('Separate concerns into distinct components so responsibilities are not overloaded.')
  if (!facts.hasCache) improvements.push('Consider a cache node for repeated read paths.')
  if (!modular) improvements.push('Introduce at least two application component types or compute nodes to improve modularity.')
  if (!improvements.length) improvements.push('Structure is within the maintainability band; keep component responsibilities clear.')
  return baseCategory('maintainability', {
    score: value,
    grade: gradeFor(value),
    measured,
    issues,
    positives,
    deductions: [`Size scores ${countScore}/100, cache ${cacheScore}/100 and modularity ${modular ? 100 : 50}/100.`],
    improvements,
    note: legacyPart?.note || 'Maintainability is scored from architecture size, caching and modularity.',
  })
}

function detailResourceEfficiency(sim) {
  const components = simComponents(sim)
  const exercised = components.filter((c) => num(c.visits) > 0)
  if (!exercised.length) {
    return notEvaluatedCategory('resourceEfficiency', 'No component was exercised by the simulation, so allocation efficiency cannot be measured.')
  }
  const cpu = exercised.map((c) => rate(c.utilization))
  const mem = exercised.map((c) => pctRate(c.memoryUtilization))
  const avgCpu = meanOf(cpu)
  const avgMem = meanOf(mem)
  const overProvisioned = exercised.filter((c) => rate(c.utilization) < RESOURCE_WASTE_FLOOR)
  const saturated = exercised.filter((c) => rate(c.utilization) > RESOURCE_SATURATED)
  const value = score(100 * clamp((avgCpu - RESOURCE_WASTE_FLOOR) / (RESOURCE_EFFICIENT_TARGET - RESOURCE_WASTE_FLOOR), 0, 1))
  const issues = []
  const positives = []
  if (overProvisioned.length) {
    issues.push({
      severity: overProvisioned.length > exercised.length / 2 ? 'medium' : 'low',
      text: `${overProvisioned.length} of ${exercised.length} exercised components run below ${pct1(RESOURCE_WASTE_FLOOR)}% CPU utilisation, indicating over-provisioned capacity.`,
    })
  }
  if (avgCpu != null && avgCpu >= RESOURCE_EFFICIENT_TARGET) {
    positives.push(`Average CPU utilisation ${pct1(avgCpu)}% is within the efficient band.`)
  }
  if (avgMem != null && avgMem > 0) {
    positives.push(`Average memory utilisation is ${pct1(avgMem)}%.`)
  }
  if (saturated.length) {
    positives.push(`${saturated.length} component${saturated.length === 1 ? '' : 's'} run above ${pct1(RESOURCE_SATURATED)}% utilisation; saturation risk is scored under Scalability.`)
  }
  const measured = [
    { label: 'Average CPU utilisation', value: pct1(avgCpu), unit: '%', expected: `${pct1(RESOURCE_WASTE_FLOOR)}%-${pct1(RESOURCE_EFFICIENT_TARGET)}% efficient band`, met: avgCpu != null && avgCpu >= RESOURCE_EFFICIENT_TARGET },
    { label: 'Average memory utilisation', value: pct1(avgMem), unit: '%', expected: 'reference only', met: null },
    { label: 'Over-provisioned components', value: overProvisioned.length, unit: '', expected: '0', met: overProvisioned.length === 0 },
    { label: 'Saturated components', value: saturated.length, unit: '', expected: '0', met: saturated.length === 0 },
    { label: 'Exercised components', value: exercised.length, unit: '', expected: '> 0', met: exercised.length > 0 },
  ]
  const improvements = []
  if (overProvisioned.length) improvements.push('Right-size over-provisioned components or consolidate them to match observed demand.')
  if (saturated.length) improvements.push('Add capacity where components saturate; see Scalability for the saturation view.')
  if (!improvements.length) improvements.push('Allocation matches observed demand; re-check after workload changes.')
  return baseCategory('resourceEfficiency', {
    score: value,
    grade: gradeFor(value),
    measured,
    issues,
    positives,
    deductions: [`Score is 100 at ${pct1(RESOURCE_EFFICIENT_TARGET)}% average CPU utilisation, falling linearly to 0 at ${pct1(RESOURCE_WASTE_FLOOR)}%.`],
    improvements,
    note: 'Measured against the configured workload, so a light workload will show low utilisation by design. Saturation is scored under Scalability; this category owns the waste tail.',
  })
}

function detailCostEfficiency(contract, sim) {
  const facts = architectureFacts(contract)
  const withMemory = facts.nodes.filter((n) => num(facts.params.get(n.id)?.memoryMb) > 0)
  const totalMemory = withMemory.reduce((sum, n) => sum + num(facts.params.get(n.id)?.memoryMb), 0)
  const measured = [
    { label: 'Components with configured memory', value: withMemory.length, unit: '', expected: 'reference only', met: null },
    { label: 'Total configured base memory', value: round1(totalMemory), unit: 'MB', expected: 'reference only', met: null },
    { label: 'Pricing model', value: 'not configured', unit: '', expected: 'configured', met: false },
  ]
  return notEvaluatedCategory(
    'costEfficiency',
    'No pricing model is configured, so a monetary cost cannot be estimated without fabricating a rate. Memory and CPU allocation efficiency is evaluated under Resource Efficiency instead.',
    {
      measured,
      improvements: ['Add an explicit pricing model (cost per CPU-hour and GB-hour) to enable a cost-efficiency score.'],
      note: 'Cost is not evaluated because the application has no pricing model. Only configured memory is reported as evidence; no cost figure is invented.',
    },
  )
}

function detailProcessConformance(mining, legacyPart) {
  if (!mining || typeof mining !== 'object') {
    return notEvaluatedCategory('processConformance', 'No mined event log is available, so process conformance cannot be measured.')
  }
  const stats = mining.statistics && typeof mining.statistics === 'object' ? mining.statistics : {}
  const totalCases = num(stats.totalCases)
  if (totalCases <= 0) {
    return notEvaluatedCategory('processConformance', 'The mined event log contains no cases, so conformance cannot be measured.')
  }
  const conformance = stats.conformanceRate == null ? null : clamp(num(stats.conformanceRate), 0, 1)
  const value = legacyPart ? legacyPart.value : score(0)
  const traceDeviations = Array.isArray(mining.traceDeviations)
    ? mining.traceDeviations
    : (mining.deviations || []).filter((d) => d?.category === 'trace')
  const reliabilityFindings = Array.isArray(mining.reliabilityFindings)
    ? mining.reliabilityFindings
    : (mining.deviations || []).filter((d) => d?.category === 'reliability')
  const significant = (mining.bottlenecks || []).filter(isSignificantBottleneck)
  const issues = []
  const positives = []
  if (conformance != null && conformance < 1) {
    issues.push({
      severity: conformance < 0.5 ? 'high' : 'medium',
      text: `${pct1(1 - conformance)}% of ${totalCases} sampled cases did not conform to an expected path.`,
    })
  }
  if (traceDeviations.length) {
    issues.push({ severity: 'medium', text: `${traceDeviations.length} trace deviation group${traceDeviations.length === 1 ? '' : 's'} affect conformance.` })
  }
  if (significant.length) {
    issues.push({ severity: 'low', text: `${significant.length} high/medium bottleneck${significant.length === 1 ? '' : 's'} of at least ${PROCESS_BOTTLENECK_FLOOR_MS} ms per visit.` })
  }
  if (conformance != null && conformance >= 1) positives.push(`All ${totalCases} sampled cases conformed to an expected path.`)
  if (!traceDeviations.length) positives.push('No trace-level deviations were observed.')
  if (reliabilityFindings.length) {
    positives.push(`${reliabilityFindings.length} reliability finding${reliabilityFindings.length === 1 ? '' : 's'} were recovered inside conforming traces and are reported without reducing conformance.`)
  }
  const measured = [
    { label: 'Conformance rate', value: conformance == null ? 'not available' : pct1(conformance), unit: conformance == null ? '' : '%', expected: '100%', met: conformance != null && conformance >= 1 },
    { label: 'Sampled cases', value: totalCases, unit: '', expected: '> 0', met: totalCases > 0 },
    { label: 'Completed cases', value: num(stats.completedCases), unit: '', expected: 'as many as possible', met: null },
    { label: 'Dropped cases', value: num(stats.droppedCases), unit: '', expected: '0', met: num(stats.droppedCases) === 0 },
    { label: 'Incomplete cases', value: num(stats.incompleteCases ?? stats.failedCases), unit: '', expected: '0', met: num(stats.incompleteCases ?? stats.failedCases) === 0 },
    { label: 'Trace deviations', value: traceDeviations.length, unit: '', expected: '0', met: traceDeviations.length === 0 },
    { label: 'Significant bottlenecks', value: significant.length, unit: '', expected: '0', met: significant.length === 0 },
  ]
  const improvements = []
  if (conformance != null && conformance < 1) improvements.push('Inspect the affected case traces and align the executed sequence with the expected path.')
  if (traceDeviations.length) improvements.push('Address the top trace deviation groups first; each affects a share of sampled cases.')
  if (significant.length) improvements.push('Reduce waiting time at the top bottlenecks or add capacity there.')
  if (!improvements.length) improvements.push('Process conformance is healthy; keep the architecture and workload aligned.')
  return baseCategory('processConformance', {
    score: value,
    grade: gradeFor(value),
    measured,
    issues,
    positives,
    deductions: [
      `Score is 100 minus ${PROCESS_CONFORMANCE_SHARE} points for the non-conforming share, ${PROCESS_DEVIATION_PENALTY} per deviation group (capped at ${PROCESS_DEVIATION_CAP}) and ${PROCESS_BOTTLENECK_PENALTY} per significant bottleneck (capped at ${PROCESS_BOTTLENECK_CAP}).`,
    ],
    improvements,
    note: legacyPart?.note || 'Process conformance is scored from mined case traces and deviations.',
  })
}

function emptyDetailedReport(reason) {
  const categories = DETAIL_ORDER.map((key) => notEvaluatedCategory(key, reason))
  return {
    overallScore: null,
    grade: gradeFor(null),
    status: 'not_evaluated',
    evaluatedCategories: 0,
    totalCategories: categories.length,
    categories,
    findings: { critical: [], high: [], medium: [], low: [], positive: [] },
    methodology: {
      description: 'No category could be evaluated.',
      weights: { ...DETAIL_WEIGHTS },
      normalizedWeights: {},
      gradeBands: GRADE_BANDS.map((b) => ({ min: b.min, letter: b.letter, label: b.label })),
      thresholds: {},
      evidenceTypes: {},
      normalization: 'Only evaluated categories contribute; their weights are renormalised to sum to 1.',
      doubleCounting: 'Each measured value is scored under one primary category.',
      notEvaluated: categories.map((c) => ({ category: c.label, reason })),
    },
    provenance: { architectureVersion: null, runId: null, evaluatedAt: Date.now() },
  }
}

function buildDetailedReport(contract, sim, mining, parts, facts) {
  const categories = [
    detailPerformance(sim),
    detailScalability(sim, facts, parts.scalability),
    detailReliability(sim, facts, parts.reliability),
    detailSecurity(contract, parts.security),
    detailMaintainability(facts, parts.maintainability),
    detailResourceEfficiency(sim),
    detailCostEfficiency(contract, sim),
    detailProcessConformance(mining, parts.processEfficiency),
  ]

  const evaluated = categories.filter((c) => c.status === 'evaluated' && Number.isFinite(c.score))
  const baseSum = evaluated.reduce((sum, c) => sum + (DETAIL_WEIGHTS[c.key] || 0), 0)
  for (const category of categories) {
    category.weight = DETAIL_WEIGHTS[category.key] || 0
    category.normalizedWeight =
      category.status === 'evaluated' && Number.isFinite(category.score) && baseSum > 0
        ? (DETAIL_WEIGHTS[category.key] || 0) / baseSum
        : 0
  }
  const overallScore = evaluated.length
    ? score(evaluated.reduce((sum, c) => sum + c.score * c.normalizedWeight, 0))
    : null

  const findings = { critical: [], high: [], medium: [], low: [], positive: [] }
  const seen = new Set()
  for (const category of categories) {
    for (const issue of category.issues) {
      const key = issue.text.toLowerCase().replace(/\s+/g, ' ').trim()
      if (seen.has(key)) continue
      seen.add(key)
      const bucket =
        issue.severity === 'critical' ? 'critical' : issue.severity === 'high' ? 'high' : issue.severity === 'medium' ? 'medium' : 'low'
      findings[bucket].push({ category: category.label, categoryKey: category.key, severity: issue.severity, text: issue.text })
    }
    for (const text of category.positives) {
      const key = `pos::${text.toLowerCase().replace(/\s+/g, ' ').trim()}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.positive.push({ category: category.label, categoryKey: category.key, text })
    }
  }

  return {
    overallScore,
    grade: gradeFor(overallScore),
    status: evaluated.length ? 'evaluated' : 'not_evaluated',
    evaluatedCategories: evaluated.length,
    totalCategories: categories.length,
    categories,
    findings,
    methodology: {
      description:
        'Each category is scored 0-100 by deterministic rules over static architecture facts, simulation metrics, or mined event logs. The overall score is the weight-normalised mean of only the evaluated categories.',
      weights: { ...DETAIL_WEIGHTS },
      normalizedWeights: Object.fromEntries(categories.map((c) => [c.key, round4(c.normalizedWeight)])),
      gradeBands: GRADE_BANDS.map((b) => ({ min: b.min, letter: b.letter, label: b.label })),
      thresholds: {
        latencyBudgetMs: LATENCY_BUDGET_MS,
        failureCeiling: RELIABILITY_FAILURE_CEILING,
        dropCeiling: RELIABILITY_DROP_CEILING,
        overflowCeiling: RELIABILITY_OVERFLOW_CEILING,
        scalabilityFreeUtilization: SCALABILITY_UTIL_FREE,
        resourceWasteFloor: RESOURCE_WASTE_FLOOR,
        resourceEfficientTarget: RESOURCE_EFFICIENT_TARGET,
        processConformanceShare: PROCESS_CONFORMANCE_SHARE,
        processBottleneckFloorMs: PROCESS_BOTTLENECK_FLOOR_MS,
      },
      evidenceTypes: {
        static: 'Derived from the architecture graph and node parameters only.',
        simulation: 'Derived from discrete-event simulation metrics and per-component counters.',
        mining: 'Derived from the mined event log, case traces and conformance analysis.',
      },
      normalization:
        'Weights are defined over all eight categories. Categories marked Not Evaluated are excluded and the remaining weights are renormalised to sum to 1, so missing data never dilutes a score.',
      doubleCounting:
        'Each measured value is scored under one primary category: latency under Performance, saturation under Scalability, failure and drop losses under Reliability, waste under Resource Efficiency, sequence deviations under Process Conformance. The findings ledger de-duplicates identical issue text across categories.',
      notEvaluated: categories.filter((c) => c.status === 'not_evaluated').map((c) => ({ category: c.label, reason: c.reason })),
    },
    provenance: {
      architectureVersion: mining?.provenance?.archHash || null,
      runId: mining?.provenance?.runKey || null,
      seed: mining?.provenance?.seed ?? null,
      arrivalRate: mining?.provenance?.arrivalRate ?? null,
      duration: mining?.provenance?.duration ?? null,
      totalRequests: mining?.provenance?.totalRequests ?? num(sim?.metrics?.totalRequests),
      sampledCases: mining?.provenance?.sampledCases ?? null,
      truncated: Boolean(mining?.provenance?.truncated),
      generatedAt: mining?.provenance?.generatedAt ?? null,
      evaluatedAt: Date.now(),
    },
  }
}

export function evaluateArchitecture(contract, sim, mining) {
  const facts = architectureFacts(contract)
  const weights = {}
  for (const key of dimensionOrder) weights[key] = round2(dimensionMeta[key]?.weight ?? 0)

  if (!facts.nodeCount) {
    const dimensions = {}
    const notes = {}
    for (const key of dimensionOrder) {
      dimensions[key] = 0
      notes[key] = 'the architecture has no components, so there is nothing to score and this dimension reads 0.'
    }
    return {
      dimensions,
      weights,
      healthScore: 0,
      notes,
      report: emptyDetailedReport('The architecture has no components to evaluate.'),
    }
  }

  const parts = {
    performance: performance(sim),
    scalability: scalability(sim, facts),
    reliability: reliability(sim, facts),
    security: security(contract),
    maintainability: maintainability(facts),
    processEfficiency: processEfficiency(mining),
  }

  const dimensions = {}
  const notes = {}
  let weighted = 0
  for (const key of dimensionOrder) {
    const part = parts[key]
    dimensions[key] = part.value
    notes[key] = part.note
    weighted += part.value * (weights[key] || 0)
  }

  const healthScore = clamp(Math.round(weighted), 0, 100)

  return {
    dimensions,
    weights,
    healthScore,
    notes,
    report: buildDetailedReport(contract, sim, mining, parts, facts),
  }
}
