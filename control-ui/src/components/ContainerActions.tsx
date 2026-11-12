import { useState } from "react"
import { MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { type PendingAction, useCommands } from "@/hooks/useCommands"
import { useMediaQuery } from "@/hooks/useMediaQuery"
import type { ContainerAction, ContainerInfo } from "@/lib/api"
import { LogsSheet } from "./LogsSheet"

/** Tailwind's md breakpoint. Below it the row actions collapse into a menu. */
export const WIDE_QUERY = "(min-width: 768px)"

interface ContainerActionsProps {
  container: ContainerInfo
  readOnly: boolean
  onChanged: () => void
  /** Told when an action starts (with the action) and when it fails (with null), so the row can say what is in flight. */
  onPending?: (name: string, action: PendingAction | null) => void
  /** When given, Logs asks the page to open its one shared sheet. Without it the row owns a sheet of its own. */
  onShowLogs?: (name: string) => void
  /**
   * For a long list: wide rows keep Logs and fold the rest into a menu. Five buttons on each of fifty
   * rows is two hundred and fifty buttons, and a red Remove on every line.
   */
  dense?: boolean
}

export function ContainerActions({ container, readOnly, onChanged, onPending, onShowLogs, dense = false }: ContainerActionsProps) {
  const [busy, setBusy] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const wide = useMediaQuery(WIDE_QUERY)
  const disabled = readOnly || busy
  const { name, port, state } = container
  const running = state === "running"
  // The menu stays enabled in read-only mode so Logs can still be opened; mutating items are disabled.
  const lifecycle: ContainerAction[] = running ? ["rebuild", "restart", "stop"] : ["start"]

  const commands = useCommands({ onPending, onChanged })

  async function run(action: PendingAction) {
    setBusy(true)
    try {
      await commands.run(name, action)
    } finally {
      setBusy(false)
    }
  }

  const showLogs = () => (onShowLogs ? onShowLogs(name) : setLogsOpen(true))

  const label: Record<ContainerAction, string> = {
    start: "Start",
    rebuild: "Rebuild",
    restart: "Restart",
    stop: "Stop",
  }

  return (
    <>
      {wide && !dense ? (
        <div className="flex flex-wrap gap-1">
          {lifecycle.map((action) => (
            <Button
              key={action}
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => run(action)}
            >
              {label[action]}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={showLogs}>
            Logs
          </Button>
          <Button size="sm" variant="destructive" disabled={disabled} onClick={() => setRemoveOpen(true)}>
            Remove
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
        {wide && (
          <Button size="sm" variant="ghost" onClick={showLogs}>
            Logs
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {wide ? (
              <Button size="icon-sm" variant="outline" aria-label={`Actions for ${name}`}>
                <MoreHorizontal aria-hidden="true" />
              </Button>
            ) : (
              <Button size="sm" variant="outline" aria-label={`Actions for ${name}`}>
                Actions
              </Button>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            // Dialogs and sheets opened from an item own focus; do not hand it back to the trigger.
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {lifecycle.map((action) => (
              <DropdownMenuItem key={action} disabled={disabled} onSelect={() => run(action)}>
                {label[action]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={showLogs}>Logs</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" disabled={disabled} onSelect={() => setRemoveOpen(true)}>
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      )}

      {!onShowLogs && <LogsSheet name={name} open={logsOpen} onOpenChange={setLogsOpen} />}

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removing {name} deletes the container and frees host port {port}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => run("remove")}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
