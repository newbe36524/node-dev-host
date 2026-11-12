import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Search } from "lucide-react"
import { useTheme } from "next-themes"
import { Dialog } from "radix-ui"
import type { PendingAction } from "@/hooks/useCommands"
import type { ContainerInfo } from "@/lib/api"
import { badgeState, type BulkAction, eligibleFor, type FleetFilter, filterActive, STATE_ORDER, summarize, type BuildBadgeState } from "@/lib/fleet"
import { cn } from "@/lib/utils"
import { openUrl } from "./ContainerTable"

export interface PaletteItem {
  id: string
  label: string
  /** Shown at the end of the row: the container the command is about. */
  detail?: string
  /** Extra words the filter also matches. */
  keywords?: string
  /** Left out of the list until something is typed. With fifty containers the per-container commands are 250 rows of noise. */
  searchOnly?: boolean
  run: () => void
}

interface BuildArgs {
  containers: ContainerInfo[]
  /** The containers the current filter shows. */
  visible: ContainerInfo[]
  filter: FleetFilter
  readOnly: boolean
  run: (name: string, action: PendingAction) => void
  bulk: (action: BulkAction, names: string[]) => void
  showLogs: (name: string) => void
  goTo: (id: string) => void
  setFilter: (filter: FleetFilter) => void
  refresh: () => void
  setTheme: (theme: string) => void
}

/** How many results the list draws. The rest are one more word of typing away. */
export const MAX_SHOWN = 30

const ACTION_LABEL = { start: "Start", rebuild: "Rebuild", restart: "Restart", stop: "Stop" } as const

/** The commands the palette offers. Remove is left out on purpose: it needs a confirmation, which lives on the row. */
export function buildPaletteItems({ containers, visible, filter, readOnly, run, bulk, showLogs, goTo, setFilter, refresh, setTheme }: BuildArgs): PaletteItem[] {
  const items: PaletteItem[] = []

  // Commands that act on a group come first and are the whole list until the visitor types.
  if (!readOnly) {
    const failedRunning = eligibleFor("rebuild", containers.filter((c) => badgeState(c) === "failed"))
    if (failedRunning.length > 0) {
      items.push({
        id: "bulk:rebuild-failed",
        label: `Rebuild ${failedRunning.length} failed`,
        keywords: "all fix retry",
        run: () => bulk("rebuild", failedRunning.map((c) => c.name)),
      })
    }
    const stopped = eligibleFor("start", containers)
    if (stopped.length > 0) {
      items.push({ id: "bulk:start-stopped", label: `Start ${stopped.length} stopped`, keywords: "all", run: () => bulk("start", stopped.map((c) => c.name)) })
    }
    const shownRunning = eligibleFor("rebuild", visible)
    if (filterActive(filter) && shownRunning.length > 1) {
      items.push({ id: "bulk:rebuild-shown", label: `Rebuild ${shownRunning.length} shown`, keywords: "all filtered", run: () => bulk("rebuild", shownRunning.map((c) => c.name)) })
    }
  }
  const counts = summarize(containers)
  for (const state of STATE_ORDER.filter((s) => counts[s] > 0 && !(filter.states.length === 1 && filter.states[0] === s))) {
    items.push({
      id: `filter:${state}`,
      label: `Show only ${state}`,
      detail: `${counts[state]}`,
      keywords: "filter",
      run: () => setFilter({ ...filter, states: [state] as BuildBadgeState[] }),
    })
  }
  if (filterActive(filter)) {
    items.push({ id: "filter:clear", label: "Clear filters", keywords: "show all reset", run: () => setFilter({ query: "", states: [] }) })
  }

  for (const c of containers) {
    items.push({ id: `go:${c.id}`, label: `Go to ${c.name}`, detail: badgeState(c), keywords: "select jump find", searchOnly: true, run: () => goTo(c.id) })
    items.push({ id: `logs:${c.id}`, label: `Logs: ${c.name}`, detail: c.name, keywords: "log output", searchOnly: true, run: () => showLogs(c.name) })
    items.push({
      id: `open:${c.id}`,
      label: `Open ${c.name}`,
      detail: `port ${c.port}`,
      keywords: "browse visit preview",
      searchOnly: true,
      run: () => window.open(openUrl(c.port), "_blank", "noopener,noreferrer"),
    })
    if (readOnly) continue
    const lifecycle = c.state === "running" ? (["rebuild", "restart", "stop"] as const) : (["start"] as const)
    for (const action of lifecycle) {
      items.push({ id: `${action}:${c.id}`, label: `${ACTION_LABEL[action]} ${c.name}`, detail: c.name, searchOnly: true, run: () => run(c.name, action) })
    }
  }
  items.push({ id: "refresh", label: "Refresh now", keywords: "poll reload update", run: refresh })
  for (const theme of ["light", "dark", "system"]) {
    items.push({ id: `theme:${theme}`, label: `Theme: ${theme}`, keywords: "appearance colour mode", run: () => setTheme(theme) })
  }
  return items
}

