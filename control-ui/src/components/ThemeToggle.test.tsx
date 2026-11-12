import { fireEvent, render, screen } from "@testing-library/react"
import { ThemeProvider } from "next-themes"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import App from "@/App"
import { ThemeToggle } from "@/components/ThemeToggle"
import { container, jsonResponse, mockFetch } from "@/test/fakeApi"

const STORAGE_KEY = "dev-host-theme"

/** Makes the OS report a dark or light colour scheme for `(prefers-color-scheme: dark)`. */
function setSystemDark(dark: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches: query === "(prefers-color-scheme: dark)" ? dark : query === "(min-width: 768px)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

function renderToggle() {
  render(
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey={STORAGE_KEY}>
      <ThemeToggle />
    </ThemeProvider>,
  )
}

function choose(label: string) {
  // Radix opens dropdown menus on pointer down.
  fireEvent.pointerDown(screen.getByRole("button", { name: "Theme" }), { button: 0, ctrlKey: false, pointerType: "mouse" })
  fireEvent.click(screen.getByRole("menuitemradio", { name: label }))
}

const isDark = () => document.documentElement.classList.contains("dark")

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove("dark")
  setSystemDark(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ThemeToggle", () => {
  it("follows the system colour scheme when nothing is saved", () => {
    setSystemDark(true)
    renderToggle()

    expect(isDark()).toBe(true)
  })

  it("applies the dark class and saves the choice when Dark is picked", () => {
    renderToggle()
    expect(isDark()).toBe(false)

    choose("Dark")

    expect(isDark()).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark")
  })

  it("switches back to light and saves it", () => {
    localStorage.setItem(STORAGE_KEY, "dark")
    renderToggle()
    expect(isDark()).toBe(true)

    choose("Light")

    expect(isDark()).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBe("light")
  })

  it("restores a saved dark choice on load, even when the system is light", () => {
    localStorage.setItem(STORAGE_KEY, "dark")
    renderToggle()

    expect(isDark()).toBe(true)
  })

  it("returns to following the system when System is picked", () => {
    setSystemDark(true)
    localStorage.setItem(STORAGE_KEY, "light")
    renderToggle()
    expect(isDark()).toBe(false)

    choose("System")

    expect(isDark()).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe("system")
  })
})

describe("App theme", () => {
  it("offers the theme toggle in the dashboard header", async () => {
    mockFetch(() => jsonResponse({ readOnly: false, containers: [container()] }))

    render(<App />)

    expect(await screen.findByText("1 container, 1 running")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Theme" })).toBeInTheDocument()
  })

  it("switches the whole dashboard to dark from the header toggle", async () => {
    mockFetch(() => jsonResponse({ readOnly: false, containers: [container()] }))

    render(<App />)
    await screen.findByText("1 container, 1 running")

    choose("Dark")

    expect(isDark()).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark")
  })
})
