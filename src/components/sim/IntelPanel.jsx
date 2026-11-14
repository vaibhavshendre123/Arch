import { Badge } from '../ui.jsx'
import { colors } from '../../theme/tokens.js'
import { utilPct } from '../../lib/metrics.js'
import { componentState } from '../ArchitectureFlow.jsx'

const NOT_MEASURED = 'Not measured'

function Row({ label, value, tone }) {
  const missing = value == null || value === NOT_MEASURED
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line-soft py-1.5 first:border-t-0">
      <dt className="text-[12px] text-ink-faint">{label}</dt>
      <dd
        className={`truncate font-mono text-[12px] ${missing ? 'text-ink-faint italic' : 'text-ink'}`}
        style={tone ? { color: tone } : undefined}
      >
        {missing ? NOT_MEASURED : value}
      </dd>
    </div>
  )
}

/**
 * Component intelligence: every figure is read from the engine's per-component
 * result for the run on screen. Anything the engine does not measure is shown as
 * "Not measured" rather than estimated.
 *
 * `liveLoad` is the count of in-flight sampled requests inside this component at
 * the playback head, taken from the same trajectories the animation draws. It is
 * explicitly labelled as sampled.
 */
export default function IntelPanel({ node, stat, liveLoad = null }) {
  if (!node) {
    return (
      <div className="py-6 text-center text-[12.5px] text-ink-faint">
        Select a component in the architecture arena to inspect its measured behaviour.
      </div>
    )
  }

  const state = componentState(stat)
  const util = stat && typeof stat.utilization === 'number' ? utilPct(stat.utilization) : null

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <div className="text-[14px] font-semibold text-ink">{node.name || node.id}</div>
          <div className="font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">{node.type}</div>
        </div>
        <Badge tone={state.key === 'over' ? 'red' : state.key === 'press' ? 'amber' : state.key === 'healthy' ? 'green' : 'dim'}>
          {state.label}
        </Badge>
      </div>

      {!stat ? (
        <div className="rounded-[7px] border border-line-soft bg-raised px-3 py-2.5 text-[12px] text-ink-faint">
          The engine recorded no statistics for this component in the run on screen.
        </div>
      ) : (
        <dl>
          <Row
            label="Utilisation"
            value={util == null ? NOT_MEASURED : `${util.toFixed(1)}%`}
            tone={util == null ? undefined : state.color}
          />
          <Row
            label="In flight now (sampled)"
            value={liveLoad == null ? NOT_MEASURED : `~${Number(liveLoad).toLocaleString()}`}
          />
          <Row label="Peak queue depth" value={stat.queueLengthMax != null ? String(stat.queueLengthMax) : NOT_MEASURED} />
          <Row
            label="Avg queue wait"
            value={stat.avgQueueWaitMs != null ? `${Number(stat.avgQueueWaitMs).toFixed(1)} ms` : NOT_MEASURED}
          />
          <Row label="Max queue wait" value={NOT_MEASURED} />
          <Row
            label="Avg processing time"
            value={stat.avgProcessingMs != null ? `${Number(stat.avgProcessingMs).toFixed(1)} ms` : NOT_MEASURED}
          />
          <Row label="Visits" value={stat.visits != null ? Number(stat.visits).toLocaleString() : NOT_MEASURED} />
          <Row
            label="Throughput"
            value={stat.throughputPerSec != null ? `${Number(stat.throughputPerSec).toFixed(2)} req/s` : NOT_MEASURED}
          />
          <Row
            label="Failed (permanent)"
            value={stat.failures != null ? Number(stat.failures).toLocaleString() : NOT_MEASURED}
            tone={stat.failures > 0 ? colors.red : undefined}
          />
          <Row label="Retries" value={stat.retries != null ? Number(stat.retries).toLocaleString() : NOT_MEASURED} />
          <Row
            label="Dropped"
            value={stat.dropped != null ? Number(stat.dropped).toLocaleString() : NOT_MEASURED}
            tone={stat.dropped > 0 ? colors.accent : undefined}
          />
          <Row
            label="Memory used"
            value={stat.memoryUsedMb != null ? `${Math.round(stat.memoryUsedMb)} MB` : NOT_MEASURED}
          />
          <Row
            label="Memory limit"
            value={stat.memoryLimitMb != null ? `${Math.round(stat.memoryLimitMb)} MB` : NOT_MEASURED}
          />
          <Row
            label="Completed requests"
            value={NOT_MEASURED}
          />
        </dl>
      )}

      <p className="mt-3 text-[11px] text-ink-faint">
        The engine does not track per-component completion counts or maximum queue wait; those rows stay
        marked as not measured rather than being estimated. Queue depth and in-flight counts during
        playback come from the sampled event log.
      </p>
    </div>
  )
}
