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
