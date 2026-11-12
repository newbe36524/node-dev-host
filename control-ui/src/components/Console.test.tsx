import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "@/App"
import { FleetRibbon } from "@/components/FleetRibbon"
import { filterItems, type PaletteItem } from "@/components/CommandPalette"
import { container, jsonResponse, mockFetch, textResponse } from "@/test/fakeApi"

afterEach(() => {
  vi.unstubAllGlobals()
})

const failedBuild = { state: "failed", builds: 1, failures: 1, finishedAt: null } as const

function twoContainers() {
  return {
    readOnly: false,
    containers: [container(), container({ name: "nd-site-b", id: "def456", port: 43102, build: failedBuild })],
  }
}

describe("FleetRibbon", () => {
  it("prints a word for every segment and totals the fleet with faults first", () => {
    render(<FleetRibbon containers={twoContainers().containers} />)

    expect(screen.getByRole("button", { name: "nd-site-a: ok" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "nd-site-b: failed" })).toBeInTheDocument()
    expect(screen.getByTestId("fleet-summary")).toHaveTextContent("1 failed1 ok")
  })

  it("renders nothing for an empty fleet", () => {
    const { container: root } = render(<FleetRibbon containers={[]} />)
    expect(root).toBeEmptyDOMElement()
  })

  it("selects the container when its segment is pressed", () => {
    const onSelect = vi.fn()
    render(<FleetRibbon containers={twoContainers().containers} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole("button", { name: "nd-site-b: failed" }))

    expect(onSelect).toHaveBeenCalledWith("def456")
  })
})

describe("filterItems", () => {
  const items: PaletteItem[] = [
    { id: "1", label: "Rebuild nd-site-a", detail: "nd-site-a", run: () => {} },
    { id: "2", label: "Logs: nd-site-b", detail: "nd-site-b", keywords: "output", run: () => {} },
  ]
  it("needs every word to match, in any order", () => {
    expect(filterItems(items, "site rebuild").map((i) => i.id)).toEqual(["1"])
    expect(filterItems(items, "output b").map((i) => i.id)).toEqual(["2"])
    expect(filterItems(items, "  ")).toHaveLength(2)
    expect(filterItems(items, "zzz")).toEqual([])
  })
})

describe("Console home", () => {
  it("shows the fleet ribbon and the session timeline with an honest caption", async () => {
    mockFetch(() => jsonResponse(twoContainers()))
    render(<App />)

    expect(await screen.findByTestId("fleet-ribbon")).toBeInTheDocument()
    const timeline = await screen.findByTestId("session-timeline")
    expect(timeline).toHaveTextContent("The server keeps no history")
    expect(within(timeline).getByText("No state changes since you opened this page.")).toBeInTheDocument()
  })

  it("moves the cursor with j and k and opens logs for the selected row with L", async () => {
    const spy = mockFetch((req) =>
      req.path.includes("/logs") ? textResponse("hello from b\n") : jsonResponse(twoContainers()),
    )
    render(<App />)
    await screen.findByTestId("fleet-ribbon")

    // The table lists failed first, so the cursor starts on nd-site-b and walks down to nd-site-a.
    fireEvent.keyDown(document, { key: "j" })
    expect(document.querySelector('[data-container-id="def456"]')).toHaveAttribute("data-selected", "true")

    fireEvent.keyDown(document, { key: "j" })
    expect(document.querySelector('[data-container-id="abc123"]')).toHaveAttribute("data-selected", "true")

    fireEvent.keyDown(document, { key: "k" })
    fireEvent.keyDown(document, { key: "l" })
    expect(await screen.findByText(/hello from b/)).toBeInTheDocument()
    expect(spy.mock.calls.some(([url]) => String(url) === "/api/containers/nd-site-b/logs?tail=200")).toBe(true)
  })

  it("R rebuilds the selected running container and shows it as in flight", async () => {
    let release: () => void = () => {}
    const spy = mockFetch((req) => {
      if (req.method === "POST") {
        return new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse({ ok: true }))
        })
      }
      return jsonResponse(twoContainers())
    })
    render(<App />)
    await screen.findByTestId("fleet-ribbon")

    fireEvent.keyDown(document, { key: "j" })
    fireEvent.keyDown(document, { key: "r" })

    expect(await screen.findByTestId("pending-action")).toHaveTextContent("rebuilding…")
    expect(spy.mock.calls.some(([url, init]) => String(url) === "/api/containers/nd-site-b/rebuild" && init?.method === "POST")).toBe(true)
    release()
  })

  it("does not rebuild in read-only mode", async () => {
    const spy = mockFetch(() => jsonResponse({ ...twoContainers(), readOnly: true }))
    render(<App />)
    await screen.findByTestId("fleet-ribbon")

    fireEvent.keyDown(document, { key: "j" })
    fireEvent.keyDown(document, { key: "r" })

    expect(spy.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0)
  })

  it("opens the command palette with Ctrl+K, filters it, and runs the chosen command with Enter", async () => {
    const spy = mockFetch((req) => (req.method === "POST" ? jsonResponse({ ok: true }) : jsonResponse(twoContainers())))
    render(<App />)
    await screen.findByTestId("fleet-ribbon")

    fireEvent.keyDown(document, { key: "k", ctrlKey: true })
    const input = await screen.findByRole("combobox", { name: "Search commands" })
    fireEvent.change(input, { target: { value: "restart site-b" } })

    expect(screen.getAllByRole("option")).toHaveLength(1)
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() =>
      expect(spy.mock.calls.some(([url, init]) => String(url) === "/api/containers/nd-site-b/restart" && init?.method === "POST")).toBe(true),
    )
  })

  it("hides commands that change a container when the server is read-only", async () => {
    mockFetch(() => jsonResponse({ ...twoContainers(), readOnly: true }))
    render(<App />)
    await screen.findByTestId("fleet-ribbon")

    fireEvent.keyDown(document, { key: "k", ctrlKey: true })
    const input = await screen.findByRole("combobox", { name: "Search commands" })
    fireEvent.change(input, { target: { value: "restart" } })

    expect(screen.queryAllByRole("option")).toHaveLength(0)
    expect(screen.getByText(/Read-only mode: commands that change a container are hidden/)).toBeInTheDocument()
  })
})
