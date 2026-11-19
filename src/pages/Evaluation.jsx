import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  Award,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Gauge as GaugeIcon,
  GitBranch,
  History,
  Info,
  Printer,
  ShieldCheck,
  Trash2,
  Workflow,
  X,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  Cell,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useApp } from '../store/AppContext.jsx'
import { useResults } from '../store/useResults.js'
import { useCountUp } from '../lib/useCountUp.js'
import { gradeFor } from '../lib/evaluation.js'
import {
  clearEvaluationHistory,
  compareEvaluations,
  loadEvaluationHistory,
  recordEvaluation,
  removeEvaluationEntry,
} from '../lib/evaluationHistory.js'
import { downloadEvaluationCsv, printEvaluationReport } from '../lib/evaluationExport.js'
import { colors, dimensionMeta, dimensionOrder, scoreColor } from '../theme/tokens.js'
import {
  Badge,
  Card,
  Empty,
  Gauge,
  PageHead,
  Spinner,
  UtilBar,
  inputClass,
} from '../components/ui.jsx'
import { HealthRadar } from '../components/charts.jsx'

const linkBtn =
  'inline-flex items-center gap-2 rounded-[7px] border border-accent bg-accent px-3.5 py-2 text-[13px] font-semibold text-on-accent transition hover:brightness-110'

const PAGE_DESC =
  'Six weighted dimensions are scored from objective simulation and mining evidence, then combined into a single health score. The table below is the full derivation, not a summary.'

function toPct(value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return 0
  return v <= 1 ? v * 100 : v
}

function grade(score) {
  if (score >= 75) return { label: 'Healthy', tone: 'green' }
  if (score >= 55) return { label: 'Acceptable', tone: 'amber' }
  return { label: 'Needs work', tone: 'red' }
}

const mono = 'font-mono text-[11px] text-ink-faint'
const EV_LABEL = { critical: 'Critical Issues', high: 'High-Priority Issues', medium: 'Medium-Priority Issues', low: 'Low-Priority Issues' }
const EV_TONE = { critical: 'red', high: 'red', medium: 'amber', low: 'blue' }

function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload || {}
  return (
    <div className="rounded-[7px] border border-line bg-overlay px-2.5 py-1.5 font-mono text-[11px] shadow-xl">
      <div className="text-ink">{row.name}</div>
      <div style={{ color: row.status === 'evaluated' ? scoreColor(row.score) : colors.inkFaint }}>
        {row.status === 'evaluated' ? `${row.score}/100` : 'Not Evaluated'}
      </div>
    </div>
  )
}

function CategoryCharts({ categories }) {
  const evaluated = categories.filter((c) => c.status === 'evaluated' && Number.isFinite(c.score))
  const radarData = evaluated.map((c) => ({ name: c.label, score: c.score, fullMark: 100 }))
  const barData = categories.map((c) => ({
    name: c.label,
    score: c.status === 'evaluated' ? c.score : null,
    status: c.status,
  }))
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div>
        <div className="mb-2 font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">
          Quality radar · {evaluated.length} evaluated dimensions
        </div>
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radarData} outerRadius="68%">
              <PolarGrid stroke={colors.lineSoft} />
              <PolarAngleAxis dataKey="name" tick={{ fill: colors.inkDim, fontSize: 9.5, fontFamily: 'IBM Plex Mono' }} />
              <PolarRadiusAxis domain={[0, 100]} tick={{ fill: colors.inkFaint, fontSize: 9 }} tickCount={5} axisLine={false} />
              <Radar name="Score" dataKey="score" stroke={colors.accent} fill={colors.accent} fillOpacity={0.22} strokeWidth={2} />
              <Tooltip content={<ChartTooltip />} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div>
        <div className="mb-2 font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">Category comparison</div>
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={barData} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 96 }}>
              <XAxis type="number" domain={[0, 100]} tick={{ fill: colors.inkFaint, fontSize: 10 }} axisLine={{ stroke: colors.lineSoft }} />
              <YAxis type="category" dataKey="name" width={92} tick={{ fill: colors.inkDim, fontSize: 9.5, fontFamily: 'IBM Plex Mono' }} axisLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="score" radius={[0, 4, 4, 0]}>
                {barData.map((entry, i) => (
                  <Cell key={i} fill={entry.status === 'evaluated' ? scoreColor(entry.score) : colors.line} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

function FindingList({ items, tone, label }) {
  if (!items?.length) return null
  return (
    <div className="rounded-[8px] border border-line-soft bg-raised px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <Badge tone={tone}>{items.length}</Badge>
        <span className="font-mono text-[11px] tracking-wider text-ink-dim uppercase">{label}</span>
      </div>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="text-[12.5px] leading-relaxed text-ink-dim">
            <span className="text-ink-faint">[{item.category}]</span> {item.text}
          </li>
        ))}
      </ul>
    </div>
  )
}

