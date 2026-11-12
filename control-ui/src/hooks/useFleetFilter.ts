import { useCallback, useEffect, useState } from "react"
import { EMPTY_FILTER, type FleetFilter, filterFromHash, filterToHash } from "@/lib/fleet"

function read(): FleetFilter {
  return typeof window === "undefined" ? EMPTY_FILTER : filterFromHash(window.location.hash)
}

/**
 * The console's filter, kept in the address bar (`#q=api&s=failed`) so a view survives a reload and
 * can be sent to someone else. Replacing, not pushing: typing must not fill the back button.
 */
export function useFleetFilter() {
  const [filter, setFilterState] = useState<FleetFilter>(read)

  const setFilter = useCallback((next: FleetFilter | ((prev: FleetFilter) => FleetFilter)) => {
    setFilterState((prev) => {
      const value = typeof next === "function" ? next(prev) : next
      const hash = filterToHash(value)
      if (hash !== window.location.hash) {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`)
      }
      return value
    })
  }, [])

  // Editing the hash by hand, or following a shared link in the same tab, updates the view.
  useEffect(() => {
    const onHash = () => setFilterState(read())
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  return { filter, setFilter }
}
