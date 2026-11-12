import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Plus, RefreshCw, ScanLine, Search, ShieldAlert } from "lucide-react"
import { ThemeProvider } from "next-themes"
import { toast } from "sonner"
import { CommandPalette } from "@/components/CommandPalette"
import { BulkBar } from "@/components/BulkBar"
import { AddNodeDialog } from "@/components/AddNodeDialog"
import { NpmRegistryDialog } from "@/components/NpmRegistryDialog"
import { ContainerTable } from "@/components/ContainerTable"
import { FleetRibbon, TILE_LIMIT } from "@/components/FleetRibbon"
import { FleetToolbar } from "@/components/FleetToolbar"
import { LogsSheet } from "@/components/LogsSheet"
import { SessionTimeline } from "@/components/SessionTimeline"
import { StartPrompt } from "@/components/StartPrompt"
import { ThemeToggle } from "@/components/ThemeToggle"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"
import { useAnimatedValue } from "@/hooks/useAnimatedValue"
import { runBatch } from "@/hooks/useBulk"
import { useCommands } from "@/hooks/useCommands"
import { useFleetFilter } from "@/hooks/useFleetFilter"
import { usePending } from "@/hooks/usePending"
import { usePolling } from "@/hooks/usePolling"
import { useSessionLog } from "@/hooks/useSessionLog"
import { errorText, listContainers, scanNodes, type ScanResult } from "@/lib/api"
import { badgeState, type BulkAction, EMPTY_FILTER, filterActive, filterFleet, fleetChanged, sortFleet, toggleState } from "@/lib/fleet"
import { transition } from "@/lib/viewTransition"

function countText(total: number, running: number) {
  const noun = total === 1 ? "container" : "containers"
  return `${total} ${noun}, ${running} running`
}

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

/** Every layer that owns focus: while one is open the single-letter shortcuts stay quiet. */
const OVERLAY = '[role="dialog"],[role="alertdialog"],[role="menu"]'

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const PALETTE_KEY = isMac ? "Cmd K" : "Ctrl K"

export default function App() {
  // Adds or removes the `dark` class on <html>. The default follows the OS setting until the user picks one.
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="dev-host-theme">
      <Dashboard />
    </ThemeProvider>
  )
}

