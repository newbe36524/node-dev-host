import { useCallback, useMemo, useState } from "react"
import type { PendingAction } from "@/hooks/useCommands"

interface Entry {
  action: PendingAction
  /** Set when the request succeeded. The entry ends with the first refresh that lands after it. */
  settledAt?: number
}

/** A request that never produces a newer list (the control server went away) must not leave a label up forever. */
const EXPIRE_MS = 30_000

/**
 * Tracks actions that are in flight or waiting for the next refresh, per container name.
 * This is what lets a row say "restarting…" the moment the button is pressed instead of staying
 * silent until the next 3-second poll.
 */
export function usePending(updatedAt: Date | undefined) {
  const [entries, setEntries] = useState<Record<string, Entry>>({})

  const setPending = useCallback((name: string, action: PendingAction | null) => {
    setEntries((prev) => {
      if (action === null) {
        if (!(name in prev)) return prev
        const { [name]: _gone, ...rest } = prev
        return rest
      }
      return { ...prev, [name]: { action } }
    })
    if (action !== null) {
      setTimeout(() => {
        setEntries((prev) => {
          if (prev[name]?.action !== action) return prev
          const { [name]: _gone, ...rest } = prev
          return rest
        })
      }, EXPIRE_MS)
    }
  }, [])

  /** Call after a successful action: every unsettled entry now waits for a refresh. */
  const settle = useCallback(() => {
    const at = Date.now()
    setEntries((prev) => {
      const next: Record<string, Entry> = {}
      for (const [name, entry] of Object.entries(prev)) next[name] = entry.settledAt === undefined ? { ...entry, settledAt: at } : entry
      return next
    })
  }, [])

  const pending = useMemo(() => {
    const out: Record<string, PendingAction> = {}
    for (const [name, entry] of Object.entries(entries)) {
      if (entry.settledAt !== undefined && updatedAt && updatedAt.getTime() >= entry.settledAt) continue
      out[name] = entry.action
    }
    return out
  }, [entries, updatedAt])

  return { pending, setPending, settle }
}
