import { useState } from "react"
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
import type { ContainerInfo } from "@/lib/api"
import { type BulkAction, eligibleFor } from "@/lib/fleet"

const ORDER: BulkAction[] = ["rebuild", "restart", "stop", "start"]
const LABEL: Record<BulkAction, string> = { rebuild: "Rebuild", restart: "Restart", stop: "Stop", start: "Start" }
/** These interrupt what is being served, so a batch of them asks first. Rebuild and start do not. */
const CONFIRM: ReadonlySet<BulkAction> = new Set(["restart", "stop"])

interface BulkBarProps {
  /** The ticked containers, in table order. */
  selected: ContainerInfo[]
  readOnly: boolean
  onRun: (action: BulkAction, names: string[]) => void
  onClear: () => void
}

/** Floats above the list while anything is ticked. Each action shows how many of the selection it applies to. */
export function BulkBar({ selected, readOnly, onRun, onClear }: BulkBarProps) {
  const [confirm, setConfirm] = useState<BulkAction>()
  if (selected.length === 0) return null

  const targets = confirm ? eligibleFor(confirm, selected) : []

  function press(action: BulkAction) {
    const names = eligibleFor(action, selected).map((c) => c.name)
    if (names.length === 0) return
    if (CONFIRM.has(action) && names.length > 1) setConfirm(action)
    else onRun(action, names)
  }

  return (
    <>
      <div
        role="region"
        aria-label="Selected containers"
        data-testid="bulk-bar"
        className="bulk-bar fixed inset-x-3 bottom-3 z-30 mx-auto flex max-w-fit flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-lg"
      >
        <p className="tabular text-sm font-medium" aria-live="polite">
          {selected.length} selected
        </p>
        <div className="flex flex-wrap gap-1">
          {ORDER.map((action) => {
            const count = eligibleFor(action, selected).length
            return (
              <Button
                key={action}
                size="sm"
                variant="outline"
                disabled={readOnly || count === 0}
                onClick={() => press(action)}
                aria-label={`${LABEL[action]} ${count} of ${selected.length} selected`}
              >
                {LABEL[action]}
                <span className="tabular text-muted-foreground">{count}</span>
              </Button>
            )
          })}
        </div>
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>

      <AlertDialog open={confirm !== undefined} onOpenChange={(open) => !open && setConfirm(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm && LABEL[confirm]} {targets.length} containers?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {targets
                .slice(0, 6)
                .map((c) => c.name)
                .join(", ")}
              {targets.length > 6 ? ` and ${targets.length - 6} more` : ""}. Their sites stop answering while this runs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => confirm && onRun(confirm, targets.map((c) => c.name))}
            >
              {confirm && LABEL[confirm]} {targets.length}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
