import { toast } from "sonner"
import type { PendingAction } from "@/hooks/useCommands"

/** How many containers a batch touches at once. A host running 50 builds at the same time helps nobody. */
export const BULK_CONCURRENCY = 4

type RunOne = (name: string, action: PendingAction, opts: { quiet: boolean }) => Promise<boolean>

const VERB: Record<PendingAction, string> = {
  start: "Started",
  stop: "Stopped",
  restart: "Restarted",
  rebuild: "Rebuilt",
  remove: "Removed",
}

/**
 * Runs one action over many containers with a small worker pool, then says what happened once:
 * a single toast, naming the containers that failed. Returns the names that failed.
 */
export async function runBatch(
  names: string[],
  action: PendingAction,
  runOne: RunOne,
  onPending: (name: string, action: PendingAction | null) => void,
): Promise<string[]> {
  // Everything queued shows as in flight right away, so the table never looks idle while work waits its turn.
  for (const name of names) onPending(name, action)
  const failed: string[] = []
  let next = 0
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++]
      if (!(await runOne(name, action, { quiet: true }))) failed.push(name)
    }
  }
  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, names.length) }, worker))

  const done = names.length - failed.length
  if (failed.length === 0) {
    toast.success(`${VERB[action]} ${done} ${done === 1 ? "container" : "containers"}.`)
  } else {
    const shown = failed.slice(0, 5).join(", ")
    const more = failed.length > 5 ? ` and ${failed.length - 5} more` : ""
    toast.error(`${action} failed for ${failed.length} of ${names.length}: ${shown}${more}.`)
  }
  return failed
}
