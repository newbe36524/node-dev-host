import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// jsdom has no matchMedia; sonner calls it on mount.
if (!window.matchMedia) {
  // Tests default to a wide viewport; narrow-layout tests override matchMedia.
  window.matchMedia = (query: string) =>
    ({
      matches: query === "(min-width: 768px)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

afterEach(() => {
  cleanup()
})
