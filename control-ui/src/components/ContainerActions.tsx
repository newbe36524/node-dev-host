import { useState } from "react"
import { toast } from "sonner"
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
import { useMediaQuery } from "@/hooks/useMediaQuery"
import {
  type ContainerAction,
  type ContainerInfo,
  errorText,
  removeContainer,
  runContainerAction,
} from "@/lib/api"
import { LogsSheet } from "./LogsSheet"

/** Tailwind's md breakpoint. Below it the row actions collapse into a menu. */
export const WIDE_QUERY = "(min-width: 768px)"

interface ContainerActionsProps {
  container: ContainerInfo
  readOnly: boolean
  onChanged: () => void
}

export function ContainerActions({ container, readOnly, onChanged }: ContainerActionsProps) {
  const [busy, setBusy] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const wide = useMediaQuery(WIDE_QUERY)
  const disabled = readOnly || busy
  const { name, port, state } = container
  const running = state === "running"
  // The menu stays enabled in read-only mode so Logs can still be opened; mutating items are disabled.
  const lifecycle: ContainerAction[] = running ? ["rebuild", "restart", "stop"] : ["start"]

  async function run(action: ContainerAction) {
    setBusy(true)
    try {
      await runContainerAction(name, action)
      onChanged()
    } catch (err) {
      toast.error(`${name}: ${action} failed. ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await removeContainer(name)
      onChanged()
    } catch (err) {
      toast.error(`${name}: remove failed. ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const label: Record<ContainerAction, string> = {
    start: "Start",
    rebuild: "Rebuild",
    restart: "Restart",
    stop: "Stop",
  }

  return (
    <>
      {wide ? (
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
          <Button size="sm" variant="ghost" onClick={() => setLogsOpen(true)}>
            Logs
          </Button>
          <Button size="sm" variant="destructive" disabled={disabled} onClick={() => setRemoveOpen(true)}>
            Remove
          </Button>
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" aria-label={`Actions for ${name}`}>
              Actions
            </Button>
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
            <DropdownMenuItem onSelect={() => setLogsOpen(true)}>Logs</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" disabled={disabled} onSelect={() => setRemoveOpen(true)}>
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <LogsSheet name={name} open={logsOpen} onOpenChange={setLogsOpen} />

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
            <AlertDialogAction variant="destructive" onClick={remove}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
