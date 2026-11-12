import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, fetchLogs, listContainers, removeContainer, runContainerAction } from "@/lib/api"
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
