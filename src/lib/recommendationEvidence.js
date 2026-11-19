import { archHash, toContract } from './contract.js'
import { validateArchitecture } from './validate.js'

/**
 * Builds the evidence payload for the Recommendations page's Gemini arm.
 *
 * Everything here is read from the current project's architecture and the simulation,
 * mining and evaluation results keyed to that exact architecture. Nothing is inferred:
 * a missing measurement is omitted rather than replaced with a zero, and a result whose
 * provenance does not match the open architecture is flagged as stale so the UI refuses
 * to send it.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const text = (v, max = 120) => {
  if (v === null || v === undefined) return ''
  return String(v)
    // eslint-disable-next-line no-control-regex -- control characters are untrusted prompt input
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function withNumbers(source, fields) {
  const out = {}
  if (!source || typeof source !== 'object') return out
  for (const [key, transform] of Object.entries(fields)) {
    const raw = source[key]
    const value = transform ? transform(raw) : num(raw)
    if (value !== null && value !== undefined) out[key] = value
  }
  return out
}

function componentEvidence(component) {
  if (!component || typeof component !== 'object') return null
  const out = withNumbers(component, {
    id: (v) => text(v, 80) || null,
    name: (v) => text(v, 80) || null,
    type: (v) => text(v, 40) || null,
    utilization: (v) => {
      const n = num(v)
      return n === null ? null : clamp(n, 0, 1)
    },
    memoryUtilization: (v) => {
      const n = num(v)
      return n === null ? null : clamp(n, 0, 100)
    },
    memoryUsedMb: num,
    memoryLimitMb: num,
    queueLengthMax: num,
    queueCapacity: num,
    failures: num,
    retries: num,
    dropped: num,
    avgProcessingMs: num,
    avgQueueWaitMs: num,
    visits: num,
    capacity: num,
  })
  return Object.keys(out).length > 1 ? out : null
}

function bottleneckEvidence(bottleneck) {
  if (!bottleneck || typeof bottleneck !== 'object') return null
  const out = withNumbers(bottleneck, {
    component: (v) => text(v, 80) || null,
    severity: (v) => text(v, 20) || null,
    waitingMs: num,
    processingMs: num,
    waitRatio: num,
    visits: num,
  })
  return Object.keys(out).length > 1 ? out : null
}

function deviationEvidence(deviation) {
  if (!deviation || typeof deviation !== 'object') return null
  const out = withNumbers(deviation, {
    type: (v) => text(v, 40) || null,
    category: (v) => text(v, 40) || null,
    component: (v) => text(v, 80) || null,
    caseCount: num,
    detail: (v) => text(v, 200) || null,
  })
  return Object.keys(out).length > 1 ? out : null
}

/** Compares the mined result's own provenance with the architecture and workload open now. */
export function checkEvidenceFreshness({ hash, workload, sim, mining }) {
  const reasons = []
  const provenance = mining?.provenance || null

  if (!hash) reasons.push('No architecture version could be identified.')
  if (!sim?.metrics) reasons.push('No simulation metrics are available.')
  if (!mining) reasons.push('No process-mining result is available.')

  if (!provenance) {
    if (mining || sim) reasons.push('The mining result has no provenance record.')
  } else {
    if (provenance.archHash && hash && provenance.archHash !== hash) {
      reasons.push('This simulation belongs to a different architecture version.')
    } else if (!provenance.archHash) {
      reasons.push('The mining result is not bound to an architecture version.')
    }
    const checks = [
      ['seed', workload?.seed],
      ['arrivalRate', workload?.arrivalRate],
      ['duration', workload?.duration],
    ]
    for (const [field, expected] of checks) {
      const actual = provenance[field]
      if (actual !== null && actual !== undefined && expected !== null && expected !== undefined) {
        if (num(actual) !== num(expected)) reasons.push(`The mining result uses a different ${field}.`)
      }
    }
    if (provenance.mode && workload?.mode && provenance.mode !== workload.mode) {
      reasons.push('The mining result was produced under a different workload mode.')
    }
    const total = num(sim?.metrics?.totalRequests)
    if (provenance.totalRequests !== null && provenance.totalRequests !== undefined && total !== null) {
      if (num(provenance.totalRequests) !== total) reasons.push('The mining result used a different request set.')
    }
  }

  return {
    stale: reasons.length > 0,
    reasons,
    archHash: hash,
    runKey: provenance?.runKey || null,
    provenanceArchHash: provenance?.archHash || null,
    truncated: Boolean(provenance?.truncated || sim?.truncated),
  }
}

/**
 * @returns {{ hash: string|null, ready: boolean, validation: object, freshness: object, payload: object }}
 */
