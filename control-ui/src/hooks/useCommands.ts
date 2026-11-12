import { useCallback } from "react"
import { toast } from "sonner"
import {
  type ContainerAction,
  deleteNode,
  errorText,
  extendAutoStart,
  recreateContainer,
  removeContainer,
  runContainerAction,
  stopAutoStart,
} from "@/lib/api"

/** What is in flight for a container, shown beside its badge until the next refresh lands. */
export type PendingAction = ContainerAction | "remove" | "delete-node" | "recreate" | "extend" | "stop-auto-start"

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
  const run = useCallback(
    async (
      name: string,
      action: PendingAction,
      { quiet = false, autoStart = false }: { quiet?: boolean; autoStart?: boolean } = {},
    ): Promise<boolean> => {
      onPending?.(name, action)
      try {
        if (action === "remove") await removeContainer(name)
        else if (action === "delete-node") await deleteNode(name)
        else if (action === "recreate") await recreateContainer(name)
        else if (action === "extend") await extendAutoStart(name)
        else if (action === "stop-auto-start") await stopAutoStart(name)
        else await runContainerAction(name, action, autoStart)
        if (!quiet) onChanged()
        return true
      } catch (err) {
        onPending?.(name, null)
        if (!quiet) toast.error(`${name}: ${action} failed. ${errorText(err)}`)
        return false
      }
    },
    [onChanged, onPending],
  )
  return { run }
}
