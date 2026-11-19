// Canvas rendering helpers for the simulation arena.
//
// This module never invents data. Every position comes from `locateAt` on a real
// trajectory, every colour from a real outcome or measured statistic, and every
// event effect from an entry in the engine's event log. React does not participate
// in any of these draws: ArchitectureFlow's frame loop calls straight into here so
// playback never re-renders the page.

import { colors } from '../../theme/tokens.js'

/* --------------------------------------------------------------------------
   Visual quality modes. These change rendering cost only — particle budget,
   trail length, effect richness — and never a simulation outcome.
-------------------------------------------------------------------------- */

export const QUALITY_ORDER = ['performance', 'cinematic', 'ultra']

export const QUALITY = {
  performance: {
    label: 'Performance',
    particles: 64,
    trailBuckets: 0,
    trailSpanMs: 0,
    pulses: 2,
    effectCap: 64,
    glowSize: 24,
    dprCap: 1.5,
    haloLayers: 1,
  },
  cinematic: {
    label: 'Cinematic',
    particles: 160,
    trailBuckets: 2,
    trailSpanMs: 450,
    pulses: 4,
    effectCap: 140,
    glowSize: 32,
    dprCap: 2,
    haloLayers: 2,
  },
  ultra: {
    label: 'Ultra',
    particles: 280,
    trailBuckets: 3,
    trailSpanMs: 780,
    pulses: 6,
    effectCap: 220,
    glowSize: 40,
    dprCap: 2,
    haloLayers: 3,
  },
}

/* --------------------------------------------------------------------------
   Deterministic sampling. When the recorded trajectory count exceeds the
   particle budget, pick an even stride across the WHOLE run — never the first
   N, which would show only the opening seconds. Identical runs sample
   identically, so the picture is reproducible.
-------------------------------------------------------------------------- */

export function sampleTrajectories(list, budget) {
  if (!Array.isArray(list)) return []
  if (!budget || list.length <= budget) return list
  const out = []
  const n = list.length
  for (let i = 0; i < budget; i += 1) out.push(list[Math.floor((i * n) / budget)])
  return out
}

/** Stable 0..1 hash so a request always draws at the same offset for a given seed. */
export function jitter01(seed) {
  const s = String(seed)
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1024) / 1024
}

/* --------------------------------------------------------------------------
   Event index: the recorded event log bucketed by timestamp, so the frame
   loop can pick up only the events inside the interval the playback head just
   crossed. Effects therefore fire exactly once per recorded event, at its real
   simulation time, and pause freezes them with the clock.
-------------------------------------------------------------------------- */

export function buildEventIndex(eventLog, bucketMs = 400) {
  const buckets = new Map()
  for (const ev of eventLog || []) {
    if (!ev || !Number.isFinite(ev.timestamp)) continue
    const b = Math.floor(ev.timestamp / bucketMs)
    let list = buckets.get(b)
    if (!list) {
      list = []
      buckets.set(b, list)
    }
    list.push(ev)
  }
  return { buckets, bucketMs }
}

/**
 * Emit recorded events with timestamps in (fromTs, toTs], up to `budget`.
 * Returns the new cursor. When the budget runs out the cursor still advances:
 * skipping the rest of that frame is deterministic for identical runs, and
 * dropping late effects beats falling behind playback.
 */
export function spawnEventsBetween(index, fromTs, toTs, budget, emit) {
  if (!index || !Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) return fromTs
  const { buckets, bucketMs } = index
  let left = budget
  const first = Math.floor(fromTs / bucketMs)
  const last = Math.floor(toTs / bucketMs)
  for (let b = first; b <= last; b += 1) {
    const list = buckets.get(b)
    if (!list) continue
    for (const ev of list) {
      if (ev.timestamp <= fromTs || ev.timestamp > toTs) continue
      if (left <= 0) return toTs
      left -= 1
      if (emit(ev) === false) return toTs
    }
  }
  return toTs
}

