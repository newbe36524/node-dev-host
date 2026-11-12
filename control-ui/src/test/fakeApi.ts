import { vi } from "vitest"
import type { ContainerInfo } from "@/lib/api"

export type FakeRequest = { method: string; path: string; headers: Headers }
export type FakeHandler = (req: FakeRequest) => Response | Promise<Response>

/** Replaces global fetch with a handler and returns the spy so tests can inspect calls. */
export function mockFetch(handler: FakeHandler) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://control.test")
    return handler({
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      headers: new Headers(init?.headers),
    })
  })
  vi.stubGlobal("fetch", spy)
  return spy
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export function textResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } })
}

export function container(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    name: "nd-site-a",
    id: "abc123",
    image: "node-dev-host:test",
    port: 43101,
    state: "running",
    health: "healthy",
    build: { state: "ok", builds: 3, failures: 0, finishedAt: "2026-11-11T10:00:00Z" },
    registered: false,
    schedule: { state: "none", until: null, daysLeft: null },
    operation: null,
    error: null,
    warning: null,
    ...overrides,
  }
}

/** Makes window.matchMedia report the given viewport for the md breakpoint. Returns a restore function. */
export function setViewport(wide: boolean) {
  const previous = window.matchMedia
  window.matchMedia = (query: string) =>
    ({
      matches: wide && query === "(min-width: 768px)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
  return () => {
    window.matchMedia = previous
  }
}

/**
 * A host at its limit: 50 containers named nd-site-01 to nd-site-50.
 * 03, 17 and 41 have failed, 08 and 22 are building, 12 and 33 are stopped; the other 43 are ok.
 */
export function fleet50(): { readOnly: boolean; containers: ContainerInfo[]; persistence: { dir: string; writable: boolean; mounted: boolean; warning: null }; nextPort: number } {
  const failed = new Set([3, 17, 41])
  const building = new Set([8, 22])
  const stopped = new Set([12, 33])
  const containers = Array.from({ length: 50 }, (_, i) => {
    const n = i + 1
    const label = String(n).padStart(2, "0")
    const base = container({ name: `nd-site-${label}`, id: `id${label}`, port: 43100 + n })
    if (stopped.has(n)) return { ...base, state: "exited" as const, health: null }
    if (failed.has(n)) return { ...base, build: { state: "failed" as const, builds: 1, failures: 1, finishedAt: null } }
    if (building.has(n)) return { ...base, build: { state: "building" as const, builds: 1, failures: 0, finishedAt: null } }
    return base
  })
  return { readOnly: false, containers, persistence: { dir: "/var/lib/dev-host/control", writable: true, mounted: true, warning: null }, nextPort: 43100 }
}
