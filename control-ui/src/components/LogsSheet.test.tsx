import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ContainerActions } from "@/components/ContainerActions"
import { LogsSheet } from "@/components/LogsSheet"
import { container, mockFetch, textResponse } from "@/test/fakeApi"

afterEach(() => {
  vi.unstubAllGlobals()
})

function Harness({ name }: { name: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open logs</button>
      <LogsSheet name={name} open={open} onOpenChange={setOpen} />
    </>
  )
}

describe("LogsSheet", () => {
  it("shows markup in log lines as literal text, with no script element", async () => {
    const spy = mockFetch(() => textResponse("boot ok\n<script>alert(1)</script>\n"))
    render(<Harness name="nd-site-a" />)

    fireEvent.click(screen.getByRole("button", { name: "Open logs" }))

    expect(await screen.findByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument()
    expect(document.querySelector("script")).toBeNull()
    expect(String(spy.mock.calls[0][0])).toBe("/api/containers/nd-site-a/logs?tail=200")
  })

  it("shows the lines of a stopped container", async () => {
    mockFetch(() => textResponse("last words before exit\nexit code 0\n"))
    render(<ContainerActions container={container({ state: "exited" })} readOnly={false} onChanged={() => {}} />)

    fireEvent.click(screen.getByRole("button", { name: "Logs" }))

    expect(await screen.findByText(/last words before exit/)).toBeInTheDocument()
    expect(screen.getByText(/exit code 0/)).toBeInTheDocument()
  })

  it("shows the server's error when logs cannot be loaded", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "no such container" }), { status: 404 }))
    render(<Harness name="gone" />)

    fireEvent.click(screen.getByRole("button", { name: "Open logs" }))

    expect(await screen.findByText("no such container")).toBeInTheDocument()
  })
})
