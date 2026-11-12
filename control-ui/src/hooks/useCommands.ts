import { toast } from "sonner"
import { type ContainerAction, errorText, removeContainer, runContainerAction } from "@/lib/api"

/** What is in flight for a container, shown beside its badge until the next refresh lands. */
export type PendingAction = ContainerAction | "remove"

export interface CommandHooks {
  /** Called with the action when it starts, and with null if it failed. */
  onPending?: (name: string, action: PendingAction | null) => void
  /** Called after a successful action so the list is refreshed. */
  onChanged: () => void
}

/**
 * The one place container actions are sent from: row buttons, keyboard shortcuts and the command
 * palette all use it, so they report failure the same way (a toast naming the container and action).
 */
export function useCommands({ onPending, onChanged }: CommandHooks) {
  /** `quiet` is for batches: the caller reports one summary and refreshes once, instead of once per container. */
  async function run(name: string, action: PendingAction, { quiet = false }: { quiet?: boolean } = {}): Promise<boolean> {
    onPending?.(name, action)
    try {
      if (action === "remove") await removeContainer(name)
      else await runContainerAction(name, action)
      if (!quiet) onChanged()
      return true
    } catch (err) {
      onPending?.(name, null)
      if (!quiet) toast.error(`${name}: ${action} failed. ${errorText(err)}`)
      return false
    }
  }
  return { run }
}
