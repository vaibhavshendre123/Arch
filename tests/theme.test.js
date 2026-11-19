import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const css = read('src/index.css')
const html = read('index.html')

function rule(selector) {
  const start = css.indexOf(selector)
  assert.ok(start > -1, `${selector} must exist in index.css`)
  return css.slice(start, css.indexOf('}', start) + 1)
}

function printBlock() {
  const start = css.indexOf('@media print')
  assert.ok(start > -1, 'a print stylesheet must exist')
  return css.slice(start, css.indexOf('@media (prefers-reduced-motion', start))
}

describe('the page background is opaque everywhere', () => {
  it('pins the dark background on html, not only on body', () => {
    // A background on body only reaches the canvas while body is the root box. Pinning it
    // on html too means a short or overflowing container can never scroll the browser's
    // default white into view.
    assert.match(rule('html {'), /background-color:\s*var\(--color-base\)/)
    assert.match(rule('body {'), /background-color:\s*var\(--color-base\)/)
  })

  it('the blueprint grids declare their own background colour', () => {
    // These set background-image only, which left the near-black grid lines sitting on
    // whatever happened to be behind them.
    for (const selector of ['.blueprint-shell {', '.blueprint-canvas {']) {
      assert.match(rule(selector), /background-color:\s*var\(--color-base\)/, `${selector} needs an opaque background`)
      assert.match(rule(selector), /background-image:/)
    }
  })
})

describe('the print stylesheet keeps the app theme', () => {
  it('does not switch the page to a white background', () => {
    const block = printBlock()
    assert.doesNotMatch(
      block,
      /background:\s*#fff/,
      'printing produced a white page with dark cards and a near-black grid on the paper',
    )
    assert.match(block, /background-color:\s*var\(--color-base\)\s*!important/)
  })

  it('asks the browser not to strip backgrounds', () => {
    const block = printBlock()
    assert.match(block, /-webkit-print-color-adjust:\s*exact/)
    assert.match(block, /print-color-adjust:\s*exact/)
  })

  it('keeps panel text readable against the panel background', () => {
    const block = printBlock()
    // The old rule forced #111 text everywhere inside .print-doc while the panels stayed
    // dark, so printed text was black on near-black.
    assert.doesNotMatch(block, /color:\s*#111/)
    assert.match(block, /\.print-doc \* \{[^}]*color:\s*var\(--color-ink\)\s*!important/)
  })
})

describe('the theme is defined once', () => {
  it('keeps the dark palette in @theme', () => {
    const theme = css.slice(css.indexOf('@theme'), css.indexOf('@layer base'))
    for (const token of ['base', 'surface', 'raised', 'line', 'ink', 'accent']) {
      assert.match(theme, new RegExp(`--color-${token}:`), `--color-${token} must be declared`)
    }
    assert.doesNotMatch(theme, /--color-base:\s*#fff/i, 'the base token must stay dark')
  })
})

describe('the light theme', () => {
  it('overrides the same palette tokens on the root element', () => {
    const start = css.indexOf("html[data-theme='light']")
    assert.ok(start > -1, 'a light-theme block must exist in index.css')
    const light = css.slice(start, css.indexOf('}', start) + 1)
    for (const token of ['base', 'base-alt', 'surface', 'raised', 'line', 'ink', 'accent', 'on-accent']) {
      assert.match(light, new RegExp(`--color-${token}:`), `--color-${token} must be redefined for light`)
    }
  })

  it('keeps text on accent fills readable in both themes', () => {
    const theme = css.slice(css.indexOf('@theme'), css.indexOf('@layer base'))
    assert.match(theme, /--color-on-accent:/)
    assert.doesNotMatch(css, /text-\[#1a1206\]/, 'buttons must use the theme-aware on-accent token')
  })

  it('applies the saved theme before the first paint', () => {
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'))
    assert.match(head, /archai\.theme/, 'the boot script must read the same key as ThemeProvider')
    assert.match(head, /document\.documentElement\.dataset\.theme\s*=/)
  })

  it('exposes a real light option in settings', () => {
    const settings = read('src/pages/Settings.jsx')
    assert.doesNotMatch(settings, /coming soon/)
    assert.match(settings, /label: 'Light'/)
    assert.match(settings, /onClick=\{\(\) => setTheme\(value\)\}/)
  })
})
