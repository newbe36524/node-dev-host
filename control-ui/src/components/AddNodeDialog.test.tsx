import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AddNodeDialog } from "@/components/AddNodeDialog"
import { jsonResponse, mockFetch } from "@/test/fakeApi"

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderDialog(nextPort: number | null, onAdded = vi.fn()) {
  const onOpenChange = vi.fn()
  render(<AddNodeDialog open onOpenChange={onOpenChange} nextPort={nextPort} onAdded={onAdded} />)
  return { onAdded, onOpenChange }
}

describe("AddNodeDialog", () => {
  it("proposes the server's next port and submits JSON", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true }))
    const { onAdded } = renderDialog(43123)

    expect(screen.getByLabelText("Port")).toHaveValue(43123)
    expect(screen.getByLabelText("Image")).toHaveValue("ghcr.io/newbe36524/node-dev-host")
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "nd-docs" } })
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "/srv/docs" } })
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "NODE_ENV=production\nAPI_URL=https://example.test/a=b" } })
    fireEvent.click(screen.getByRole("button", { name: "Add node" }))

    await waitFor(() => expect(onAdded).toHaveBeenCalledOnce())
    const [, init] = spy.mock.calls[0]
    expect(init?.method).toBe("POST")
    expect(new Headers(init?.headers).get("X-Dev-Host-Control")).toBe("1")
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "nd-docs",
      workspace: "/srv/docs",
      port: 43123,
      image: "ghcr.io/newbe36524/node-dev-host",
      env: { NODE_ENV: "production", API_URL: "https://example.test/a=b" },
    })
  })

  it("seeds the port when the dialog opens after the list loads", () => {
    const onOpenChange = vi.fn()
    const props = { onOpenChange, onAdded: vi.fn(), disabled: false }
    const { rerender } = render(<AddNodeDialog {...props} open={false} nextPort={null} />)

    rerender(<AddNodeDialog {...props} open={false} nextPort={43123} />)
    rerender(<AddNodeDialog {...props} open nextPort={43123} />)

    expect(screen.getByLabelText("Port")).toHaveValue(43123)
  })

  it("keeps values and shows server validation next to the form", async () => {
    mockFetch(() => jsonResponse({ error: "port already in use: 43123" }, 409))
    renderDialog(43123)
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "nd-docs" } })
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "/srv/docs" } })
    fireEvent.click(screen.getByRole("button", { name: "Add node" }))

    expect(await screen.findByTestId("add-node-error")).toHaveTextContent("port already in use: 43123")
    expect(screen.getByLabelText("Name")).toHaveValue("nd-docs")
    expect(screen.getByLabelText("Port")).toHaveValue(43123)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})
