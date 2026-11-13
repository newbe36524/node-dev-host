import { describe, expect, it } from "vitest"
import { container } from "@/test/fakeApi"
import type { BuildStateName, ContainerInfo } from "@/lib/api"
import {
  badgeState,
  type BuildBadgeState,
  eligibleFor,
  EMPTY_FILTER,
  emptyLog,
  filterFleet,
  filterFromHash,
  filterToHash,
  fleetChanged,
  laneSegments,
  recordSnapshot,
  relativeAge,
  sortFleet,
  summarize,
  timelineWindow,
  toggleState,
} from "@/lib/fleet"

const failed = { state: "failed", builds: 1, failures: 1, finishedAt: null } as const

describe("badgeState and summarize", () => {
  it("shows stopped for a container that is not running, whatever its last build said", () => {
    expect(badgeState(container({ state: "exited", build: failed }))).toBe("stopped")
    expect(badgeState(container({ build: failed }))).toBe("failed")
  })

  it("counts every container once", () => {
    const counts = summarize([
      container(),
      container({ id: "b", build: failed }),
      container({ id: "c", state: "exited" }),
    ])
    expect(counts).toMatchObject({ ok: 1, failed: 1, stopped: 1, building: 0 })
  })
})

describe("fleetChanged", () => {
  const persistence = { dir: "/var/lib/dev-host/control", writable: true, mounted: true, warning: null }
  it("is false for the first list and for an identical one", () => {
    const list = { readOnly: false, containers: [container()], persistence, nextPort: 43100 }
    expect(fleetChanged(undefined, list)).toBe(false)
    expect(fleetChanged(list, { ...list })).toBe(false)
  })

  it("is true when a state moves or a container appears", () => {
    const before = { readOnly: false, containers: [container()], persistence, nextPort: 43100 }
    expect(fleetChanged(before, { ...before, containers: [container({ build: failed })] })).toBe(true)
    expect(fleetChanged(before, { ...before, containers: [container(), container({ id: "b" })] })).toBe(true)
  })
})

describe("relativeAge", () => {
  const now = Date.parse("2026-11-11T10:10:00Z")
  it.each([
    ["2026-11-11T10:09:58Z", "just now"],
    ["2026-11-11T10:09:48Z", "12s ago"],
    ["2026-11-11T10:06:00Z", "4m ago"],
    ["2026-11-11T07:00:00Z", "3h ago"],
    ["2026-11-09T10:00:00Z", "2d ago"],
    ["2026-11-11T10:20:00Z", "just now"],
  ])("%s reads %s", (iso, text) => {
    expect(relativeAge(iso, now)).toBe(text)
  })

  it("returns null for a value that is not a date", () => {
    expect(relativeAge("nope", now)).toBeNull()
  })
})

describe("session log", () => {
  it("treats the first list as a baseline: lanes start at page open and nothing is a change", () => {
    const log = recordSnapshot(emptyLog(1000), [container()], 5000)
    expect(log.changes).toEqual([])
    expect(log.lanes.abc123.spans).toEqual([{ state: "ok", from: 1000 }])
  })

  it("records a state change once, and nothing for an identical list", () => {
    let log = recordSnapshot(emptyLog(0), [container()], 1000)
    log = recordSnapshot(log, [container({ build: failed })], 4000)
    const same = recordSnapshot(log, [container({ build: failed })], 7000)
    expect(same).toBe(log)
    expect(log.changes).toEqual([{ id: "abc123", name: "nd-site-a", from: "ok", to: "failed", at: 4000 }])
    expect(log.lanes.abc123.spans.map((s) => s.state)).toEqual(["ok", "failed"])
  })

  it("records a container that appears later and one that goes away", () => {
    let log = recordSnapshot(emptyLog(0), [container()], 1000)
    log = recordSnapshot(log, [container(), container({ id: "b", name: "nd-site-b" })], 2000)
    log = recordSnapshot(log, [container({ id: "b", name: "nd-site-b" })], 3000)
    expect(log.changes.map((c) => [c.name, c.from, c.to])).toEqual([
      ["nd-site-b", null, "ok"],
      ["nd-site-a", "ok", "removed"],
    ])
  })

  it("clips lane segments to the window as percentages", () => {
    const log = recordSnapshot(recordSnapshot(emptyLog(0), [container()], 0), [container({ build: failed })], 60_000)
    const now = 120_000
    const win = timelineWindow(log, now)
    expect(win).toEqual({ start: 0, end: 120_000 })
    const segs = laneSegments(log.lanes.abc123, win, now)
    expect(segs.map((s) => [s.state, Math.round(s.left), Math.round(s.width)])).toEqual([
      ["ok", 0, 50],
      ["failed", 50, 50],
    ])
  })
})