/* --------------------------------------------------------------------------
   Colour helpers: everything renders from theme tokens, mixed numerically so
   congestion/failure tinting is a measured ratio rather than a mood.
-------------------------------------------------------------------------- */

function toRgb(value) {
  const c = value.replace('#', '')
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]
}

export function mixRgb(a, b, t) {
  const A = Array.isArray(a) ? a : toRgb(a)
  const B = Array.isArray(b) ? b : toRgb(b)
  const k = Math.min(1, Math.max(0, t))
  return [A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k]
}

export function rgba(c, alpha) {
  const A = Array.isArray(c) ? c : toRgb(c)
  return `rgba(${A[0] | 0},${A[1] | 0},${A[2] | 0},${alpha})`
}

// Canvas code needs raw channels, not CSS strings. Cache them, but key the cache on the
// palette itself so switching theme refreshes the colours without a manual invalidation.
let rgbCache = null
let rgbKey = null

function currentRgb() {
  const key = [colors.teal, colors.blue, colors.green, colors.accent, colors.red, colors.purple].join('|')
  if (rgbCache && rgbKey === key) return rgbCache
  rgbCache = {
    cyan: toRgb(colors.teal),
    blue: toRgb(colors.blue),
    green: toRgb(colors.green),
    amber: toRgb(colors.accent),
    red: toRgb(colors.red),
    purple: toRgb(colors.purple),
  }
  rgbKey = key
  return rgbCache
}

function paletteColor(_target, key) {
  if (typeof key !== 'string') return undefined
  const rgb = currentRgb()
  const outcome = {
    cyan: rgb.cyan,
    blue: rgb.blue,
    green: rgb.green,
    amber: rgb.amber,
    red: rgb.red,
    purple: rgb.purple,
    completed: rgb.green,
    retried: rgb.purple,
    failed: rgb.red,
    dropped: rgb.amber,
  }
  return outcome[key]
}

export const RGB = new Proxy({}, { get: paletteColor })
export const OUTCOME_RGB = new Proxy({}, { get: paletteColor })

/**
 * Stream colour for one connection, from what actually travelled it:
 * failure share bleeds red, dropped share amber, completions a green cast,
 * and congestion measured at the endpoint queues pulls it toward amber.
 */
export function edgeTint(entry, congestion) {
  const load01 = entry && entry.count ? Math.min(1, entry.count / 60) : 0
  let c = mixRgb(RGB.cyan, RGB.blue, load01)
  if (entry && entry.count > 0) {
    const failShare = (entry.failed || 0) / entry.count
    const dropShare = (entry.dropped || 0) / entry.count
    const okShare = Math.max(0, 1 - failShare - dropShare)
    c = mixRgb(c, RGB.red, failShare * 0.55)
    c = mixRgb(c, RGB.amber, dropShare * 0.5)
    c = mixRgb(c, RGB.green, okShare * 0.14)
  }
  c = mixRgb(c, RGB.amber, Math.min(1, congestion) * 0.6)
  return c
}

/* --------------------------------------------------------------------------
   Glow sprites: one radial-gradient sprite per colour, drawn with the
   `lighter` composite so many particles stack into a bloom instead of paying
   for a shadowBlur pass. The cache keeps per-frame allocation at zero.
-------------------------------------------------------------------------- */

const spriteCache = new Map()

function spriteFor(rgb, size) {
  const key = `${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0}|${size}`
  let canvas = spriteCache.get(key)
  if (canvas) return canvas
  canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')
  const r = size / 2
  const grad = g.createRadialGradient(r, r, 0, r, r, r)
  grad.addColorStop(0, rgba(rgb, 1))
  grad.addColorStop(0.3, rgba(rgb, 0.6))
  grad.addColorStop(1, rgba(rgb, 0))
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  spriteCache.set(key, canvas)
  return canvas
}

