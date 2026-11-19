/**
 * Exports for the Evaluation & Score module.
 *
 * CSV is a flat summary of the overall score, category scores, methodology and
 * provenance. PDF is produced through the browser print dialog from a
 * self-contained HTML document, so no server or binary PDF dependency is
 * required and the output reflects exactly the report shown on screen.
 */

function csvCell(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function esc(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmt(value, unit = '') {
  if (value === null || value === undefined || value === '') return '—'
  return `${value}${unit}`
}

function gradeText(grade) {
  if (!grade) return 'Not Evaluated'
  return `${grade.letter} · ${grade.label}`
}

function findingLines(findings) {
  const buckets = [
    ['Critical', findings?.critical],
    ['High', findings?.high],
    ['Medium', findings?.medium],
    ['Low', findings?.low],
  ]
  const lines = []
  for (const [label, items] of buckets) {
    for (const item of items || []) lines.push(`[${label}] ${item.category}: ${item.text}`)
  }
  return lines
}

/**
 * Flattened CSV: one row per category plus a summary row, so a spreadsheet can
 * filter by category, evidence type and status.
 */
export function evaluationToCsv(evaluation, meta = {}) {
  const report = evaluation?.report
  const provenance = report?.provenance || {}
  const rows = []
  const header = [
    'Section',
    'Category',
    'Evidence',
    'Status',
    'Score',
    'Grade',
    'Weight',
    'Normalized Weight',
    'Measured Values',
    'Issues',
    'Positives',
    'Improvements',
  ]
  rows.push(header)

  rows.push([
    'Overall',
    'Overall Architecture Score',
    'static+simulation+mining',
    report?.status || 'unknown',
    report?.overallScore ?? '',
    gradeText(report?.grade),
    '',
    '',
    `Legacy health score: ${evaluation?.healthScore ?? '—'}`,
    findingLines(report?.findings).join(' | '),
    (report?.findings?.positive || []).map((p) => p.text).join(' | '),
    '',
  ])

  for (const category of report?.categories || []) {
    rows.push([
      'Category',
      category.label,
      (category.evidence || []).join('+'),
      category.status,
      category.score ?? '',
      gradeText(category.grade),
      category.weight ?? '',
      category.normalizedWeight ?? '',
      (category.measured || []).map((m) => `${m.label}: ${fmt(m.value, m.unit)} (expected ${m.expected})`).join(' | '),
      (category.issues || []).map((i) => `[${i.severity}] ${i.text}`).join(' | '),
      (category.positives || []).join(' | '),
      (category.improvements || []).join(' | '),
    ])
  }

  const methodology = report?.methodology
  if (methodology) {
    rows.push(['Methodology', 'Weights', '', '', '', '', '', '', JSON.stringify(methodology.weights || {}), '', '', ''])
    rows.push(['Methodology', 'Normalized weights', '', '', '', '', '', '', JSON.stringify(methodology.normalizedWeights || {}), '', '', ''])
    rows.push(['Methodology', 'Grade bands', '', '', '', '', '', '', (methodology.gradeBands || []).map((b) => `${b.letter}>=${b.min}`).join(' | '), '', '', ''])
    rows.push(['Methodology', 'Normalization', '', '', '', '', '', '', methodology.normalization || '', '', '', ''])
    rows.push(['Methodology', 'Double counting', '', '', '', '', '', '', methodology.doubleCounting || '', '', '', ''])
    rows.push(['Methodology', 'Thresholds', '', '', '', '', '', '', JSON.stringify(methodology.thresholds || {}), '', '', ''])
  }

  rows.push([
    'Provenance',
    'Architecture version',
    '',
    '',
    '',
    '',
    '',
    '',
    provenance.architectureVersion || '—',
    '',
    '',
    '',
  ])
  rows.push(['Provenance', 'Simulation run', '', '', '', '', '', '', provenance.runId || '—', '', '', ''])
  rows.push([
    'Provenance',
    'Run parameters',
    '',
    '',
    '',
    '',
    '',
    '',
    `seed ${provenance.seed ?? '—'} · arrival ${provenance.arrivalRate ?? '—'}/s · duration ${provenance.duration ?? '—'}s${provenance.truncated ? ' · truncated' : ''}`,
    '',
    '',
    '',
  ])
  rows.push(['Provenance', 'Evaluation timestamp', '', '', '', '', '', '', provenance.evaluatedAt ? new Date(provenance.evaluatedAt).toISOString() : meta.evaluatedAt || '—', '', '', ''])

  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
}

export function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function categorySection(category) {
  const measured = (category.measured || [])
    .map(
      (m) =>
        `<tr><td>${esc(m.label)}</td><td>${esc(fmt(m.value, m.unit))}</td><td>${esc(m.expected)}</td><td>${
          m.met === true ? 'Met' : m.met === false ? 'Not met' : '—'
        }</td></tr>`,
    )
    .join('')
  const issues = (category.issues || [])
    .map((i) => `<li><strong>${esc(i.severity)}</strong> — ${esc(i.text)}</li>`)
    .join('')
  const positives = (category.positives || []).map((p) => `<li>${esc(p)}</li>`).join('')
  const deductions = (category.deductions || []).map((d) => `<li>${esc(d)}</li>`).join('')
  const improvements = (category.improvements || []).map((i) => `<li>${esc(i)}</li>`).join('')
  return `
    <section class="category">
      <h2>${esc(category.label)} <span class="badge ${category.status === 'evaluated' ? 'ok' : 'na'}">${
        category.status === 'evaluated' ? `${esc(category.score)}/100` : 'Not Evaluated'
      }</span></h2>
      <p class="meta">Evidence: ${esc((category.evidence || []).join(', ') || '—')} · Weight: ${esc(
        Math.round((category.weight || 0) * 100),
      )}% · Normalized: ${esc(Math.round((category.normalizedWeight || 0) * 100))}% · Grade: ${esc(
        gradeText(category.grade),
      )}</p>
      ${category.reason ? `<p class="reason">${esc(category.reason)}</p>` : ''}
      <h3>Evaluation criteria</h3>
      <ul>${(category.criteria || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <h3>Measured values</h3>
      <table><thead><tr><th>Metric</th><th>Value</th><th>Expected</th><th>Status</th></tr></thead><tbody>${measured}</tbody></table>
      ${issues ? `<h3>Identified issues</h3><ul>${issues}</ul>` : ''}
      ${positives ? `<h3>Positive findings</h3><ul>${positives}</ul>` : ''}
      ${deductions ? `<h3>Score deductions</h3><ul>${deductions}</ul>` : ''}
      ${improvements ? `<h3>Improvement recommendations</h3><ul>${improvements}</ul>` : ''}
      <p class="note">${esc(category.note)}</p>
    </section>`
}

function findingsSection(findings) {
  const buckets = [
    ['Critical Issues', findings?.critical],
    ['High-Priority Issues', findings?.high],
    ['Medium-Priority Issues', findings?.medium],
    ['Low-Priority Issues', findings?.low],
    ['Positive Findings', findings?.positive],
  ]
  return buckets
    .map(([label, items]) => {
      if (!items?.length) return ''
      return `<section class="findings"><h2>${esc(label)}</h2><ul>${items
        .map((i) => `<li><strong>${esc(i.category)}</strong> — ${esc(i.text)}</li>`)
        .join('')}</ul></section>`
    })
    .join('')
}

export function evaluationReportHtml(evaluation, meta = {}) {
  const report = evaluation?.report
  const provenance = report?.provenance || {}
  const methodology = report?.methodology || {}
  const categories = report?.categories || []
  const weights = Object.entries(methodology.weights || {})
    .map(([key, value]) => {
      const cat = categories.find((c) => c.key === key)
      return `<tr><td>${esc(cat?.label || key)}</td><td>${esc(Math.round(value * 100))}%</td><td>${esc(
        Math.round((methodology.normalizedWeights?.[key] || 0) * 100),
      )}%</td><td>${cat?.status === 'evaluated' ? `${esc(cat.score)}/100` : 'Not Evaluated'}</td></tr>`
    })
    .join('')
  const notEvaluated = (methodology.notEvaluated || [])
    .map((n) => `<li><strong>${esc(n.category)}</strong> — ${esc(n.reason)}</li>`)
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Evaluation report — ${esc(meta.projectName || 'Architecture')}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #0f172a; margin: 32px; font-size: 12px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 22px 0 6px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  h3 { font-size: 12px; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: .04em; color: #475569; }
  p { margin: 4px 0; line-height: 1.5; }
  .meta { color: #64748b; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #e2e8f0; color: #0f172a; vertical-align: middle; }
  .badge.ok { background: #dcfce7; color: #166534; }
  .badge.na { background: #f1f5f9; color: #64748b; }
  .score { font-size: 40px; font-weight: 700; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0; }
  th, td { text-align: left; border-bottom: 1px solid #e2e8f0; padding: 4px 6px; vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; }
  ul { margin: 4px 0 8px 18px; padding: 0; }
  li { margin: 2px 0; line-height: 1.45; }
  section.category { page-break-inside: avoid; margin-top: 10px; }
  .reason { color: #b45309; }
  .note { color: #475569; font-style: italic; }
  .provenance { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; }
  @media print { body { margin: 14mm; } section.category { page-break-inside: avoid; } }
</style>
</head>
<body>
  <h1>Architecture Evaluation Report</h1>
  <p class="meta">${esc(meta.projectName || 'Architecture')} · evaluated ${esc(
    provenance.evaluatedAt ? new Date(provenance.evaluatedAt).toLocaleString() : new Date().toLocaleString(),
  )}</p>

  <h2>Overall</h2>
  <p class="score">${report?.overallScore == null ? 'Not Evaluated' : `${esc(report.overallScore)} / 100`}</p>
  <p>Grade: <strong>${esc(gradeText(report?.grade))}</strong> · Status: ${esc(report?.status || 'unknown')} · Evaluated categories: ${esc(
    report?.evaluatedCategories ?? 0,
  )} of ${esc(report?.totalCategories ?? 0)}</p>
  <p class="meta">Legacy six-dimension health score: ${esc(evaluation?.healthScore ?? '—')}</p>

  <h2>Provenance</h2>
  <div class="provenance">
    <p><strong>Architecture version:</strong> ${esc(provenance.architectureVersion || '—')}</p>
    <p><strong>Simulation run:</strong> ${esc(provenance.runId || '—')}</p>
    <p><strong>Run parameters:</strong> seed ${esc(provenance.seed ?? '—')} · arrival ${esc(
      provenance.arrivalRate ?? '—',
    )}/s · duration ${esc(provenance.duration ?? '—')}s${provenance.truncated ? ' · truncated' : ''}</p>
    <p><strong>Total requests:</strong> ${esc(provenance.totalRequests ?? '—')} · <strong>Sampled cases:</strong> ${esc(
      provenance.sampledCases ?? '—',
    )}</p>
    <p><strong>Evaluation timestamp:</strong> ${esc(
      provenance.evaluatedAt ? new Date(provenance.evaluatedAt).toISOString() : new Date().toISOString(),
    )}</p>
  </div>

  <h2>Category scores and weights</h2>
  <table>
    <thead><tr><th>Category</th><th>Base weight</th><th>Normalized</th><th>Score</th></tr></thead>
    <tbody>${weights}</tbody>
  </table>

  <h2>Methodology</h2>
  <p>${esc(methodology.description)}</p>
  <p><strong>Normalization:</strong> ${esc(methodology.normalization)}</p>
  <p><strong>Double counting:</strong> ${esc(methodology.doubleCounting)}</p>
  <p><strong>Grade bands:</strong> ${esc((methodology.gradeBands || []).map((b) => `${b.letter} ≥ ${b.min}`).join(' · '))}</p>
  ${notEvaluated ? `<h3>Not evaluated</h3><ul>${notEvaluated}</ul>` : ''}

  <h2>Findings</h2>
  ${findingsSection(report?.findings)}

  <h2>Category analysis</h2>
  ${categories.map(categorySection).join('')}
</body>
</html>`
}

/**
 * Opens a print window containing the report. The user chooses "Save as PDF" in
 * the browser's print dialog; this avoids a binary PDF dependency while keeping
 * the output faithful to the on-screen report.
 */
export function printEvaluationReport(evaluation, meta = {}) {
  if (typeof window === 'undefined') return false
  const html = evaluationReportHtml(evaluation, meta)
  const win = window.open('', '_blank', 'width=900,height=1200')
  if (!win) return false
  win.document.open()
  win.document.write(html)
  win.document.close()
  win.focus()
  // Give the document a tick to lay out before opening the print dialog.
  win.setTimeout(() => {
    win.print()
  }, 200)
  return true
}

export function downloadEvaluationCsv(evaluation, meta = {}) {
  const project = (meta.projectName || 'architecture').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  downloadCsv(`evaluation-${project}-${stamp}.csv`, evaluationToCsv(evaluation, meta))
}