describe("working a large fleet", () => {
  const mk = (name: string, state: ContainerInfo["state"], build: BuildStateName, port = 43101): ContainerInfo => ({
    name,
    id: name,
    image: "node-dev-host:test",
    port,
    state,
    health: null,
    build: { state: build, builds: 1, failures: 0, finishedAt: null },
    project: { name: null, description: null, configSource: null, configError: null, warnings: [] },
    registered: false,
    schedule: { state: "none", until: null, daysLeft: null },
    operation: null,
    error: null,
    warning: null,
  })
  const fleet = [
    mk("nd-site-10", "running", "ok", 43110),
    mk("nd-site-2", "running", "ok", 43102),
    mk("nd-api", "exited", "ok", 43120),
    mk("nd-web", "running", "building", 43121),
    mk("nd-docs", "running", "failed", 43122),
  ]

  it("sorts failed first, then building, then ok, then stopped, with numbers compared as numbers", () => {
    expect(sortFleet(fleet).map((c) => c.name)).toEqual(["nd-docs", "nd-web", "nd-site-2", "nd-site-10", "nd-api"])
  })

  it("filters by every word in the name, image or port, and by state", () => {
    expect(filterFleet(fleet, { query: "site-10", states: [] }).map((c) => c.name)).toEqual(["nd-site-10"])
    expect(filterFleet(fleet, { query: "43121", states: [] }).map((c) => c.name)).toEqual(["nd-web"])
    // The port is searched too: 43102 contains "10", so the word 10 finds nd-site-2 as well.
    expect(filterFleet(fleet, { query: "site 10", states: [] }).map((c) => c.name)).toEqual(["nd-site-10", "nd-site-2"])
    expect(filterFleet(fleet, { query: "", states: ["failed", "stopped"] }).map((c) => c.name)).toEqual(["nd-api", "nd-docs"])
    expect(filterFleet(fleet, { query: "nd-", states: ["ok"] })).toHaveLength(2)
    expect(filterFleet(fleet, EMPTY_FILTER)).toBe(fleet)
  })

  it("toggles a state in and out of the filter", () => {
    const on = toggleState(EMPTY_FILTER, "failed")
    expect(on.states).toEqual(["failed"])
    expect(toggleState(on, "failed").states).toEqual([])
  })

  it("round-trips the filter through the address bar and ignores junk", () => {
    const filter = { query: "api gateway", states: ["failed", "building"] as BuildBadgeState[] }
    expect(filterFromHash(filterToHash(filter))).toEqual(filter)
    expect(filterToHash(EMPTY_FILTER)).toBe("")
    expect(filterFromHash("#s=failed,nonsense,failed")).toEqual({ query: "", states: ["failed"] })
    expect(filterFromHash("#something-else")).toEqual(EMPTY_FILTER)
  })

  it("starts only stopped containers and stops, restarts and rebuilds only running ones", () => {
    expect(eligibleFor("start", fleet).map((c) => c.name)).toEqual(["nd-api"])
    expect(eligibleFor("rebuild", fleet)).toHaveLength(4)
    expect(eligibleFor("stop", fleet).some((c) => c.name === "nd-api")).toBe(false)
  })
})
