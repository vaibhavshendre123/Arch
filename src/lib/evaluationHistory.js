/**
 * Browser-local evaluation history for the Evaluation & Score module.
 *
 * History is a per-browser comparison aid, not architecture data, so it is
 * deliberately kept in localStorage rather than persisted to the backend. Each
 * entry is scoped to a project and stamped with the architecture version and
 * simulation run so two unrelated runs are never compared without saying so.
 */

const PREFIX = 'archai.evaluation.history.v1'
const DEFAULT_MAX_ENTRIES = 20

function storage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    return null
  }
}

function scopeKey(scope) {
  return `${PREFIX}:${scope || 'unknown'}`
}

function findingTexts(findings, buckets) {
  const out = []
  for (const bucket of buckets) {
    for (const item of findings?.[bucket] || []) {
      if (item && typeof item.text === 'string') out.push(item.text)
    }
  }
  return out
}

function snapshotFromEvaluation(evaluation, meta = {}) {
  const report = evaluation?.report
  if (!report || !Array.isArray(report.categories)) return null
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    evaluatedAt: new Date().toISOString(),
    projectId: meta.projectId ?? null,
    projectName: meta.projectName ?? null,
    architectureVersion: report.provenance?.architectureVersion ?? null,
    runId: report.provenance?.runId ?? null,
    seed: report.provenance?.seed ?? null,
    arrivalRate: report.provenance?.arrivalRate ?? null,
    duration: report.provenance?.duration ?? null,
    truncated: Boolean(report.provenance?.truncated),
    overallScore: report.overallScore ?? null,
    healthScore: Number.isFinite(Number(evaluation?.healthScore)) ? Number(evaluation.healthScore) : null,
    grade: report.grade || null,
    status: report.status || 'unknown',
    categories: report.categories.map((c) => ({
      key: c.key,
      label: c.label,
      score: c.status === 'evaluated' ? c.score : null,
      status: c.status,
    })),
    findings: {
      critical: findingTexts(report.findings, ['critical']),
      high: findingTexts(report.findings, ['high']),
      medium: findingTexts(report.findings, ['medium']),
      low: findingTexts(report.findings, ['low']),
      positive: findingTexts(report.findings, ['positive']),
    },
  }
}

function isValidSnapshot(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    Array.isArray(value.categories) &&
    value.findings &&
    typeof value.findings === 'object'
  )
}

export function loadEvaluationHistory(scope) {
  const store = storage()
  if (!store) return []
  try {
    const parsed = JSON.parse(store.getItem(scopeKey(scope)) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidSnapshot)
  } catch {
    return []
  }
}

function persist(scope, entries) {
  const store = storage()
  if (store) {
    try {
      store.setItem(scopeKey(scope), JSON.stringify(entries))
    } catch {
      // A full or blocked storage must never stop the user from evaluating.
    }
  }
  return entries
}

/**
 * Appends a snapshot. An identical run (same architecture version, run key and
 * overall score) updates the existing entry instead of adding a duplicate.
 */
export function recordEvaluation(scope, evaluation, meta = {}) {
  const snapshot = snapshotFromEvaluation(evaluation, meta)
  if (!snapshot) return loadEvaluationHistory(scope)
  const maxEntries = Number(meta.maxEntries) > 0 ? Number(meta.maxEntries) : DEFAULT_MAX_ENTRIES
  const existing = loadEvaluationHistory(scope)
  const duplicateIndex = existing.findIndex(
    (entry) =>
      entry.runId &&
      entry.runId === snapshot.runId &&
      entry.architectureVersion === snapshot.architectureVersion &&
      entry.overallScore === snapshot.overallScore,
  )
  let next
  if (duplicateIndex >= 0) {
    next = [...existing]
    next[duplicateIndex] = { ...snapshot, id: existing[duplicateIndex].id }
  } else {
    next = [snapshot, ...existing]
  }
  return persist(scope, next.slice(0, maxEntries))
}

export function clearEvaluationHistory(scope) {
  const store = storage()
  if (store) {
    try {
      store.removeItem(scopeKey(scope))
    } catch {
      // ignore
    }
  }
  return []
}

export function removeEvaluationEntry(scope, id) {
  const next = loadEvaluationHistory(scope).filter((entry) => entry.id !== id)
  return persist(scope, next)
}

function issueSet(snapshot) {
  return new Set(findingTexts(snapshot?.findings, ['critical', 'high', 'medium', 'low']))
}

/**
 * Compares two snapshots. `older` is the baseline and `newer` the current run.
 * The result states whether the two are even comparable: comparing across
 * architecture versions or runs is allowed but flagged, never hidden.
 */
export function compareEvaluations(older, newer) {
  if (!older || !newer) return null
  const sameArchitecture = older.architectureVersion === newer.architectureVersion
  const sameRun = older.runId === newer.runId
  const newerByKey = new Map((newer.categories || []).map((c) => [c.key, c]))
  const deltas = (older.categories || []).map((old) => {
    const cur = newerByKey.get(old.key)
    const before = old.status === 'evaluated' ? old.score : null
    const after = cur && cur.status === 'evaluated' ? cur.score : null
    return {
      key: old.key,
      label: old.label,
      before,
      after,
      delta: before != null && after != null ? after - before : null,
      status: cur?.status || 'not_evaluated',
    }
  })
  const improved = deltas.filter((d) => d.delta != null && d.delta > 0)
  const regressed = deltas.filter((d) => d.delta != null && d.delta < 0)
  const oldIssues = issueSet(older)
  const newIssues = issueSet(newer)
  const introduced = [...newIssues].filter((text) => !oldIssues.has(text))
  const resolved = [...oldIssues].filter((text) => !newIssues.has(text))
  const overallDelta =
    older.overallScore != null && newer.overallScore != null ? newer.overallScore - older.overallScore : null
  return {
    sameArchitecture,
    sameRun,
    older,
    newer,
    overallDelta,
    deltas,
    improved,
    regressed,
    introduced,
    resolved,
    warning: sameArchitecture
      ? sameRun
        ? null
        : 'Same architecture version but a different simulation run: differences reflect the run, not a design change.'
      : 'Different architecture versions: this compares two different designs and the difference must be read with that in mind.',
  }
}

export const EVALUATION_HISTORY_PREFIX = PREFIX
