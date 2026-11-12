import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Toaster } from "@/components/ui/sonner"
import { ContainerActions } from "@/components/ContainerActions"
import { container, jsonResponse, mockFetch, setViewport } from "@/test/fakeApi"

let restoreViewport: (() => void) | undefined

afterEach(() => {
  restoreViewport?.()
  restoreViewport = undefined
  vi.unstubAllGlobals()
})

function openMenu(name: string) {
  // Radix opens dropdown menus on pointer down.
  fireEvent.pointerDown(screen.getByRole("button", { name: `Actions for ${name}` }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  })
}

describe("ContainerActions on a narrow viewport", () => {
  it("collapses the actions into one Actions menu with the same items", async () => {
    restoreViewport = setViewport(false)
    render(<ContainerActions container={container()} readOnly={false} onChanged={() => {}} />)

    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
    openMenu("nd-site-a")

    const menu = await screen.findByRole("menu")
    expect(within(menu).getByRole("menuitem", { name: "Rebuild" })).toBeEnabled()
    expect(within(menu).getByRole("menuitem", { name: "Restart" })).toBeEnabled()
    expect(within(menu).getByRole("menuitem", { name: "Stop" })).toBeEnabled()
    expect(within(menu).getByRole("menuitem", { name: "Logs" })).toBeEnabled()
    expect(within(menu).getByRole("menuitem", { name: "Remove" })).toBeEnabled()
    expect(within(menu).queryByRole("menuitem", { name: "Start" })).toBeNull()
  })

  it("runs a menu action and sends the control header", async () => {
    restoreViewport = setViewport(false)
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    const onChanged = vi.fn()
    render(
      <>
        <ContainerActions container={container()} readOnly={false} onChanged={onChanged} />
        <Toaster />
      </>,
    )

    openMenu("nd-site-a")
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop" }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe("/api/containers/nd-site-a/stop")
    expect(init?.method).toBe("POST")
    expect(new Headers(init?.headers).get("X-Dev-Host-Control")).toBe("1")
  })

  it("Remove from the menu opens the dialog and sends nothing until confirmed", async () => {
    restoreViewport = setViewport(false)
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    render(<ContainerActions container={container({ state: "exited", port: 43102 })} readOnly={false} onChanged={() => {}} />)

    openMenu("nd-site-a")
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }))

    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Removing nd-site-a deletes the container and frees host port 43102")
    expect(spy).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy.mock.calls[0][1]?.method).toBe("DELETE")
  })

  it("in read-only mode disables the mutating menu items but keeps Logs", async () => {
    restoreViewport = setViewport(false)
    render(<ContainerActions container={container()} readOnly onChanged={() => {}} />)

    openMenu("nd-site-a")
    const menu = await screen.findByRole("menu")
    for (const name of ["Rebuild", "Restart", "Stop", "Remove"]) {
      expect(within(menu).getByRole("menuitem", { name })).toHaveAttribute("data-disabled")
    }
    expect(within(menu).getByRole("menuitem", { name: "Logs" })).not.toHaveAttribute("data-disabled")
  })
})