function CategoryDetail({ category }) {
  const [open, setOpen] = useState(false)
  const notEvaluated = category.status === 'not_evaluated'
  return (
    <div className="rounded-[8px] border border-line bg-raised">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-3 px-3.5 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-ink-faint">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-ink">{category.label}</span>
          <span className="mt-0.5 block font-mono text-[10.5px] text-ink-faint">
            evidence: {(category.evidence || []).join(', ')} · weight {Math.round((category.weight || 0) * 100)}%
            {!notEvaluated ? ` · normalized ${Math.round((category.normalizedWeight || 0) * 100)}%` : ''}
          </span>
        </span>
        {notEvaluated ? (
          <Badge tone="dim">Not Evaluated</Badge>
        ) : (
          <span className="font-mono text-[15px] font-semibold" style={{ color: scoreColor(category.score) }}>
            {category.score}/100
          </span>
        )}
        <Badge tone={category.grade?.tone || 'dim'}>{category.grade?.letter || '—'}</Badge>
      </button>
      {open ? (
        <div className="border-t border-line-soft px-3.5 py-3">
          {notEvaluated ? (
            <div className="mb-3 rounded-[7px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
              {category.reason}
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <div className={mono + ' mb-1.5 uppercase'}>Evaluation criteria</div>
              <ul className="mb-3 space-y-1">
                {(category.criteria || []).map((c, i) => (
                  <li key={i} className="flex gap-2 text-[12px] text-ink-dim">
                    <span className="text-accent">·</span>
                    {c}
                  </li>
                ))}
              </ul>
              <div className={mono + ' mb-1.5 uppercase'}>Measured values</div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[11.5px]">
                  <thead>
                    <tr className="font-mono text-[10px] tracking-wider text-ink-faint uppercase">
                      <th className="px-2 py-1 text-left">Metric</th>
                      <th className="px-2 py-1 text-left">Value</th>
                      <th className="px-2 py-1 text-left">Expected</th>
                      <th className="px-2 py-1 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(category.measured || []).map((m, i) => (
                      <tr key={i} className="border-t border-line-soft">
                        <td className="px-2 py-1.5 text-ink-dim">{m.label}</td>
                        <td className="px-2 py-1.5 font-mono text-ink">
                          {m.value === null || m.value === undefined ? '—' : `${m.value}${m.unit || ''}`}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-ink-faint">{m.expected}</td>
                        <td className="px-2 py-1.5">
                          {m.met === true ? <span className="text-green">Met</span> : m.met === false ? <span className="text-red">Not met</span> : <span className="text-ink-faint">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="space-y-3">
              {category.issues?.length ? (
                <div>
                  <div className={mono + ' mb-1.5 uppercase'}>Detected problems</div>
                  <ul className="space-y-1">
                    {category.issues.map((issue, i) => (
                      <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-ink-dim">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0 text-red" />
                        <span><span className="font-mono text-[10.5px] text-red uppercase">{issue.severity}</span> · {issue.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {category.positives?.length ? (
                <div>
                  <div className={mono + ' mb-1.5 uppercase'}>Positive findings</div>
                  <ul className="space-y-1">
                    {category.positives.map((p, i) => (
                      <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-ink-dim">
                        <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-green" />
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {category.deductions?.length ? (
                <div>
                  <div className={mono + ' mb-1.5 uppercase'}>Score deductions</div>
                  <ul className="space-y-1">
                    {category.deductions.map((d, i) => (
                      <li key={i} className="text-[12px] leading-relaxed text-ink-dim">— {d}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div>
                <div className={mono + ' mb-1.5 uppercase'}>Suggested improvements</div>
                <ul className="space-y-1">
                  {(category.improvements || []).map((imp, i) => (
                    <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-ink-dim">
                      <span className="text-accent">→</span>
                      {imp}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-[7px] border border-line-soft bg-overlay px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-faint">
                {category.note}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function HistoryPanel({ history, fromId, toId, setFromId, setToId, comparison, onClear, onRemove }) {
  const from = history.find((h) => h.id === fromId) || null
  const to = history.find((h) => h.id === toId) || null
  return (
    <div>
      {history.length < 2 ? (
        <div className="mb-3 rounded-[7px] border border-line-soft bg-overlay px-3 py-2 text-[12px] text-ink-faint">
          Records are added automatically after each evaluation. Run a simulation again (or change the architecture) to
          build a second snapshot and enable comparison.
        </div>
      ) : null}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={mono + ' mb-1 block uppercase'}>Baseline (older)</span>
          <select value={fromId ?? ''} onChange={(e) => setFromId(e.target.value)} className={`${inputClass} max-w-full`}>
            {history.map((h) => (
              <option key={h.id} value={h.id}>
                {new Date(h.evaluatedAt).toLocaleString()} · {h.overallScore ?? '—'}/100 · {h.architectureVersion || 'no arch'}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={mono + ' mb-1 block uppercase'}>Current (newer)</span>
          <select value={toId ?? ''} onChange={(e) => setToId(e.target.value)} className={`${inputClass} max-w-full`}>
            {history.map((h) => (
              <option key={h.id} value={h.id}>
                {new Date(h.evaluatedAt).toLocaleString()} · {h.overallScore ?? '—'}/100 · {h.architectureVersion || 'no arch'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {comparison ? (
        <div className="mb-4 rounded-[8px] border border-line bg-raised p-3.5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">Comparison</span>
            {comparison.sameArchitecture ? (
              <Badge tone="green">same architecture version</Badge>
            ) : (
              <Badge tone="red">different architecture versions</Badge>
            )}
            {comparison.sameRun ? <Badge tone="dim">same run</Badge> : <Badge tone="amber">different run</Badge>}
            {comparison.overallDelta != null ? (
              <span className={`font-mono text-[13px] ${comparison.overallDelta >= 0 ? 'text-green' : 'text-red'}`}>
                {comparison.overallDelta >= 0 ? '+' : ''}
                {comparison.overallDelta} overall
              </span>
            ) : null}
          </div>
          {comparison.warning ? (
            <div className="mb-3 rounded-[7px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
              {comparison.warning}
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div>
              <div className={mono + ' mb-1.5 uppercase'}>Category deltas</div>
              <div className="space-y-1">
                {comparison.deltas.map((d) => (
                  <div key={d.key} className="flex items-center justify-between gap-2 text-[12px] text-ink-dim">
                    <span>{d.label}</span>
                    <span className="font-mono text-[11px] text-ink-faint">
                      {d.before ?? '—'} → {d.after ?? '—'}{' '}
                      {d.delta != null ? (
                        <span className={d.delta >= 0 ? 'text-green' : 'text-red'}>
                          {d.delta >= 0 ? '+' : ''}
                          {d.delta}
                        </span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <div>
                <div className={mono + ' mb-1.5 uppercase'}>Newly introduced issues</div>
                {comparison.introduced.length ? (
                  <ul className="space-y-1">
                    {comparison.introduced.map((t, i) => (
                      <li key={i} className="text-[12px] text-red">+ {t}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-[12px] text-ink-faint">None</span>
                )}
              </div>
              <div>
                <div className={mono + ' mb-1.5 uppercase'}>Resolved issues</div>
                {comparison.resolved.length ? (
                  <ul className="space-y-1">
                    {comparison.resolved.map((t, i) => (
                      <li key={i} className="text-[12px] text-green">− {t}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-[12px] text-ink-faint">None</span>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className={mono + ' mb-1.5 uppercase'}>Recorded evaluations</div>
      <div className="space-y-2">
        {history.length ? (
          history.map((h) => (
            <div key={h.id} className="flex flex-wrap items-center gap-3 rounded-[7px] border border-line-soft bg-raised px-3 py-2">
              <span className="font-mono text-[11.5px] text-ink">{new Date(h.evaluatedAt).toLocaleString()}</span>
              <span className="font-mono text-[11.5px] text-accent">{h.overallScore ?? '—'}/100</span>
              <span className={mono}>arch {h.architectureVersion || '—'}</span>
              <span className={mono}>run {h.runId || '—'}</span>
              {h.truncated ? <Badge tone="amber">truncated</Badge> : null}
              <button
                type="button"
                onClick={() => onRemove(h.id)}
                className="ml-auto cursor-pointer rounded-[5px] border border-line-soft p-1 text-ink-faint transition hover:border-red hover:text-red"
                aria-label="Remove this history entry"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        ) : (
          <div className="py-4 text-center text-[12.5px] text-ink-faint">No evaluations recorded yet.</div>
        )}
      </div>
      {history.length ? (
        <button
          type="button"
          onClick={onClear}
          className="mt-3 inline-flex items-center gap-1.5 rounded-[6px] border border-line bg-raised px-3 py-1.5 text-[12px] text-ink-dim transition hover:border-red hover:text-red"
        >
          <X size={12} />
          Clear history
        </button>
      ) : null}
    </div>
  )
}

export default function Evaluation() {
  const { currentProject } = useApp()
  const { evaluation, mining, sim, status, error } = useResults(currentProject?.arch)

  // Sweeps up to the score like the old speedometer needle did. The number is the answer
  // here, so the number itself is what moves. Declared at the top of the component, before
  // the early returns, because a hook called after one would be conditional.
  const scoreRef = useCountUp(evaluation ? Math.round(Number(evaluation.healthScore) || 0) : 0)

  const historyScope = currentProject?.id || currentProject?.name || 'unknown'
  const [history, setHistory] = useState([])
  const [fromId, setFromId] = useState(null)
  const [toId, setToId] = useState(null)

  useEffect(() => {
    const entries = loadEvaluationHistory(historyScope)
    setHistory(entries)
    setFromId((current) => (current && entries.some((e) => e.id === current) ? current : entries[1]?.id || entries[0]?.id || null))
    setToId((current) => (current && entries.some((e) => e.id === current) ? current : entries[0]?.id || null))
  }, [historyScope])

  useEffect(() => {
    if (!evaluation?.report) return
    const entries = recordEvaluation(historyScope, evaluation, {
      projectId: currentProject?.id || null,
      projectName: currentProject?.name || null,
    })
    setHistory(entries)
    setFromId((current) => (current && entries.some((e) => e.id === current) ? current : entries[1]?.id || entries[0]?.id || null))
    setToId((current) => (current && entries.some((e) => e.id === current) ? current : entries[0]?.id || null))
  }, [evaluation, historyScope, currentProject?.id, currentProject?.name])

  const comparison = useMemo(
    () => compareEvaluations(history.find((h) => h.id === fromId), history.find((h) => h.id === toId)),
    [history, fromId, toId],
  )

  if (!currentProject) {
    return (
      <Card>
        <Empty
          icon={<Award size={26} />}
          title="No project is open."
          hint="Evaluation scores an architecture, so open or create a project first."
          action={
            <Link to="/projects" className={linkBtn}>
              Go to My Projects
            </Link>
          }
        />
      </Card>
    )
  }

  if (status === 'error') {
    return (
      <div>
        <PageHead
          eyebrow="Evaluation & Health Score"
          title={`Evaluation — ${currentProject.name}`}
          desc={PAGE_DESC}
        />
        <Card className="border-red">
          <div className="font-mono text-[12px] text-red">Evaluation error</div>
          <div className="mt-1 text-[13px] text-ink">{error || 'Unknown evaluation failure.'}</div>
        </Card>
      </div>
    )
  }

  if (status === 'running' && !evaluation) {
    return (
      <div>
        <PageHead
          eyebrow="Evaluation & Health Score"
          title={`Evaluation — ${currentProject.name}`}
          desc={PAGE_DESC}
        />
        <Card>
          <Spinner label="Scoring the six dimensions…" />
        </Card>
      </div>
    )
  }

  if (!evaluation) {
    return (
      <div>
        <PageHead
          eyebrow="Evaluation & Health Score"
          title={`Evaluation — ${currentProject.name}`}
          desc={PAGE_DESC}
        />
        <Card>
          <Empty
            icon={<Award size={26} />}
            title="No evaluation available yet."
            hint="The health score is derived from simulation metrics and mined traces. Run the simulation first."
            action={
              <Link to="/simulation" className={linkBtn}>
                Go to Simulation
              </Link>
            }
          />
        </Card>
      </div>
    )
  }

  const dims = evaluation.dimensions || {}
  const weights = evaluation.weights || {}
  const notes = evaluation.notes || {}
  const healthScore = Math.round(Number(evaluation.healthScore) || 0)
  const verdict = grade(healthScore)
  const byScoreAsc = [...dimensionOrder].sort((a, b) => (Number(dims[a]) || 0) - (Number(dims[b]) || 0))
  const weakest = byScoreAsc[0]
  const strongest = byScoreAsc[byScoreAsc.length - 1]

  const rows = dimensionOrder.map((key) => {
    const meta = dimensionMeta[key] || { label: key, weight: 0 }
    const weight = Number(weights[key] ?? meta.weight) || 0
    const score = Math.round(Number(dims[key]) || 0)
    return {
      key,
      label: meta.label,
      weight,
      score,
      contribution: score * weight,
      note: notes[key] || 'No note was produced for this dimension.',
    }
  })
  const weightTotal = rows.reduce((sum, r) => sum + r.weight, 0)
  const contributionTotal = rows.reduce((sum, r) => sum + r.contribution, 0)

  const metrics = sim?.metrics || {}
  const bottleneckCount = (mining?.bottlenecks || []).length
  const allDeviations = (mining?.deviations || []).filter((d) => d && d.type !== 'none')
  const traceDeviationCount = allDeviations.filter((d) => d.category === 'trace').length
  const reliabilityCount = allDeviations.length - traceDeviationCount
  const nodes = currentProject.arch?.nodes || []
  const edges = currentProject.arch?.edges || []

  const report = evaluation.report || null
  const categories = report?.categories || []
  const findings = report?.findings || {}
  const provenance = report?.provenance || {}
  const evaluatedCategories = categories.filter((c) => c.status === 'evaluated' && Number.isFinite(c.score))
  const overallScore = report?.overallScore
  const overallGrade = report?.grade || gradeFor(overallScore)
  const projectMeta = { projectId: currentProject?.id, projectName: currentProject?.name }

  const inputs = [
    {
      icon: <Workflow size={14} />,
      title: 'Architecture',
      detail: `${nodes.length} nodes and ${edges.length} edges. Node category, replica count, security placement and tier depth drive the structural dimensions.`,
    },
    {
      icon: <GaugeIcon size={14} />,
      title: 'Simulation metrics',
      detail: `Latency percentiles, success rate ${toPct(metrics.successRate).toFixed(1)}%, throughput ${(Number(metrics.throughputPerSec) || 0).toFixed(1)} req/s, peak utilisation, dropped and failed requests.`,
    },
    {
      icon: <GitBranch size={14} />,
      title: 'Process mining findings',
      detail: `${bottleneckCount} bottleneck(s), ${traceDeviationCount} trace deviation(s) affecting conformance and ${reliabilityCount} reliability finding(s) recovered from the event log, together with case conformance and mean waiting time.`,
    },
    {
      icon: <ShieldCheck size={14} />,
      title: 'Rule checks',
      detail: 'Deterministic structural rules covering authentication and firewall presence, redundancy, caching and single points of failure.',
    },
  ]

  return (
    <div>
      <PageHead
        eyebrow="Evaluation & Health Score"
        title={`Evaluation — ${currentProject.name}`}
        desc={PAGE_DESC}
        actions={<Badge tone={verdict.tone}>{verdict.label}</Badge>}
      />

      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* `items-start` was dropped from this grid: it left the shorter card floating at its
            own height with a large dead gap underneath while its neighbour ran taller.
            Default stretch makes both cards the same height. */}
        <Card
          title="Health Score"
          sub="Weighted mean of the six dimension scores."
          className="flex flex-col"
          bodyClass="flex flex-1 flex-col p-5"
        >
          <div className="flex flex-1 items-center justify-center">
            {/* The speedometer sweep and the number are driven by the same easing, so the
                arc and the figure arrive together. */}
            <Gauge score={healthScore} size={280} label="">
              <span
                ref={scoreRef}
                className="font-mono text-[46px] leading-none font-bold tabular-nums"
                style={{ color: scoreColor(healthScore) }}
              >
                {healthScore}
              </span>
              <span className="mt-1 block font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">
                out of 100 · {verdict.label}
              </span>
            </Gauge>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-[8px] border border-line-soft bg-raised p-3">
              <div className="mb-1 font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">
                Strongest dimension
              </div>
              <div className="text-[13px] text-ink">{dimensionMeta[strongest]?.label || '—'}</div>
              <div className="font-mono text-[15px] text-green">{Math.round(Number(dims[strongest]) || 0)}/100</div>
            </div>
            <div className="rounded-[8px] border border-line-soft bg-raised p-3">
              <div className="mb-1 font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">
                Weakest dimension
              </div>
              <div className="text-[13px] text-ink">{dimensionMeta[weakest]?.label || '—'}</div>
              <div className="font-mono text-[15px] text-red">{Math.round(Number(dims[weakest]) || 0)}/100</div>
            </div>
          </div>
        </Card>

        <Card title="Dimension profile" sub="Same six scores, plotted as a radar.">
          <HealthRadar evaluation={evaluation} height={300} />
        </Card>
      </div>

      <Card
        title="How the health score is produced"
        sub="Every dimension, its weight, its score, its contribution and the sentence that justifies it."
        className="mb-5"
      >
        <div className="mb-4 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['Dimension', 'Weight', 'Score', 'Meter', 'Weighted', 'Justification'].map((h) => (
                  <th
                    key={h}
                    className="px-2.5 pb-2.5 text-left font-mono text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="align-top hover:bg-white/[0.015]">
                  <td className="border-t border-line-soft px-2.5 py-2.5 text-[13px] whitespace-nowrap">
                    {r.label}
                  </td>
                  <td className="border-t border-line-soft px-2.5 py-2.5 font-mono text-[12.5px] whitespace-nowrap">
                    {toPct(r.weight).toFixed(0)}%
                  </td>
                  <td
                    className="border-t border-line-soft px-2.5 py-2.5 font-mono text-[12.5px] whitespace-nowrap"
                    style={{ color: scoreColor(r.score) }}
                  >
                    {r.score}/100
                  </td>
                  <td className="w-[150px] border-t border-line-soft px-2.5 py-2.5">
                    <div className="mb-0">
                      <UtilBar value={r.score} label="" right="" />
                    </div>
                  </td>
                  <td className="border-t border-line-soft px-2.5 py-2.5 font-mono text-[12.5px] whitespace-nowrap text-ink-dim">
                    {r.score} x {r.weight.toFixed(2)} = {r.contribution.toFixed(2)}
                  </td>
                  <td className="border-t border-line-soft px-2.5 py-2.5 text-[12.5px] leading-relaxed text-ink-dim">
                    {r.note}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="border-t border-line px-2.5 py-2.5 font-mono text-[12px] text-ink-faint uppercase">
                  Total
                </td>
                <td className="border-t border-line px-2.5 py-2.5 font-mono text-[12.5px] text-ink">
                  {toPct(weightTotal).toFixed(0)}%
                </td>
                <td className="border-t border-line px-2.5 py-2.5 font-mono text-[12.5px] text-ink-faint">—</td>
                <td className="border-t border-line px-2.5 py-2.5" />
                <td className="border-t border-line px-2.5 py-2.5 font-mono text-[12.5px] text-ink">
                  {contributionTotal.toFixed(2)}
                </td>
                <td className="border-t border-line px-2.5 py-2.5 text-[12.5px] text-ink-dim">
                  Sum of the weighted contributions listed above.
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {report ? (
        <Card
          className="mb-5"
          title="Comprehensive Evaluation"
          sub="Eight categories scored from static architecture facts, simulation metrics and mined traces. Only evaluated categories contribute to the overall score."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => downloadEvaluationCsv(evaluation, projectMeta)}
                className="inline-flex items-center gap-1.5 rounded-[6px] border border-line bg-raised px-2.5 py-1.5 text-[12px] font-semibold text-ink transition hover:border-accent"
              >
                <Download size={12} />
                CSV
              </button>
              <button
                type="button"
                onClick={() => printEvaluationReport(evaluation, projectMeta)}
                className="inline-flex items-center gap-1.5 rounded-[6px] border border-line bg-raised px-2.5 py-1.5 text-[12px] font-semibold text-ink transition hover:border-accent"
              >
                <Printer size={12} />
                PDF
              </button>
            </div>
          }
        >
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-[8px] border border-accent/40 bg-accent/8 p-3">
              <div className="font-mono text-[10px] tracking-wider text-ink-faint uppercase">Overall score</div>
              <div className="font-mono text-[22px] font-bold" style={{ color: scoreColor(overallScore ?? 0) }}>
                {overallScore == null ? '—' : overallScore}
              </div>
              <div className="font-mono text-[10.5px] text-ink-faint">/100 · {overallGrade.label}</div>
            </div>
            <div className="rounded-[8px] border border-line-soft bg-raised p-3">
              <div className="font-mono text-[10px] tracking-wider text-ink-faint uppercase">Status</div>
              <div className="mt-1"><Badge tone={overallGrade.tone}>{report.status}</Badge></div>
              <div className="mt-1 font-mono text-[10.5px] text-ink-faint">
                {evaluatedCategories.length} of {report.totalCategories} categories evaluated
              </div>
            </div>
            <div className="rounded-[8px] border border-line-soft bg-raised p-3">
              <div className="font-mono text-[10px] tracking-wider text-ink-faint uppercase">Architecture version</div>
              <div className="mt-1 font-mono text-[12px] break-all text-ink">{provenance.architectureVersion || '—'}</div>
            </div>
            <div className="rounded-[8px] border border-line-soft bg-raised p-3">
              <div className="font-mono text-[10px] tracking-wider text-ink-faint uppercase">Simulation run</div>
              <div className="mt-1 font-mono text-[12px] break-all text-ink">{provenance.runId || '—'}</div>
              <div className="mt-1 font-mono text-[10.5px] text-ink-faint">
                {provenance.seed != null ? `seed ${provenance.seed}` : 'seed —'}
                {provenance.arrivalRate != null ? ` · ${provenance.arrivalRate} req/s` : ''}
              </div>
            </div>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {categories.map((category) => (
              <div key={category.key} className="rounded-[8px] border border-line-soft bg-raised p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] leading-tight text-ink-dim">{category.label}</span>
                  <Badge tone={category.evidence?.includes('mining') ? 'blue' : category.evidence?.includes('simulation') ? 'dim' : 'amber'}>
                    {category.evidence?.includes('static') && !category.evidence?.includes('simulation') ? 'static' : category.evidence?.includes('mining') ? 'mining' : 'simulation'}
                  </Badge>
                </div>
                <div className="mt-1.5 font-mono text-[16px] font-semibold" style={{ color: category.status === 'evaluated' ? scoreColor(category.score) : colors.inkFaint }}>
                  {category.status === 'evaluated' ? `${category.score}/100` : 'Not Evaluated'}
                </div>
                <div className="mt-1 font-mono text-[10px] text-ink-faint">
                  grade {category.grade?.letter || '—'} · {Math.round((category.normalizedWeight || 0) * 100)}% normalized
                </div>
                <div className="mt-1.5"><UtilBar value={category.status === 'evaluated' ? category.score : 0} label="" right="" /></div>
              </div>
            ))}
          </div>

          <CategoryCharts categories={categories} />

          <div className="mt-4 border-t border-line-soft pt-4">
            <div className="mb-2 flex items-center gap-2">
              <Info size={12} className="text-accent" />
              <span className="font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">Scoring methodology</span>
            </div>
            <div className="space-y-1.5 text-[12.5px] leading-relaxed text-ink-dim">
              <p>{report.methodology?.description}</p>
              <p>{report.methodology?.normalization}</p>
              <p>{report.methodology?.doubleCounting}</p>
              <p>
                Grade bands: {(report.methodology?.gradeBands || []).map((b) => `${b.letter} ≥ ${b.min}`).join(' · ')} ·
                latency budget {report.methodology?.thresholds?.latencyBudgetMs} ms ·
                failure ceiling {Math.round((report.methodology?.thresholds?.failureCeiling || 0) * 100)}% ·
                drop ceiling {Math.round((report.methodology?.thresholds?.dropCeiling || 0) * 100)}%
              </p>
              {report.methodology?.notEvaluated?.length ? (
                <div className="rounded-[7px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
                  Not evaluated: {report.methodology.notEvaluated.map((n) => n.category).join(', ')}. Missing metrics are
                  shown as Not Evaluated rather than assigned an artificial score.
                </div>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      {report ? (
        <Card className="mb-5" title="Detailed Findings" sub="Issues are grouped by priority. Identical issues are reported once even if they can be seen from more than one category.">
          {['critical', 'high', 'medium', 'low'].some((k) => findings[k]?.length) || findings.positive?.length ? (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {['critical', 'high', 'medium', 'low'].map((k) => (
                <FindingList key={k} items={findings[k]} tone={EV_TONE[k]} label={EV_LABEL[k]} />
              ))}
              {findings.positive?.length ? (
                <div className="rounded-[8px] border border-green/30 bg-green/5 px-3 py-2.5">
                  <div className="mb-1.5 flex items-center gap-2">
                    <CheckCircle2 size={13} className="text-green" />
                    <span className="font-mono text-[11px] tracking-wider text-green uppercase">Positive Findings · {findings.positive.length}</span>
                  </div>
                  <ul className="space-y-1.5">
                    {findings.positive.map((p, i) => (
                      <li key={i} className="text-[12.5px] leading-relaxed text-ink-dim">
                        <span className="text-ink-faint">[{p.category}]</span> {p.text}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="py-4 text-center text-[12.5px] text-ink-faint">No findings were recorded for this evaluation.</div>
          )}
        </Card>
      ) : null}

      {report ? (
        <Card className="mb-5" title="Detailed Category Analysis" sub="Open a category for its criteria, measured values, evidence, detected problems, deductions and improvements.">
          <div className="space-y-2">
            {categories.map((category) => (
              <CategoryDetail key={category.key} category={category} />
            ))}
          </div>
        </Card>
      ) : null}

      {report ? (
        <Card className="mb-5" title="Evaluation History" sub="Snapshots are stored in this browser and scoped to the project, architecture version and simulation run.">
          <HistoryPanel
            history={history}
            fromId={fromId}
            toId={toId}
            setFromId={setFromId}
            setToId={setToId}
            comparison={comparison}
            onClear={() => setHistory(clearEvaluationHistory(historyScope))}
            onRemove={(id) => setHistory(removeEvaluationEntry(historyScope, id))}
          />
        </Card>
      ) : null}

      <Card title="Where this came from" sub="The four inputs the evaluator reads.">
          <div className="space-y-3">
            {inputs.map((item) => (
              <div key={item.title} className="flex gap-3 rounded-[8px] border border-line-soft bg-raised p-3">
                <span className="mt-0.5 shrink-0 text-accent">{item.icon}</span>
                <div>
                  <div className="text-[13px] font-semibold text-ink">{item.title}</div>
                  <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-dim">{item.detail}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3.5 border-t border-line-soft pt-3 text-[12px] text-ink-faint">
            Weights are normalised to sum to 1.00; the current set sums to{' '}
            {toPct(weightTotal).toFixed(0)}%. Dimension scores are integers on a 0 to 100
            scale produced by deterministic thresholded checks, not by a model.
          </div>
        </Card>
    </div>
  )
}
