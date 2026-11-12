import { useRef, useState } from "react"
import { Check, TriangleAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ContainerInfo } from "@/lib/api"
import { badgeState, type BuildBadgeState, STATE_ORDER, summarize } from "@/lib/fleet"

// Each segment is a status cell, not a decoration: fill = signal hue, word = the state, so it still
// reads in greyscale. Failed is the only one with a heavy outline, and it is the only one that pulses.
const SEGMENT: Record<BuildBadgeState, string> = {
  ok: "bg-emerald-700 text-white",
  building: "bg-sky-700 text-white",
  failed: "bg-destructive/10 text-destructive ring-2 ring-inset ring-destructive",
  starting: "bg-secondary text-secondary-foreground",
  waiting: "border border-muted-foreground/50 text-foreground",
  unknown: "border border-muted-foreground/50 text-muted-foreground",
  stopped: "border border-dashed border-muted-foreground/60 text-muted-foreground",
}

/** Up to this many containers each segment is a labelled tile. Past it the band becomes a dense matrix. */
export const TILE_LIMIT = 12

interface FleetRibbonProps {
  /** Every container, in the order the host reports them. The matrix keeps this order so a cell never moves. */
  containers: ContainerInfo[]
  /** The container the keyboard cursor is on. */
  selectedId?: string
  /** Ticked for a batch. */
  checked?: ReadonlySet<string>
  /** Containers the current filter shows. Others stay on the matrix but step back. Undefined means all. */
  visibleIds?: ReadonlySet<string>
  /** States the filter is limited to. The counts in the summary are the buttons that set it. */
  activeStates?: BuildBadgeState[]
  /** When each container last changed state in this session. A failed segment pings once when it has one. */
  changedAt?: Record<string, number>
  onSelect?: (id: string) => void
  /** Shift or Ctrl/Cmd on a cell ticks it for a batch. */
  onTick?: (id: string) => void
  onToggleState?: (state: BuildBadgeState) => void
}

/** One band for the whole host: a segment per container, with the totals above it. */
export function FleetRibbon({
  containers,
  selectedId,
  checked,
  visibleIds,
  activeStates = [],
  changedAt = {},
  onSelect,
  onTick,
  onToggleState,
}: FleetRibbonProps) {
  const [probe, setProbe] = useState<string>()
  const listRef = useRef<HTMLUListElement>(null)
  if (containers.length === 0) return null
  const counts = summarize(containers)
  // A state the filter is on stays in the list even when nothing is in it any more, so it can be switched off.
  const present = STATE_ORDER.filter((s) => counts[s] > 0 || activeStates.includes(s))
  const compact = containers.length > TILE_LIMIT
  const probed = containers.find((c) => c.id === (probe ?? selectedId))
  const tabStop = containers.find((c) => c.id === selectedId)?.id ?? containers[0].id

  function press(event: React.MouseEvent, id: string) {
    if ((event.shiftKey || event.ctrlKey || event.metaKey) && onTick) onTick(id)
    else onSelect?.(id)
  }

  // One tab stop for the whole matrix; the arrows move inside it, so fifty cells do not cost fifty Tab presses.
  function onKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    const cells = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-cell]") ?? [])
    const at = cells.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    const rowWidth = cells.findIndex((c) => c.offsetTop !== cells[0].offsetTop)
    const columns = rowWidth < 0 ? cells.length : rowWidth
    const delta: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }
    let target: number | undefined
    if (event.key in delta) target = at + delta[event.key]
    else if (event.key === "Home") target = 0
    else if (event.key === "End") target = cells.length - 1
    if (target === undefined) return
    event.preventDefault()
    cells[Math.max(0, Math.min(cells.length - 1, target))]?.focus()
  }

  return (
    <section aria-label="Fleet status" className="space-y-2" data-testid="fleet-ribbon">
      <p className="tabular flex flex-wrap gap-x-1 gap-y-1 text-sm text-muted-foreground" data-testid="fleet-summary">
        {present.map((state) => {
          const on = activeStates.includes(state)
          return (
            <button
              key={state}
              type="button"
              aria-pressed={on}
              aria-label={`${counts[state]} ${state}, ${on ? "showing only these" : "show only these"}`}
              onClick={() => onToggleState?.(state)}
              className={cn(
                "rounded-md px-2 py-1 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                "aria-pressed:bg-muted aria-pressed:font-medium aria-pressed:text-foreground aria-pressed:underline aria-pressed:decoration-2 aria-pressed:underline-offset-4",
                state === "failed" && "font-medium text-destructive hover:text-destructive",
              )}
            >
              {counts[state]} {state}
            </button>
          )
        })}
      </p>
      <ul ref={listRef} onKeyDown={compact ? onKeyDown : undefined} className="flex flex-wrap gap-1">
        {containers.map((c) => {
          const state = badgeState(c)
          const selected = c.id === selectedId
          const ticked = checked?.has(c.id) ?? false
          const dim = visibleIds !== undefined && !visibleIds.has(c.id)
          const ping = state === "failed" && changedAt[c.id] !== undefined && "fault-ping"
          return (
            <li key={c.id} className={compact ? "shrink-0" : "min-w-0 grow basis-28"}>
              <button
                type="button"
                data-cell
                data-state={state}
                data-dim={dim || undefined}
                data-ticked={ticked || undefined}
                aria-label={`${c.name}: ${state}`}
                aria-pressed={selected}
                title={`${c.name}: ${state}`}
                tabIndex={compact && c.id !== tabStop ? -1 : undefined}
                onClick={(event) => press(event, c.id)}
                onMouseEnter={() => setProbe(c.id)}
                onMouseLeave={() => setProbe(undefined)}
                onFocus={() => setProbe(c.id)}
                onBlur={() => setProbe(undefined)}
                className={cn(
                  "relative flex w-full min-w-0 text-left text-xs outline-none transition-[colors,opacity] focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  "aria-pressed:outline-2 aria-pressed:outline-offset-2 aria-pressed:outline-foreground",
                  compact ? "size-6 items-center justify-center rounded-[5px]" : "h-11 flex-col justify-center rounded-md px-2.5",
                  SEGMENT[state],
                  dim && "opacity-25 hover:opacity-100",
                  ping,
                )}
              >
                {compact ? (
                  state === "failed" && <TriangleAlert className="size-3.5" aria-hidden="true" />
                ) : (
                  <>
                    <span className="truncate font-medium">{c.name}</span>
                    <span className="truncate opacity-90">{state}</span>
                  </>
                )}
                {ticked && (
                  <span className="absolute -top-1 -right-1 grid size-3.5 place-items-center rounded-full bg-foreground text-background" aria-hidden="true">
                    <Check className="size-2.5" strokeWidth={3} />
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      {compact && (
        <p className="min-h-5 truncate text-xs text-muted-foreground" data-testid="matrix-readout">
          {probed ? (
            <>
              <span className="font-medium text-foreground">{probed.name}</span> · {badgeState(probed)} · port {probed.port}
            </>
          ) : (
            "Hover or focus a cell to read it. Click to select, Shift-click to tick."
          )}
        </p>
      )}
    </section>
  )
}