function Dashboard() {
  const { data, error, stale, updatedAt, polling, refresh } = usePolling(listContainers)
  // A refresh that moves a state lands inside a View Transition so the badge morphs instead of snapping.
  const list = useAnimatedValue(data, (prev, next) => next !== undefined && fleetChanged(prev, next), "fleet")
  const containers = list?.containers
  const running = containers?.filter((c) => c.state === "running").length ?? 0

  // Up to 50 containers: the table shows what needs a human first, narrowed by the filter in the address bar.
  const { filter, setFilter } = useFleetFilter()
  const sorted = useMemo(() => (containers ? sortFleet(containers) : []), [containers])
  const visible = useMemo(() => filterFleet(sorted, filter), [sorted, filter])
  const visibleIds = useMemo(() => new Set(visible.map((c) => c.id)), [visible])
  const filtering = filterActive(filter)

  const { log, changedAt } = useSessionLog(list)
  const { pending, setPending, settle } = usePending(updatedAt)
  const afterChange = useCallback(() => {
    settle()
    refresh()
  }, [settle, refresh])
  const commands = useCommands({ onPending: setPending, onChanged: afterChange })

  const [selectedId, setSelectedId] = useState<string>()
  const [logs, setLogs] = useState<{ name: string; open: boolean }>()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [addNodeOpen, setAddNodeOpen] = useState(false)
  const [registryOpen, setRegistryOpen] = useState(false)
  const [startName, setStartName] = useState<string>()
  const [scanResult, setScanResult] = useState<ScanResult>()
  const searchRef = useRef<HTMLInputElement>(null)

  // The cursor never points at a row that has gone, or one the filter hides.
  const selected = visible.find((c) => c.id === selectedId)

  const select = useCallback((id: string | undefined) => {
    setSelectedId(id)
    if (id) {
      // After paint, so a row that the same update brought back is in the document to scroll to.
      requestAnimationFrame(() =>
        document.querySelector(`[data-container-id="${CSS.escape(id)}"]`)?.scrollIntoView?.({ block: "nearest" }),
      )
    }
  }, [])

  // Ticks are for batches. Only rows you can see count, so an action never reaches a container the filter hides.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const tickedVisible = useMemo(() => new Set(visible.filter((c) => ticked.has(c.id)).map((c) => c.id)), [visible, ticked])
  const tickedContainers = useMemo(() => visible.filter((c) => tickedVisible.has(c.id)), [visible, tickedVisible])
  const anchor = useRef<string | undefined>(undefined)

  const tick = useCallback(
    (id: string, range = false) => {
      const ids = visible.map((c) => c.id)
      setTicked((prev) => {
        const next = new Set(prev)
        const from = anchor.current ? ids.indexOf(anchor.current) : -1
        const to = ids.indexOf(id)
        if (range && from >= 0 && to >= 0) {
          // Shift-click ticks the whole stretch between the last tick and this one.
          for (const between of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(between)
        } else if (next.has(id)) {
          next.delete(id)
        } else {
          next.add(id)
        }
        return next
      })
      anchor.current = id
    },
    [visible],
  )
  const tickAll = useCallback((ids: string[], on: boolean) => {
    setTicked((prev) => {
      const next = new Set(prev)
      for (const id of ids) on ? next.add(id) : next.delete(id)
      return next
    })
  }, [])
  const clearTicks = useCallback(() => setTicked(new Set()), [])

  const goTo = useCallback(
    (id: string) => {
      // A container the filter hides cannot be gone to, so going there ends the filter.
      if (!visibleIds.has(id)) setFilter(EMPTY_FILTER)
      select(id)
    },
    [visibleIds, setFilter, select],
  )

  // The sheet opens inside a View Transition: the row's badge and the sheet's badge share a name, so it travels.
  const showLogs = useCallback((name: string) => {
    transition(() => setLogs({ name, open: true }))
  }, [])

  const requestStart = useCallback(
    (name: string) => {
      const target = containers?.find((container) => container.name === name)
      if (target?.registered && target.schedule.state !== "active") {
        setStartName(name)
      } else {
        void commands.run(name, "start")
      }
    },
    [containers, commands.run],
  )

  const chooseStart = useCallback(
    (autoStart: boolean) => {
      const name = startName
      setStartName(undefined)
      if (name) void commands.run(name, "start", { autoStart })
    },
    [startName, commands.run],
  )

  const scan = useCallback(async () => {
    try {
      setScanResult(await scanNodes())
      afterChange()
    } catch (err) {
      toast.error(`Scan failed. ${errorText(err)}`)
    }
  }, [afterChange])

  const run = useCallback(
    (name: string, action: Parameters<typeof commands.run>[1]) => {
      if (action === "start") requestStart(name)
      else void commands.run(name, action)
    },
    // `commands.run` closes over stable callbacks only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestStart, setPending, afterChange],
  )

  const bulk = useCallback(
    async (action: BulkAction, names: string[]) => {
      const failed = await runBatch(names, action, commands.run, setPending)
      afterChange()
      // What worked is done with; what failed stays ticked so the same press can try it again.
      const byName = new Map((containers ?? []).map((c) => [c.name, c.id]))
      setTicked(new Set(failed.flatMap((name) => byName.get(name) ?? [])))
    },
    // `commands.run` closes over stable callbacks only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setPending, afterChange, containers],
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || event.repeat) return
      if (isTyping(event.target) || document.querySelector(OVERLAY)) return
      const ids = visible.map((c) => c.id)
      const index = selectedId ? ids.indexOf(selectedId) : -1
      switch (event.key) {
        case "j":
          if (ids.length) select(ids[index < 0 ? 0 : Math.min(index + 1, ids.length - 1)])
          break
        case "k":
          if (ids.length) select(ids[index < 0 ? ids.length - 1 : Math.max(index - 1, 0)])
          break
        case "Escape":
          // One Esc lets go of the batch, the next of the cursor.
          if (tickedVisible.size > 0) clearTicks()
          else select(undefined)
          break
        case "/":
          event.preventDefault()
          searchRef.current?.focus()
          break
        case "x":
          if (selected) tick(selected.id)
          else toast.info("Select a row first with j and k.")
          break
        case "f": {
          // The next failed row after the cursor, wrapping round: the fastest way through a bad hour.
          const failed = visible.filter((c) => badgeState(c) === "failed")
          if (failed.length === 0) {
            toast.info("No container has failed.")
            break
          }
          const at = failed.findIndex((c) => ids.indexOf(c.id) > index)
          select(failed[at < 0 ? 0 : at].id)
          break
        }
        case "l":
        case "r": {
          if (!selected) {
            toast.info("Select a row first with j and k.")
            break
          }
          if (event.key === "l") {
            showLogs(selected.name)
          } else if (list?.readOnly) {
            toast.info("Read-only mode is on, so changes are disabled.")
          } else if (selected.state !== "running") {
            toast.info(`${selected.name} is not running, so there is nothing to rebuild.`)
          } else {
            run(selected.name, "rebuild")
          }
          break
        }
        case "s":
          if (!selected) {
            toast.info("Select a row first with j and k.")
          } else if (list?.readOnly) {
            toast.info("Read-only mode is on, so changes are disabled.")
          } else if (selected.state === "running") {
            toast.info(`${selected.name} is already running.`)
          } else {
            run(selected.name, "start")
          }
          break
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [visible, selectedId, selected, list?.readOnly, select, showLogs, run, tick, tickedVisible, clearTicks])

  const logsContainer = useMemo(() => containers?.find((c) => c.name === logs?.name), [containers, logs?.name])

  return (
    // pb-28: room under the list for the batch bar, so the last rows are never behind it.
    <main className={`mx-auto max-w-6xl space-y-4 p-4 md:p-6 ${tickedContainers.length > 0 ? "pb-28" : ""}`}>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Dev host control</h1>
          <p className="text-sm text-muted-foreground" data-testid="container-count">
            {list ? countText(list.containers.length, running) : "Loading containers…"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" disabled={!list?.persistence?.writable || list.readOnly} onClick={() => setRegistryOpen(true)}>
            npm registry
          </Button>
          <Button size="sm" variant="outline" disabled={!list?.persistence?.writable || list.readOnly} onClick={() => setAddNodeOpen(true)}>
            <Plus aria-hidden="true" />
            Add node
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!list?.persistence?.writable || list.readOnly}
            onClick={() => void scan()}
          >
            <ScanLine aria-hidden="true" />
            Scan
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K Meta+K">
            <Search aria-hidden="true" />
            Commands
            <kbd className="hidden rounded-sm border px-1 text-[11px] text-muted-foreground md:inline">{PALETTE_KEY}</kbd>
          </Button>
          <ThemeToggle />
          {list?.readOnly && (
            <Badge variant="secondary" data-testid="read-only-status">
              <ShieldAlert />
              Read-only
            </Badge>
          )}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="refresh-indicator">
            {polling ? (
              <Loader2 className="size-3.5 animate-spin" aria-label="Refreshing" />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden="true" />
            )}
            {updatedAt
              ? `Updated ${updatedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
              : "Waiting for first update"}
          </span>
        </div>
      </header>

      {stale && (
        <Alert variant="destructive">
          <AlertTitle>Data may be stale</AlertTitle>
          <AlertDescription>
            The last refresh failed ({errorText(error)}).{" "}
            {list ? "The rows below are from the last good refresh." : "No list has loaded yet."}
          </AlertDescription>
        </Alert>
      )}
      {list?.persistence && !list.persistence.mounted && (
        <Alert data-testid="persistence-not-mounted">
          <AlertTitle>Node records are not on a mounted volume</AlertTitle>
          <AlertDescription>
            Node records may be lost if the control container is recreated.{" "}
            {list.persistence.warning ?? `They are stored at ${list.persistence.dir}, but that directory is not a separate mount.`}
          </AlertDescription>
        </Alert>
      )}
      {list?.persistence && !list.persistence.writable && (
        <Alert variant="destructive" data-testid="persistence-not-writable">
          <AlertTitle>Node records cannot be saved</AlertTitle>
          <AlertDescription>
            {list.persistence.warning ?? `The control server cannot write to ${list.persistence.dir}. Add, scan and schedule changes are unavailable.`}
          </AlertDescription>
        </Alert>
      )}
      {scanResult && (
        <p role="status" data-testid="scan-result" className="text-sm text-muted-foreground">
          Scan complete: {scanResult.imported.length} imported, {scanResult.skipped.length} skipped
          {scanResult.imported.length > 0 && ` — ${scanResult.imported.join(", ")}`}
          {scanResult.skipped.map(({ name, reason }) => ` — ${name}: ${reason}`)}
        </p>
      )}

      {list ? (
        <>
          <FleetRibbon
            containers={list.containers}
            selectedId={selected?.id}
            checked={tickedVisible}
            visibleIds={filtering ? visibleIds : undefined}
            activeStates={filter.states}
            changedAt={changedAt}
            onSelect={select}
            onTick={(id) => tick(id)}
            onToggleState={(state) => setFilter((prev) => toggleState(prev, state))}
          />
          <div>
            {list.containers.length > 1 && (
              <FleetToolbar filter={filter} onChange={setFilter} shown={visible.length} total={list.containers.length} inputRef={searchRef} />
            )}
            <div className="pt-3">
              <ContainerTable
                containers={visible}
                readOnly={list.readOnly}
                onChanged={afterChange}
                selectedId={selected?.id}
                changedAt={changedAt}
                pending={pending}
                onPending={setPending}
                onShowLogs={showLogs}
                onStart={requestStart}
                logsId={logs?.open ? logsContainer?.id : undefined}
                checked={list.containers.length > 1 ? tickedVisible : undefined}
                onTick={tick}
                onTickAll={tickAll}
                onSelect={select}
                filtered={filtering && list.containers.length > 0}
                onClearFilter={() => setFilter(EMPTY_FILTER)}
                denseActions={list.containers.length > TILE_LIMIT}
              />
            </div>
          </div>
          {list.containers.length > 0 && (
            <p className="hidden text-xs text-muted-foreground md:block" data-testid="shortcut-hint">
              <kbd className="rounded-sm border px-1">j</kbd> <kbd className="rounded-sm border px-1">k</kbd> select a row ·{" "}
              <kbd className="rounded-sm border px-1">x</kbd> tick · <kbd className="rounded-sm border px-1">f</kbd> next failed ·{" "}
              <kbd className="rounded-sm border px-1">/</kbd> filter · <kbd className="rounded-sm border px-1">L</kbd> logs ·{" "}
              <kbd className="rounded-sm border px-1">R</kbd> rebuild · <kbd className="rounded-sm border px-1">S</kbd> start ·{" "}
              <kbd className="rounded-sm border px-1">{PALETTE_KEY}</kbd> all commands
            </p>
          )}
          <SessionTimeline log={log} />
        </>
      ) : (
        !stale && <p className="text-sm text-muted-foreground">Loading containers…</p>
      )}

      {logs && (
        <LogsSheet
          name={logs.name}
          open={logs.open}
          container={logsContainer}
          onOpenChange={(open) => setLogs((prev) => (prev ? { ...prev, open } : prev))}
        />
      )}
      {startName && <StartPrompt name={startName} open onOpenChange={(open) => !open && setStartName(undefined)} onChoose={chooseStart} />}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        containers={sorted}
        visible={visible}
        filter={filter}
        readOnly={list?.readOnly ?? false}
        run={run}
        bulk={bulk}
        scan={() => void scan()}
        showLogs={showLogs}
        goTo={goTo}
        setFilter={setFilter}
        refresh={refresh}
      />
      <BulkBar selected={tickedContainers} readOnly={list?.readOnly ?? false} onRun={bulk} onClear={clearTicks} />
      <NpmRegistryDialog
        open={registryOpen}
        onOpenChange={setRegistryOpen}
        current={list?.settings?.npmRegistry ?? null}
        disabled={!list?.persistence?.writable || (list?.readOnly ?? true)}
        onSaved={afterChange}
      />
      <AddNodeDialog
        open={addNodeOpen}
        onOpenChange={setAddNodeOpen}
        nextPort={list?.nextPort ?? null}
        disabled={!list?.persistence?.writable || list.readOnly}
        onAdded={afterChange}
      />
      <Toaster />
    </main>
  )
}
