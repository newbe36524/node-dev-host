import { flushSync } from "react-dom"

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished?: Promise<unknown> } | undefined
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Whether `transition` would animate here. */
export function canTransition(): boolean {
  return typeof document !== "undefined" && typeof (document as TransitionDocument).startViewTransition === "function" && !reducedMotion()
}

/**
 * Runs a state update inside a same-document View Transition, so elements that carry the same
 * `view-transition-name` before and after morph into each other. Where the API is missing, or the
 * visitor prefers reduced motion, the update simply happens at once. The result is the same either way.
 */
export function transition(update: () => void, scope?: string): void {
  if (!canTransition()) {
    update()
    return
  }
  // `scope` is written to <html data-vt> for the length of the transition, so CSS can give extra
  // elements a transition name only while they need one (the table rows, for a reorder).
  const root = document.documentElement
  if (scope) root.dataset.vt = scope
  const clear = () => {
    if (scope && root.dataset.vt === scope) delete root.dataset.vt
  }
  const run = (document as TransitionDocument).startViewTransition!(() => {
    flushSync(update)
  })
  if (run?.finished) void run.finished.then(clear, clear)
  else clear()
}
