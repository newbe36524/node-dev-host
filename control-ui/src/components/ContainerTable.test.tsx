import { render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ContainerTable, openUrl } from "@/components/ContainerTable"
import { container, setViewport } from "@/test/fakeApi"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ContainerTable", () => {
  it("renders two containers with their port, image, state and build badge", () => {
    const containers = [
      container(),
      container({
        name: "nd-site-b",
        id: "def456",
        image: "node-dev-host:alpine",
        port: 43102,
        state: "exited",
        health: null,
        build: { state: "failed", builds: 1, failures: 1, finishedAt: null },
      }),
    ]

    render(<ContainerTable containers={containers} readOnly={false} onChanged={() => {}} />)

    const rowA = screen.getByRole("row", { name: /nd-site-a/ })
    expect(within(rowA).getByText("43101")).toBeInTheDocument()
    expect(within(rowA).getByText("node-dev-host:test")).toBeInTheDocument()
    expect(within(rowA).getByText("running")).toBeInTheDocument()
    expect(within(rowA).getByText("healthy")).toBeInTheDocument()
    expect(within(rowA).getByText("ok", { selector: "[data-state]" })).toBeInTheDocument()

    const rowB = screen.getByRole("row", { name: /nd-site-b/ })
    expect(within(rowB).getByText("43102")).toBeInTheDocument()
    expect(within(rowB).getByText("exited")).toBeInTheDocument()
    // A stopped container shows the "stopped" build badge, not its last build state.
    expect(within(rowB).getByText("stopped", { selector: "[data-state]" })).toBeInTheDocument()
    expect(within(rowB).queryByText("failed", { selector: "[data-state]" })).toBeNull()
  })

  it("shows an empty-state message instead of an error when there are no containers", () => {
    render(<ContainerTable containers={[]} readOnly={false} onChanged={() => {}} />)

    expect(screen.getByText(/No dev-host containers yet/)).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("opens the port on the page's host, using 127.0.0.1", () => {
    vi.stubGlobal("location", { protocol: "http:", hostname: "127.0.0.1" })

    render(<ContainerTable containers={[container()]} readOnly={false} onChanged={() => {}} />)

    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "http://127.0.0.1:43101/")
  })

  it("opens the port on the page's host, using devbox.local", () => {
    vi.stubGlobal("location", { protocol: "http:", hostname: "devbox.local" })

    render(<ContainerTable containers={[container()]} readOnly={false} onChanged={() => {}} />)

    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "http://devbox.local:43101/")
  })

  it("builds the open URL from protocol, hostname and port", () => {
    expect(openUrl(43101, { protocol: "https:", hostname: "devbox.local" })).toBe("https://devbox.local:43101/")
  })

  it("in read-only mode shows an alert, keeps the rows and disables every action", () => {
    render(
      <ContainerTable
        containers={[container(), container({ name: "nd-site-b", id: "def456", state: "exited", port: 43102 })]}
        readOnly
        onChanged={() => {}}
      />,
    )

    expect(screen.getByRole("alert")).toHaveTextContent("Read-only mode is on")
    expect(screen.getByText("nd-site-a")).toBeInTheDocument()
    expect(screen.getByText("nd-site-b")).toBeInTheDocument()

    for (const name of ["Rebuild", "Restart", "Stop", "Start", "Remove"]) {
      for (const button of screen.queryAllByRole("button", { name })) {
        expect(button).toBeDisabled()
      }
    }
  })

  it("shows active and ended auto-start windows as quiet time values", () => {
    render(
      <ContainerTable
        containers={[
          container({ schedule: { state: "active", until: "2026-11-18T10:00:00Z", daysLeft: 6 } }),
          container({ id: "def456", name: "nd-site-b", schedule: { state: "ended", until: "2026-11-10T10:00:00Z", daysLeft: 0 } }),
          container({ id: "ghi789", name: "nd-site-c" }),
        ]}
        readOnly={false}
        onChanged={() => {}}
      />,
    )

    const active = screen.getByRole("row", { name: /nd-site-a/ })
    const activeSchedule = within(active).getAllByRole("cell")[7]
    expect(within(activeSchedule).getByText(/6 days left/)).toBeInTheDocument()
    expect(within(activeSchedule).getByText(/Until/).tagName).toBe("TIME")
    const ended = screen.getByRole("row", { name: /nd-site-b/ })
    const endedSchedule = within(ended).getAllByRole("cell")[7]
    expect(within(endedSchedule).getByText(/Ended/)).toBeInTheDocument()
    const noWindow = screen.getByRole("row", { name: /nd-site-c/ })
    expect(within(within(noWindow).getAllByRole("cell")[7]).getByText("—")).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Auto-start" })).toHaveClass("hidden", "md:table-cell")
  })

  it("keeps an unregistered row unscheduled and omits node-only actions", () => {
    render(<ContainerTable containers={[container({ state: "exited" })]} readOnly={false} onChanged={() => {}} />)

    const row = screen.getByRole("row", { name: /nd-site-a/ })
    expect(within(row).getByText("—")).toBeInTheDocument()
    expect(within(row).queryByRole("button", { name: "Recreate" })).toBeNull()
    expect(within(row).queryByRole("button", { name: "Delete node" })).toBeNull()
  })

  it("shows a failed operation, error and warning on a narrow not-created card", () => {
    const restoreViewport = setViewport(false)
    render(
      <ContainerTable
        containers={[
          container({
            id: "node:nd-site-a",
            state: "not created",
            registered: true,
            operation: { phase: "creating", since: "2026-11-11T10:00:00Z" },
            error: "Docker refused the create",
            warning: "Latest image could not be pulled: pull access denied for node-dev-host, repository does not exist or may require 'docker login'",
          }),
        ]}
        readOnly={false}
        onChanged={() => {}}
      />,
    )

    const row = screen.getByRole("row", { name: /nd-site-a/ })
    const state = within(row).getByText("not created")
    expect(state).toHaveClass("border-dashed")
    expect(within(row).getByText("stopped", { selector: "[data-state]" })).toBeInTheDocument()
    expect(within(row).getByTestId("pending-action")).toHaveTextContent("creating…")
    expect(within(row).getByTestId("row-error")).toHaveTextContent("Docker refused the create")
    expect(within(row).getByTestId("row-warning")).toHaveTextContent("Latest image could not be pulled")
    expect(within(row).getByTestId("row-warning")).toHaveClass("w-72", "break-words")
    expect(within(row).queryByRole("link", { name: "Open" })).toBeNull()
    restoreViewport()
  })
})
