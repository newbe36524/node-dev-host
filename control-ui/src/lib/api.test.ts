import { afterEach, describe, expect, it, vi } from "vitest"
import {
  addNode,
  ApiError,
  deleteNode,
  extendAutoStart,
  fetchLogs,
  listContainers,
  recreateContainer,
  removeContainer,
  runContainerAction,
  scanNodes,
  stopAutoStart,
} from "@/lib/api"
import { jsonResponse, mockFetch, textResponse } from "@/test/fakeApi"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("api client", () => {
  it("lists containers without the control header", async () => {
    const fetchSpy = mockFetch(() =>
      jsonResponse({ readOnly: false, containers: [] }),
    )

    const list = await listContainers()

    expect(list).toEqual({ readOnly: false, containers: [] })
    const [, init] = fetchSpy.mock.calls[0]
    expect(init?.method ?? "GET").toBe("GET")
    expect(new Headers(init?.headers).has("X-Dev-Host-Control")).toBe(false)
  })

  it("sends the control header on a stop POST", async () => {
    const fetchSpy = mockFetch(() => jsonResponse({ ok: true }))

    await runContainerAction("nd-site-a", "stop")

    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe("/api/containers/nd-site-a/stop")
    expect(init?.method).toBe("POST")
    expect(new Headers(init?.headers).get("X-Dev-Host-Control")).toBe("1")
  })

  it("sends the control header on a DELETE", async () => {
    const fetchSpy = mockFetch(() => jsonResponse({ ok: true }))

    await removeContainer("nd-site-a")

    const [, init] = fetchSpy.mock.calls[0]
    expect(init?.method).toBe("DELETE")
    expect(new Headers(init?.headers).get("X-Dev-Host-Control")).toBe("1")
  })

  it("sends JSON and the control header for adding a node", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    const node = { name: "nd-site-a", workspace: "/srv/site-a", port: 43101, image: "node-dev-host:test", env: { NODE_ENV: "production" } }

    await addNode(node)

    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe("/api/nodes")
    expect(init?.method).toBe("POST")
    expect(new Headers(init?.headers).get("X-Dev-Host-Control")).toBe("1")
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json")
    expect(JSON.parse(String(init?.body))).toEqual(node)
  })

  it.each([
    ["delete node", () => deleteNode("nd-site-a"), "DELETE", "/api/nodes/nd-site-a"],
    ["extend auto-start", () => extendAutoStart("nd-site-a"), "POST", "/api/nodes/nd-site-a/auto-start"],
    ["stop auto-start", () => stopAutoStart("nd-site-a"), "DELETE", "/api/nodes/nd-site-a/auto-start"],
    ["recreate", () => recreateContainer("nd-site-a"), "POST", "/api/containers/nd-site-a/recreate"],
    ["scan", () => scanNodes(), "POST", "/api/scan"],
  ])("sends the control header on %s", async (_label, call, method, path) => {
    const spy = mockFetch(() => jsonResponse({ imported: [], skipped: [] }))
    await call()
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe(path)
    expect(init?.method).toBe(method)
    expect(new Headers(init?.headers).get("X-Dev-Host-Control")).toBe("1")
  })

  it("starts with auto-start using a JSON body", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    await runContainerAction("nd-site-a", "start", true)
    const [, init] = spy.mock.calls[0]
    expect(new Headers(init?.headers).get("X-Dev-Host-Control")).toBe("1")
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json")
    expect(JSON.parse(String(init?.body))).toEqual({ autoStart: true })
  })

  it("maps a JSON error body to its message", async () => {
    mockFetch(() => jsonResponse({ error: "container is busy" }, 409))

    const err = await runContainerAction("nd-site-a", "restart").catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toBe("container is busy")
    expect((err as ApiError).status).toBe(409)
  })

  it("falls back to an HTTP status message when the body is not JSON", async () => {
    mockFetch(() => textResponse("<html>oops</html>", 500))

    await expect(removeContainer("nd-site-a")).rejects.toThrow("Request failed with HTTP 500")
  })

  it.each([400, 403, 409, 413, 415, 503])("preserves the server error message for HTTP %i", async (status) => {
    mockFetch(() => jsonResponse({ error: `failure ${status}` }, status))
    await expect(addNode({ name: "nd-site-a", workspace: "/srv/site-a", port: 43101, image: "node-dev-host:test" }))
      .rejects.toMatchObject({ status, message: `failure ${status}` })
  })

  it("reports an unreachable server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))

    await expect(listContainers()).rejects.toThrow("Cannot reach the control server")
  })

  it("fetches logs as plain text with the default tail of 200", async () => {
    const fetchSpy = mockFetch(() => textResponse("line one\n<script>alert(1)</script>\n"))

    const body = await fetchLogs("nd-site-a")

    expect(body).toBe("line one\n<script>alert(1)</script>\n")
    expect(String(fetchSpy.mock.calls[0][0])).toBe("/api/containers/nd-site-a/logs?tail=200")
  })
})
