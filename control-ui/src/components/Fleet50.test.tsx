import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import App from "@/App"
import { FleetRibbon, TILE_LIMIT } from "@/components/FleetRibbon"
import { fleet50, jsonResponse, mockFetch } from "@/test/fakeApi"

beforeEach(() => {
  window.history.replaceState(null, "", "/")
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function rowNames(): string[] {
  return Array.from(document.querySelectorAll("[data-row]")).map((row) => row.querySelector("td:nth-child(2)")?.textContent ?? "")
}

async function open() {
  const spy = mockFetch((req) => (req.method === "POST" ? jsonResponse({ ok: true }) : jsonResponse(fleet50())))
  render(<App />)
  await screen.findByTestId("fleet-toolbar")
  return spy
}

const posts = (spy: ReturnType<typeof mockFetch>) =>
  spy.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => String(url))

describe("50 containers: reading the list", () => {
  it("lists failed containers first, then building, then ok, with stopped last", async () => {
    await open()
    const names = rowNames()

    expect(names).toHaveLength(50)
    expect(names.slice(0, 3)).toEqual(["nd-site-03", "nd-site-17", "nd-site-41"])
    expect(names.slice(3, 5)).toEqual(["nd-site-08", "nd-site-22"])
    expect(names.slice(-2)).toEqual(["nd-site-12", "nd-site-33"])
  })

  it("turns the fleet into a dense matrix of 50 cells that keeps the host's order", async () => {
    await open()
    const cells = within(screen.getByTestId("fleet-ribbon")).getAllByRole("button", { name: /^nd-site-\d+: / })

    expect(cells).toHaveLength(50)
    expect(cells[0]).toHaveAccessibleName("nd-site-01: ok")
    expect(cells[2]).toHaveAccessibleName("nd-site-03: failed")
    expect(screen.getByTestId("matrix-readout")).toHaveTextContent("Hover or focus a cell")

    fireEvent.mouseEnter(cells[2])
    expect(screen.getByTestId("matrix-readout")).toHaveTextContent("nd-site-03 · failed · port 43103")
  })

  it("keeps the matrix as tiles up to the limit, and as a matrix past it", () => {
    const { containers } = fleet50()
    const { unmount } = render(<FleetRibbon containers={containers.slice(0, TILE_LIMIT)} />)
    expect(screen.queryByTestId("matrix-readout")).toBeNull()
    unmount()
    render(<FleetRibbon containers={containers.slice(0, TILE_LIMIT + 1)} />)
    expect(screen.getByTestId("matrix-readout")).toBeInTheDocument()
  })

  it("the counts are the filter: pressing 3 failed shows only those rows and dims the rest of the matrix", async () => {
    await open()

    fireEvent.click(screen.getByRole("button", { name: /^3 failed/ }))

    expect(rowNames()).toEqual(["nd-site-03", "nd-site-17", "nd-site-41"])
    expect(screen.getByTestId("filter-result")).toHaveTextContent("3 of 50 shown")
    expect(window.location.hash).toBe("#s=failed")
    expect(screen.getByRole("button", { name: "nd-site-01: ok" })).toHaveAttribute("data-dim", "true")
    expect(screen.getByRole("button", { name: "nd-site-03: failed" })).not.toHaveAttribute("data-dim")

    fireEvent.click(screen.getByRole("button", { name: /^3 failed/ }))
    expect(rowNames()).toHaveLength(50)
    expect(window.location.hash).toBe("")
  })

  it("searches by name, image or port, says how many it kept, and clears with Esc", async () => {
    await open()
    const input = screen.getByRole("searchbox", { name: "Filter containers" })

    fireEvent.change(input, { target: { value: "site-4" } })
    // nd-site-40 to nd-site-49. The failed one (41) still sorts to the top of what is left.
    expect(rowNames()).toHaveLength(10)
    expect(rowNames()[0]).toBe("nd-site-41")
    expect(screen.getByTestId("filter-result")).toHaveTextContent("10 of 50 shown")

    fireEvent.change(input, { target: { value: "43117" } })
    expect(rowNames()).toEqual(["nd-site-17"])

    fireEvent.keyDown(input, { key: "Escape" })
    expect(input).toHaveValue("")
    expect(rowNames()).toHaveLength(50)
  })

  it("says so when a filter keeps nothing, and offers the way back", async () => {
    await open()

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter containers" }), { target: { value: "zzz" } })

    expect(screen.getByTestId("no-match")).toHaveTextContent("No container matches this filter.")
    fireEvent.click(within(screen.getByTestId("no-match")).getByRole("button", { name: "Clear filters" }))
    expect(rowNames()).toHaveLength(50)
  })

  it("restores the filter from the address bar on load", async () => {
    window.history.replaceState(null, "", "/#q=site-1&s=building")
    mockFetch(() => jsonResponse(fleet50()))
    render(<App />)
    await screen.findByTestId("fleet-toolbar")

    expect(screen.getByRole("searchbox", { name: "Filter containers" })).toHaveValue("site-1")
    expect(rowNames()).toEqual([])
    expect(screen.getByTestId("no-match")).toBeInTheDocument()
  })

  it("draws only the timeline lanes that changed and counts the rest", async () => {
    await open()
    const timeline = await screen.findByTestId("session-timeline")

    expect(within(timeline).queryAllByRole("img")).toHaveLength(0)
    expect(within(timeline).getByText("No state changes since you opened this page.")).toBeInTheDocument()
  })
})

describe("50 containers: keyboard", () => {
  it("/ focuses the filter, f walks the failed rows and wraps, Esc lets go of the cursor", async () => {
    await open()

    fireEvent.keyDown(document, { key: "/" })
    expect(screen.getByRole("searchbox", { name: "Filter containers" })).toHaveFocus()
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" })
    ;(document.activeElement as HTMLElement).blur()

    const selected = () => document.querySelector("[data-row][data-selected]")?.getAttribute("data-container-id")
    fireEvent.keyDown(document, { key: "f" })
    expect(selected()).toBe("id03")
    fireEvent.keyDown(document, { key: "f" })
    expect(selected()).toBe("id17")
    fireEvent.keyDown(document, { key: "f" })
    expect(selected()).toBe("id41")
    fireEvent.keyDown(document, { key: "f" })
    expect(selected()).toBe("id03")

    fireEvent.keyDown(document, { key: "Escape" })
    expect(selected()).toBeUndefined()
  })

  it("x ticks the row under the cursor and the first Esc lets go of the batch before the cursor", async () => {
    await open()
    fireEvent.keyDown(document, { key: "j" })
    fireEvent.keyDown(document, { key: "x" })

    expect(screen.getByTestId("bulk-bar")).toHaveTextContent("1 selected")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByTestId("bulk-bar")).toBeNull()
    expect(document.querySelector("[data-row][data-selected]")).not.toBeNull()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(document.querySelector("[data-row][data-selected]")).toBeNull()
  })
})

