import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NpmRegistryDialog } from "@/components/NpmRegistryDialog"
import { jsonResponse, mockFetch } from "@/test/fakeApi"

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderDialog(current: string | null, onSaved = vi.fn()) {
  const onOpenChange = vi.fn()
  render(<NpmRegistryDialog open onOpenChange={onOpenChange} current={current} onSaved={onSaved} />)
  return { onSaved, onOpenChange }
}

describe("NpmRegistryDialog", () => {
  it("starts from the saved registry and posts the trimmed value", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true, settings: { npmRegistry: "http://mirror.test/" } }))
    const { onSaved, onOpenChange } = renderDialog("http://old.test/")

    expect(screen.getByLabelText("Registry URL")).toHaveValue("http://old.test/")
    fireEvent.change(screen.getByLabelText("Registry URL"), { target: { value: "  http://mirror.test/  " } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(onOpenChange).toHaveBeenCalledWith(false)
    const [, init] = spy.mock.calls[0]
    expect(init?.method).toBe("POST")
    expect(new Headers(init?.headers).get("X-Dev-Host-Control")).toBe("1")
    expect(JSON.parse(String(init?.body))).toEqual({ npmRegistry: "http://mirror.test/" })
  })

  it("'Use default' saves null", async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true, settings: { npmRegistry: null } }))
    const { onSaved } = renderDialog("http://old.test/")

    fireEvent.click(screen.getByRole("button", { name: "Use default" }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toEqual({ npmRegistry: null })
  })

  it("shows the server's refusal and keeps the dialog open", async () => {
    mockFetch(() => jsonResponse({ error: "npmRegistry must not contain credentials; put them in the workspace .npmrc" }, 400))
    const { onSaved, onOpenChange } = renderDialog(null)

    fireEvent.change(screen.getByLabelText("Registry URL"), { target: { value: "https://u:p@mirror.test/" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByTestId("npm-registry-error")).toHaveTextContent("must not contain credentials")
    expect(onSaved).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
