import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Boxes,
  Cloud,
  Database,
  Folder,
  Globe,
  ListOrdered,
  Lock,
  Maximize2,
  Minus,
  Network,
  Plus,
  Radio,
  Server,
  ShieldAlert,
  ShieldCheck,
  Shuffle,
  Smartphone,
  User,
  Zap,
} from 'lucide-react'
import { edgeTraffic, locateAt, statsAt } from '../lib/trajectories.js'
import { colors, withAlpha } from '../theme/tokens.js'
import {
  ACTIVITY_EFFECT,
  OUTCOME_RGB,
  QUALITY,
  QUALITY_ORDER,
  RGB,
  buildEventIndex,
  drawEffect,
  drawGlow,
  drawNodeHalo,
  drawPulse,
  edgeTint,
  jitter01,
  mixRgb,
  pointAt,
  roundRectPath,
  sampleTrajectories,
  spawnEventsBetween,
  rgba,
  strokePath,
} from './sim/flowRender.js'

export const CARD_W = 148
export const CARD_H = 96
const GAP = 40
const LABEL_H = 42
const TAU = Math.PI * 2

// Playback timing lives in lib/playback.js. It used to sit here as a bare 0.02x-2x
// multiplier, which cannot express "play the whole run in N seconds".
export { REAL_TIME, WALL_CLOCK_TARGETS, DEFAULT_WALL_CLOCK, resolveSpeed, speedLabel } from '../lib/playback.js'

// Real measurements drive every visual: the dashes travel at the measured throughput on
// that connection, the LOAD badge is the component's utilisation, CONN is how many requests
// are inside it right now, and the alert marker appears when it is genuinely saturated.
const ICONS = {
  user: User,
  webClient: Globe,
  mobileClient: Smartphone,
  apiGateway: ShieldCheck,
  loadBalancer: Shuffle,
  server: Server,
  microservice: Boxes,
  database: Database,
  cache: Zap,
  fileStorage: Folder,
  queue: ListOrdered,
  messageBroker: Radio,
  externalService: Cloud,
  authentication: Lock,
  firewall: ShieldAlert,
}

const FALLBACK_ICON = Network

// Visual style of each event-driven effect: colour from the theme, duration in
// wall-clock milliseconds. The activity list comes from the engine's own
// vocabulary (see sim/flowRender.js ACTIVITY_EFFECT); nothing here fires for an
// activity the engine never recorded.
const EFFECT_STYLE = {
  entry: { rgb: RGB.blue, dur: 430 },
  burst: { rgb: RGB.cyan, dur: 540 },
  out: { rgb: RGB.green, dur: 470 },
  ok: { rgb: RGB.green, dur: 650 },
  fail: { rgb: RGB.red, dur: 520 },
  drop: { rgb: RGB.amber, dur: 740 },
  retry: { rgb: RGB.purple, dur: 570 },
}

export function cardOf(node) {
  const x = node?.position?.x ?? 0
  const y = node?.position?.y ?? 0
  return {
    x,
    y,
    w: CARD_W,
    h: CARD_H,
    cx: x + CARD_W / 2,
    cy: y + CARD_H / 2,
    right: x + CARD_W,
    left: x,
    bottom: y + CARD_H,
  }
}

export function boundsOfFlow(node) {
  return cardOf(node)
}

