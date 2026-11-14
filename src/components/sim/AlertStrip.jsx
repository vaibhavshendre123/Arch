import { CircleAlert, Info, TriangleAlert } from 'lucide-react'

const TONES = {
  red: { border: 'border-red/40', bg: 'bg-red/8', text: 'text-red', Icon: CircleAlert },
  amber: { border: 'border-accent/40', bg: 'bg-accent/8', text: 'text-accent', Icon: TriangleAlert },
  info: { border: 'border-blue/30', bg: 'bg-blue/8', text: 'text-blue', Icon: Info },
}

/**
 * Alerts raised from the engine's own metrics and per-component statistics.
 * Each entry carries the measurement that raised it; nothing here is heuristic
 * decoration. An empty list renders a calm "all clear" line rather than nothing,
 * so the absence of alerts is itself visible.
 */
export default function AlertStrip({ alerts = [], pending = false }) {
  if (!alerts.length) {
    if (pending) {
      return (
        <div className="rounded-[7px] border border-dim/40 bg-dim/5 px-3 py-2.5 text-[12.5px] text-ink-faint">
          Nothing has run yet. Alerts are raised only from measurements, so this list stays
          empty until a run produces numbers.
        </div>
      )
    }
    return (
      <div className="rounded-[7px] border border-green/30 bg-green/8 px-3 py-2.5 text-[12.5px] text-ink-dim">
        No saturation, truncation or loss alerts for this run. Every component stayed inside its
        configured limits and the engine completed the requested duration.
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {alerts.map((alert, i) => {
        const tone = TONES[alert.tone] || TONES.info
        const Icon = tone.Icon
        return (
          <div key={`${alert.title}-${i}`} className={`flex gap-2.5 rounded-[7px] border ${tone.border} ${tone.bg} px-3 py-2.5`}>
            <Icon size={14} className={`mt-0.5 shrink-0 ${tone.text}`} />
            <div className="min-w-0">
              <div className={`text-[12.5px] font-semibold ${tone.text}`}>{alert.title}</div>
              <div className="mt-0.5 text-[12px] text-ink-dim">{alert.reason}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Build the alert list for a run. Pure function over the engine result, so the
 * same numbers always raise the same alerts.
 */
export function buildAlerts(sim) {
  if (!sim) return []
  const alerts = []
  const metrics = sim.metrics || {}
  const components = Object.values(sim.components || {})

  if (sim.truncated) {
    alerts.push({
      tone: 'amber',
      title: 'Event budget exhausted',
      reason: `The engine stopped after simulating ${((sim.simulatedMs || 0) / 1000).toFixed(1)} s of the ${Number(sim.duration || 0).toFixed(0)} s requested, because the run hit the ${Number(metrics.totalEvents || sim.loggingStats?.totalEvents || 0).toLocaleString()}-event processing cap. Cases still in flight at that moment are reported as failed or incomplete.`,
    })
  }

  const dropped = Number(metrics.droppedRequests) || 0
  if (dropped > 0) {
    alerts.push({
      tone: dropped > metrics.totalRequests * 0.05 ? 'red' : 'amber',
      title: `${dropped.toLocaleString()} request${dropped === 1 ? '' : 's'} dropped`,
      reason: `Drop rate ${((dropped / Math.max(1, metrics.totalRequests)) * 100).toFixed(2)}%. Requests were dropped when a component's queue was already at its configured limit.`,
    })
  }

  const failed = Number(metrics.failedRequests) || 0
  if (failed > 0) {
    alerts.push({
      tone: failed > metrics.totalRequests * 0.05 ? 'red' : 'amber',
      title: `${failed.toLocaleString()} request${failed === 1 ? '' : 's'} failed`,
      reason: `Failure rate ${((failed / Math.max(1, metrics.totalRequests)) * 100).toFixed(2)}%. Counts permanent failures plus cases still in flight when the run ended.`,
    })
  }

  for (const c of components) {
    const util = (Number(c.utilization) || 0) * 100
    if (util > 85) {
      alerts.push({
        tone: 'red',
        title: `${c.name || c.id} is overloaded`,
        reason: `Utilisation reached ${util.toFixed(1)}% of its ${c.capacity} slot${c.capacity === 1 ? '' : 's'} over the simulated span, with a peak queue of ${c.queueLengthMax ?? 0}.`,
      })
    }
    const cap = Number(c.queueCapacity)
    if (Number.isFinite(cap) && cap > 0 && cap < 1000 && (c.queueLengthMax || 0) >= cap) {
      alerts.push({
        tone: 'red',
        title: `Queue saturated at ${c.name || c.id}`,
        reason: `The queue hit its configured limit of ${cap} waiting requests (peak observed: ${c.queueLengthMax}). Further arrivals at that moment were dropped.`,
      })
    }
    const wait = Number(c.avgQueueWaitMs) || 0
    if (wait >= 1000) {
      alerts.push({
        tone: 'amber',
        title: `Excessive waiting at ${c.name || c.id}`,
        reason: `Requests waited ${wait.toFixed(0)} ms on average in its queue — over a second of pure queue residence per visit.`,
      })
    }
  }

  return alerts
}
