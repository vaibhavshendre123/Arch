import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Award,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  GitBranch,
  Info,
  MessageSquare,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Workflow,
} from 'lucide-react'
import { useApp } from '../store/AppContext.jsx'
import { useResults } from '../store/useResults.js'
import { colors, dimensionMeta, dimensionOrder } from '../theme/tokens.js'
import { computeAgreement, describeAgreement } from '../lib/advisorAgreement.js'
import {
  buildRecommendationEvidence,
  recommendationScope,
} from '../lib/recommendationEvidence.js'
import {
  loadRecommendationStatuses,
  RECOMMENDATION_STATUSES,
  saveRecommendationStatus,
} from '../lib/recommendationStatus.js'
import {
  askAdvisorQuestion,
  getAdvisorStatus,
  requestGeminiRecommendations,
} from '../services/advisor.js'
import { Badge, Button, Card, Empty, inputClass, PageHead, Spinner } from '../components/ui.jsx'

const linkBtn =
  'inline-flex items-center gap-2 rounded-[7px] border border-accent bg-accent px-3.5 py-2 text-[13px] font-semibold text-on-accent transition hover:brightness-110'

const SEVERITY_RANK = { high: 3, med: 2, low: 1 }
const PRIORITY_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 }
const PRIORITY_TONE = { Critical: 'red', High: 'amber', Medium: 'blue', Low: 'dim' }
const STATUS_LABEL = {
  open: 'Open',
  'in-review': 'In review',
  accepted: 'Accepted',
  dismissed: 'Dismissed',
}

const CATEGORIES = [
  'Performance Optimization',
  'Scalability',
  'Security',
  'Reliability',
  'Cost Optimization',
  'Database Optimization',
  'Infrastructure',
  'Architecture Design',
]
const CATEGORY_BY_DIMENSION = {
  performance: 'Performance Optimization',
  scalability: 'Scalability',
  reliability: 'Reliability',
  security: 'Security',
  maintainability: 'Architecture Design',
  processEfficiency: 'Performance Optimization',
}
const SUGGESTED_QUESTIONS = [
  'What is the biggest bottleneck?',
  'How can I improve performance?',
  'Which component needs scaling?',
  'How can I improve reliability?',
  'What are the main security concerns?',
]

const PAGE_EYEBROW = 'Architecture Advisor'
const PAGE_DESC =
  'Two independent advisors read the same project evidence. The baseline is a deterministic rule engine that runs entirely in this browser tab. The Gemini arm sends the current architecture, simulation, mining and evaluation evidence through this project’s own backend for a second opinion. Both are advisory only: nothing is applied to the architecture.'

function asList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim())
  if (value === null || value === undefined || value === '') return []
  return [String(value)]
}

function priorityOf(rec) {
  if (PRIORITY_RANK[rec?.priority]) return rec.priority
  return rec?.severity === 'high' ? 'High' : rec?.severity === 'med' ? 'Medium' : 'Low'
}

function categoryOf(rec) {
  return rec?.category || CATEGORY_BY_DIMENSION[rec?.dimension] || 'Architecture Design'
}

function priorityColor(priority) {
  if (priority === 'Critical') return colors.red
  if (priority === 'High') return colors.accent
  if (priority === 'Medium') return colors.blue
  return colors.inkFaint
}

/** Fills the rich view fields for older cached recommendations without changing the cache. */
function displayRecommendation(rec, arm) {
  const problem = rec.problem || rec.issue || ''
  const rootCause = rec.rootCause || rec.why || ''
  const solution = rec.solution || rec.recommendation || ''
  return {
    ...rec,
    arm,
    category: categoryOf(rec),
    priority: priorityOf(rec),
    problem,
    rootCause,
    evidence: asList(rec.evidence || [rec.issue, rec.why].filter(Boolean)),
    solution,
    steps: asList(rec.steps || (solution ? [solution] : [])),
    benefits: asList(rec.benefits || [rec.effect, ...(rec.expectedImpact || [])].filter(Boolean)),
    risks: asList(rec.risks || ['Verify the predicted effect with a new simulation run.']),
    confidence: rec.confidence || 'Medium',
  }
}

function toPct(value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return 0
  return v <= 1 ? v * 100 : v
}

function rank(severity) {
  return SEVERITY_RANK[severity] || 1
}

