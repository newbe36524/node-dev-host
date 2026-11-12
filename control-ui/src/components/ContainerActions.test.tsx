import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Toaster } from "@/components/ui/sonner"
import { ContainerActions } from "@/components/ContainerActions"
import { jsonResponse, mockFetch, container } from "@/test/fakeApi"

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderActions(overrides: Parameters<typeof container>[0] = {}, readOnly = false) {
  const onChanged = vi.fn()
  render(
    <>
      <ContainerActions container={container(overrides)} readOnly={readOnly} onChanged={onChanged} />
      <Toaster />
    </>,
  )
  return { onChanged }
}

function mutatingCalls(spy: ReturnType<typeof mockFetch>) {
  return spy.mock.calls.filter(([, init]) => init?.method && init.method !== "GET")
}

describe("ContainerActions", () => {
  it("shows Rebuild, Restart and Stop for a running container, without Start", () => {
    renderActions()

    expect(screen.getByRole("button", { name: "Rebuild" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull()
  })

  it("shows Start for a stopped container, without Rebuild, Restart or Stop", () => {
    renderActions({ state: "exited" })

    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Rebuild" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
  })

  it("Remove sends nothing until confirmed, and nothing after cancelling", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    const { onChanged } = renderActions()

    fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Removing nd-site-a deletes the container and frees host port 43101")
    expect(mutatingCalls(spy)).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(spy).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("Remove sends a DELETE with the control header once confirmed", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    const { onChanged } = renderActions()

    fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe("/api/containers/nd-site-a")
    expect(init?.method).toBe("DELETE")
    expect(new Headers(init?.headers).get("X-Dev-Host-Control")).toBe("1")
  })

  it("a failed action shows the server's error message in a toast", async () => {
    mockFetch(() => jsonResponse({ error: "docker refused the restart" }, 500))
    const { onChanged } = renderActions()

    fireEvent.click(screen.getByRole("button", { name: "Restart" }))

    expect(await screen.findByText(/docker refused the restart/)).toBeInTheDocument()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("a successful action sends a POST with the control header and refreshes", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    const { onChanged } = renderActions()

    fireEvent.click(screen.getByRole("button", { name: "Stop" }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe("/api/containers/nd-site-a/stop")
    expect(init?.method).toBe("POST")
    expect(new Headers(init?.headers).get("X-Dev-Host-Control")).toBe("1")
  })

  it("in read-only mode disables Start, Rebuild, Restart, Stop and Remove", () => {
    renderActions({}, true)

    for (const name of ["Rebuild", "Restart", "Stop", "Remove"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled()
    }
  })
})
