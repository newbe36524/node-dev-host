import { useEffect, useRef, type CSSProperties } from "react"
import { Loader2, ShieldAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { PendingAction } from "@/hooks/useCommands"
import { useNow } from "@/hooks/useNow"
import type { ContainerInfo, ProjectInfo } from "@/lib/api"
import { badgeState, relativeAge } from "@/lib/fleet"
import { cn } from "@/lib/utils"
import { ContainerActions } from "./ContainerActions"
import { badgeTransitionName } from "./LogsSheet"
import { ContainerStateBadge, StateBadge } from "./StateBadge"

type LocationLike = Pick<Location, "protocol" | "hostname">

/** Link to a container's published port on the same host the dashboard was loaded from. */
export function openUrl(port: number, loc: LocationLike = window.location): string {
  return `${loc.protocol}//${loc.hostname}:${port}/`
}

/** A change is "recent" for this long: the dashed ring around its badge is shown, then removed. */
const RECENT_MS = 4000
// A row whose status carries no project metadata (an older node) renders as it did before the metadata existed.
const NO_PROJECT: ProjectInfo = { name: null, description: null, configSource: null, configError: null, warnings: [] }

const PENDING_WORD: Record<PendingAction, string> = {
  start: "starting…",
  stop: "stopping…",
  restart: "restarting…",
  rebuild: "rebuilding…",
  remove: "removing…",
  "delete-node": "deleting…",
  recreate: "recreating…",
  extend: "extending…",
  "stop-auto-start": "updating…",
}

const OPERATION_WORD = {
  pulling: "pulling…",
  creating: "creating…",
  starting: "starting…",
  removing: "removing…",
} as const

/** "12s ago", ticking once a second. The full local time is in the tooltip and the ISO value in `dateTime`. */
function BuildAge({ iso }: { iso: string | null }) {
  const now = useNow()
  if (iso === null) return <>—</>
  const date = new Date(iso)
  const full = Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
  return (
    <time dateTime={iso} title={full} className="whitespace-nowrap">
      {relativeAge(iso, now) ?? iso}
    </time>
  )
}

/** A checkbox with a roomy hit area. The cell is 40px wide; the box is 16px. */
function Tick({ label, checked, onChange }: { label: string; checked: boolean; onChange: (event: React.ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <label className="-m-2 flex size-10 cursor-pointer items-center justify-center">
      <input type="checkbox" aria-label={label} checked={checked} onChange={onChange} className="size-4 cursor-pointer accent-foreground" />
    </label>
  )
}

/** The select-all box: ticked when every row shown is ticked, dashed when some are. */
function TickAll({ ids, checked, onTickAll }: { ids: string[]; checked: ReadonlySet<string>; onTickAll: (ids: string[], on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const count = ids.filter((id) => checked.has(id)).length
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && count < ids.length
  }, [count, ids.length])
  return (
    <label className="-m-2 flex size-10 cursor-pointer items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        aria-label={count === ids.length ? "Untick all shown" : "Tick all shown"}
        checked={ids.length > 0 && count === ids.length}
        onChange={() => onTickAll(ids, count !== ids.length)}
        className="size-4 cursor-pointer accent-foreground"
      />
    </label>
  )
}

interface ContainerTableProps {
  containers: ContainerInfo[]
  readOnly: boolean
  onChanged: () => void
  /** The row the keyboard cursor is on. */
  selectedId?: string
  /** When each container last changed state in this session. */
  changedAt?: Record<string, number>
  /** Actions in flight, by container name. */
  pending?: Record<string, PendingAction>
  onPending?: (name: string, action: PendingAction | null) => void
  onShowLogs?: (name: string) => void
  onStart?: (name: string) => void
  /** The container whose logs sheet is open. Its row badge gives up its transition name so the sheet's badge can take it. */
  logsId?: string
  /** Ticked for a batch. When absent the table has no checkbox column. */
  checked?: ReadonlySet<string>
  /** `range` is true when Shift was held: tick everything between the last tick and this row. */
  onTick?: (id: string, range: boolean) => void
  onTickAll?: (ids: string[], on: boolean) => void
  /** Clicking the empty part of a row moves the keyboard cursor there. */
  onSelect?: (id: string) => void
  /** The list is empty because of a filter, not because there are no containers. */
  filtered?: boolean
  onClearFilter?: () => void
  /** Fold the row actions into a menu. Set by the page from the size of the whole fleet, so filtering never changes the rows' shape. */
  denseActions?: boolean
}

export function ContainerTable({
  containers,
  readOnly,
  onChanged,
  selectedId,
  changedAt = {},
  pending = {},
  onPending,
  onShowLogs,
  onStart,
  logsId,
  checked,
  onTick,
  onTickAll,
  onSelect,
  filtered = false,
  onClearFilter,
  denseActions = false,
}: ContainerTableProps) {
  const now = useNow()
  return (
    <div className="space-y-4">
      {readOnly && (
        <Alert>
          <ShieldAlert />
          <AlertTitle>Read-only mode is on</AlertTitle>
          <AlertDescription>
            The control server does not accept changes, so container actions are disabled.
          </AlertDescription>
        </Alert>
      )}
      {containers.length === 0 && filtered ? (
        <div className="space-y-3 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground" data-testid="no-match">
          <p>No container matches this filter.</p>
          {onClearFilter && (
            <Button size="sm" variant="outline" onClick={onClearFilter}>
              Clear filters
            </Button>
          )}
        </div>
      ) : containers.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No dev-host containers yet. Start a container with the node-dev-host.port label and it will appear here.
        </div>
      ) : (
        // No overflow here, and none on the table's own wrapper: either would turn it into the scroll
        // container and the sticky header would stick to nothing.
        <div className="rounded-md border">
          <Table className="block md:table" containerClassName="overflow-visible">
            <TableHeader className="sr-only md:not-sr-only md:sticky md:top-12 md:z-10 [&_th]:bg-background [&_th]:shadow-[inset_0_-1px_0_var(--border)]">
              <TableRow className="border-b-0">
                {checked && onTickAll && (
                  <TableHead className="w-10">
                    <TickAll ids={containers.map((c) => c.id)} checked={checked} onTickAll={onTickAll} />
                  </TableHead>
                )}
                <TableHead>Name</TableHead>
                <TableHead>Port</TableHead>
                <TableHead className="hidden lg:table-cell">Image</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="hidden md:table-cell">Health</TableHead>
                <TableHead>Build</TableHead>
                <TableHead className="hidden md:table-cell">Last build</TableHead>
                <TableHead className="hidden md:table-cell">Auto-start</TableHead>
                <TableHead>Open</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="block md:table-row-group">
              {containers.map((c) => {
                const state = badgeState(c)
                const changed = changedAt[c.id]
                const recent = changed !== undefined && now - changed < RECENT_MS
                const inFlight = pending[c.name]
                const operationWord = c.operation ? OPERATION_WORD[c.operation.phase] : undefined
                const selected = c.id === selectedId
                const ticked = checked?.has(c.id) ?? false
                const project = c.project ?? NO_PROJECT
                const configured = project.configSource !== null
                const projectText = [project.name, project.description].filter(Boolean).join(" · ")
                return (
                // Below md each row stacks as a card; from md it is a table row.
                <TableRow
                  key={c.id}
                  data-container-id={c.id}
                  data-row
                  data-selected={selected || undefined}
                  data-ticked={ticked || undefined}
                  aria-current={selected || undefined}
                  // Named for a View Transition only while a reorder runs (see index.css), so rows slide to
                  // their new place instead of vanishing and reappearing.
                  style={{ "--row-vt": `row-${c.id}` } as CSSProperties}
                  onClick={(event) => {
                    if (onSelect && !(event.target as HTMLElement).closest("button,a,input,label,[role=menuitem]")) onSelect(c.id)
                  }}
                  className={cn(
                    "flex flex-wrap items-center gap-x-3 gap-y-2 py-3 md:table-row md:py-0",
                    ticked && "bg-muted/60",
                    selected && "bg-muted ring-1 ring-inset ring-foreground/30 hover:bg-muted",
                  )}
                >
                  {checked && onTick && (
                    <TableCell className="w-10 shrink-0">
                      <Tick
                        label={`Tick ${c.name}`}
                        checked={ticked}
                        onChange={(event) => onTick(c.id, (event.nativeEvent as MouseEvent).shiftKey === true)}
                      />
                    </TableCell>
                  )}
                  <TableCell className="min-w-0 flex-1 basis-[calc(100%-3.5rem)] font-medium md:basis-auto md:flex-none">
                    {c.name}
                    {/* Project metadata is shown only for a node whose workspace has a configuration file. */}
                    {configured && project.name && (
                      <span className="font-normal text-muted-foreground md:hidden" data-testid="project-name"> · {project.name}</span>
                    )}
                    {configured && projectText && (
                      <span className="mt-0.5 hidden truncate text-xs font-normal text-muted-foreground md:block" title={projectText} data-testid="project-line">
                        {projectText}
                      </span>
                    )}
                    {configured && c.build.state === "failed" && project.configError && (
                      <span className="block w-72 max-w-full break-words text-xs text-destructive" data-testid="config-error">Config: {project.configError}</span>
                    )}
                    {configured && project.warnings.map((warning, index) => (
                      <span key={index} className="block w-72 max-w-full break-words text-xs text-muted-foreground" data-testid="project-warning">{warning}</span>
                    ))}
                  </TableCell>
                  <TableCell className="tabular-nums">{c.port}</TableCell>
                  <TableCell className="hidden max-w-48 truncate lg:table-cell" title={c.image}>
                    {c.image}
                  </TableCell>
                  <TableCell>
                    <ContainerStateBadge state={c.state} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{c.health ?? "—"}</TableCell>
                  <TableCell>
                    <div className="grid gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {/* Re-keyed on every change so the ring restarts; absent when nothing changed recently. */}
                        <span key={recent ? changed : "steady"} className={recent ? "state-ring" : "inline-flex"}>
                          <StateBadge
                            state={state}
                            transitionName={logsId === c.id ? undefined : badgeTransitionName(c.id)}
                          />
                        </span>
                        {(operationWord || inFlight) && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="pending-action">
                            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                            {operationWord ?? (inFlight ? PENDING_WORD[inFlight] : "")}
                          </span>
                        )}
                      </div>
                      {c.error && <span className="block w-72 max-w-full break-words text-xs text-destructive" data-testid="row-error">Fault: {c.error}</span>}
                      {c.warning && <span className="block w-72 max-w-full break-words text-xs text-muted-foreground" data-testid="row-warning">{c.warning}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <BuildAge iso={c.build.finishedAt} />
                  </TableCell>
                  <TableCell>
                    {c.schedule.state === "active" && c.schedule.until ? (
                      <span className="text-xs text-muted-foreground">
                        {c.schedule.daysLeft !== null && `${c.schedule.daysLeft} days left · `}
                        <time dateTime={c.schedule.until} title={new Date(c.schedule.until).toLocaleString()}>
                          Until {new Date(c.schedule.until).toLocaleDateString()}
                        </time>
                      </span>
                    ) : c.schedule.state === "ended" && c.schedule.until ? (
                      <span className="text-xs text-muted-foreground">
                        Ended <time dateTime={c.schedule.until}>{new Date(c.schedule.until).toLocaleDateString()}</time>
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {c.state === "not created" ? (
                      "—"
                    ) : (
                      <Button variant="link" size="sm" asChild>
                        <a href={openUrl(c.port)} target="_blank" rel="noopener noreferrer">
                          Open
                        </a>
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    <ContainerActions
                      container={c}
                      readOnly={readOnly}
                      onChanged={onChanged}
                      onPending={onPending}
                      onShowLogs={onShowLogs}
                      onStart={onStart}
                      dense={denseActions}
                    />
                  </TableCell>
                </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