export function drawGlow(ctx, rgb, x, y, radius, alpha, spriteSize = 32) {
  if (radius <= 0 || alpha <= 0.01) return
  const sprite = spriteFor(rgb, spriteSize)
  const prev = ctx.globalCompositeOperation
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = Math.min(1, Math.max(0, alpha))
  ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = prev
}

/* --------------------------------------------------------------------------
   Interpolation along a sampled polyline (the connector shapes sampled in
   ArchitectureFlow from the same curve the SVG draws), in user units, so
   streams and particles share one geometry.
-------------------------------------------------------------------------- */

export function pointAt(pts, p) {
  if (!pts || !pts.length) return null
  const t = Math.min(1, Math.max(0, p))
  const f = t * (pts.length - 1)
  const i = Math.min(pts.length - 2, Math.floor(f))
  if (i < 0) return { x: pts[0][0], y: pts[0][1] }
  const k = f - i
  return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k }
}

export function strokePath(ctx, pts, width, style, alpha, from = 0, to = pts ? pts.length - 1 : 0) {
  if (!pts || pts.length < 2 || alpha <= 0.01 || to - from < 1) return
  ctx.globalAlpha = alpha
  ctx.strokeStyle = style
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(pts[from][0], pts[from][1])
  for (let i = from + 1; i <= to; i += 1) ctx.lineTo(pts[i][0], pts[i][1])
  ctx.stroke()
  ctx.globalAlpha = 1
}

/**
 * A moving light pulse along a connection: a short comet of glow sprites whose
 * travel is driven by playback (simulation) time, so playback speed moves it
 * consistently and pause freezes it. Rate scales with the edge's real traffic.
 */
export function drawPulse(ctx, rgb, pts, frac, alpha, spriteSize = 32, headRadius = 5) {
  const head = pointAt(pts, frac)
  if (!head || alpha <= 0.02) return
  for (let k = 4; k >= 0; k -= 1) {
    const p = pointAt(pts, frac - k * 0.016)
    if (!p) continue
    const fade = 1 - k / 5
    drawGlow(ctx, rgb, p.x, p.y, headRadius * (0.5 + fade * 0.7), alpha * fade * fade, spriteSize)
  }
}

/* --------------------------------------------------------------------------
   Living-node halo: layered rounded-rect strokes (a cheap, predictable bloom)
   plus a radial wash behind the card. Intensity is measured utilisation and
   live in-flight work; colour is the component's derived state.
-------------------------------------------------------------------------- */

export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

