import { useEffect, useRef, useState } from "react"
import { Pause, Play } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { type ContainerInfo, errorText, fetchLogs } from "@/lib/api"
import { badgeState } from "@/lib/fleet"
import { StateBadge } from "./StateBadge"

const LOG_TAIL = 200
/** Same cadence as the container list, so the sheet and the table age together. */
export const LOG_POLL_MS = 3000

/** The name the row badge and the sheet badge share, so the badge morphs from one to the other. */
export function badgeTransitionName(id: string) {
  return `vt-${id}`
}

interface LogsSheetProps {
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When given, its state badge sits in the header and takes over the row badge's transition name while open. */
  container?: ContainerInfo
}

function clock(date: Date) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function LogsSheet({ name, open, onOpenChange, container }: LogsSheetProps) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date>()
  const [paused, setPaused] = useState(false)
  // A failed refresh after the first load keeps the lines and says so; it never replaces them with an error.
  const [refreshFailed, setRefreshFailed] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    if (!open) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setText(null)
    setError(null)
    setRefreshFailed(false)
    setUpdatedAt(undefined)
    setPaused(false)
    pinned.current = true

    const load = async (first: boolean) => {
      try {
        const body = await fetchLogs(name, LOG_TAIL)
        if (!active) return
        setText(body)
        setError(null)
        setRefreshFailed(false)
        setUpdatedAt(new Date())
      } catch (err) {
        if (!active) return
        if (first) setError(errorText(err))
        else setRefreshFailed(true)
      }
      if (active) timer = setTimeout(() => load(false), LOG_POLL_MS)
    }
    void load(true)
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [open, name])

  // Pausing stops applying new lines but not the fetch loop; resuming picks up the latest at once.
  const [frozen, setFrozen] = useState<string | null>(null)
  useEffect(() => {
    setFrozen(paused ? text : null)
    // Freeze whatever was showing at the moment of pausing, not later arrivals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused])
  const shown = paused && frozen !== null ? frozen : text

  // Keep following the tail while the reader is at the bottom; leave them alone once they scroll up.
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [shown])

  function onScroll() {
    const el = scroller.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  const status = paused
    ? "Paused"
    : refreshFailed
      ? "Live updates are failing; showing the last lines received"
      : updatedAt
        ? `Live, updated ${clock(updatedAt)}`
        : "Loading"

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-hidden sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 pr-8">
            Logs: {name}
            {container && (
              <StateBadge state={badgeState(container)} transitionName={open ? badgeTransitionName(container.id) : undefined} />
            )}
          </SheetTitle>
          <SheetDescription className="flex items-center gap-2">
            <span>
              Last {LOG_TAIL} lines. <span data-testid="logs-status" className={refreshFailed ? "text-destructive" : undefined}>{status}</span>
            </span>
            {text !== null && error === null && (
              <Button
                size="xs"
                variant="ghost"
                aria-pressed={paused}
                onClick={() => setPaused((p) => !p)}
              >
                {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                {paused ? "Resume" : "Pause"}
              </Button>
            )}
          </SheetDescription>
        </SheetHeader>
        <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-auto px-4 pb-4">
          {error !== null ? (
            <Alert variant="destructive">
              <AlertTitle>Could not load logs</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : shown === null ? (
            <p className="text-sm text-muted-foreground">Loading logs…</p>
          ) : (
            <pre className="rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
              {shown || "(no log lines)"}
            </pre>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