export function buildRecommendationEvidence({
  project = null,
  architecture = null,
  workload = null,
  sim = null,
  mining = null,
  evaluation = null,
  recommendations = null,
  resultKey = null,
}) {
  const hash = architecture ? archHash(architecture) : null
  const validation = validateArchitecture(architecture || {})
  const freshness = checkEvidenceFreshness({ hash, workload, sim, mining })
  const contract = toContract(architecture || {})

  const rawMetrics = sim?.metrics && typeof sim.metrics === 'object' ? sim.metrics : {}
  const rate = (v) => {
    const n = num(v)
    return n === null ? null : clamp(n, 0, 1)
  }
  // The engine reports successRate as 0-100; the advisor contract uses 0-1. Only the
  // measured field is converted, and an absent field stays absent.
  const successRate = num(rawMetrics.successRate)
  const successRatio = successRate === null ? null : rate(successRate > 1 ? successRate / 100 : successRate)
  const metrics = {
    ...withNumbers(rawMetrics, {
      totalRequests: num,
      completedRequests: num,
      avgLatencyMs: num,
      p50: num,
      p95: num,
      p99: num,
      maxLatencyMs: num,
      throughputPerSec: num,
      failureRate: rate,
      dropRate: rate,
      concurrentUsers: num,
    }),
    ...withNumbers(sim, { arrivalRate: num, concurrentUsers: num }),
    // These are the names the backend advisor contract has always used. They are mapped
    // from the engine's real fields here, so Gemini never sees the old zero-filled payload.
    total: num(rawMetrics.totalRequests),
    failed: num(rawMetrics.failedRequests),
    dropped: num(rawMetrics.droppedRequests),
    throughput: num(rawMetrics.throughputPerSec),
    successRate: successRatio,
  }
  // Drop keys whose source field was absent: a null in JSON must not read as a measurement.
  for (const [key, value] of Object.entries(metrics)) {
    if (value === null) delete metrics[key]
  }

  const components = Object.values(
    sim?.components && typeof sim.components === 'object' ? sim.components : {},
  )
    .map(componentEvidence)
    .filter(Boolean)
    .slice(0, 40)

  const statistics = mining?.statistics && typeof mining.statistics === 'object' ? mining.statistics : {}
  const bottlenecks = (Array.isArray(mining?.bottlenecks) ? mining.bottlenecks : [])
    .map(bottleneckEvidence)
    .filter(Boolean)
    .slice(0, 12)
  const deviations = (Array.isArray(mining?.deviations) ? mining.deviations : [])
    .map(deviationEvidence)
    .filter(Boolean)
    .slice(0, 12)

  const dimensionNotes = {}
  if (evaluation?.notes && typeof evaluation.notes === 'object') {
    for (const [key, value] of Object.entries(evaluation.notes)) {
      if (typeof value === 'string') dimensionNotes[key] = text(value, 400)
    }
  }

  const dimensionScores = {}
  if (evaluation?.dimensions && typeof evaluation.dimensions === 'object') {
    for (const [key, value] of Object.entries(evaluation.dimensions)) {
      const n = num(value)
      if (n !== null) dimensionScores[key] = clamp(n, 0, 100)
    }
  }

  const versionId = project?.versionId || project?.archVersionId || project?.currentVersionId || null
  const payload = {
    project: {
      id: text(project?.id, 80) || null,
      name: text(project?.name, 120) || null,
      versionId: text(versionId, 80) || null,
      versionLabel: text(project?.versionLabel || project?.version?.label, 120) || null,
    },
    architecture: {
      hash,
      nodeCount: contract.nodes.length,
      edgeCount: contract.edges.length,
      nodes: contract.nodes.slice(0, 40).map((node) => ({
        id: text(node.id, 80),
        type: text(node.type, 40),
        name: text(node.name, 80),
        parameters: node.parameters && typeof node.parameters === 'object' ? node.parameters : {},
      })),
      edges: contract.edges.slice(0, 80).map((edge) => ({
        source: text(edge.source, 80),
        target: text(edge.target, 80),
        weight: num(edge.weight),
      })),
    },
    validation: {
      valid: Boolean(validation.valid),
      canSimulate: Boolean(validation.canSimulate),
      errorCodes: (validation.errors || []).slice(0, 8).map((e) => text(e?.code, 40)),
      errorMessages: (validation.errors || []).slice(0, 8).map((e) => text(e?.message, 200)),
      warningCodes: (validation.warnings || []).slice(0, 8).map((w) => text(w?.code, 40)),
    },
    freshness,
    resultKey: resultKey ? text(resultKey, 160) : null,
    metrics,
    components,
    mining: {
      statistics: {
        available: Boolean(statistics.available),
        totalCases: num(statistics.totalCases),
        droppedCases: num(statistics.droppedCases),
        conformanceRate: rate(statistics.conformanceRate),
      },
      bottlenecks,
      deviations,
      provenance: mining?.provenance
        ? {
            archHash: text(mining.provenance.archHash, 80) || null,
            seed: num(mining.provenance.seed),
            arrivalRate: num(mining.provenance.arrivalRate),
            duration: num(mining.provenance.duration),
            runKey: text(mining.provenance.runKey, 160) || null,
            truncated: Boolean(mining.provenance.truncated),
          }
        : null,
    },
    evaluation: {
      healthScore: num(evaluation?.healthScore) === null ? null : clamp(num(evaluation.healthScore), 0, 100),
      dimensions: dimensionScores,
      notes: dimensionNotes,
    },
    baselineFindings: (Array.isArray(recommendations) ? recommendations : [])
      .slice(0, 12)
      .map((r) => ({
        id: text(r?.id, 80) || null,
        dimension: text(r?.dimension, 40) || null,
        severity: text(r?.severity, 20) || null,
        title: text(r?.title, 160) || null,
      })),
  }

  return {
    hash,
    validation,
    freshness,
    ready:
      Boolean(hash) &&
      Boolean(validation.canSimulate) &&
      !freshness.stale &&
      Boolean(sim?.metrics) &&
      Object.keys(dimensionScores).length > 0,
    payload,
  }
}

/** Scope used for per-browser review status; never persisted with the project itself. */
export function recommendationScope({ project, architecture, resultKey }) {
  return [
    text(project?.id, 80) || 'no-project',
    archHash(architecture || {}),
    text(resultKey, 160) || 'no-result',
  ].join('::')
}
