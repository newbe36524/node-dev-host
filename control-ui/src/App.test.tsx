import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "@/App"
import { container, jsonResponse, mockFetch } from "@/test/fakeApi"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("App header", () => {
  it("shows the container count, running count and the refresh time", async () => {
    mockFetch(() =>
      jsonResponse({
        readOnly: false,
        containers: [
          container(),
          container({ name: "nd-site-b", id: "def456", port: 43102, state: "exited", health: null }),
        ],
      }),
    )

    render(<App />)

    expect(await screen.findByText("2 containers, 1 running")).toBeInTheDocument()
    expect(await screen.findByText(/^Updated \d{2}:\d{2}:\d{2}$/)).toBeInTheDocument()
    expect(screen.queryByTestId("read-only-status")).toBeNull()
  })

  it("shows a read-only status in the header when the server is read-only", async () => {
    mockFetch(() => jsonResponse({
      readOnly: true,
      containers: [container()],
      persistence: { dir: "/var/lib/dev-host/control", writable: true, mounted: true, warning: null },
      nextPort: 43100,
    }))

    render(<App />)

    expect(await screen.findByTestId("read-only-status")).toHaveTextContent("Read-only")
    expect(screen.getByText("1 container, 1 running")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add node" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Scan" })).toBeDisabled()
  })

  it("shows distinct persistence alerts and disables Add node when records cannot be written", async () => {
    mockFetch(() => jsonResponse({
      readOnly: false,
      containers: [],
      persistence: {
        dir: "/var/lib/dev-host/control",
        writable: false,
        mounted: false,
        warning: "records are on an ephemeral filesystem",
      },
      nextPort: 43100,
    }))

    render(<App />)

    expect(await screen.findByTestId("persistence-not-mounted")).toHaveTextContent("may be lost if the control container is recreated")
    expect(screen.getByTestId("persistence-not-writable")).toHaveTextContent("records are on an ephemeral filesystem")
    expect(screen.getByRole("button", { name: "Add node" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Scan" })).toBeDisabled()
  })

  it("reports scan imports and each skipped reason", async () => {
    const list = {
      readOnly: false,
      containers: [container()],
      persistence: { dir: "/var/lib/dev-host/control", writable: true, mounted: true, warning: null },
      nextPort: 43102,
    }
    const spy = mockFetch((req) =>
      req.path === "/api/scan"
        ? jsonResponse({ imported: ["nd-imported"], skipped: [{ name: "nd-public", reason: "published port is not bound to loopback" }] })
        : jsonResponse(list),
    )
    render(<App />)
    await screen.findByText("1 container, 1 running")

    fireEvent.click(screen.getByRole("button", { name: "Scan" }))

    await waitFor(() =>
      expect(spy.mock.calls.some(([url, init]) => String(url) === "/api/scan" && init?.method === "POST")).toBe(true),
    )
    expect(await screen.findByTestId("scan-result")).toHaveTextContent(
      "Scan complete: 1 imported, 1 skipped — nd-imported — nd-public: published port is not bound to loopback",
    )
  })
})