export function drawNodeHalo(ctx, card, rgb, opts) {
  const { alpha, layers = 2, grow = 0, pulse = 0 } = opts
  if (alpha <= 0.01) return
  const pad = 4 + grow
  // Radial wash behind the card, so the node looks lit rather than outlined.
  drawGlow(ctx, rgb, card.cx, card.cy, Math.max(card.w, card.h) * 0.62 + grow * 6, alpha * 0.5, 40)
  for (let i = 0; i < layers; i += 1) {
    const k = (i + 1) / layers
    roundRectPath(ctx, card.x - pad - i * 2.5, card.y - pad - i * 2.5, card.w + (pad + i * 2.5) * 2, card.h + (pad + i * 2.5) * 2, 13)
    ctx.globalAlpha = alpha * (0.5 - k * 0.22) + pulse * (1 - k / layers) * 0.3
    ctx.strokeStyle = rgba(rgb, 1)
    ctx.lineWidth = 1.4
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/* --------------------------------------------------------------------------
   Event effects, one per recorded event activity. `p` is the normalised age
   0..1 of the effect in wall-clock time; the spawn itself was scheduled by
   simulation time, so pause stops new ones and these finish their short life.
-------------------------------------------------------------------------- */

export function drawEffect(ctx, fx, p, rich) {
  const fade = 1 - p
  if (fade <= 0) return
  const { x, y, rgb } = fx
  switch (fx.kind) {
    case 'entry': {
      // Node-entry pulse: a ring lifting off the card's left edge.
      const r = 6 + p * 16
      ctx.globalAlpha = fade * 0.7
      ctx.strokeStyle = rgba(rgb, 1)
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.stroke()
      drawGlow(ctx, rgb, x, y, 10 + p * 8, fade * 0.35, 24)
      break
    }
    case 'burst': {
      // Processing start: a short activity burst around the component centre.
      const n = rich ? 7 : 4
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * Math.PI * 2 + fx.spin
        const d = 6 + p * (rich ? 26 : 16)
        drawGlow(ctx, rgb, x + Math.cos(a) * d, y + Math.sin(a) * d, 3.4 * fade + 1.2, fade * 0.7, 24)
      }
      drawGlow(ctx, rgb, x, y, 12 + p * 6, fade * 0.4, 24)
      break
    }
    case 'out': {
      // Processing complete: a pulse leaving toward the card's right edge.
      const ox = x + p * 26
      ctx.globalAlpha = fade * 0.65
      ctx.strokeStyle = rgba(rgb, 1)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(ox, y, 4 + p * 8, 0, Math.PI * 2)
      ctx.stroke()
      drawGlow(ctx, rgb, ox, y, 9, fade * 0.4, 24)
      break
    }
    case 'ok': {
      // Request completion: one calm green confirmation ring.
      const r = 6 + p * 24
      ctx.globalAlpha = fade * 0.75
      ctx.strokeStyle = rgba(rgb, 1)
      ctx.lineWidth = 1.7
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.stroke()
      if (rich) {
        ctx.globalAlpha = fade * 0.4
        ctx.beginPath()
        ctx.arc(x, y, r * 0.55, 0, Math.PI * 2)
        ctx.stroke()
      }
      drawGlow(ctx, rgb, x, y, 10, fade * 0.35, 24)
      break
    }
    case 'fail': {
      // Failure: a red disruption flash at the component that aborted the request.
      drawGlow(ctx, rgb, x, y, 14 + p * 16, fade * 0.75, 32)
      ctx.globalAlpha = fade * 0.8
      ctx.strokeStyle = rgba(rgb, 1)
      ctx.lineWidth = 2
      ctx.beginPath()
      const spikes = 8
      for (let i = 0; i <= spikes * 2; i += 1) {
        const a = (i / (spikes * 2)) * Math.PI * 2
        const rr = i % 2 ? 5 + p * 9 : 9 + p * 16
        const px = x + Math.cos(a) * rr
        const py = y + Math.sin(a) * rr
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.stroke()
      break
    }
    case 'drop': {
      // Drop: an amber marker falling away from the component that rejected it.
      const dy = p * p * 18
      const r = 5 + p * 10
      ctx.globalAlpha = fade * 0.7
      ctx.strokeStyle = rgba(rgb, 1)
      ctx.lineWidth = 1.7
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.arc(x, y + dy, r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      drawGlow(ctx, rgb, x, y + dy, 9, fade * 0.4, 24)
      break
    }
    case 'retry': {
      // Retry: a purple double ring — the request is looping back.
      const r = 5 + p * 18
      ctx.globalAlpha = fade * 0.7
      ctx.strokeStyle = rgba(rgb, 1)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = fade * 0.4
      ctx.beginPath()
      ctx.arc(x, y, r * 0.6, 0.6, Math.PI * 1.7)
      ctx.stroke()
      drawGlow(ctx, rgb, x, y, 11, fade * 0.4, 24)
      break
    }
    default:
      break
  }
  ctx.globalAlpha = 1
  ctx.setLineDash([])
}

/** Map an engine activity name to the effect that activity actually caused. */
export const ACTIVITY_EFFECT = {
  QUEUE_ENTER: 'entry',
  PROCESS_START: 'burst',
  PROCESS_COMPLETE: 'out',
  REQUEST_COMPLETE: 'ok',
  FAILURE: 'fail',
  REQUEST_DROPPED: 'drop',
  RETRY: 'retry',
}
