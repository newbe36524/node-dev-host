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

  it("Remove container sends nothing until confirmed, and nothing after cancelling", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    const { onChanged } = renderActions({ registered: true })

    fireEvent.click(screen.getByRole("button", { name: "Remove container" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Removing nd-site-a deletes the container and frees host port 43101")
    expect(dialog).toHaveTextContent("The saved node record remains")
    expect(mutatingCalls(spy)).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(spy).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("Remove container sends a DELETE with the control header once confirmed", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    const { onChanged } = renderActions({ registered: true })

    fireEvent.click(screen.getByRole("button", { name: "Remove container" }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove container" }))

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

    expect(await screen.findByText(/nd-site-a: restart failed\. docker refused the restart/)).toBeInTheDocument()
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

    for (const name of ["Rebuild", "Restart", "Stop", "Remove container"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled()
    }
  })

  it("disables every registered-node mutation in read-only mode", () => {
    renderActions({ registered: true }, true)

    for (const name of ["Rebuild", "Restart", "Stop", "Recreate", "Extend 7 days", "Stop auto-start", "Remove container", "Delete node"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled()
    }
  })

  it("shows registered-node actions and sends their routes", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    renderActions({ registered: true, state: "exited" })

    for (const label of ["Recreate", "Extend 7 days", "Stop auto-start", "Delete node"]) {
      expect(screen.getByRole("button", { name: label })).toBeEnabled()
    }

    fireEvent.click(screen.getByRole("button", { name: "Recreate" }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "Extend 7 days" }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole("button", { name: "Stop auto-start" }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3))
    expect(spy.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/containers/nd-site-a/recreate",
      "/api/nodes/nd-site-a/auto-start",
      "/api/nodes/nd-site-a/auto-start",
    ])
    expect(spy.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "POST", "DELETE"])
  })

  it("asks before deleting the node and says its record will be deleted too", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    renderActions({ registered: true, state: "exited" })
    fireEvent.click(screen.getByRole("button", { name: "Delete node" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("saved node record")
    expect(spy).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(spy).not.toHaveBeenCalled()
  })

  it("sends a confirmed Delete node request", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    renderActions({ registered: true, state: "exited" })
    fireEvent.click(screen.getByRole("button", { name: "Delete node" }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete node" }))

    await waitFor(() => expect(spy).toHaveBeenCalledOnce())
    expect(String(spy.mock.calls[0][0])).toBe("/api/nodes/nd-site-a")
    expect(spy.mock.calls[0][1]?.method).toBe("DELETE")
  })

  it("prompts before starting without an active window and Cancel sends nothing", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    renderActions({ registered: true, state: "exited" })
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("This node has no active auto-start window")

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(spy).not.toHaveBeenCalled()
  })

  it("starts without an auto-start body when Start only is chosen", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    renderActions({ registered: true, state: "exited" })
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Start only" }))

    await waitFor(() => expect(spy).toHaveBeenCalledOnce())
    expect(String(spy.mock.calls[0][0])).toBe("/api/containers/nd-site-a/start")
    expect(spy.mock.calls[0][1]?.body).toBeUndefined()
  })

  it("sets auto-start when Start and auto-start is chosen", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    renderActions({ registered: true, state: "exited" })
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Start and auto-start" }))

    await waitFor(() => expect(spy).toHaveBeenCalledOnce())
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toEqual({ autoStart: true })
  })

  it("starts immediately when the auto-start window is active", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    renderActions({
      registered: true,
      state: "exited",
      schedule: { state: "active", until: "2026-11-18T10:00:00Z", daysLeft: 7 },
    })
    fireEvent.click(screen.getByRole("button", { name: "Start" }))

    await waitFor(() => expect(spy).toHaveBeenCalledOnce())
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(spy.mock.calls[0][1]?.body).toBeUndefined()
  })
})
