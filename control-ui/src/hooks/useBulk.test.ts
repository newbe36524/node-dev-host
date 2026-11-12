import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { BULK_CONCURRENCY, runBatch } from "@/hooks/useBulk"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

afterEach(() => {
  vi.clearAllMocks()
})

const names = Array.from({ length: 12 }, (_, i) => `nd-${i}`)

describe("runBatch", () => {
  it("never has more than the pool size in flight, and runs every container once", async () => {
    let inFlight = 0
    let peak = 0
    const seen: string[] = []
    const runOne = async (name: string) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      seen.push(name)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return true
    }

    const failed = await runBatch(names, "rebuild", runOne, () => {})

    expect(failed).toEqual([])
    expect(peak).toBe(BULK_CONCURRENCY)
    expect([...seen].sort()).toEqual([...names].sort())
  })

  it("marks everything in flight at once, runs quietly, and reports one summary toast", async () => {
    const pending: Array<[string, string | null]> = []
    const quiet: boolean[] = []
    await runBatch(names.slice(0, 3), "restart", async (_n, _a, opts) => (quiet.push(opts.quiet), true), (n, a) => pending.push([n, a]))

    expect(pending).toEqual([["nd-0", "restart"], ["nd-1", "restart"], ["nd-2", "restart"]])
    expect(quiet).toEqual([true, true, true])
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith("Restarted 3 containers.")
  })

  it("names the containers that failed in a single error toast and returns them", async () => {
    const failed = await runBatch(names.slice(0, 8), "stop", async (name) => !["nd-2", "nd-5"].includes(name), () => {})

    expect(failed.sort()).toEqual(["nd-2", "nd-5"])
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("stop failed for 2 of 8: "))
    expect(toast.success).not.toHaveBeenCalled()
  })
})
