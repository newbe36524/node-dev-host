// Pure helpers behind the console home page: what state a container is shown in, how the fleet adds up,
// how old a build is, and the in-memory record of state changes seen since the page was opened.
// Nothing here touches the DOM or the network, so every rule can be unit tested.

import type { BuildStateName, ContainerInfo, ContainerList } from "@/lib/api"

/** Build states plus "stopped" for containers that are not running. */
export type BuildBadgeState = BuildStateName | "stopped"

/** What a container is shown as: its build state while it runs, "stopped" otherwise. */
export function badgeState(c: ContainerInfo): BuildBadgeState {
  return c.state === "running" ? c.build.state : "stopped"
}

/** Display order for the fleet summary. Faults first, because they are what an operator is looking for. */
export const STATE_ORDER: BuildBadgeState[] = ["failed", "building", "ok", "starting", "waiting", "unknown", "stopped"]

export type FleetCounts = Record<BuildBadgeState, number>

export function summarize(containers: ContainerInfo[]): FleetCounts {
  const counts: FleetCounts = { ok: 0, building: 0, failed: 0, starting: 0, waiting: 0, unknown: 0, stopped: 0 }
  for (const c of containers) counts[badgeState(c)] += 1
  return counts
}

// ---------------------------------------------------------------------------------------------
// Working a large fleet (up to 50 containers): triage order, filter, URL persistence, bulk scope.
// ---------------------------------------------------------------------------------------------

/** Triage order for the table: what needs a human first, what is quietly fine last. */
const TRIAGE_ORDER: BuildBadgeState[] = ["failed", "building", "starting", "waiting", "unknown", "ok", "stopped"]
const TRIAGE_RANK = new Map(TRIAGE_ORDER.map((state, rank) => [state, rank]))

/** Failed first, then work in progress, then healthy, then stopped. Ties break by name, digits compared as numbers. */
export function sortFleet(containers: ContainerInfo[]): ContainerInfo[] {
  return [...containers].sort(
    (a, b) =>
      (TRIAGE_RANK.get(badgeState(a)) ?? 0) - (TRIAGE_RANK.get(badgeState(b)) ?? 0) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  )
}

export interface FleetFilter {
  /** Free text. Every word must appear in the name, image or port. */
  query: string
  /** Show only these states. Empty means every state. */
  states: BuildBadgeState[]
}

export const EMPTY_FILTER: FleetFilter = { query: "", states: [] }

export function filterActive(filter: FleetFilter): boolean {
  return filter.query.trim() !== "" || filter.states.length > 0
}

