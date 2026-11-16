/**
 * Server-side mirror of `src/data/nodeTypes.js`.
 *
 * Duplicated deliberately. The backend is deployed as its own package and cannot import
 * from the frontend tree, and `services/recommendation.service.js` already sets this
 * precedent for the six evaluation dimensions so the backend contract stays explicit and
 * testable on its own. `tests/backend-contract.test.js` asserts the two lists stay
 * identical, so this cannot silently drift.
 *
 * Ranges follow the same rules the frontend validator enforces (capacity > 0,
 * processingTime >= 0, a probability between 0 and 1) with the input maxima from
 * `parameterMeta` as upper bounds.
 */
export const PARAMETER_SPEC = Object.freeze({
  processingTime: { min: 0, max: 500 },
  capacity: { min: 1, max: 2000, minExclusive: true },
  failureProbability: { min: 0, max: 1 },
  queueCapacity: { min: 0, max: 2000 },
  memoryMb: { min: 16, max: 8192 },
  memoryPerSessionMb: { min: 0, max: 512 },
  retryLimit: { min: 0, max: 5, integer: true },
  baseLatencyMs: { min: 0, max: 500 },
  serviceTimeCv: { min: 0, max: 2 },
})

export const NODE_TYPE_KEYS = Object.freeze([
  'user',
  'webClient',
  'mobileClient',
  'apiGateway',
  'loadBalancer',
  'server',
  'microservice',
  'database',
  'cache',
  'fileStorage',
  'queue',
  'messageBroker',
  'externalService',
  'authentication',
  'firewall',
])

export function isKnownNodeType(type) {
  return NODE_TYPE_KEYS.includes(type)
}
