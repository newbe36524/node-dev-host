import { useSyncExternalStore } from "react"

// One shared one-second clock. Every component that shows a relative time subscribes to it,
// so ten rows cost one timer, and the timer only runs while something is listening.
let current = Date.now()
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    current = Date.now()
    timer = setInterval(() => {
      current = Date.now()
      listeners.forEach((l) => l())
    }, 1000)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/** Epoch milliseconds, refreshed once a second while the component is mounted. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => current, () => current)
}
