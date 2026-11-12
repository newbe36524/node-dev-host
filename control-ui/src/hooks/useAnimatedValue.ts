import { useEffect, useState } from "react"
import { transition } from "@/lib/viewTransition"

/**
 * Follows `value`, but applies a change that `animate` approves inside a View Transition.
 * The first value, and any change `animate` rejects, lands immediately.
 */
export function useAnimatedValue<T>(value: T, animate: (prev: T, next: T) => boolean, scope?: string): T {
  const [shown, setShown] = useState(value)

  useEffect(() => {
    if (Object.is(value, shown)) return
    if (animate(shown, value)) {
      transition(() => setShown(value), scope)
    } else {
      setShown(value)
    }
    // `animate` is a pure comparison supplied inline; only a new value should trigger work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return shown
}