describe("50 containers: acting on many", () => {
  it("ticks every failed row from the filter, rebuilds them in one press, and reports once", async () => {
    const spy = await open()
    fireEvent.click(screen.getByRole("button", { name: /^3 failed/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick all shown" }))

    const bar = screen.getByTestId("bulk-bar")
    expect(bar).toHaveTextContent("3 selected")
    fireEvent.click(within(bar).getByRole("button", { name: "Rebuild 3 of 3 selected" }))

    await waitFor(() => expect(posts(spy).sort()).toEqual(["/api/containers/nd-site-03/rebuild", "/api/containers/nd-site-17/rebuild", "/api/containers/nd-site-41/rebuild"]))
    await waitFor(() => expect(screen.queryByTestId("bulk-bar")).toBeNull())
  })

  it("Shift-click ticks the whole stretch between two rows", async () => {
    await open()
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick nd-site-03" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick nd-site-08" }), { shiftKey: true })

    // 03, 17, 41, 08: the first four rows in triage order.
    expect(screen.getByTestId("bulk-bar")).toHaveTextContent("4 selected")
  })

  it("counts, per action, how much of a mixed selection it applies to, and skips the rest", async () => {
    const spy = await open()
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick nd-site-01" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick nd-site-12" }))

    const bar = screen.getByTestId("bulk-bar")
    expect(within(bar).getByRole("button", { name: "Rebuild 1 of 2 selected" })).toBeEnabled()
    expect(within(bar).getByRole("button", { name: "Start 1 of 2 selected" })).toBeEnabled()

    fireEvent.click(within(bar).getByRole("button", { name: "Start 1 of 2 selected" }))
    await waitFor(() => expect(posts(spy)).toEqual(["/api/containers/nd-site-12/start"]))
  })

  it("asks before stopping or restarting several, naming them, and does nothing on Cancel", async () => {
    const spy = await open()
    fireEvent.click(screen.getByRole("button", { name: /^3 failed/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick all shown" }))
    fireEvent.click(screen.getByRole("button", { name: "Stop 3 of 3 selected" }))

    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Stop 3 containers?")
    expect(dialog).toHaveTextContent("nd-site-03, nd-site-17, nd-site-41")
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))

    expect(posts(spy)).toEqual([])
    fireEvent.click(screen.getByRole("button", { name: "Stop 3 of 3 selected" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Stop 3" }))
    await waitFor(() => expect(posts(spy)).toHaveLength(3))
  })

  it("does not ask for one container, and disables everything in read-only mode", async () => {
    const readOnly = { ...fleet50(), readOnly: true }
    mockFetch(() => jsonResponse(readOnly))
    render(<App />)
    await screen.findByTestId("fleet-toolbar")

    fireEvent.click(screen.getByRole("checkbox", { name: "Tick nd-site-01" }))
    for (const button of within(screen.getByTestId("bulk-bar")).getAllByRole("button", { name: /of 1 selected/ })) {
      expect(button).toBeDisabled()
    }
  })

  it("never acts on a ticked row the filter has since hidden", async () => {
    const spy = await open()
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick nd-site-01" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick nd-site-03" }))
    fireEvent.click(screen.getByRole("button", { name: /^3 failed/ }))

    const bar = screen.getByTestId("bulk-bar")
    expect(bar).toHaveTextContent("1 selected")
    fireEvent.click(within(bar).getByRole("button", { name: "Rebuild 1 of 1 selected" }))
    await waitFor(() => expect(posts(spy)).toEqual(["/api/containers/nd-site-03/rebuild"]))
  })
})

