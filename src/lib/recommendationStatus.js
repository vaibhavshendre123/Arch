/**
 * Feature-local status tracking for AI recommendations.
 *
 * This deliberately uses localStorage rather than the project store: review state is a
 * per-browser workflow aid, not architecture data, so it must never be persisted with a
 * project or synchronised to the backend. Keys are scoped to the project, architecture
 * version and simulation result so an old decision cannot follow a recommendation onto a
 * different architecture.
 */

const PREFIX = 'archai.recommendations.status.v1'

export const RECOMMENDATION_STATUSES = ['open', 'in-review', 'accepted', 'dismissed']

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

export function loadRecommendationStatuses(scope) {
  const store = storage()
  if (!store) return {}
  try {
    const parsed = JSON.parse(store.getItem(scopeKey(scope)) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (RECOMMENDATION_STATUSES.includes(value)) out[id] = value
    }
    return out
  } catch {
    return {}
  }
}

export function saveRecommendationStatus(scope, id, status) {
  if (!id || !RECOMMENDATION_STATUSES.includes(status)) return loadRecommendationStatuses(scope)
  const next = { ...loadRecommendationStatuses(scope), [id]: status }
  const store = storage()
  if (store) {
    try {
      store.setItem(scopeKey(scope), JSON.stringify(next))
    } catch {
      // A full or blocked storage must not stop the user reviewing recommendations.
    }
  }
  return next
}
