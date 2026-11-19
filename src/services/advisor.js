import api from './api.js'

/**
 * Client for the server-side Gemini advisor arm. The API key never reaches the browser:
 * this calls our own backend, which holds the key and proxies the request.
 */

/** Availability check, so the page can say "not configured" without a failed request. */
export async function getAdvisorStatus() {
  const { data } = await api.get('/recommendations/advisor')
  return data.data
}

/**
 * Asks the backend for the Gemini arm. Throws on failure; callers are expected to fall
 * back to the deterministic rules rather than treating this as fatal, because the rules
 * are always available locally.
 */
export async function requestGeminiRecommendations(evidence) {
  const { data } = await api.post('/recommendations/advisor', { evidence })
  return data.data
}

/**
 * Conversational follow-up over the same evidence. This is a separate route so the
 * existing /advisor request/response contract used by the comparison arm stays unchanged.
 */
export async function askAdvisorQuestion({ question, history = [], evidence }) {
  const { data } = await api.post('/recommendations/advisor/chat', { question, history, evidence })
  return data.data
}