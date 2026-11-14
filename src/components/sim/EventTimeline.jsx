import { useMemo, useState } from 'react'
import { Badge } from '../ui.jsx'

const MAX_ROWS = 60

// Visual tone per activity family. Text label stays the activity name from the log.
const TONE = {
  REQUEST_ARRIVAL: 'blue',
  QUEUE_ENTER: 'dim',
  QUEUE_EXIT: 'dim',
  PROCESS_START: 'purple',
  PROCESS_COMPLETE: 'green',
  RETRY: 'amber',
  FAILURE: 'red',
  REQUEST_DROPPED: 'red',
  REQUEST_COMPLETE: 'green',
  TRANSIT: 'dim',
}

const FILTER_LABELS = {
  REQUEST_ARRIVAL: 'arrivals',
  QUEUE_ENTER: 'queue in',
  PROCESS_START: 'processing',
  PROCESS_COMPLETE: 'processed',
  RETRY: 'retries',
  FAILURE: 'failures',
  REQUEST_DROPPED: 'dropped',
  REQUEST_COMPLETE: 'completed',
}

/**
 * The simulation event log as a filterable timeline. Rows are the engine's own
 * logged events with their real timestamps; the filter only hides rows, never
 * reorders or invents them. Selecting a row reveals the full event record.
 */
export default function EventTimeline({ eventLog = [], headSec = null }) {
  const [active, setActive] = useState(() => new Set())
  const [selectedKey, setSelectedKey] = useState(null)

  const kinds = useMemo(() => {
    const seen = new Map()
    for (const e of eventLog) {
      if (!seen.has(e.activity)) seen.set(e.activity, 0)
      seen.set(e.activity, seen.get(e.activity) + 1)
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1])
  }, [eventLog])

  const rows = useMemo(() => {
    const filtered = active.size ? eventLog.filter((e) => active.has(e.activity)) : eventLog
    return filtered.slice(0, MAX_ROWS)
  }, [eventLog, active])

  const selected = useMemo(
    () => (selectedKey == null ? null : eventLog.find((e) => String(e.eventId ?? e.caseId) + ':' + e.timestamp === selectedKey) || null),
    [eventLog, selectedKey],
  )

  const toggle = (activity) => {
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(activity)) next.delete(activity)
      else next.add(activity)
      return next
    })
  }

  if (!eventLog.length) {
    return <div className="py-8 text-center text-[12.5px] text-ink-faint">No events logged for this view.</div>
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">filter</span>
        {kinds.map(([activity, count]) => {
          const on = active.has(activity)
          return (
            <button
              key={activity}
              type="button"
              onClick={() => toggle(activity)}
              aria-pressed={on}
              className={`rounded-[5px] border px-2 py-0.5 font-mono text-[10.5px] transition ${
                on ? 'border-accent bg-accent/15 text-accent' : 'border-line-soft bg-raised text-ink-faint hover:text-ink'
              }`}
            >
              {FILTER_LABELS[activity] || activity.toLowerCase()} · {count.toLocaleString()}
            </button>
          )
        })}
        {active.size ? (
          <button
            type="button"
            onClick={() => setActive(new Set())}
            className="rounded-[5px] px-2 py-0.5 font-mono text-[10.5px] text-ink-faint underline transition hover:text-ink"
          >
            clear
          </button>
        ) : null}
      </div>

      <div className="max-h-[240px] overflow-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {['Case', 'Activity', 'Component', 'Status', 't'].map((h) => (
                <th
                  key={h}
                  className="px-2.5 pb-2 text-left font-mono text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => {
              const key = `${e.eventId ?? e.caseId}:${e.timestamp}`
              const ts = Number(e.timestamp) || 0
              // Events after the playback head are dimmed while the replay runs, so the
              // timeline reads as a scrubber's companion rather than an unrelated list.
              const past = headSec == null || ts / 1000 <= headSec
              const isSelected = selectedKey === key
              return (
                <tr
                  key={key || i}
                  onClick={() => setSelectedKey(isSelected ? null : key)}
                  className={`cursor-pointer transition hover:bg-white/[0.02] ${isSelected ? 'bg-accent/8' : ''} ${
                    past ? '' : 'opacity-45'
                  }`}
                >
                  <td className="border-t border-line-soft px-2.5 py-1.5 font-mono text-[12px] text-ink-dim">{e.caseId}</td>
                  <td className="border-t border-line-soft px-2.5 py-1.5">
                    <Badge tone={TONE[e.activity] || 'dim'}>{e.activity}</Badge>
                  </td>
                  <td className="border-t border-line-soft px-2.5 py-1.5 text-[12.5px] text-ink">
                    {e.componentName || e.componentId || '—'}
                  </td>
                  <td className="border-t border-line-soft px-2.5 py-1.5 font-mono text-[11.5px] text-ink-dim">{e.status || '—'}</td>
                  <td className="border-t border-line-soft px-2.5 py-1.5 font-mono text-[12px] text-ink">
                    {(ts / 1000).toFixed(2)} s
                    <span className="ml-1.5 text-ink-faint">({Math.round(ts)} ms)</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {selected ? (
        <div className="mt-3 rounded-[7px] border border-line-soft bg-raised px-3 py-2.5">
          <div className="mb-1.5 font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">event detail</div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-3">
            {[
              ['Event id', String(selected.eventId ?? '—')],
              ['Case', String(selected.caseId ?? '—')],
              ['Activity', selected.activity],
              ['Component', selected.componentName || selected.componentId || '—'],
              ['Status', selected.status || '—'],
              ['Simulation time', `${((Number(selected.timestamp) || 0) / 1000).toFixed(3)} s`],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <dt className="text-ink-faint">{k}</dt>
                <dd className="truncate font-mono text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  )
}
