import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "@/App"
import { container, jsonResponse, mockFetch } from "@/test/fakeApi"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("App header", () => {
  it("shows the container count, running count and the refresh time", async () => {
    mockFetch(() =>
      jsonResponse({
        readOnly: false,
        containers: [
          container(),
          container({ name: "nd-site-b", id: "def456", port: 43102, state: "exited", health: null }),
        ],
      }),
    )

    render(<App />)

    expect(await screen.findByText("2 containers, 1 running")).toBeInTheDocument()
    expect(await screen.findByText(/^Updated \d{2}:\d{2}:\d{2}$/)).toBeInTheDocument()
    expect(screen.queryByTestId("read-only-status")).toBeNull()
  })

  it("shows a read-only status in the header when the server is read-only", async () => {
    mockFetch(() => jsonResponse({ readOnly: true, containers: [container()] }))

    render(<App />)

    expect(await screen.findByTestId("read-only-status")).toHaveTextContent("Read-only")
    expect(screen.getByText("1 container, 1 running")).toBeInTheDocument()
  })
})
