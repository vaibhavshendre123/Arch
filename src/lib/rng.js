const FNV_OFFSET = 2166136261
const FNV_PRIME = 16777619
const UINT32_MAX = 4294967296
const FALLBACK_STATE = 0x9e3779b9

export function hashSeed(input) {
  const raw = typeof input === 'number' ? `n:${Number.isFinite(input) ? input : 0}` : `s:${String(input ?? '')}`
  let hash = FNV_OFFSET
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
  }
  hash ^= hash >>> 15
  hash = Math.imul(hash, 2246822507)
  hash ^= hash >>> 13
  return hash >>> 0
}

function toState(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.trunc(seed) >>> 0
  return hashSeed(seed)
}

export function createRng(seed) {
  let state = toState(seed)
  if (state === 0) state = FALLBACK_STATE

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_MAX
  }

  const int = (min, max) => {
    const lo = Math.ceil(Math.min(min, max))
    const hi = Math.floor(Math.max(min, max))
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0
    if (hi <= lo) return lo
    return lo + Math.floor(next() * (hi - lo + 1))
  }

  const float = (min, max) => {
    const lo = Math.min(min, max)
    const hi = Math.max(min, max)
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0
    if (hi === lo) return lo
    return lo + next() * (hi - lo)
  }

  const pick = (list) => {
    if (!Array.isArray(list) || list.length === 0) return undefined
    if (list.length === 1) return list[0]
    const index = Math.floor(next() * list.length)
    return list[index < 0 ? 0 : index >= list.length ? list.length - 1 : index]
  }

  const bool = (probability) => {
    const p = Number.isFinite(probability) ? probability : 0
    if (p <= 0) return false
    if (p >= 1) return true
    return next() < p
  }

  const exponential = (mean) => {
    const m = Number.isFinite(mean) ? mean : 0
    if (m <= 0) return 0
    const u = 1 - next()
    return -Math.log(u > 0 && u < 1 ? u : Number.EPSILON) * m
  }

  // Gamma sampler (Marsaglia–Tsang). Service times stay exponential when the coefficient
  // of variation is 1 (shape 1); a shape below 1 is boosted by the standard U^(1/k)
  // transform so a low CV can produce a near-deterministic service time.
  const gamma = (shape, scale = 1) => {
    const k = Number.isFinite(shape) ? shape : 0
    const theta = Number.isFinite(scale) ? scale : 0
    if (!(k > 0) || !(theta > 0)) return 0

    let a = k
    let boost = 1
    if (a < 1) {
      a += 1
      const u = next()
      boost = Math.pow(u > 0 ? u : Number.EPSILON, 1 / k)
    }

    const d = a - 1 / 3
    const c = 1 / Math.sqrt(9 * d)
    // The acceptance loop is bounded so a pathological draw can never hang the engine.
    for (let attempt = 0; attempt < 64; attempt += 1) {
      let x = 0
      let v = 0
      do {
        const u1 = next()
        const u2 = next()
        const radius = Math.sqrt(-2 * Math.log(u1 > 0 ? u1 : Number.EPSILON))
        x = radius * Math.cos(2 * Math.PI * u2)
        v = 1 + c * x
      } while (v <= 0)
      v = v * v * v
      const u = next()
      if (u < 1 - 0.0331 * x * x * x * x) return theta * d * v * boost
      if (Math.log(u > 0 ? u : Number.EPSILON) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return theta * d * v * boost
      }
    }
    return theta * d * boost
  }

  return { next, int, float, pick, bool, exponential, gamma }
}
