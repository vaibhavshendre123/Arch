// Dark values double as the fallback for non-browser consumers (Node tests, SSR): the
// browser reads the live values from the CSS custom properties in index.css instead.
const darkTokens = {
  base: '#0A0E14',
  baseAlt: '#0D1219',
  surface: '#10161F',
  raised: '#151C27',
  overlay: '#1A222E',
  line: '#212B38',
  lineSoft: '#182028',
  ink: '#E7EDF4',
  inkDim: '#8996A6',
  inkFaint: '#5B6675',
  accent: '#FFB454',
  teal: '#52E5C7',
  purple: '#C792EA',
  blue: '#7DA6FF',
  red: '#FF6B6B',
  green: '#7EE787',
}

const cssVars = {
  base: '--color-base',
  baseAlt: '--color-base-alt',
  surface: '--color-surface',
  raised: '--color-raised',
  overlay: '--color-overlay',
  line: '--color-line',
  lineSoft: '--color-line-soft',
  ink: '--color-ink',
  inkDim: '--color-ink-dim',
  inkFaint: '--color-ink-faint',
  accent: '--color-accent',
  teal: '--color-teal',
  purple: '--color-purple',
  blue: '--color-blue',
  red: '--color-red',
  green: '--color-green',
}

let tokenCache = null
let tokenTheme = null

function readTokens() {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return darkTokens
  const theme = document.documentElement.dataset.theme || 'dark'
  if (tokenCache && tokenTheme === theme) return tokenCache
  const style = getComputedStyle(document.documentElement)
  const next = {}
  for (const [key, cssVar] of Object.entries(cssVars)) {
    next[key] = style.getPropertyValue(cssVar).trim() || darkTokens[key]
  }
  tokenCache = next
  tokenTheme = theme
  return next
}

// Charts, canvases and inline styles read `colors.*` at render time. A proxy keeps every
// consumer theme-aware without requiring each one to know a theme switch happened.
export const colors = new Proxy({}, {
  get(_target, key) {
    if (typeof key !== 'string') return undefined
    return readTokens()[key]
  },
})

export const fonts = {
  sans: "'IBM Plex Sans', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
}

export const gridSizes = { shell: 28, canvas: 22 }

// Getters rather than captured values: these objects are imported once, long before the
// user flips the theme, so plain properties would freeze the dark palette forever.
export const categoryColor = {
  get client() { return colors.teal },
  get application() { return colors.accent },
  get data() { return colors.purple },
  get infrastructure() { return colors.blue },
  get security() { return colors.red },
}

export function withAlpha(hex, alpha) {
  const c = hex.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  if ([r, g, b].some(Number.isNaN)) return hex
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function scoreColor(score) {
  if (score >= 75) return colors.green
  if (score >= 55) return colors.accent
  return colors.red
}

export function severityColor(severity) {
  if (severity === 'high') return colors.red
  if (severity === 'med') return colors.accent
  return colors.blue
}

export function utilizationColor(utilization) {
  if (utilization > 85) return colors.red
  if (utilization > 65) return colors.accent
  return colors.green
}

/**
 * Colour for a completed-request ratio.
 *
 * The Simulation page previously hard-coded green for Success Rate, so a run that dropped
 * 60% of its requests was displayed in the same colour as a flawless one. Thresholds mirror
 * the ones used in `utilizationColor`: anything under 95% is a problem, and the amber band
 * exists so a run that is merely untidy is distinguishable from one that is failing.
 */
export function successRateColor(rate) {
  if (rate >= 99.5) return colors.green
  if (rate >= 95) return colors.accent
  return colors.red
}

export const dimensionMeta = {
  performance: { label: 'Performance', weight: 0.25 },
  scalability: { label: 'Scalability', weight: 0.2 },
  reliability: { label: 'Reliability', weight: 0.15 },
  security: { label: 'Security', weight: 0.15 },
  maintainability: { label: 'Maintainability', weight: 0.15 },
  processEfficiency: { label: 'Process Efficiency', weight: 0.1 },
}

export const dimensionOrder = [
  'performance',
  'scalability',
  'reliability',
  'security',
  'maintainability',
  'processEfficiency',
]

export const chartAxis = {
  get tick() { return { fill: colors.inkFaint, fontSize: 10, fontFamily: fonts.mono } },
  get axisLine() { return { stroke: colors.line } },
  get grid() { return { stroke: colors.lineSoft } },
}

export const tierOrder = ['client', 'security', 'application', 'infrastructure', 'data']

export const tierY = {
  client: 0,
  security: 2.2,
  application: 4.4,
  infrastructure: 6.6,
  data: 8.8,
}