export function filterFleet(containers: ContainerInfo[], filter: FleetFilter): ContainerInfo[] {
  if (!filterActive(filter)) return containers
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean)
  return containers.filter((c) => {
    if (filter.states.length > 0 && !filter.states.includes(badgeState(c))) return false
    const hay = `${c.name} ${c.image} ${c.port}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** Adds the state to the filter, or removes it when it is already there. */
export function toggleState(filter: FleetFilter, state: BuildBadgeState): FleetFilter {
  const states = filter.states.includes(state) ? filter.states.filter((s) => s !== state) : [...filter.states, state]
  return { ...filter, states }
}

/** `#q=api&s=failed,building`. An empty filter is an empty string, so the address bar stays clean. */
export function filterToHash(filter: FleetFilter): string {
  const params = new URLSearchParams()
  if (filter.query.trim()) params.set("q", filter.query.trim())
  if (filter.states.length) params.set("s", filter.states.join(","))
  const text = params.toString()
  return text ? `#${text}` : ""
}

export function filterFromHash(hash: string): FleetFilter {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  const states = (params.get("s") ?? "").split(",").filter((s): s is BuildBadgeState => TRIAGE_RANK.has(s as BuildBadgeState))
  return { query: params.get("q") ?? "", states: [...new Set(states)] }
}

export type BulkAction = "start" | "stop" | "restart" | "rebuild"

/** Start needs a stopped container; stop, restart and rebuild need a running one. The rest of a mixed selection is skipped, not failed. */
export function eligibleFor(action: BulkAction, containers: ContainerInfo[]): ContainerInfo[] {
  return containers.filter((c) => (action === "start" ? c.state !== "running" : c.state === "running"))
}

/** True when a refresh changed anything an operator would see move: a state, or a container coming or going. */
export function fleetChanged(prev: ContainerList | undefined, next: ContainerList): boolean {
  if (!prev) return false
  if (prev.containers.length !== next.containers.length) return true
  const before = new Map(prev.containers.map((c) => [c.id, badgeState(c)]))
  return next.containers.some((c) => before.get(c.id) !== badgeState(c))
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "12s ago", "4m ago", "3h ago", "2d ago". A time in the future (clock skew) reads as "just now". */
export function relativeAge(iso: string, now: number): string | null {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const diff = Math.max(0, now - then)
  if (diff < 5 * SECOND) return "just now"
  if (diff < MINUTE) return `${Math.floor(diff / SECOND)}s ago`
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  return `${Math.floor(diff / DAY)}d ago`
}

// ---------------------------------------------------------------------------------------------
// Session log: state changes seen by this browser tab since it was opened. It is not server history,
// and the UI says so.
// ---------------------------------------------------------------------------------------------

export type LaneState = BuildBadgeState | "removed"

export interface Span {
  state: LaneState
  /** Epoch ms when this state was first seen. A span ends where the next one starts. */
  from: number
}

export interface Lane {
  id: string
  name: string
  spans: Span[]
}

export interface ChangeEvent {
  id: string
  name: string
  /** null when the container first appeared after the page was opened. */
  from: LaneState | null
  to: LaneState
  at: number
}

export interface SessionLog {
  startedAt: number
  /** False until the first snapshot has been recorded, so the first list is a baseline and not a burst of changes. */
  seen: boolean
  lanes: Record<string, Lane>
  /** Lane ids in the order they were first seen. */
  order: string[]
  /** Newest last. */
  changes: ChangeEvent[]
}

export const MAX_CHANGES = 200
export const MAX_SPANS_PER_LANE = 200
/** Spans that ended longer ago than this are dropped. The timeline never shows more than this. */
export const WINDOW_MAX_MS = HOUR

export function emptyLog(at: number): SessionLog {
  return { startedAt: at, seen: false, lanes: {}, order: [], changes: [] }
}

/** Returns a new log with the snapshot folded in, or the same object when nothing changed. */
export function recordSnapshot(log: SessionLog, containers: ContainerInfo[], at: number): SessionLog {
  let lanes = log.lanes
  let order = log.order
  let changes = log.changes
  let touched = !log.seen

  const present = new Set<string>()
  for (const c of containers) {
    present.add(c.id)
    const state = badgeState(c)
    const lane = lanes[c.id]
    if (!lane) {
      if (lanes === log.lanes) lanes = { ...lanes }
      // On the first snapshot a lane starts at page-open time so the bar has no gap before it.
      lanes[c.id] = { id: c.id, name: c.name, spans: [{ state, from: log.seen ? at : log.startedAt }] }
      order = [...order, c.id]
      if (log.seen) changes = [...changes, { id: c.id, name: c.name, from: null, to: state, at }]
      touched = true
      continue
    }
    const last = lane.spans[lane.spans.length - 1]
    if (last.state !== state || lane.name !== c.name) {
      if (lanes === log.lanes) lanes = { ...lanes }
      const spans = last.state === state ? lane.spans : [...lane.spans, { state, from: at }].slice(-MAX_SPANS_PER_LANE)
      lanes[c.id] = { ...lane, name: c.name, spans }
      if (last.state !== state) changes = [...changes, { id: c.id, name: c.name, from: last.state, to: state, at }]
      touched = true
    }
  }

  for (const id of order) {
    if (present.has(id)) continue
    const lane = lanes[id]
    const last = lane.spans[lane.spans.length - 1]
    if (last.state === "removed") continue
    if (lanes === log.lanes) lanes = { ...lanes }
    lanes[id] = { ...lane, spans: [...lane.spans, { state: "removed", from: at }] }
    changes = [...changes, { id, name: lane.name, from: last.state, to: "removed", at }]
    touched = true
  }

  if (!touched) return log
  if (changes.length > MAX_CHANGES) changes = changes.slice(-MAX_CHANGES)
  return { ...log, seen: true, lanes, order, changes }
}

/** When each container last changed state in this session. Containers that never changed are absent. */
export function lastChangeById(log: SessionLog): Record<string, number> {
  const out: Record<string, number> = {}
  for (const change of log.changes) out[change.id] = change.at
  return out
}

export interface TimelineWindow {
  start: number
  end: number
}

const MIN_WINDOW_MS = 2 * MINUTE

/** The visible span of the timeline: at least two minutes, at most an hour, always ending now. */
export function timelineWindow(log: SessionLog, now: number): TimelineWindow {
  const elapsed = Math.max(0, now - log.startedAt)
  const width = Math.min(WINDOW_MAX_MS, Math.max(MIN_WINDOW_MS, elapsed))
  return { start: now - width, end: now }
}

export interface Segment {
  state: LaneState
  /** 0 to 100, share of the track. */
  left: number
  width: number
}

/** Segments of a lane clipped to the window, as percentages of the track. */
export function laneSegments(lane: Lane, win: TimelineWindow, now: number): Segment[] {
  const total = win.end - win.start
  const out: Segment[] = []
  lane.spans.forEach((span, index) => {
    const next = lane.spans[index + 1]
    const from = Math.max(span.from, win.start)
    const to = Math.min(next ? next.from : now, win.end)
    if (to <= from) return
    out.push({ state: span.state, left: ((from - win.start) / total) * 100, width: ((to - from) / total) * 100 })
  })
  return out
}

/** "2m", "45s", "1h": the label for the left edge of the timeline. */
export function formatSpan(ms: number): string {
  if (ms >= HOUR) return `${Math.round(ms / HOUR)}h`
  if (ms >= MINUTE) return `${Math.round(ms / MINUTE)}m`
  return `${Math.max(1, Math.round(ms / SECOND))}s`
}