/** Elbow connector between two cards, with the arrowhead landing on the target edge. */
function edgePath(from, to) {
  const sx = from.right
  const sy = from.cy
  const tx = to.left - 10
  const ty = to.cy

  if (tx - sx < 24) {
    // Target sits behind the source: route around it.
    const midX = (sx + tx) / 2
    return `M ${sx} ${sy} C ${sx + 40} ${sy}, ${midX} ${sy - 60}, ${midX} ${sy - 60} L ${midX} ${ty - 60} C ${midX} ${ty - 60}, ${tx - 40} ${ty}, ${tx} ${ty}`
  }

  const dx = Math.max(36, (tx - sx) * 0.5)
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`
}

/** Point on a cubic bezier defined by four control points. */
function cubicAt(p0, p1, p2, p3, t) {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]
}

/**
 * Sample the exact curve `edgePath` draws, as plain points in user units.
 *
 * Pure math rather than DOM measurement, so the canvas layers can share the SVG's
 * geometry without a layout pass: particles and pulses follow the same shape the
 * connector is drawn with, and nothing can drift between the two renderers.
 */
function sampleEdgeShape(from, to, n = 44) {
  const sx = from.right
  const sy = from.cy
  const tx = to.left - 10
  const ty = to.cy
  const pts = []

  if (tx - sx < 24) {
    const midX = (sx + tx) / 2
    const half = Math.max(8, Math.floor(n / 2))
    const a0 = [sx, sy]
    const a1 = [sx + 40, sy]
    const a2 = [midX, sy - 60]
    const a3 = [midX, sy - 60]
    const b0 = [midX, ty - 60]
    const b1 = [midX, ty - 60]
    const b2 = [tx - 40, ty]
    const b3 = [tx, ty]
    for (let i = 0; i <= half; i += 1) pts.push(cubicAt(a0, a1, a2, a3, i / half))
    const steps = 6
    for (let i = 1; i <= steps; i += 1) pts.push([midX, sy - 60 + (ty - 60 - (sy - 60)) * (i / steps)])
    for (let i = 0; i <= half; i += 1) pts.push(cubicAt(b0, b1, b2, b3, i / half))
    return pts
  }

  const dx = Math.max(36, (tx - sx) * 0.5)
  const p0 = [sx, sy]
  const p1 = [sx + dx, sy]
  const p2 = [tx - dx, ty]
  const p3 = [tx, ty]
  for (let i = 0; i <= n; i += 1) pts.push(cubicAt(p0, p1, p2, p3, i / n))
  return pts
}

/**
 * Health of a component, derived only from engine output.
 *
 * IDLE    — the run never visited it (no measurement exists yet).
 * HEALTHY — utilisation under 65%.
 * PRESS   — 65-85%, queues are forming.
 * OVER    — above 85%, or the configured queue limit was reached: saturated.
 *
 * Each state carries a text label as well as a colour, so it is never
 * communicated by hue alone.
 */
export function componentState(stat) {
  if (!stat || typeof stat.utilization !== 'number' || stat.visits === 0) {
    return { key: 'idle', label: 'IDLE', color: colors.inkDim }
  }
  const util = Math.min(100, Math.max(0, stat.utilization * 100))
  const queueCap = Number(stat.queueCapacity)
  const saturated =
    Number.isFinite(queueCap) && queueCap > 0 && queueCap < 1000 && (stat.queueLengthMax || 0) >= queueCap
  if (util > 85 || saturated) return { key: 'over', label: saturated ? 'SATURATED' : 'OVERLOADED', color: colors.red }
  if (util > 65) return { key: 'press', label: 'PRESSURE', color: colors.accent }
  return { key: 'healthy', label: 'HEALTHY', color: colors.green }
}

function CornerTicks({ w, h, color }) {
  const t = 9
  const pad = 1
  return (
    <g pointerEvents="none" stroke={color} strokeWidth={1.4} fill="none" opacity={0.9}>
      <path d={`M ${pad} ${pad + t} L ${pad} ${pad} L ${pad + t} ${pad}`} />
      <path d={`M ${w - pad - t} ${pad} L ${w - pad} ${pad} L ${w - pad} ${pad + t}`} />
      <path d={`M ${pad} ${h - pad - t} L ${pad} ${h - pad} L ${pad + t} ${h - pad}`} />
      <path d={`M ${w - pad - t} ${h - pad} L ${w - pad} ${h - pad} L ${w - pad} ${h - pad - t}`} />
    </g>
  )
}

export default function ArchitectureFlow({
  arch,
  components,
  trajectories = [],
  // The engine's own event log, so event effects fire only for recorded events.
  eventLog = null,
  running = false,
  speed = 1,
  // The configured workload duration in seconds. Playback covers exactly this span and
  // then stops, instead of looping.
  durationSec = 0,
  // True when the engine stopped at its event budget before the duration elapsed.
  truncated = false,
  // The engine's logging stride. Counters read off the sampled log are multiplied by it so
  // the live read-out reflects real concurrency instead of the sample size.
  sampleEvery = 1,
  onComplete,
  // Direct DOM refs so the frame loop can paint progress without re-rendering the page.
  progressBarRef,
  resetKey = 0,
  readout,
  // Optional extras for the control room. Selecting a node and the bottleneck list come
  // from real engine/mining data; the live per-node load is written for the parent to
  // poll without re-rendering this component.
  selectedId = null,
  onSelectNode,
  bottleneckIds = [],
  nodeLoadRef = { current: null },
  height = 520,
  // The reader's motion preference: the canvas holds still when it is set, and playback
  // still works if the reader presses Play anyway.
  reducedMotion = false,
}) {
  const nodes = useMemo(() => arch?.nodes || [], [arch])
  const edges = useMemo(
    () => (arch?.edges || []).filter((e) => e.source && e.target),
    [arch],
  )
  const cards = useMemo(() => new Map(nodes.map((n) => [n.id, cardOf(n)])), [nodes])
  const bottleneckSet = useMemo(() => new Set(bottleneckIds || []), [bottleneckIds])

  const traffic = useMemo(() => edgeTraffic(trajectories), [trajectories])

  // The playback timeline is the configured workload duration, so the run stops exactly
  // where the user asked it to. The one exception is a run the engine had to cut short at
  // its event budget: replaying to the full duration there would leave a long empty tail,
  // so the timeline ends with the data instead.
  const timeline = useMemo(() => {
    const configuredMs = Math.max(0, Number(durationSec) || 0) * 1000
    if (!trajectories.length) {
      return { start: 0, span: Math.max(1, configuredMs), coversRun: false }
    }
    const dataStart = trajectories[0].start
    const dataEnd = trajectories[trajectories.length - 1].end
    const useDataEnd = truncated && dataEnd < configuredMs - 1
    const end = configuredMs > 0 ? (useDataEnd ? dataEnd : configuredMs) : dataEnd
    return {
      start: dataStart,
      span: Math.max(1, end - dataStart),
      coversRun: !(configuredMs > 0 && end < configuredMs - 1),
    }
  }, [trajectories, durationSec, truncated])

  // Hottest connection sets the dash speed so relative load between links is visible.
  const maxCount = useMemo(() => {
    let max = 0
    for (const entry of traffic.values()) max = Math.max(max, entry.count)
    return max || 1
  }, [traffic])

  /* ------------------------------------------------------------------
     Visual quality. Rendering cost only — never a simulation outcome.
     Stored on the device so the choice survives a reload.
  ------------------------------------------------------------------ */
  const [quality, setQualityState] = useState(() => {
    try {
      const saved = window.localStorage.getItem('archai.simQuality')
      if (saved && QUALITY[saved]) return saved
    } catch {
      // Storage can be unavailable (private mode); the default below is fine.
    }
    return 'cinematic'
  })
  const cfg = QUALITY[quality] || QUALITY.cinematic
  const fpsChipRef = useRef(null)
  const fallbackDoneRef = useRef(false)

  const chooseQuality = useCallback((key) => {
    if (!QUALITY[key]) return
    // An explicit choice overrides the automatic frame-rate fallback for this run.
    fallbackDoneRef.current = true
    setQualityState(key)
    try {
      window.localStorage.setItem('archai.simQuality', key)
    } catch {
      // A preference that cannot be stored is still honoured for this session.
    }
  }, [])

  // Deterministic visual sample: an even stride across the whole recorded run when the
  // particle budget is smaller than the trajectory list. Disclosed under the arena.
  const sampled = useMemo(
    () => sampleTrajectories(trajectories, cfg.particles),
    [trajectories, cfg.particles],
  )
  const eventIndex = useMemo(() => buildEventIndex(eventLog), [eventLog])

  // Connection geometry sampled from the same curve the SVG draws (see sampleEdgeShape).
  const edgeGeoms = useMemo(() => {
    const list = []
    for (const e of edges) {
      const from = cards.get(e.source)
      const to = cards.get(e.target)
      if (!from || !to) continue
      const key = `${e.source}->${e.target}`
      const entry = traffic.get(key) || null
      list.push({
        key,
        fromId: e.source,
        toId: e.target,
        pts: sampleEdgeShape(from, to),
        entry,
        load: entry && maxCount ? entry.count / maxCount : 0,
        hash: jitter01(key),
      })
    }
    return list
  }, [edges, cards, traffic, maxCount])
  const geomByKey = useMemo(() => new Map(edgeGeoms.map((g) => [g.key, g])), [edgeGeoms])

  const edgeRefs = useRef([])
  // Playback position lives in a ref so changing speed, pausing or a new result can
  // restart the effect without snapping the run back to zero.
  const clockRef = useRef(0)
  const finishedRef = useRef(false)

  // Canvas layers: one pooled frame buffer of in-flight requests (filled by the playback
  // loop below), one pool of one-shot event effects, and the clocks that drive ambience.
  const particleBuf = useRef({ count: 0, items: [], at: 0, fade: 1 })
  const effects = useRef({ list: [], cursor: -Infinity })
  const wallRef = useRef(0)
  const ambRef = useRef(0)
  const fpsRef = useRef({ frames: 0, windowStart: 0, value: 0 })
  const bgCanvasRef = useRef(null)
  const fgCanvasRef = useRef(null)

  // A new run, or an explicit Replay, restarts from the beginning.
  useEffect(() => {
    clockRef.current = 0
    finishedRef.current = false
    // `progressBarRef` is a ref object owned by the parent, and the element it points at
    // is only rendered once a result exists. Checking the ref object instead of its
    // `current` threw a TypeError on first mount and took the whole page down.
    if (progressBarRef?.current) progressBarRef.current.style.width = '0%'
    // Presentation state the canvas layers own: a replay starts from a clean frame with
    // the effect pool and the spawn cursor back at the head of the timeline.
    const buf = particleBuf.current
    buf.count = 0
    buf.at = timeline.start
    buf.fade = 1
    effects.current.list.length = 0
    effects.current.cursor = timeline.start - 1
    fallbackDoneRef.current = false
    fpsRef.current = { frames: 0, windowStart: 0, value: 0 }
  }, [resetKey, timeline, progressBarRef])

  useEffect(() => {
    if (!running) return undefined

    let raf = 0
    let previous = performance.now()
    const { span, start } = timeline

    const finish = () => {
      // The completion callback flips parent state, which re-renders and re-runs this
      // effect. Guard so the parent is told about the end of the run exactly once.
      if (finishedRef.current) return
      finishedRef.current = true
      cancelAnimationFrame(raf)
      onComplete?.()
    }

    const tick = (now) => {
      const dt = Math.min(64, now - previous)
      previous = now

      // Clamp to the span rather than wrapping. `% span` is what made the run loop
      // forever; the run must finish on the configured duration and then stop.
      const elapsed = Math.min(span, clockRef.current + dt * speed)
      clockRef.current = elapsed
      const position = span > 0 ? elapsed / span : 1

      // Each connection's dashes advance in proportion to the traffic it actually carried,
      // so a busy link visibly streams and an idle one barely moves.
      for (let i = 0; i < edgeRefs.current.length; i += 1) {
        const el = edgeRefs.current[i]
        if (!el) continue
        const load = Number(el.dataset.load || 0)
        el.setAttribute('stroke-dashoffset', String(-elapsed * (6 + load * 90)))
      }

      // The frame's particle buffer, filled from the deterministic sample: pooled objects,
      // written in place, so playback never allocates a new particle per request per frame.
      const at = start + position * span
      const edgeFade = position >= 1 ? 0 : Math.min(1, (1 - position) / 0.05)
      const buf = particleBuf.current
      const items = buf.items
      let slot = 0
      for (const traj of sampled) {
        const where = locateAt(traj, at)
        if (!where) continue
        let item = items[slot]
        if (!item) {
          item = { traj: null, where: null }
          items[slot] = item
        }
        item.traj = traj
        item.where = where
        slot += 1
      }
      buf.count = slot
      buf.at = at
      buf.fade = edgeFade

      if (readout?.current && slot > 0) {
        const stats = statsAt(trajectories, at, { scale: sampleEvery })
        // Mark extrapolated numbers so a sampled count is never read as an exact one.
        const approx = stats.estimated ? '~' : ''
        readout.current.textContent =
          `t ${(at / 1000).toFixed(1)}s · in flight ${approx}${stats.inFlight.toLocaleString()} · ` +
          `completed ${approx}${stats.completed.toLocaleString()} · ` +
          `failed ${approx}${stats.failed.toLocaleString()} · dropped ${approx}${stats.dropped.toLocaleString()}`
        // Live per-component load from the same sampled trajectories, for the component
        // intelligence panel. Written into a ref so the page can poll it on its own timer.
        nodeLoadRef.current = stats.perNode
      }

      // Progress is written straight to the DOM. Calling setState here would re-render the
      // page on every frame.
      if (progressBarRef?.current) progressBarRef.current.style.width = `${(position * 100).toFixed(2)}%`

      // The run has reached the configured duration: stop for good.
      if (elapsed >= span) {
        finish()
        return
      }

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [running, speed, sampled, timeline, readout, progressBarRef, onComplete, sampleEvery, nodeLoadRef, trajectories])

  /* ------------------------------------------------------------------
     Camera: smooth focus when a component is selected. Pure view state —
     it never touches positions, edges or trajectories. The reader's own
     drag or zoom cancels the transition immediately, and nothing moves
     during normal playback.
  ------------------------------------------------------------------ */
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const panRef = useRef(pan)
  const camAnimRef = useRef(0)

  useEffect(() => {
    panRef.current = pan
  }, [pan])

  const stopCamera = useCallback(() => {
    if (camAnimRef.current) {
      cancelAnimationFrame(camAnimRef.current)
      camAnimRef.current = 0
    }
  }, [])

  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    stopCamera()
  }, [resetKey, nodes, stopCamera])

  const boxes = nodes.map((n) => cards.get(n.id))
  const baseView = useMemo(() => {
    if (!boxes.length) return { x: 0, y: 0, w: 900, h: 460 }
    const x0 = Math.min(...boxes.map((b) => b.x))
    const y0 = Math.min(...boxes.map((b) => b.y))
    const x1 = Math.max(...boxes.map((b) => b.right))
    const y1 = Math.max(...boxes.map((b) => b.bottom + LABEL_H))
    return {
      x: x0 - GAP,
      y: y0 - GAP,
      w: x1 - x0 + GAP * 2,
      h: y1 - y0 + GAP * 2,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, CARD_W, CARD_H])

  // Smooth focus transition on selection: ease the pan so the chosen component settles in
  // the middle of the arena. Dragging takes over instantly (see the guard in `step`).
  useEffect(() => {
    if (!selectedId) return undefined
    const card = cards.get(selectedId)
    if (!card) return undefined
    // The view centre is the base centre plus pan, so this is the pan that centres it.
    const targetX = card.cx - (baseView.x + baseView.w / 2)
    const targetY = card.cy - (baseView.y + baseView.h / 2)
    const fromX = panRef.current.x
    const fromY = panRef.current.y
    if (Math.abs(targetX - fromX) < 1 && Math.abs(targetY - fromY) < 1) return undefined
    const t0 = performance.now()
    const dur = 420
    let raf = 0
    const step = (now) => {
      if (dragRef.current) {
        // The reader grabbed the canvas mid-transition: stop steering.
        raf = 0
        return
      }
      const k = Math.min(1, (now - t0) / dur)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      setPan({ x: fromX + (targetX - fromX) * e, y: fromY + (targetY - fromY) * e })
      if (k < 1) {
        raf = requestAnimationFrame(step)
      } else {
        raf = 0
      }
    }
    raf = requestAnimationFrame(step)
    camAnimRef.current = raf
    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (camAnimRef.current === raf) camAnimRef.current = 0
    }
  }, [selectedId, cards, baseView])

  const viewBox = useMemo(() => {
    const w = baseView.w / zoom
    const h = baseView.h / zoom
    const x = baseView.x + (baseView.w - w) / 2 + pan.x
    const y = baseView.y + (baseView.h - h) / 2 + pan.y
    return `${x} ${y} ${w} ${h}`
  }, [baseView, zoom, pan])

  const zoomBy = useCallback(
    (factor) => {
      stopCamera()
      setZoom((z) => Math.min(6, Math.max(0.5, z * factor)))
    },
    [stopCamera],
  )
  const fitView = useCallback(() => {
    stopCamera()
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [stopCamera])

  const toSvgDelta = useCallback((dx, dy) => {
    const el = svgRef.current
    if (!el) return { dx: 0, dy: 0 }
    const rect = el.getBoundingClientRect()
    const vb = el.viewBox.baseVal
    const span = vb && vb.width ? vb.width : baseView.w
    const scale = rect.width > 0 ? span / rect.width : 1
    return { dx: dx * scale, dy: dy * scale }
  }, [baseView.w])

  const onPointerDown = (e) => {
    // Nodes handle their own clicks; drag only starts on empty canvas.
    if (e.target.closest('[data-node="1"]')) return
    stopCamera()
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e) => {
    const drag = dragRef.current
    if (!drag) return
    const { dx, dy } = toSvgDelta(e.clientX - drag.x, e.clientY - drag.y)
    setPan({ x: drag.panX - dx, y: drag.panY - dy })
  }
  const onPointerUp = (e) => {
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  /* ------------------------------------------------------------------
     The canvas frame loop. One requestAnimationFrame drives both layers:
     streams and living-node halos UNDER the SVG, particle trails, cores
     and recorded-event effects OVER it. React renders none of this — every
     draw reads the pooled frame buffer, the component statistics, or the
     event index — so playback never re-renders the page and pause simply
     freezes the buffer at the simulation time it holds.
  ------------------------------------------------------------------ */
  useEffect(() => {
    const bg = bgCanvasRef.current
    const fg = fgCanvasRef.current
    const svg = svgRef.current
    if (!bg || !fg || !svg) return undefined

    let alive = true
    let raf = 0
    let prev = performance.now()
    let size = { w: 0, h: 0, dpr: 1 }

    const resize = () => {
      const rect = svg.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width))
      const h = Math.max(1, Math.round(rect.height))
      const dpr = Math.min(window.devicePixelRatio || 1, cfg.dprCap)
      if (size.w === w && size.h === h && size.dpr === dpr) return
      size = { w, h, dpr }
      bg.width = Math.round(w * dpr)
      bg.height = Math.round(h * dpr)
      fg.width = Math.round(w * dpr)
      fg.height = Math.round(h * dpr)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(svg)

    const draw = (now) => {
      const dt = Math.min(64, now - prev)
      prev = now
      const motion = !reducedMotion || running
      if (motion) wallRef.current += dt
      if (!reducedMotion) ambRef.current += dt
      const wall = wallRef.current
      const amb = ambRef.current
      const elapsed = clockRef.current
      const buf = particleBuf.current

      const vb = svg.viewBox.baseVal
      if (!vb || !vb.width || !size.w) return
      const { w, h, dpr } = size
      const s = Math.min(w / vb.width, h / vb.height)
      const ox = (w - vb.width * s) / 2 - vb.x * s
      const oy = (h - vb.height * s) / 2 - vb.y * s

      // Recorded events fire once each, at their real simulation time, as the playback
      // head crosses them. Pause holds the cursor; a replay rewinds and clears.
      if (motion) {
        const pool = effects.current
        if (buf.at < pool.cursor) {
          pool.list.length = 0
          pool.cursor = buf.at
        }
        pool.cursor = spawnEventsBetween(eventIndex, pool.cursor, buf.at, 24, (ev) => {
          const kind = ACTIVITY_EFFECT[ev.activity]
          if (!kind) return undefined
          const card = cards.get(ev.componentId || ev.componentName)
          if (!card) return undefined
          const style = EFFECT_STYLE[kind]
          if (!style) return undefined
          if (pool.list.length >= cfg.effectCap) pool.list.shift()
          pool.list.push({
            kind,
            x: kind === 'entry' ? card.x - 4 : kind === 'out' ? card.right + 4 : card.cx,
            y: card.cy,
            rgb: style.rgb,
            born: wall,
            dur: style.dur * (cfg.effectCap <= 64 ? 0.7 : 1),
            spin: jitter01(ev.caseId ?? ev.timestamp) * 6.28,
          })
          return undefined
        })
      } else {
        effects.current.list.length = 0
      }

      // Live load from the frame buffer: what is inside each component (waiting and
      // processing separately) and what is currently crossing each connection.
      const waitByNode = new Map()
      const liveByNode = new Map()
      const liveByEdge = new Map()
      for (let i = 0; i < buf.count; i += 1) {
        const item = buf.items[i]
        if (!item || !item.where) continue
        const where = item.where
        if (where.kind === 'service') {
          const bucket = where.phase === 'waiting' ? waitByNode : liveByNode
          bucket.set(where.nodeId, (bucket.get(where.nodeId) || 0) + 1)
        } else {
          const key = `${where.fromId}->${where.toId}`
          liveByEdge.set(key, (liveByEdge.get(key) || 0) + 1)
        }
      }
      const states = new Map()
      for (const n of nodes) states.set(n.id, componentState(components?.[n.id]))

      /* ---------------- background layer: streams + living nodes ---------------- */
      bg.setTransform(dpr, 0, 0, dpr, 0, 0)
      bg.clearRect(0, 0, w, h)
      bg.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy)

      for (const g of edgeGeoms) {
        const live = liveByEdge.get(g.key) || 0
        let congestion = Math.min(1, ((waitByNode.get(g.fromId) || 0) + (waitByNode.get(g.toId) || 0)) / 8)
        if (states.get(g.fromId)?.key === 'over') congestion += 0.45
        if (states.get(g.toId)?.key === 'over') congestion += 0.45
        const rgb = edgeTint(g.entry, congestion)
        // Brightness: static measured traffic and live concurrency, whichever is stronger.
        const activity = Math.max(g.load * 0.4, live / (live + 2.5))
        strokePath(bg, g.pts, 7, rgba(rgb, 1), 0.05 + 0.12 * activity)
        strokePath(bg, g.pts, 2.1, rgba(rgb, 1), 0.16 + 0.55 * activity)
        // Moving light pulses travel in simulation time, so playback speed moves them and
        // pause freezes them. Density scales with the connection's real traffic.
        if (activity > 0.05) {
          const n = Math.max(1, Math.round(cfg.pulses * (0.5 + 0.5 * activity)))
          const rate = 0.0007 + 0.003 * g.load + 0.0004 * Math.min(live, 8)
          const base = elapsed * rate
          for (let i = 0; i < n; i += 1) {
            const frac = (base + i / n + g.hash) % 1
            drawPulse(bg, rgb, g.pts, frac, 0.32 + 0.45 * activity, cfg.glowSize, 4.5)
          }
        }
      }

      // Component halos: colour from the derived state, breathing from wall time (frozen
      // under reduced motion), intensity from measured utilisation plus live work.
      const warn = 0.5 + 0.5 * Math.sin(amb / 320)
      for (const n of nodes) {
        const card = cards.get(n.id)
        if (!card) continue
        const state = states.get(n.id)
        const live = liveByNode.get(n.id) || 0
        const waiting = waitByNode.get(n.id) || 0
        const phase = 0.5 + 0.5 * Math.sin(amb / (820 + jitter01(n.id) * 520) + jitter01(n.id) * 6.3)
        let rgb
        let alpha
        if (state.key === 'idle') {
          rgb = RGB.blue
          alpha = 0.05
        } else if (state.key === 'healthy') {
          rgb = mixRgb(RGB.cyan, RGB.green, 0.55)
          alpha = 0.09 + 0.05 * phase
        } else if (state.key === 'press') {
          rgb = RGB.amber
          alpha = 0.14 + 0.07 * phase
        } else {
          rgb = RGB.red
          alpha = 0.2 + 0.18 * warn
        }
        alpha *= 0.72 + 0.38 * Math.min(1, (live + waiting) / 5)
        drawNodeHalo(bg, card, rgb, {
          alpha,
          layers: cfg.haloLayers,
          grow: Math.min(3.5, waiting * 0.7),
          pulse: state.key === 'over' ? warn * 0.6 : 0,
        })
        // Overload: one expanding ring so the state reads from across the room.
        if (state.key === 'over' && !reducedMotion) {
          const k = (amb % 1500) / 1500
          const pad = 6 + k * 9
          roundRectPath(bg, card.x - pad, card.y - pad, card.w + pad * 2, card.h + pad * 2, 15)
          bg.globalAlpha = (1 - k) * 0.45
          bg.strokeStyle = rgba(RGB.red, 1)
          bg.lineWidth = 1.6
          bg.stroke()
          bg.globalAlpha = 1
        }
      }

      // Selected-component spotlight: a soft wash behind the chosen card.
      if (selectedId) {
        const card = cards.get(selectedId)
        if (card) {
          drawGlow(bg, RGB.blue, card.cx, card.cy, 210, 0.13, 64)
          drawGlow(bg, RGB.cyan, card.cx, card.cy, 120, 0.09, 48)
        }
      }

      /* ---------------- foreground layer: effects + particles ---------------- */
      fg.setTransform(dpr, 0, 0, dpr, 0, 0)
      fg.clearRect(0, 0, w, h)
      fg.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy)

      const rich = cfg.effectCap > 64
      const list = effects.current.list
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const fx = list[i]
        const p = (wall - fx.born) / fx.dur
        if (p >= 1) {
          list[i] = list[list.length - 1]
          list.pop()
          continue
        }
        if (p >= 0) drawEffect(fg, fx, p, rich)
      }

      const fade = buf.fade
      const buckets = cfg.trailBuckets
      const trailPts = []
      for (let i = 0; i < buf.count; i += 1) {
        const item = buf.items[i]
        if (!item || !item.traj || !item.where) continue
        const traj = item.traj
        const where = item.where
        const rgb = OUTCOME_RGB[traj.outcome] || RGB.green
        let x = 0
        let y = 0
        let waiting = false

        if (where.kind === 'service') {
          const card = cards.get(where.nodeId)
          if (!card) continue
          if (where.phase === 'waiting') {
            // Waiting: a stable scatter down the card's left edge — the same request keeps
            // the same spot, so the cluster reads as a queue rather than noise.
            waiting = true
            x = card.x - 9 - jitter01(traj.caseId) * 24
            y = card.y + 12 + jitter01(`${traj.caseId}:q`) * (card.h - 24)
          } else {
            // Processing: parked inside the component with a per-request offset.
            x = card.cx + (jitter01(traj.caseId) - 0.5) * card.w * 0.5
            y = card.cy + (jitter01(`${traj.caseId}:y`) - 0.5) * card.h * 0.55
          }
        } else {
          const from = cards.get(where.fromId)
          const to = cards.get(where.toId)
          if (!from || !to) continue
          const geom = geomByKey.get(`${where.fromId}->${where.toId}`)
          const onCurve = geom ? pointAt(geom.pts, where.progress) : null
          if (onCurve) {
            x = onCurve.x
            y = onCurve.y
          } else {
            x = from.right + (to.left - from.right) * where.progress
            y = from.cy + (to.cy - from.cy) * where.progress
          }
        }

        // Trail: earlier positions of the SAME request at earlier simulation times, read
        // back through locateAt — a motion trail with no invented data behind it.
        if (buckets > 0 && !waiting && fade > 0.02) {
          const points = buckets * 3
          const stepMs = cfg.trailSpanMs / points
          trailPts.length = 0
          for (let k = 0; k <= points; k += 1) {
            const t2 = buf.at - k * stepMs
            const w2 = t2 < traj.start ? null : locateAt(traj, t2)
            if (!w2) break
            let px
            let py
            if (w2.kind === 'service') {
              const c2 = cards.get(w2.nodeId)
              if (!c2) break
              px = c2.cx + (jitter01(traj.caseId) - 0.5) * c2.w * 0.5
              py = c2.cy + (jitter01(`${traj.caseId}:y`) - 0.5) * c2.h * 0.55
            } else {
              const f2 = cards.get(w2.fromId)
              const t3 = cards.get(w2.toId)
              if (!f2 || !t3) break
              const gm = geomByKey.get(`${w2.fromId}->${w2.toId}`)
              const pt2 = gm ? pointAt(gm.pts, w2.progress) : null
              if (pt2) {
                px = pt2.x
                py = pt2.y
              } else {
                px = f2.right + (t3.left - f2.right) * w2.progress
                py = f2.cy + (t3.cy - f2.cy) * w2.progress
              }
            }
            trailPts.push([px, py])
          }
          if (trailPts.length > 1) {
            const last = trailPts.length - 1
            for (let b = 0; b < buckets; b += 1) {
              const to = Math.max(1, Math.round((last * (b + 1)) / buckets))
              strokePath(fg, trailPts, 1.7, rgba(rgb, 1), (0.1 + 0.14 * ((b + 1) / buckets)) * fade, 0, to)
            }
          }
        }

        const jr = jitter01(`${traj.caseId}:r`)
        const radius = 1.5 + jr * 1.2
        if (waiting) {
          // Hollow amber ring: waiting must not look like motion.
          fg.globalAlpha = 0.75 * fade
          fg.strokeStyle = rgba(RGB.amber, 1)
          fg.lineWidth = 1.3
          fg.beginPath()
          fg.arc(x, y, 2.6, 0, TAU)
          fg.stroke()
          fg.globalAlpha = 1
        } else {
          drawGlow(fg, rgb, x, y, radius * 2.7, 0.5 * fade, cfg.glowSize)
          fg.globalAlpha = Math.max(0, Math.min(1, 0.95 * fade))
          fg.fillStyle = rgba(rgb, 1)
          fg.beginPath()
          fg.arc(x, y, radius, 0, TAU)
          fg.fill()
          if (where.kind === 'service' && where.phase === 'processing' && buckets >= 2) {
            // White-hot core while the component is actually working on the request.
            fg.globalAlpha = 0.9 * fade
            fg.fillStyle = 'rgba(255,255,255,0.92)'
            fg.beginPath()
            fg.arc(x, y, radius * 0.45, 0, TAU)
            fg.fill()
          }
          fg.globalAlpha = 1
        }
      }

      // Live queue read beside each component that currently has waiting requests.
      if (waitByNode.size) {
        fg.font = '600 9px "IBM Plex Mono", ui-monospace, monospace'
        fg.textAlign = 'end'
        fg.textBaseline = 'middle'
        const approx = sampleEvery > 1 ? '~' : ''
        for (const [id, count] of waitByNode) {
          const card = cards.get(id)
          if (!card) continue
          fg.globalAlpha = 0.85
          fg.fillStyle = rgba(RGB.amber, 1)
          fg.fillText(`${approx}Q${count}`, card.x - 14, card.y + 4)
        }
        fg.globalAlpha = 1
        fg.textAlign = 'start'
      }

      if (selectedId) {
        const card = cards.get(selectedId)
        if (card) drawGlow(fg, RGB.cyan, card.cx, card.cy, 90, 0.07, 48)
      }

      // Measured frame rate — shown live, and the basis for the quality fallback below.
      const fps = fpsRef.current
      if (!fps.windowStart) fps.windowStart = now
      fps.frames += 1
      const win = now - fps.windowStart
      if (win >= 500) {
        fps.value = (fps.frames * 1000) / win
        fps.frames = 0
        fps.windowStart = now
        const label = `${Math.round(fps.value)} FPS`
        if (fpsChipRef.current) fpsChipRef.current.textContent = label
        fg.setAttribute('data-fps', String(Math.round(fps.value)))
        // Quality fallback: a struggling playback drops one tier rather than dropping
        // frames. It never runs after an explicit choice, and never touches results.
        if (running && !fallbackDoneRef.current && fps.value < 40) {
          const idx = QUALITY_ORDER.indexOf(quality)
          if (idx > 0) {
            fallbackDoneRef.current = true
            setQualityState(QUALITY_ORDER[idx - 1])
          }
        }
      }
    }

    const loop = (now) => {
      raf = 0
      if (!alive) return
      draw(now)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      alive = false
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [
    cfg,
    cards,
    nodes,
    components,
    edgeGeoms,
    geomByKey,
    eventIndex,
    selectedId,
    sampleEvery,
    running,
    reducedMotion,
    quality,
  ])

  return (
    <div className="relative">
      {/* Background canvas: flowing streams and living-node halos, under the diagram. */}
      <canvas
        ref={bgCanvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0"
      />
      <svg
        ref={svgRef}
        width="100%"
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Architecture diagram with live request flow"
        style={{ display: 'block', height, cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none', position: 'relative', zIndex: 1 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <marker
            id="flow-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY={5}
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.inkDim} />
          </marker>
          <filter id="flow-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Connections: a static base line plus an animated dashed overlay. */}
        <g pointerEvents="none">
          {edges.map((e, i) => {
            const from = cards.get(e.source)
            const to = cards.get(e.target)
            if (!from || !to) return null
            const d = edgePath(from, to)
            const entry = traffic.get(`${e.source}->${e.target}`)
            const load = entry ? entry.count / maxCount : 0
            return (
              <g key={e.id || `${e.source}->${e.target}`}>
                <path d={d} fill="none" stroke={colors.line} strokeWidth={1.6} markerEnd="url(#flow-arrow)" />
                <path
                  ref={(el) => {
                    if (el) edgeRefs.current[i] = el
                  }}
                  d={d}
                  fill="none"
                  stroke={entry ? colors.teal : colors.inkFaint}
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  strokeDasharray="2 16"
                  opacity={entry ? 0.25 + load * 0.7 : 0.12}
                  data-load={load}
                  data-dir="1"
                />
              </g>
            )
          })}
        </g>

        {/* Component cards. */}
        {nodes.map((n) => {
          const card = cards.get(n.id)
          const stat = components?.[n.id]
          const state = componentState(stat)
          const util = stat && typeof stat.utilization === 'number' ? Math.min(100, Math.max(0, stat.utilization * 100)) : null
          const Icon = ICONS[n.type] || FALLBACK_ICON
          const selected = selectedId === n.id
          const bottleneck = bottleneckSet.has(n.id)
          const queueNow = stat && (stat.queueLengthMax || 0) > 0 ? stat.queueLengthMax : null
          return (
            <g
              key={n.id}
              data-node="1"
              transform={`translate(${card.x}, ${card.y})`}
              style={{ cursor: onSelectNode ? 'pointer' : 'default' }}
              onClick={onSelectNode ? () => onSelectNode(n.id) : undefined}
              role={onSelectNode ? 'button' : undefined}
              aria-label={onSelectNode ? `${n.name || n.id}, ${n.type}, ${state.label}` : undefined}
              tabIndex={onSelectNode ? 0 : undefined}
              onKeyDown={
                onSelectNode
                  ? (ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault()
                        onSelectNode(n.id)
                      }
                    }
                  : undefined
              }
            >
              {/* Bottleneck outline from the mining report: amber, dashed, outside the card. */}
              {bottleneck && (
                <rect
                  x={-5}
                  y={-5}
                  width={CARD_W + 10}
                  height={CARD_H + 10}
                  rx={13}
                  fill="none"
                  stroke={colors.accent}
                  strokeWidth={1.2}
                  strokeDasharray="5 4"
                  opacity={0.85}
                  pointerEvents="none"
                />
              )}

              <rect
                x={0}
                y={0}
                width={CARD_W}
                height={CARD_H}
                rx={10}
                fill={withAlpha(colors.baseAlt, 0.92)}
                stroke={state.color}
                strokeWidth={selected ? 2 : 1.3}
                filter={state.key === 'over' ? 'url(#flow-glow)' : undefined}
              />

              {/* Overloaded: an outer pulse ring so the state is visible from across the room. */}
              {state.key === 'over' && (
                <rect
                  className="sim-overload-ring"
                  x={-3}
                  y={-3}
                  width={CARD_W + 6}
                  height={CARD_H + 6}
                  rx={12}
                  fill="none"
                  stroke={colors.red}
                  strokeWidth={1.6}
                  pointerEvents="none"
                />
              )}

              <CornerTicks w={CARD_W} h={CARD_H} color={selected ? colors.accent : state.color} />

              <g transform="translate(12, 11)" style={{ color: state.color }}>
                <Icon width={20} height={20} strokeWidth={1.7} />
              </g>

              {/* State chip: text as well as colour. */}
              <g transform={`translate(${CARD_W - 10}, 10)`}>
                <rect
                  x={-state.label.length * 5.6 - 10}
                  y={0}
                  width={state.label.length * 5.6 + 10}
                  height={15}
                  rx={7.5}
                  fill={withAlpha(state.color, 0.14)}
                  stroke={withAlpha(state.color, 0.5)}
                  strokeWidth={1}
                />
                <text
                  x={-state.label.length * 2.8 - 5}
                  y={10.5}
                  textAnchor="middle"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 8.5,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    fill: state.color,
                  }}
                >
                  {state.label}
                </text>
              </g>

              <text
                x={12}
                y={CARD_H - 26}
                style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600, fill: colors.ink }}
              >
                {(n.name || n.id).length > 16 ? `${(n.name || n.id).slice(0, 15)}…` : n.name || n.id}
              </text>
              <text
                x={12}
                y={CARD_H - 13}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 8.5,
                  fontWeight: 600,
                  letterSpacing: '0.07em',
                  fill: colors.inkFaint,
                  textTransform: 'uppercase',
                }}
              >
                {String(n.type || '').replace(/([A-Z])/g, ' $1').trim().toUpperCase()}
              </text>

              {/* Utilisation bar along the bottom of the card. */}
              <rect x={12} y={CARD_H - 8} width={CARD_W - 24} height={4} rx={2} fill={colors.overlay} />
              {util != null && (
                <rect
                  x={12}
                  y={CARD_H - 8}
                  width={Math.max(2, ((CARD_W - 24) * util) / 100)}
                  height={4}
                  rx={2}
                  fill={state.color}
                />
              )}

              {/* Peak queue depth, only when the engine actually measured one. */}
              {queueNow != null && (
                <g transform={`translate(${CARD_W - 12}, ${CARD_H - 22})`}>
                  <text
                    x={0}
                    y={0}
                    textAnchor="end"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, fill: colors.blue }}
                  >
                    Q↑{queueNow}
                  </text>
                </g>
              )}

              {/* Load percentage, top-right area under the state chip. */}
              {util != null && (
                <text
                  x={CARD_W - 12}
                  y={40}
                  textAnchor="end"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, fill: state.color }}
                >
                  {util.toFixed(0)}%
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {/* Foreground canvas: particle trails, cores and recorded-event effects, over the
          diagram so a request is visible while it sits inside a component. */}
      <canvas
        ref={fgCanvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[2]"
      />

      {/* Visual quality: rendering cost only, never a simulation outcome. */}
      <div className="absolute left-2.5 top-2.5 z-[3] flex items-center gap-1 rounded-[7px] border border-line bg-overlay/90 p-1">
        <span className="px-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-faint">FX</span>
        <div role="group" aria-label="Visual quality" className="flex items-center gap-1">
          {QUALITY_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => chooseQuality(key)}
              aria-pressed={quality === key}
              className={`rounded-[4px] px-1.5 py-0.5 font-mono text-[10px] transition ${
                quality === key ? 'bg-teal/15 text-teal' : 'text-ink-dim hover:bg-raised hover:text-ink'
              }`}
            >
              {QUALITY[key].label}
            </button>
          ))}
        </div>
        <span
          ref={fpsChipRef}
          className="border-l border-line px-1.5 font-mono text-[10px] text-ink-faint"
        >
          —
        </span>
      </div>

      {/* Zoom and fit controls. A pure view transform over the same graph. */}
      <div className="absolute right-2.5 top-2.5 z-[3] flex items-center gap-1 rounded-[7px] border border-line bg-overlay/90 p-1">
        <button
          type="button"
          onClick={() => zoomBy(1.25)}
          aria-label="Zoom in"
          className="rounded-[4px] p-1 text-ink-dim transition hover:bg-raised hover:text-ink"
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          onClick={() => zoomBy(0.8)}
          aria-label="Zoom out"
          className="rounded-[4px] p-1 text-ink-dim transition hover:bg-raised hover:text-ink"
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          onClick={fitView}
          aria-label="Fit to screen"
          className="rounded-[4px] p-1 text-ink-dim transition hover:bg-raised hover:text-ink"
        >
          <Maximize2 size={13} />
        </button>
        <span className="px-1 font-mono text-[10px] text-ink-faint">{zoom.toFixed(1)}×</span>
      </div>

      {/* Sampling disclosure: the picture is a real sample of the recorded run, and says so. */}
      {trajectories.length > 0 && (
        <div className="relative z-[3] mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-faint">
          <span>
            visual sample: {sampled.length.toLocaleString()} of{' '}
            {trajectories.length.toLocaleString()} recorded trajectories
            {sampled.length < trajectories.length ? ' — even stride across the whole run' : ''}
          </span>
          <span>event effects replay from the recorded event log</span>
        </div>
      )}
    </div>
  )
}

export function FlowLegend({ readoutRef }) {
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-ink-faint">
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: colors.green }} />
        in flight, will complete
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: colors.purple }} />
        retried
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: colors.red }} />
        will fail
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: colors.accent }} />
        will be dropped
      </span>
      <span ref={readoutRef} className="font-mono">
        waiting for the replay…
      </span>
    </div>
  )
}