/**
 * Every whitespace-separated word of the query must appear somewhere in the item. Results that start
 * with what was typed come first, then ones with a word that does, then the rest; ties keep list order.
 */
export function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return items
  const typed = words.join(" ")
  const scored: { item: PaletteItem; score: number }[] = []
  for (const item of items) {
    const label = item.label.toLowerCase()
    const hay = `${label} ${item.detail ?? ""} ${item.keywords ?? ""}`.toLowerCase()
    if (!words.every((w) => hay.includes(w))) continue
    const score = label.startsWith(typed) ? 0 : label.split(/[\s:]+/).some((t) => t.startsWith(words[0])) ? 1 : 2
    scored.push({ item, score })
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.item)
}

interface CommandPaletteProps extends Omit<BuildArgs, "setTheme"> {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPalette({ open, onOpenChange, ...args }: CommandPaletteProps) {
  const { setTheme } = useTheme()
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const uid = useId()
  const listId = `${uid}-list`

  const items = useMemo(
    () => buildPaletteItems({ ...args, setTheme }),
    // `args` members are stable callbacks and the container list; spreading keeps the dependency list honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [args.containers, args.visible, args.filter, args.readOnly, args.run, args.bulk, args.showLogs, args.goTo, args.setFilter, args.refresh, setTheme],
  )
  const matches = useMemo(
    () => (query.trim() ? filterItems(items, query) : items.filter((item) => !item.searchOnly)),
    [items, query],
  )
  const shown = useMemo(() => matches.slice(0, MAX_SHOWN), [matches])
  const current = shown[Math.min(active, shown.length - 1)]

  useEffect(() => {
    if (open) {
      setQuery("")
      setActive(0)
    }
  }, [open])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" })
  }, [active, shown])

  function choose(item: PaletteItem | undefined) {
    if (!item) return
    onOpenChange(false)
    item.run()
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActive((i) => (shown.length === 0 ? 0 : (i + 1) % shown.length))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActive((i) => (shown.length === 0 ? 0 : (i - 1 + shown.length) % shown.length))
    } else if (event.key === "Home") {
      event.preventDefault()
      setActive(0)
    } else if (event.key === "End") {
      event.preventDefault()
      setActive(Math.max(0, shown.length - 1))
    } else if (event.key === "Enter") {
      event.preventDefault()
      choose(current)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Content
          className="fixed top-[12vh] left-1/2 z-50 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-98 data-closed:animate-out data-closed:fade-out-0"
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={current ? `${uid}-${current.id}` : undefined}
              aria-label="Search commands"
              placeholder="Type a command or a container name"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul ref={listRef} id={listId} role="listbox" aria-label="Commands" className="max-h-72 overflow-auto p-1">
            {shown.map((item) => {
              const selected = item.id === current?.id
              return (
                <li
                  key={item.id}
                  id={`${uid}-${item.id}`}
                  role="option"
                  aria-selected={selected}
                  onMouseMove={() => setActive(shown.indexOf(item))}
                  onClick={() => choose(item)}
                  className={cn(
                    "flex cursor-default items-center justify-between gap-3 rounded-md px-2.5 py-2 text-sm",
                    selected && "bg-muted",
                  )}
                >
                  <span className="truncate">{item.label}</span>
                  {item.detail && <span className="shrink-0 text-xs text-muted-foreground">{item.detail}</span>}
                </li>
              )
            })}
            {shown.length === 0 && (
              <li role="presentation" className="px-2.5 py-6 text-center text-sm text-muted-foreground">
                No command matches “{query}”.
              </li>
            )}
          </ul>
          {matches.length > shown.length && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground" data-testid="palette-more">
              Showing {shown.length} of {matches.length}. Keep typing to narrow it down.
            </p>
          )}
          {!query.trim() && args.containers.length > 0 && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              Type a container name to go to it, read its logs or change it.
            </p>
          )}
          {args.readOnly && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              Read-only mode: commands that change a container are hidden.
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
