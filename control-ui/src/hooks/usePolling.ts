import { useCallback, useEffect, useRef, useState } from "react"

export const POLL_INTERVAL_MS = 3000

export interface PollingResult<T> {
  /** Last successful result. Kept when a later poll fails. */
  data: T | undefined
  /** Error from the most recent poll, if it failed. */
  error: Error | undefined
  /** True while the most recent poll has failed, so `data` may be out of date. */
  stale: boolean
  /** When the last successful poll finished. */
  updatedAt: Date | undefined
  /** True while a poll request is in flight. */
  polling: boolean
  /** Poll right away and restart the interval. */
  refresh: () => void
}

/**
 * Calls `fetcher` now and then every `intervalMs` after each attempt finishes.
 * A failed attempt keeps the previous data and sets `stale`.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number = POLL_INTERVAL_MS,
): PollingResult<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error>()
  const [updatedAt, setUpdatedAt] = useState<Date>()
  const [polling, setPolling] = useState(false)
  const [nonce, setNonce] = useState(0)
  const fetcherRef = useRef(fetcher)

  useEffect(() => {
    fetcherRef.current = fetcher
  }, [fetcher])

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      setPolling(true)
      try {
        const next = await fetcherRef.current()
        if (!active) return
        setData(() => next)
        setError(undefined)
        setUpdatedAt(new Date())
      } catch (err) {
        if (!active) return
        setError(err instanceof Error ? err : new Error(String(err)))
      } finally {
        if (active) setPolling(false)
      }
      if (active) {
        timer = setTimeout(tick, intervalMs)
      }
    }

    void tick()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [intervalMs, nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  return { data, error, stale: error !== undefined, updatedAt, polling, refresh }
}
