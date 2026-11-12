import { render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ContainerTable, openUrl } from "@/components/ContainerTable"
import { container } from "@/test/fakeApi"

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
})