describe("50 containers: command palette", () => {
  it("opens on group commands, not on 250 per-container ones", async () => {
    await open()
    fireEvent.keyDown(document, { key: "k", ctrlKey: true })
    await screen.findByRole("combobox", { name: "Search commands" })

    const labels = screen.getAllByRole("option").map((o) => o.textContent)
    expect(labels).toContain("Rebuild 3 failed")
    expect(labels).toContain("Start 2 stopped")
    expect(labels.some((l) => /^Show only failed/.test(l ?? ""))).toBe(true)
    expect(labels.some((l) => /^Logs:/.test(l ?? ""))).toBe(false)
    expect(labels.length).toBeLessThan(20)
  })

  it("Rebuild 3 failed runs the batch", async () => {
    const spy = await open()
    fireEvent.keyDown(document, { key: "k", ctrlKey: true })
    const input = await screen.findByRole("combobox", { name: "Search commands" })
    fireEvent.change(input, { target: { value: "rebuild failed" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => expect(posts(spy)).toHaveLength(3))
    expect(posts(spy).every((u) => u.endsWith("/rebuild"))).toBe(true)
  })

  it("caps the list at 30 and says how many more there are, ranking a name's own commands first", async () => {
    await open()
    fireEvent.keyDown(document, { key: "k", ctrlKey: true })
    const input = await screen.findByRole("combobox", { name: "Search commands" })

    fireEvent.change(input, { target: { value: "nd-site" } })
    expect(screen.getAllByRole("option")).toHaveLength(30)
    expect(screen.getByTestId("palette-more")).toHaveTextContent(/Showing 30 of \d+/)

    fireEvent.change(input, { target: { value: "site-17" } })
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Go to nd-site-17")
  })

  it("Go to a container the filter hides ends the filter and moves the cursor there", async () => {
    await open()
    fireEvent.click(screen.getByRole("button", { name: /^3 failed/ }))
    fireEvent.keyDown(document, { key: "k", ctrlKey: true })
    const input = await screen.findByRole("combobox", { name: "Search commands" })
    fireEvent.change(input, { target: { value: "go to site-25" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => expect(rowNames()).toHaveLength(50))
    expect(document.querySelector('[data-container-id="id25"]')).toHaveAttribute("data-selected", "true")
  })
})

describe("50 containers: row actions", () => {
  it("fold into a menu beside Logs, so fifty rows do not carry two hundred and fifty buttons", async () => {
    const spy = await open()
    const row = document.querySelector('[data-container-id="id01"]') as HTMLElement

    expect(within(row).getByRole("button", { name: "Logs" })).toBeInTheDocument()
    expect(within(row).queryByRole("button", { name: "Rebuild" })).toBeNull()
    expect(within(row).queryByRole("button", { name: "Remove" })).toBeNull()

    const trigger = within(row).getByRole("button", { name: "Actions for nd-site-01" })
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rebuild" }))
    await waitFor(() => expect(posts(spy)).toEqual(["/api/containers/nd-site-01/rebuild"]))
  })

  it("stay as buttons on a small fleet", async () => {
    mockFetch(() => jsonResponse({ readOnly: false, containers: fleet50().containers.slice(0, 3) }))
    render(<App />)
    const row = await waitFor(() => {
      const r = document.querySelector('[data-container-id="id01"]') as HTMLElement
      expect(r).not.toBeNull()
      return r
    })
    expect(within(row).getByRole("button", { name: "Rebuild" })).toBeInTheDocument()
  })
})