function sorted(list) {
  return [...(list || [])].sort(
    (a, b) => PRIORITY_RANK[priorityOf(b)] - PRIORITY_RANK[priorityOf(a)] || rank(b.severity) - rank(a.severity),
  )
}

function AgreementMetrics({ agreement }) {
  const show = (value, suffix = '') => (value === null || value === undefined ? 'n/a' : `${value}${suffix}`)
  const rows = [
    ['Dimensions in common', `${agreement.sharedCount} of ${agreement.unionCount}`],
    ['Jaccard overlap', show(agreement.jaccard, '%')],
    ['Severity agreement', show(agreement.severityAgreement, '%')],
    [
      'Severity rank correlation',
      agreement.severityCorrelation === null ? 'n/a (needs 3+ shared)' : agreement.severityCorrelation.toFixed(3),
    ],
  ]
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-[8px] border border-line-soft bg-raised p-3">
          <div className="mb-1 font-mono text-[10px] tracking-wider text-ink-faint uppercase">{label}</div>
          <div className="font-mono text-[16px] font-semibold text-ink">{value}</div>
        </div>
      ))}
    </div>
  )
}

function EnhancedRecommendationCard({ rec, status, onStatusChange }) {
  const [expanded, setExpanded] = useState(false)
  const priority = priorityOf(rec)
  const color = priorityColor(priority)
  const sourceLabel = rec.arm === 'gemini' ? `Gemini${rec.model ? ` · ${rec.model}` : ''}` : 'Rule-based'

  return (
    <div className="relative mb-3.5 overflow-hidden rounded-panel border border-line bg-surface p-4">
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone={PRIORITY_TONE[priority]}>{priority}</Badge>
        <Badge tone={rec.severity === 'high' ? 'red' : rec.severity === 'med' ? 'amber' : 'blue'}>
          {rec.severity}
        </Badge>
        <span className="font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">{rec.category}</span>
        <span className="ml-auto font-mono text-[10px] text-ink-faint">{sourceLabel}</span>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-start justify-between gap-3 text-left"
      >
        <h3 className="text-[14.5px] text-ink">{rec.title}</h3>
        <span className="mt-0.5 shrink-0 text-ink-faint">
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>
      </button>
      {!expanded && rec.problem && (
        <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-ink-dim">{rec.problem}</p>
      )}

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-line-soft pt-3">
          {[
            ['Problem', rec.problem],
            ['Root cause', rec.rootCause],
            ['Recommended solution', rec.solution],
          ].map(([label, value]) =>
            value ? (
              <div key={label}>
                <div className="mb-0.5 font-mono text-[10px] tracking-wider text-ink-faint uppercase">{label}</div>
                <div className="text-[13px] leading-relaxed text-ink">{value}</div>
              </div>
            ) : null,
          )}

          {rec.evidence.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[10px] tracking-wider text-ink-faint uppercase">
                Supporting evidence
              </div>
              <ul className="space-y-1 text-[12.5px] leading-relaxed text-ink-dim">
                {rec.evidence.map((item, i) => (
                  <li key={`${item}-${i}`} className="flex gap-2">
                    <span className="font-mono text-accent">·</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rec.steps.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[10px] tracking-wider text-ink-faint uppercase">
                Implementation steps
              </div>
              <ol className="space-y-1 text-[12.5px] leading-relaxed text-ink-dim">
                {rec.steps.map((step, i) => (
                  <li key={`${step}-${i}`} className="flex gap-2">
                    <span className="font-mono text-accent">{i + 1}.</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[
              ['Expected benefits', rec.benefits, colors.green],
              ['Potential risks', rec.risks, colors.red],
            ].map(([label, items, tone]) => (
              <div key={label}>
                <div className="mb-1 font-mono text-[10px] tracking-wider text-ink-faint uppercase">{label}</div>
                <ul className="space-y-1 text-[12.5px] leading-relaxed text-ink-dim">
                  {items.length ? (
                    items.map((item, i) => (
                      <li key={`${item}-${i}`} className="flex gap-2">
                        <span style={{ color: tone }}>·</span>
                        <span>{item}</span>
                      </li>
                    ))
                  ) : (
                    <li className="text-ink-faint">Not stated for this finding.</li>
                  )}
                </ul>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-[7px] border border-line-soft bg-raised px-3 py-2">
            <span className="font-mono text-[10px] tracking-wider text-ink-faint uppercase">Confidence</span>
            <Badge tone={rec.confidence === 'High' ? 'green' : rec.confidence === 'Medium' ? 'amber' : 'dim'}>
              {rec.confidence}
            </Badge>
            <label className="ml-auto flex items-center gap-2 font-mono text-[10px] tracking-wider text-ink-faint uppercase">
              Review status
              <select
                className={`${inputClass} w-auto py-1 text-[12px] normal-case tracking-normal`}
                value={status}
                onChange={(e) => onStatusChange(rec.id, e.target.value)}
              >
                {RECOMMENDATION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="text-[11.5px] text-ink-faint">
            {rec.issue && `Measured detail: ${rec.issue}`}
            {rec.effect && ` Expected effect: ${rec.effect}`}
          </div>
        </div>
      )}
    </div>
  )
}

function AdvisorChat({ evidence, enabled, blockedReason }) {
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const send = useCallback(
    async (raw) => {
      const asked = String(raw ?? question).trim()
      if (!asked || loading || !enabled) return
      const history = messages.map((m) => ({ role: m.role, content: m.content }))
      setQuestion('')
      setLoading(true)
      setError(null)
      try {
        const result = await askAdvisorQuestion({ question: asked, history, evidence: evidence.payload })
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: asked },
          {
            role: 'assistant',
            content: result.answer,
            bullets: result.bullets || [],
            caveats: result.caveats || [],
            model: result.model,
          },
        ])
      } catch (err) {
        setError(err.message || 'The advisor could not answer that question.')
      } finally {
        setLoading(false)
      }
    },
    [question, loading, enabled, messages, evidence],
  )

  return (
    <Card
      title="Architecture AI advisor"
      sub="Ask about the open architecture and the results currently bound to it."
      className="mb-5"
      actions={<Badge tone={enabled ? 'green' : 'dim'}>{enabled ? 'Ready' : 'Unavailable'}</Badge>}
    >
      {!enabled && (
        <p className="mb-3 text-[12.5px] text-ink-dim">
          {blockedReason || 'Configure Gemini and run a simulation to enable the advisor.'}
        </p>
      )}

      <div className="mb-3 flex flex-wrap gap-1.5">
        {SUGGESTED_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={!enabled || loading}
            onClick={() => send(q)}
            className="cursor-pointer rounded-[6px] border border-line-soft bg-raised px-2.5 py-1 text-[11.5px] text-ink-dim transition hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {q}
          </button>
        ))}
      </div>

      {messages.length > 0 && (
        <div className="mb-3 max-h-80 space-y-3 overflow-y-auto pr-1">
          {messages.map((message, i) => (
            <div
              key={`${message.role}-${i}`}
              className={`rounded-[8px] border px-3 py-2 text-[12.5px] leading-relaxed ${
                message.role === 'user'
                  ? 'border-accent/40 bg-accent/10 text-ink'
                  : 'border-line-soft bg-raised text-ink-dim'
              }`}
            >
              <div className="mb-1 font-mono text-[10px] tracking-wider text-ink-faint uppercase">
                {message.role === 'user' ? 'You' : `Gemini${message.model ? ` · ${message.model}` : ''}`}
              </div>
              <p>{message.content}</p>
              {message.bullets?.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {message.bullets.map((b, j) => (
                    <li key={`${b}-${j}`} className="flex gap-2">
                      <span className="text-accent">·</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              )}
              {message.caveats?.length > 0 && (
                <div className="mt-2 border-t border-line-soft pt-2 text-[11.5px] text-ink-faint">
                  {message.caveats.map((c, j) => (
                    <div key={`${c}-${j}`}>Caveat: {c}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {loading && <Spinner label="Gemini is reading this architecture…" />}
      {error && <p className="mb-2 text-[12.5px] text-red">{error}</p>}

      <div className="flex gap-2">
        <input
          className={inputClass}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send(question)
          }}
          placeholder="Ask about bottlenecks, scaling, reliability or security…"
          disabled={!enabled || loading}
        />
        <Button onClick={() => send(question)} disabled={!enabled || loading || !question.trim()} icon={<Send size={14} />}>
          Ask
        </Button>
      </div>
      <p className="mt-2 text-[11.5px] text-ink-faint">
        Answers cite only the measurements and component names in the current project evidence. Nothing is applied
        automatically.
      </p>
    </Card>
  )
}

export default function Recommendations() {
  const { currentProject, workload } = useApp()
  const {
    key: resultKey,
    recommendations,
    evaluation,
    mining,
    sim,
    status,
    error,
  } = useResults(currentProject?.arch)

  const [advisor, setAdvisor] = useState({ state: 'idle', recommendations: null, error: null, model: null })
  const [arm, setArm] = useState('baseline')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [search, setSearch] = useState('')
  // Reading the feature-local store during render avoids a state/effect echo; saving a
  // decision in the event handler below bumps this counter to repaint the cards.
  const [, refreshStatuses] = useState(0)

  // Availability is a cheap authenticated GET, so it is safe to run on mount. The
  // generation call is not: it spends paid quota and stays behind an explicit click.
  useEffect(() => {
    let active = true
    getAdvisorStatus()
      .then((info) => {
        if (!active) return
        setAdvisor((prev) => ({
          ...prev,
          state: info.configured ? 'ready' : 'unconfigured',
          model: info.model || null,
        }))
      })
      .catch(() => {
        if (active) setAdvisor((prev) => ({ ...prev, state: 'unavailable' }))
      })
    return () => {
      active = false
    }
  }, [])

  const evidence = useMemo(
    () =>
      buildRecommendationEvidence({
        project: currentProject,
        architecture: currentProject?.arch,
        workload,
        sim,
        mining,
        evaluation,
        recommendations,
        resultKey,
      }),
    [currentProject, workload, sim, mining, evaluation, recommendations, resultKey],
  )

  const scope = useMemo(
    () =>
      recommendationScope({
        project: currentProject,
        architecture: currentProject?.arch,
        resultKey,
      }),
    [currentProject, resultKey],
  )

  const statuses = loadRecommendationStatuses(scope)

  const changeStatus = useCallback(
    (id, next) => {
      saveRecommendationStatus(scope, id, next)
      refreshStatuses((n) => n + 1)
    },
    [scope],
  )

  const askGemini = useCallback(async () => {
    setAdvisor((prev) => ({ ...prev, state: 'loading', error: null }))
    try {
      const result = await requestGeminiRecommendations(evidence.payload)
      setAdvisor({
        state: 'done',
        recommendations: result.recommendations || [],
        error: null,
        model: result.model || null,
      })
    } catch (err) {
      setAdvisor((prev) => ({ ...prev, state: 'error', error: err.message || 'The advisor request failed.' }))
    }
  }, [evidence])

  if (!currentProject) {
    return (
      <Card>
        <Empty
          icon={<Sparkles size={26} />}
          title="No project is open."
          hint="Recommendations are written for a specific architecture. Open or create a project first."
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
        <PageHead eyebrow={PAGE_EYEBROW} title={`Recommendations — ${currentProject.name}`} desc={PAGE_DESC} />
        <Card className="border-red">
          <div className="font-mono text-[12px] text-red">Recommendation error</div>
          <div className="mt-1 text-[13px] text-ink">{error || 'Unknown recommendation failure.'}</div>
        </Card>
      </div>
    )
  }

  if (status === 'running' && !recommendations) {
    return (
      <div>
        <PageHead eyebrow={PAGE_EYEBROW} title={`Recommendations — ${currentProject.name}`} desc={PAGE_DESC} />
        <Card>
          <Spinner label="Composing the advisory layer…" />
        </Card>
      </div>
    )
  }

  if (!recommendations) {
    return (
      <div>
        <PageHead eyebrow={PAGE_EYEBROW} title={`Recommendations — ${currentProject.name}`} desc={PAGE_DESC} />
        <Card>
          <Empty
            icon={<Sparkles size={26} />}
            title="No recommendations yet."
            hint="The advisors read simulation and mining findings, so the pipeline needs to run at least once."
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

  const baseline = sorted(recommendations.map((r) => displayRecommendation(r, 'baseline')))
  const geminiRecs = advisor.recommendations
    ? sorted(advisor.recommendations.map((r) => displayRecommendation(r, 'gemini')))
    : null
  const agreement = geminiRecs ? computeAgreement(recommendations, advisor.recommendations) : null
  const active = arm === 'gemini' && geminiRecs ? geminiRecs : baseline
  const availableCategories = [...new Set(active.map((r) => r.category))].sort()

  const query = search.trim().toLowerCase()
  const filtered = active.filter((r) => {
    const categoryOk = categoryFilter === 'all' || r.category === categoryFilter
    const priorityOk = priorityFilter === 'all' || r.priority === priorityFilter
    const searchText = [r.title, r.problem, r.rootCause, r.solution, ...r.evidence, ...r.steps].join(' ').toLowerCase()
    return categoryOk && priorityOk && (!query || searchText.includes(query))
  })

  const priorityCounts = Object.fromEntries(
    Object.keys(PRIORITY_RANK).map((p) => [p, active.filter((r) => r.priority === p).length]),
  )

  const dims = evaluation?.dimensions || {}
  const healthScore = Math.round(Number(evaluation?.healthScore) || 0)
  const worst = [...dimensionOrder]
    .map((key) => ({ key, label: dimensionMeta[key]?.label || key, score: Number(dims[key]) || 0 }))
    .sort((a, b) => a.score - b.score)[0]
  const bottleneckCount = (mining?.bottlenecks || []).length
  const deviationCount = (mining?.deviations || []).filter((d) => d && d.type !== 'none').length
  const metrics = sim?.metrics || {}

  const inputs = [
    {
      icon: <Award size={14} />,
      label: 'Health score',
      value: `${healthScore} / 100`,
      hint: 'Weighted mean of the six evaluation dimensions.',
    },
    {
      icon: <TrendingUp size={14} />,
      label: 'Worst dimension',
      value: `${worst?.label || '—'} (${worst?.score ?? 0})`,
      hint: 'The dimension that most limited the overall score.',
    },
    {
      icon: <Workflow size={14} />,
      label: 'Bottlenecks',
      value: String(bottleneckCount),
      hint: 'Components whose waiting time dominates processing time.',
    },
    {
      icon: <GitBranch size={14} />,
      label: 'Deviations',
      value: String(deviationCount),
      hint: 'Executed traces that the expected model does not predict.',
    },
  ]

  const contextBlocked = !evidence.ready
  const aiAvailable = ['ready', 'done', 'error'].includes(advisor.state)
  const blockedReason = !evidence.validation.canSimulate
    ? 'This architecture has blocking validation errors. Fix them before asking Gemini.'
    : evidence.freshness.stale
      ? `These results are stale: ${evidence.freshness.reasons.join(' ')}`
      : !evidence.hash || !sim?.metrics
        ? 'There is no simulation bound to this architecture yet.'
        : 'Not enough evaluation evidence is available.'

  return (
    <div>
      <PageHead
        eyebrow={PAGE_EYEBROW}
        title={`Recommendations — ${currentProject.name}`}
        desc={PAGE_DESC}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="red">{priorityCounts.Critical} critical</Badge>
            <Badge tone="amber">{priorityCounts.High} high</Badge>
            <Badge tone="blue">{priorityCounts.Medium} medium</Badge>
            <Badge tone="dim">{priorityCounts.Low} low</Badge>
          </div>
        }
      />

      <Card
        title="Evidence handed to both advisors"
        sub={`Project ${evidence.payload.project.name || '—'} · architecture ${evidence.hash || '—'} · result ${resultKey || '—'}`}
        className="mb-5"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {inputs.map((item) => (
            <div key={item.label} className="rounded-[8px] border border-line-soft bg-raised p-3.5">
              <div className="mb-1.5 flex items-center gap-2 font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">
                <span className="text-accent">{item.icon}</span>
                {item.label}
              </div>
              <div className="font-mono text-[17px] font-semibold text-ink">{item.value}</div>
              <div className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">{item.hint}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-[8px] border border-line-soft bg-raised p-3 text-[12px] text-ink-dim">
          <Info size={13} className="mt-0.5 shrink-0 text-accent" />
          <span>
            Both advisors also receive the {evidence.payload.architecture.nodeCount} architecture nodes and{' '}
            {evidence.payload.architecture.edgeCount} connections, {evidence.payload.components.length} measured
            components, conformance and evaluation findings, plus p50 {Math.round(Number(metrics.p50) || 0)} ms and
            p95 {Math.round(Number(metrics.p95) || 0)} ms with a success rate of{' '}
            {toPct(metrics.successRate).toFixed(1)}%. A missing measurement is never replaced with a guess.
          </span>
        </div>
        {contextBlocked && (
          <div className="mt-3 flex items-start gap-2 rounded-[8px] border border-red/40 bg-red/10 p-3 text-[12px] text-red">
            <ShieldCheck size={14} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Gemini is blocked for this context.</div>
              <div className="mt-0.5">{blockedReason} The rule-based arm below stays available.</div>
            </div>
          </div>
        )}
      </Card>

      <Card
        title="Advisor comparison"
        sub="The baseline runs locally and deterministically; Gemini runs server-side."
        className="mb-5"
        actions={
          <Button
            onClick={askGemini}
            disabled={contextBlocked || advisor.state === 'loading' || advisor.state === 'unconfigured'}
            icon={<Sparkles size={14} />}
          >
            {advisor.state === 'loading' ? 'Asking Gemini…' : geminiRecs ? 'Ask Gemini again' : 'Ask Gemini'}
          </Button>
        }
      >
        {advisor.state === 'unconfigured' && (
          <p className="text-[13px] text-ink-dim">
            The Gemini arm is switched off because <code className="font-mono text-[12px]">GEMINI_API_KEY</code> is
            not set on the backend. The baseline below is unaffected, because it never leaves this browser tab.
          </p>
        )}

        {advisor.state === 'unavailable' && (
          <p className="text-[13px] text-ink-dim">
            The backend could not be reached, so only the local baseline is shown. The baseline below is unaffected.
          </p>
        )}

        {advisor.state === 'ready' && !geminiRecs && (
          <p className="text-[13px] text-ink-dim">
            Gemini is configured on the server{advisor.model ? ` (${advisor.model})` : ''}. Nothing is sent until you
            press the button, because each call spends API quota.
          </p>
        )}

        {advisor.state === 'loading' && <Spinner label="Waiting for Gemini…" />}

        {advisor.state === 'error' && (
          <p className="text-[13px] text-red">
            The Gemini arm failed: {advisor.error} The baseline below is unaffected.
          </p>
        )}

        {agreement && (
          <div className="mt-1">
            <AgreementMetrics agreement={agreement} />
            <p className="mt-3 text-[12.5px] leading-relaxed text-ink-dim">{describeAgreement(agreement)}</p>
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
              Jaccard overlap is the share of distinct dimensions raised by either advisor that both raised. Severity
              agreement compares the high/med/low verdict on shared dimensions, and the rank correlation measures
              whether the two advisors order those dimensions the same way.
            </p>
          </div>
        )}
      </Card>

      <Card title="Recommendation overview" sub="Counts reflect the arm currently selected below." className="mb-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Object.keys(PRIORITY_RANK).map((p) => (
            <div key={p} className="rounded-[8px] border border-line-soft bg-raised p-3.5">
              <div className="mb-1 flex items-center justify-between font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">
                <span>{p}</span>
                <span style={{ color: priorityColor(p) }}>●</span>
              </div>
              <div className="font-mono text-[19px] font-semibold text-ink">{priorityCounts[p]}</div>
              <div className="mt-0.5 text-[11.5px] text-ink-faint">
                {active.filter((r) => r.priority === p && statuses[r.id] === 'accepted').length} accepted
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Review recommendations" sub="Filter, search, expand and record a review decision." className="mb-5">
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[auto_1fr_1fr_2fr_auto]">
          <div className="flex gap-1 rounded-[7px] border border-line-soft bg-raised p-1">
            <button
              type="button"
              onClick={() => setArm('baseline')}
              className={`cursor-pointer rounded-[5px] px-3 py-1.5 font-mono text-[11.5px] ${
                arm === 'baseline' ? 'bg-accent text-on-accent' : 'text-ink-dim hover:text-ink'
              }`}
            >
              Rule-based ({baseline.length})
            </button>
            <button
              type="button"
              onClick={() => setArm('gemini')}
              disabled={!geminiRecs}
              className={`cursor-pointer rounded-[5px] px-3 py-1.5 font-mono text-[11.5px] disabled:cursor-not-allowed disabled:opacity-40 ${
                arm === 'gemini' && geminiRecs ? 'bg-accent text-on-accent' : 'text-ink-dim hover:text-ink'
              }`}
            >
              Gemini ({geminiRecs?.length ?? 0})
            </button>
          </div>
          <select className={inputClass} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="all">All categories</option>
            {availableCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select className={inputClass} value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
            <option value="all">All priorities</option>
            {Object.keys(PRIORITY_RANK).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <div className="relative">
            <Search size={14} className="absolute top-2.5 left-3 text-ink-faint" />
            <input
              className={`${inputClass} pl-9`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title, cause, evidence or steps…"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setCategoryFilter('all')
              setPriorityFilter('all')
              setSearch('')
            }}
          >
            Clear
          </Button>
        </div>

        <div className="mb-3 flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => (
            <span
              key={c}
              className={`rounded-[5px] px-2 py-0.5 font-mono text-[10px] ${
                availableCategories.includes(c) ? 'bg-accent/12 text-accent' : 'bg-overlay text-ink-faint'
              }`}
            >
              {c} {active.filter((r) => r.category === c).length}
            </span>
          ))}
        </div>

        {filtered.length ? (
          filtered.map((rec) => (
            <EnhancedRecommendationCard
              key={`${arm}-${rec.id}`}
              rec={rec}
              status={statuses[rec.id] || 'open'}
              onStatusChange={changeStatus}
            />
          ))
        ) : (
          <Empty
            icon={<CircleCheck size={22} />}
            title="No recommendations match these filters."
            hint="Clear the filters, or select the other advisor arm."
          />
        )}
      </Card>

      <AdvisorChat
        key={evidence.payload.resultKey || 'no-result'}
        evidence={evidence}
        enabled={aiAvailable && !contextBlocked}
        blockedReason={
          advisor.state === 'unconfigured'
            ? 'GEMINI_API_KEY is not configured on the backend. The baseline remains available.'
            : advisor.state === 'unavailable'
              ? 'The backend could not be reached. The baseline remains available.'
              : blockedReason
        }
      />

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[2fr_320px]">
        <Card title="Priority scale" sub="How the advisory layer ranks urgency.">
          <div className="space-y-2.5">
            {[
              ['Critical', 'A severe measured score or request loss. Address before the next review.'],
              ['High', 'Directly harms the current objective metrics. Schedule it soon.'],
              ['Medium', 'Visible in the evidence but bounded. Plan it.'],
              ['Low', 'Structural or cost improvement. Consider it when the workload grows.'],
            ].map(([p, text]) => (
              <div key={p} className="flex items-start gap-2.5">
                <Badge tone={PRIORITY_TONE[p]}>{p}</Badge>
                <span className="text-[12.5px] leading-relaxed text-ink-dim">{text}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="How to read these" sub="They are advice, not verdicts.">
          <div className="space-y-2.5 text-[12.5px] leading-relaxed text-ink-dim">
            <p>
              Each expanded card separates the problem, root cause, supporting evidence, solution, steps, expected
              benefits and risks. Confidence reflects how much measured evidence was available.
            </p>
            <p>
              Review status is stored only in this browser and is scoped to the project, architecture version and
              result. Nothing is applied automatically and no project data is changed.
            </p>
          </div>
        </Card>

        <Card title="Reading the volume" sub="How many findings to expect from a healthy design.">
          <div className="flex items-start gap-2.5">
            <CircleCheck size={15} className="mt-0.5 shrink-0 text-green" />
            <p className="text-[12.5px] leading-relaxed text-ink-dim">
              This architecture produced {baseline.length} rule-based finding{baseline.length === 1 ? '' : 's'} from a
              health score of {healthScore} and {deviationCount} real deviation{deviationCount === 1 ? '' : 's'}. A
              long list usually signals that the simulated workload is undersized rather than that the design is
              sound.
            </p>
          </div>
        </Card>

        <Card title="Advisor provenance" sub="Which arm produced what you are reading.">
          <div className="space-y-2.5 text-[12.5px] leading-relaxed text-ink-dim">
            <p>
              <MessageSquare size={13} className="mr-1.5 inline text-accent" />
              Rule-based findings are generated locally from the same measurements and cannot call an external API.
            </p>
            <p>
              <Sparkles size={13} className="mr-1.5 inline text-accent" />
              Gemini findings are labelled with the server model and are only requested after you press Ask Gemini.
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}
