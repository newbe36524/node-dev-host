import { useNow } from "@/hooks/useNow"
import { cn } from "@/lib/utils"
import {
  type ChangeEvent,
  formatSpan,
  type Lane,
  type LaneState,
  laneSegments,
  type SessionLog,
  timelineWindow,
} from "@/lib/fleet"

// The track only carries the same three signals as everywhere else. The words live beside it:
// the current state at the end of each lane, and the last few changes spelled out below.
const FILL: Record<LaneState, string> = {
  ok: "bg-emerald-700",
  building: "bg-sky-700",
  failed: "bg-destructive",
  starting: "bg-muted-foreground/60",
  waiting: "bg-muted-foreground/45",
  unknown: "bg-muted-foreground/45",
  stopped: "bg-muted-foreground/30",
  removed: "border border-dashed border-muted-foreground/60 bg-transparent",
}

const RECENT = 5
/** Lanes drawn at most. A fleet of fifty with a bad hour must not turn this into a second table. */
const MAX_LANES = 10

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function describe(change: ChangeEvent): string {
  if (change.to === "removed") return `${change.name} was removed (was ${change.from})`
  if (change.from === null) return `${change.name} appeared as ${change.to}`
  return `${change.name} went from ${change.from} to ${change.to}`
}

function currentState(lane: Lane): LaneState {
  return lane.spans[lane.spans.length - 1].state
}

/** What this browser tab has seen change since it was opened. It is not server history, and says so. */
export function SessionTimeline({ log }: { log: SessionLog }) {
  const now = useNow()
  if (log.order.length === 0) return null

  const win = timelineWindow(log, now)
  const recent = log.changes.slice(-RECENT).reverse()
  // Only lanes that moved are drawn, the most recently moved first. A steady container is a flat bar and says nothing.
  const moved = log.order
    .map((id) => log.lanes[id])
    .filter((lane) => lane.spans.length > 1)
    .sort((a, b) => b.spans[b.spans.length - 1].from - a.spans[a.spans.length - 1].from)
  const lanes = moved.slice(0, MAX_LANES)
  const steady = log.order.length - moved.length

  return (
    <section aria-labelledby="timeline-title" className="space-y-3" data-testid="session-timeline">
      <div>
        <h2 id="timeline-title" className="text-sm font-medium">
          Session timeline
        </h2>
        <p className="text-xs text-muted-foreground">
          Since you opened this page at <time dateTime={new Date(log.startedAt).toISOString()}>{clock(log.startedAt)}</time>.
          The server keeps no history, so earlier changes are not shown.
        </p>
      </div>

      {lanes.length > 0 && (
      <div className="space-y-1.5">
        {lanes.map((lane) => {
          const state = currentState(lane)
          return (
            <div key={lane.id} className="grid grid-cols-[minmax(0,8rem)_1fr_4.5rem] items-center gap-3 text-xs">
              <span className="truncate font-medium" title={lane.name}>
                {lane.name}
              </span>
              <div className="relative h-3 overflow-hidden rounded-sm bg-muted" role="img" aria-label={`${lane.name} is ${state}`}>
                {laneSegments(lane, win, now).map((seg, i) => (
                  <span
                    key={i}
                    className={cn("absolute inset-y-0 box-border", FILL[seg.state])}
                    style={{ left: `${seg.left}%`, width: `${seg.width}%` }}
                    title={seg.state}
                  />
                ))}
              </div>
              <span className="truncate text-muted-foreground">{state}</span>
            </div>
          )
        })}
        <div className="grid grid-cols-[minmax(0,8rem)_1fr_4.5rem] gap-3 text-[11px] text-muted-foreground" aria-hidden="true">
          <span />
          <span className="tabular flex justify-between">
            <span>{formatSpan(win.end - win.start)} ago</span>
            <span>now</span>
          </span>
          <span />
        </div>
        <p className="text-xs text-muted-foreground" data-testid="timeline-footnote">
          {moved.length > lanes.length && `${moved.length - lanes.length} more changed and are not drawn. `}
          {steady > 0 && `${steady} ${steady === 1 ? "container has" : "containers have"} not changed and ${steady === 1 ? "is" : "are"} not drawn.`}
        </p>
      </div>
      )}

      {recent.length === 0 ? (
        <p className="text-xs text-muted-foreground">No state changes since you opened this page.</p>
      ) : (
        <ol className="space-y-0.5 text-xs" aria-label="Recent state changes">
          {recent.map((change, i) => (
            <li key={`${change.id}-${change.at}-${i}`} className="flex gap-2">
              <time dateTime={new Date(change.at).toISOString()} className="shrink-0 text-muted-foreground">
                {clock(change.at)}
              </time>
              <span className={cn(change.to === "failed" && "font-medium text-destructive")}>{describe(change)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
