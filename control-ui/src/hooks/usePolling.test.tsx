import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePolling } from "@/hooks/usePolling"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe("usePolling", () => {
  it("polls every 3 seconds", async () => {
    const fetcher = vi.fn().mockResolvedValue("rows")
    renderHook(() => usePolling(fetcher))

    await advance(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await advance(2999)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await advance(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("keeps the previous data and sets stale when a poll fails, then clears it", async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first rows")
      .mockRejectedValueOnce(new Error("socket gone"))
      .mockResolvedValueOnce("second rows")
    const { result } = renderHook(() => usePolling(fetcher))

    await advance(0)
    expect(result.current.data).toBe("first rows")
    expect(result.current.stale).toBe(false)

    await advance(3000)
    expect(result.current.data).toBe("first rows")
    expect(result.current.stale).toBe(true)
    expect(result.current.error?.message).toBe("socket gone")

    await advance(3000)
    expect(result.current.data).toBe("second rows")
    expect(result.current.stale).toBe(false)
    expect(result.current.error).toBeUndefined()
  })

  it("stops polling after unmount", async () => {
    const fetcher = vi.fn().mockResolvedValue("rows")
    const { unmount } = renderHook(() => usePolling(fetcher))
    await advance(0)

    unmount()
    await advance(10_000)

    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
