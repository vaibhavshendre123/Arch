import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  Award,
  ChevronDown,
  ChevronRight,
  GitBranch,
  History,
  Info,
  Lightbulb,
  ListTree,
  Route,
  ScrollText,
  Timer,
  TrendingUp,
} from 'lucide-react'
import { useApp } from '../store/AppContext.jsx'
import { useResults } from '../store/useResults.js'
import { colors, severityColor, scoreColor } from '../theme/tokens.js'
import {
  Badge,
  Card,
  DataTable,
  Empty,
  PageHead,
  Spinner,
  StatCard,
  UtilBar,
  inputClass,
} from '../components/ui.jsx'
import { BottleneckChart, PathSupportChart } from '../components/charts.jsx'

const ARROW = ' → '

const linkBtn =
  'inline-flex items-center gap-2 rounded-[7px] border border-accent bg-accent px-3.5 py-2 text-[13px] font-semibold text-on-accent transition hover:brightness-110'

function toPct(value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return 0
  return v <= 1 ? v * 100 : v
}

function severityTone(severity) {
  if (severity === 'high') return 'red'
  if (severity === 'med') return 'amber'
  return 'blue'
}

function PathList({ names }) {
  return (
    <div className="font-mono text-[12px] leading-relaxed break-words text-ink">
      {names.map((name, i) => (
        <span key={`${name}-${i}`}>
          {i > 0 ? <span className="text-ink-faint">{ARROW}</span> : null}
          <span className={i === 0 || i === names.length - 1 ? 'text-accent' : 'text-ink-dim'}>{name}</span>
        </span>
      ))}
    </div>
  )
}

function InfoTip({ label, children }) {
  return (
    <span className="group/tip relative inline-flex cursor-help items-center gap-1">
      <Info size={12} className="text-ink-faint" aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-30 mb-1.5 hidden w-72 rounded-[7px] border border-line bg-overlay p-2.5 text-[11.5px] leading-relaxed text-ink-dim shadow-xl group-hover/tip:block group-focus-within/tip:block"
      >
        {children}
      </span>
    </span>
  )
}

function DeviationRow({ deviation, totalCases, onInspectCase }) {
  const [open, setOpen] = useState(false)
  const caseIds = deviation.caseIds || []
  return (
    <div
      className="rounded-[8px] border border-line bg-raised p-3.5"
      style={{ borderLeft: `3px solid ${severityColor(deviation.severity)}` }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-start gap-2 text-left"
        aria-expanded={open}
      >
        <span className="mt-0.5 shrink-0 text-ink-faint">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="mb-1.5 flex flex-wrap items-center gap-2">
            <Badge tone={severityTone(deviation.severity)}>{deviation.severity || 'low'}</Badge>
            <Badge tone={deviation.category === 'trace' ? 'red' : 'dim'}>
              {deviation.category === 'trace' ? 'affects conformance' : 'reliability'}
            </Badge>
            <span className="font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">{deviation.type}</span>
            <span className="font-mono text-[10.5px] text-ink-faint">
              · {Number(deviation.caseCount) || 0} of {totalCases} cases
            </span>
          </span>
          <span className="block text-[13px] text-ink">{deviation.component}</span>
          <span className="mt-0.5 block text-[12.5px] text-ink-dim">{deviation.detail}</span>
        </span>
      </button>
      {open && (
        <div className="mt-3 border-t border-line-soft pt-3">
          {(deviation.expectedActivity || deviation.observedActivity) && (
            <div className="mb-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {deviation.expectedActivity && (
                <div className="rounded-[6px] bg-overlay px-2.5 py-2">
                  <div className="font-mono text-[10px] tracking-wider text-ink-faint uppercase">Expected</div>
                  <div className="mt-0.5 font-mono text-[11.5px] text-ink">{deviation.expectedActivity}</div>
                </div>
              )}
              {deviation.observedActivity && (
                <div className="rounded-[6px] bg-overlay px-2.5 py-2">
                  <div className="font-mono text-[10px] tracking-wider text-ink-faint uppercase">Observed</div>
                  <div className="mt-0.5 font-mono text-[11.5px] text-ink">{deviation.observedActivity}</div>
                </div>
              )}
            </div>
          )}
          <div className="font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">
            Affected cases {caseIds.length < Number(deviation.caseCount) ? `(showing ${caseIds.length})` : ''}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {caseIds.length ? (
              caseIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onInspectCase(id)}
                  className="cursor-pointer rounded-[5px] border border-line-soft bg-overlay px-2 py-1 font-mono text-[11px] text-ink-dim transition hover:border-accent hover:text-accent"
                >
                  case {id}
                </button>
              ))
            ) : (
              <span className="text-[12px] text-ink-faint">No case identifiers recorded for this group.</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TraceTimeline({ caseId, events, outcome, path }) {
  const rows = (events || []).filter((e) => String(e.caseId) === String(caseId))
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone={outcome === 'completed' ? 'green' : outcome === 'dropped' ? 'red' : 'amber'}>{outcome}</Badge>
        <span className="font-mono text-[11.5px] text-ink-dim">{rows.length} events</span>
        {path?.length ? (
          <span className="font-mono text-[11px] text-ink-faint">
            {path.length} activities: {path.join(ARROW)}
          </span>
        ) : null}
      </div>
      {rows.length ? (
        <ol className="space-y-1">
          {rows.map((e, i) => (
            <li key={`${e.eventId ?? i}`} className="flex items-baseline gap-3 font-mono text-[11.5px]">
              <span className="w-20 shrink-0 text-right text-ink-faint">{Number(e.timestamp).toFixed(1)} ms</span>
              <span
                className={`w-40 shrink-0 ${
                  e.activity === 'FAILURE' || e.activity === 'REQUEST_DROPPED'
                    ? 'text-red'
                    : e.activity === 'REQUEST_COMPLETE'
                      ? 'text-green'
                      : 'text-accent'
                }`}
              >
                {e.activity}
              </span>
              <span className="min-w-0 truncate text-ink-dim">{e.componentName || '—'}</span>
              {e.status ? <span className="shrink-0 text-ink-faint">{e.status}</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <div className="py-3 text-center text-[12px] text-ink-faint">No events recorded for this case in the sample.</div>
      )}
    </div>
  )
}

export default function ProcessMining() {
  const { currentProject } = useApp()
  const { mining, status, error, sim } = useResults(currentProject?.arch)
  const [sortKey, setSortKey] = useState('count')
  const [selectedCaseId, setSelectedCaseId] = useState(null)
  const [caseQuery, setCaseQuery] = useState('')

  const caseSummaries = useMemo(() => mining?.caseSummaries || [], [mining])
  const summaryById = useMemo(() => new Map(caseSummaries.map((c) => [String(c.caseId), c])), [caseSummaries])

  const filteredCases = useMemo(() => {
    const q = caseQuery.trim().toLowerCase()
    if (!q) return caseSummaries.slice(0, 40)
    return caseSummaries.filter((c) => String(c.caseId).toLowerCase().includes(q)).slice(0, 40)
  }, [caseSummaries, caseQuery])

  if (!currentProject) {
    return (
      <Card>
        <Empty
          icon={<GitBranch size={26} />}
          title="No project is open."
          hint="Traces are derived from a project's architecture, so open or create a project first."
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
          eyebrow="Process Mining"
          title={`Process Mining — ${currentProject.name}`}
          desc="Traces are reconstructed from the simulation event log and compared against the expected paths derived from the architecture graph."
        />
        <Card className="border-red">
          <div className="font-mono text-[12px] text-red">Process mining error</div>
          <div className="mt-1 text-[13px] text-ink">{error || 'Unknown mining failure.'}</div>
          <div className="mt-3 text-[12.5px] text-ink-dim">
            No mined figures are shown for a failed run. Fix the architecture in the Builder, then run a simulation to
            produce a fresh event log.
          </div>
        </Card>
      </div>
    )
  }

  if (status === 'running' && !mining) {
    return (
      <div>
        <PageHead
          eyebrow="Process Mining"
          title={`Process Mining — ${currentProject.name}`}
          desc="Traces are reconstructed from the simulation event log and compared against the expected paths derived from the architecture graph."
        />
        <Card>
          <Spinner label="Reconstructing traces from the event log…" />
        </Card>
      </div>
    )
  }

  if (!mining) {
    return (
      <div>
        <PageHead
          eyebrow="Process Mining"
          title={`Process Mining — ${currentProject.name}`}
          desc="Traces are reconstructed from the simulation event log and compared against the expected paths derived from the architecture graph."
        />
        <Card>
          <Empty
            icon={<GitBranch size={26} />}
            title="No mined traces yet."
            hint="Process mining runs on the simulation event log. Run a simulation to produce one."
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

  const stats = mining.statistics || {}
  const available = stats.available !== false && Number(stats.totalCases) > 0
  const traceDeviations = (mining.traceDeviations || []).filter((d) => d && d.category === 'trace')
  const reliabilityFindings = (mining.reliabilityFindings || []).filter((d) => d && d.category === 'reliability')
  const conformanceValue = stats.conformanceRate == null ? null : toPct(stats.conformanceRate)
  const expectedPaths = mining.expectedPaths || []
  const pathMeta = mining.expectedPathMeta || {}
  const frequentPaths = (mining.frequentPaths || []).slice(0, 8)
  const allVariants = mining.variants || []
  const bottlenecks = [...(mining.bottlenecks || [])].sort((a, b) => (b.waitRatio || 0) - (a.waitRatio || 0))
  const waitingEntries = Object.entries(mining.waitingTimes || {})
  const provenance = mining.provenance || null
  const entryCount = pathMeta.entryCount ?? (sim?.entryIds || []).length
  const terminalCount = pathMeta.terminalCount ?? (sim?.terminalIds || []).length

  const sortedVariants = [...allVariants].sort((a, b) => {
    if (sortKey === 'support') return (b.support || 0) - (a.support || 0) || (b.count || 0) - (a.count || 0)
    if (sortKey === 'length') return (a.path?.length || 0) - (b.path?.length || 0) || (b.count || 0) - (a.count || 0)
    return (b.count || 0) - (a.count || 0) || (b.support || 0) - (a.support || 0)
  })

  const frequentRows = frequentPaths.map((p, i) => ({
    key: `${i}-${(p.path || []).join('|')}`,
    cells: [
      <span key="path" className="font-mono text-[12px] text-ink">
        {(p.path || []).join(ARROW)}
      </span>,
      `${Number(p.count || 0).toLocaleString()}`,
      `${toPct(p.support).toFixed(1)}%`,
    ],
  }))

  const bottleneckRows = bottlenecks.map((b, i) => ({
    key: b.componentId || `${b.component}-${i}`,
    cells: [
      b.component,
      `${(Number(b.waitingMs) || 0).toFixed(1)} ms`,
      `${(Number(b.processingMs) || 0).toFixed(1)} ms`,
      `${(Number(b.waitRatio) || 0).toFixed(2)}x`,
      `${Number(b.queueDepthMax) || 0}`,
      <Badge key="sev" tone={severityTone(b.severity)}>
        {b.severity || 'low'}
      </Badge>,
    ],
  }))

  const waitingRows = waitingEntries.map(([name, w]) => ({
    key: name,
    cells: [
      name,
      `${Math.round(Number(w?.total) || 0).toLocaleString()} ms`,
      `${Math.round(Number(w?.avg) || 0)} ms`,
      `${Math.round(Number(w?.max) || 0)} ms`,
      `${Number(w?.count) || 0}`,
    ],
  }))

  const inspectCase = (id) => {
    setSelectedCaseId(String(id))
    const el = document.getElementById('trace-inspector')
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const selectedSummary = selectedCaseId ? summaryById.get(String(selectedCaseId)) : null

  return (
    <div>
      <PageHead
        eyebrow="Process Mining"
        title={`Process Mining — ${currentProject.name}`}
        desc="Traces are reconstructed from the simulation event log, grouped into case variants, and compared against the expected paths derived from the architecture graph."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="dim">{Number(stats.totalCases || 0).toLocaleString()} sampled cases</Badge>
            <Badge tone="dim">{allVariants.length} variants</Badge>
            {provenance?.archHash ? (
              <Badge tone="dim" className="font-mono">
                <History size={11} className="mr-1" />
                arch {provenance.archHash}
              </Badge>
            ) : null}
          </div>
        }
      />

      {provenance?.archHash || provenance?.seed != null ? (
        <div className="mb-4 rounded-[8px] border border-line-soft bg-raised px-3.5 py-2.5 text-[12px] text-ink-dim">
          <span className="font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">Source run</span>
          <span className="ml-2 font-mono text-[11.5px]">
            {provenance.archHash ? `architecture ${provenance.archHash}` : 'architecture unknown'}
            {provenance.arrivalRate != null ? ` · ${provenance.arrivalRate} req/s` : ''}
            {provenance.duration != null ? ` · requested ${provenance.duration}s` : ''}
            {provenance.truncated && provenance.simulatedMs != null
              ? ` · simulated ${((Number(provenance.simulatedMs) || 0) / 1000).toFixed(1)}s (event budget reached)`
              : ''}
            {provenance.seed != null ? ` · seed ${provenance.seed}` : ''}
            {provenance.totalRequests != null
              ? ` · ${Number(provenance.totalRequests).toLocaleString()} total requests, ${Number(stats.totalCases || 0).toLocaleString()} sampled`
              : ''}
          </span>
          <span className="ml-2 text-ink-faint">
            Results are bound to this run and architecture hash. Editing the architecture produces a new run; earlier
            results are never mixed into it.
          </span>
          {provenance.truncated ? (
            <div className="mt-1.5 rounded-[7px] border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-200">
              The engine's event budget stopped this run after{' '}
              {((Number(provenance.simulatedMs) || 0) / 1000).toFixed(1)}s of the {provenance.duration}s requested.
              Cases still in flight at that moment appear as incomplete traces below; the counts describe{' '}
              {Number(provenance.simulatedMs || 0) >= Number(provenance.duration || 0) * 1000
                ? 'the full run'
                : 'the simulated span, not the whole requested duration'}
              .
            </div>
          ) : null}
          {Number(provenance.unfinishedSampledCases || 0) > 0 ? (
            <div className="mt-1.5 text-[11.5px] text-ink-faint">
              {Number(provenance.unfinishedSampledCases).toLocaleString()} sampled case(s) were still in flight when the
              run ended. Their partial traces are kept in the sample and reported as incomplete traces.
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Cases Analysed"
          value={Number(stats.totalCases || 0).toLocaleString()}
          icon={
            <span className="flex items-center gap-1">
              <GitBranch size={14} />
              <InfoTip label="How case count is derived">
                Distinct caseIds in the sampled simulation event log after exact-duplicate events are collapsed. The
                engine samples every Nth arrival up to a 400-case cap, so this is a systematic sample of the run, not
                every simulated request.
              </InfoTip>
            </span>
          }
          delta={`${Number(stats.completedCases || 0).toLocaleString()} completed · ${Number(stats.droppedCases || 0).toLocaleString()} dropped · ${Number(stats.incompleteCases ?? stats.failedCases ?? 0).toLocaleString()} incomplete`}
        />
        <StatCard
          label="Conformance"
          value={conformanceValue == null ? '—' : `${conformanceValue.toFixed(1)}%`}
          tone={conformanceValue == null ? undefined : scoreColor(conformanceValue)}
          icon={
            <span className="flex items-center gap-1">
              <Route size={14} />
              <InfoTip label="Conformance formula">
                {mining.conformanceFormula ||
                  'conformanceRate = conformingCases / totalCases. A case conforms only if it completed, was not dropped, and its ordered activity sequence exactly matches an expected path.'}
              </InfoTip>
            </span>
          }
          delta={
            conformanceValue == null
              ? 'Not enough data to compute conformance'
              : `${Number(stats.conformingCases || 0).toLocaleString()} of ${Number(stats.totalCases || 0).toLocaleString()} cases conform · reliability findings inside conforming traces do not reduce this figure`
          }
        />
        <StatCard
          label="Trace Deviations"
          value={traceDeviations.length}
          tone={traceDeviations.length > 0 ? colors.red : undefined}
          icon={<AlertTriangle size={14} />}
          delta={
            traceDeviations.length
              ? 'Sequence-level deviations that make affected cases non-conforming — expand a row below to inspect cases'
              : 'No observed sequence deviated from the expected model'
          }
        />
        <StatCard
          label="Variants"
          value={Number(stats.variants ?? allVariants.length)}
          icon={<ListTree size={14} />}
          delta={`average case length ${(Number(stats.avgCaseLength) || 0).toFixed(1)} activities · ${reliabilityFindings.length} reliability finding${reliabilityFindings.length === 1 ? '' : 's'} did not reduce conformance`}
        />
      </div>

      {!available ? (
        <Card className="mb-5">
          <Empty
            icon={<ScrollText size={26} />}
            title="No process data available."
            hint="The simulation produced no completed cases in the event log, so conformance, variants and deviations cannot be computed. Run a simulation with a non-zero arrival rate against a valid architecture."
          />
        </Card>
      ) : null}

      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card
          title="Expected paths"
          sub={`Enumerated by depth-first walk from the ${entryCount} entry node(s) to the ${terminalCount} terminal node(s).`}
        >
          {pathMeta.truncated ? (
            <div className="mb-3 rounded-[7px] border border-accent/40 bg-accent/8 px-3 py-2 text-[12px] text-ink-dim">
              <AlertTriangle size={12} className="mr-1 inline text-accent" />
              Enumeration stopped at the {pathMeta.limit}-path budget, so this list is a subset of the routes the graph
              admits. Conformance is checked only against the paths shown; a case walking an unenumerated route is
              reported as a path mismatch.
            </div>
          ) : null}
          {pathMeta.hasCycles ? (
            <div className="mb-3 rounded-[7px] border border-line-soft bg-raised px-3 py-2 text-[12px] text-ink-dim">
              This graph contains a cycle. The walk never re-enters a node already on the active path, so enumeration
              always terminates; the engine separately caps traversal depth at 40 steps per case.
            </div>
          ) : null}
          {expectedPaths.length ? (
            <div className="space-y-2">
              {expectedPaths.map((path, i) => (
                <div key={`exp-${i}`} className="rounded-[7px] border border-line-soft bg-raised px-3 py-2">
                  <PathList names={(path || []).map((step) => (typeof step === 'string' ? step : step?.name))} />
                </div>
              ))}
            </div>
          ) : (
            <div className="py-6 text-center text-[12.5px] text-ink-faint">
              No expected path could be enumerated from this graph.
            </div>
          )}
          <div className="mt-3 border-t border-line-soft pt-3 text-[11.5px] text-ink-faint">
            Graph shape: {entryCount} entr{entryCount === 1 ? 'y' : 'ies'}, {terminalCount} terminal node
            {terminalCount === 1 ? '' : 's'}
            {pathMeta.hasCycles ? ', cycle present' : ''}. Branching and shared components each produce a distinct
            path; alternative routes are legitimate, not deviations.
          </div>
        </Card>

        <Card title="Observed frequent paths" sub="Collapsed case variants ranked by case count and support.">
          <div className="mb-3 flex items-center gap-2">
            <span className="font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">Sort by</span>
            {[
              { key: 'count', label: 'Cases' },
              { key: 'support', label: 'Support' },
              { key: 'length', label: 'Length' },
            ].map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setSortKey(opt.key)}
                className={`cursor-pointer rounded-[5px] border px-2 py-1 font-mono text-[11px] transition ${
                  sortKey === opt.key ? 'border-accent text-accent' : 'border-line-soft text-ink-faint hover:text-ink'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {frequentPaths.length ? (
            <div className="mb-4">
              <DataTable headers={['Trace', 'Cases', 'Support']} rows={frequentRows} empty="No traces observed." />
            </div>
          ) : (
            <div className="py-6 text-center text-[12.5px] text-ink-faint">No traces observed.</div>
          )}
          <div className="border-t border-line-soft pt-3.5">
            <div className="mb-2 font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">
              Variant case counts
            </div>
            <PathSupportChart paths={sortedVariants} height={170} />
          </div>
        </Card>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card
          title="Deviations"
          sub="Findings are split by whether they changed the executed sequence (trace, affects conformance) or were recovered inside a conforming trace (reliability)."
        >
          {traceDeviations.length || reliabilityFindings.length ? (
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex items-center gap-2 font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">
                  <AlertTriangle size={12} className="text-red" />
                  Trace deviations · {traceDeviations.length}
                </div>
                {traceDeviations.length ? (
                  <div className="space-y-3">
                    {traceDeviations.map((d, i) => (
                      <DeviationRow
                        key={`trace-${d.type}-${i}`}
                        deviation={d}
                        totalCases={stats.totalCases || 0}
                        onInspectCase={inspectCase}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[7px] border border-line-soft bg-raised px-3 py-2.5 text-[12.5px] text-ink-dim">
                    No sequence-level deviations. Every observed activity sequence matched an expected path (or was a
                    reliability event inside one).
                  </div>
                )}
              </div>
              <div>
                <div className="mb-2 flex items-center gap-2 font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">
                  <TrendingUp size={12} className="text-ink-faint" />
                  Reliability findings · {reliabilityFindings.length}
                </div>
                {reliabilityFindings.length ? (
                  <div className="space-y-3">
                    {reliabilityFindings.map((d, i) => (
                      <DeviationRow
                        key={`rel-${d.type}-${i}`}
                        deviation={d}
                        totalCases={stats.totalCases || 0}
                        onInspectCase={inspectCase}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[7px] border border-line-soft bg-raised px-3 py-2.5 text-[12.5px] text-ink-dim">
                    No failures, retries or queueing episodes were recorded in the sample.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="py-6 text-center text-[12.5px] text-ink-faint">
              No deviations were detected. Executed traces conform to the expected model.
            </div>
          )}
        </Card>

        <Card title="Bottlenecks" sub="Components ranked by the ratio of waiting time to processing time.">
          <div className="mb-4">
            <BottleneckChart bottlenecks={bottlenecks} height={190} />
          </div>
          <DataTable
            headers={['Component', 'Waiting', 'Processing', 'Wait ratio', 'Max queue', 'Severity']}
            rows={bottleneckRows}
            empty="No queueing bottleneck detected."
          />
        </Card>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div id="trace-inspector">
          <Card
            title="Trace inspector"
            sub="Pick a sampled case to replay its event timeline in order."
          >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              className={`${inputClass} max-w-56`}
              placeholder="Filter by case id…"
              value={caseQuery}
              onChange={(e) => setCaseQuery(e.target.value)}
              aria-label="Filter cases by id"
            />
            <select
              className={`${inputClass} max-w-64`}
              value={selectedCaseId ?? ''}
              onChange={(e) => setSelectedCaseId(e.target.value || null)}
              aria-label="Select a case to inspect"
            >
              <option value="">Choose a case…</option>
              {filteredCases.map((c) => (
                <option key={c.caseId} value={c.caseId}>
                  case {c.caseId} · {c.outcome} · {c.activityCount} activities
                  {c.deviationTypes?.length ? ` · ${c.deviationTypes.length} finding(s)` : ''}
                </option>
              ))}
            </select>
          </div>
          {selectedCaseId ? (
            <TraceTimeline
              caseId={selectedCaseId}
              events={sim?.eventLog || []}
              outcome={selectedSummary?.outcome}
              path={selectedSummary?.path}
            />
          ) : (
            <div className="py-6 text-center text-[12.5px] text-ink-faint">
              Select a case to see its ordered events with timestamps.
            </div>
          )}
          </Card>
        </div>

        <Card title="Waiting times" sub="Aggregated queue residence time per component across all sampled cases.">
          <DataTable
            headers={['Component', 'Total', 'Average', 'Max', 'Count']}
            rows={waitingRows}
            empty="No waiting time recorded."
          />
        </Card>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title="How this was derived" sub="Method statement for reproducibility.">
          <ol className="mb-3.5 space-y-2 text-[13px] text-ink-dim">
            {[
              'Events from the discrete event engine were grouped by caseId, discarding the sampling step so each request is one case; exact duplicate events (same case, activity, component and timestamp) are collapsed.',
              'Within a case, events were sorted by timestamp (original order as tie-break) to reconstruct the executed activity sequence; consecutive events on the same component collapse to one step.',
              'Sequences were collapsed to unique variants; each variant was counted and its support computed against the sampled case total.',
              'Expected paths were enumerated by depth-first walk of the architecture graph from every entry node to every terminal node, cutting cycles by refusing to re-enter a node already on the active path and reporting when the path budget truncates the model.',
              'A case conforms only when it completed (REQUEST_COMPLETE), was not dropped, and its sequence matches an expected path exactly. Dropped, incomplete and path-mismatched cases are non-conforming and count in the denominator. Reliability findings (failures, retries, queueing) inside a case that still completed an expected path are reported but do not reduce conformance.',
              'Bottlenecks are ranked by the wait ratio (waiting ms ÷ processing ms, both shown to one decimal so the ratio is directly checkable), with severity assigned from the wait ratio and the observed maximum queue depth.',
            ].map((step, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="font-mono text-[11px] text-accent">{String(i + 1).padStart(2, '0')}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <div className="rounded-[8px] border border-line-soft bg-raised p-3">
            <div className="mb-1 flex items-center gap-2 font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">
              <Lightbulb size={12} />
              Sampling caveat
            </div>
            <p className="text-[12.5px] text-ink-dim">
              The engine emits a deterministic sample of the event log, capped at 400 cases. The sample is chosen by
              seed, so repeating a run with the same seed reproduces exactly the same traces, but the mined figures
              describe the sample rather than every simulated case. Where the engine reports{' '}
              {Number(stats.totalRequests || provenance?.totalRequests || 0).toLocaleString()} total requests, the{' '}
              {Number(stats.totalCases || 0).toLocaleString()} analysed cases are the systematic sample drawn from them.
              Sampled cases that were still in flight when the run ended are kept as incomplete traces rather than
              dropped, and the outcome counts above always show zeros explicitly when an outcome was not observed.
            </p>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-[8px] border border-line-soft bg-raised p-3">
              <div className="mb-1 font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">Max wait</div>
              <div className="font-mono text-[17px] text-ink">{Math.round(Number(stats.maxWaitMs) || 0)} ms</div>
            </div>
            <div className="rounded-[8px] border border-line-soft bg-raised p-3">
              <div className="mb-1 font-mono text-[10.5px] tracking-wider text-ink-faint uppercase">Avg case length</div>
              <div className="font-mono text-[17px] text-ink">{(Number(stats.avgCaseLength) || 0).toFixed(1)}</div>
            </div>
          </div>
        </Card>

        <Card title="Conformance &amp; findings summary" sub="How the headline numbers relate to one another.">
          <div className="space-y-2.5 text-[13px] text-ink-dim">
            <div className="rounded-[7px] border border-line-soft bg-raised px-3 py-2.5">
              <span className="font-mono text-[11.5px] text-ink">Conformance</span>{' '}
              {conformanceValue == null
                ? 'is unavailable — the log contained no assessable cases.'
                : `= ${Number(stats.conformingCases || 0).toLocaleString()} conforming ÷ ${Number(stats.totalCases || 0).toLocaleString()} total sampled cases = ${conformanceValue.toFixed(1)}%.`}
            </div>
            <div className="rounded-[7px] border border-line-soft bg-raised px-3 py-2.5">
              <span className="font-mono text-[11.5px] text-ink">Trace deviations</span> ({traceDeviations.length}) are
              sequence-level findings — dropped, incomplete, unexpected or skipped components, or completed paths that
              match no expected route. Each one makes its affected cases non-conforming.
            </div>
            <div className="rounded-[7px] border border-line-soft bg-raised px-3 py-2.5">
              <span className="font-mono text-[11.5px] text-ink">Reliability findings</span> ({reliabilityFindings.length}){' '}
              are failures, retries and queueing episodes. When the trace still completed an expected path they are
              reported here without reducing conformance, so a 100% conformance figure can coexist with non-zero
              reliability findings — they measure different things.
            </div>
            <div className="rounded-[7px] border border-line-soft bg-raised px-3 py-2.5">
              <span className="font-mono text-[11.5px] text-ink">Variants</span> count distinct ordered activity
              sequences actually observed. A single-variant result means every sampled case walked the same collapsed
              path; branching architectures legitimately produce more.
            </div>
          </div>
        </Card>
      </div>

      {bottlenecks.length ? (
        <Card
          title="Bottleneck share of total waiting time"
          sub="Each component's average wait as a share of the sum of average waits across bottlenecks."
        >
          {(() => {
            const totalWait = bottlenecks.reduce((sum, b) => sum + (Number(b.waitingMs) || 0), 0)
            return bottlenecks.map((b) => {
              const share = totalWait > 0 ? ((Number(b.waitingMs) || 0) / totalWait) * 100 : 0
              return (
                <UtilBar
                  key={b.componentId || b.component}
                  value={share}
                  label={b.component}
                  right={`${share.toFixed(1)}% of ${(Math.round(totalWait) || 0).toLocaleString()} ms total wait · ${(
                    Number(b.waitRatio) || 0
                  ).toFixed(2)}x wait ratio`}
                />
              )
            })
          })()}
        </Card>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link
          to="/simulation"
          className="inline-flex items-center gap-2 rounded-[7px] border border-line bg-raised px-3.5 py-2 text-[13px] font-semibold text-ink"
        >
          <Timer size={14} />
          Change the workload
        </Link>
        <span className="flex items-center gap-1.5 text-[11.5px] text-ink-faint">
          <Award size={12} />
          These findings feed the Process Efficiency dimension of the health score.
        </span>
      </div>
    </div>
  )
}
