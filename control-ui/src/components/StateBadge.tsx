import { Badge } from "@/components/ui/badge"
import type { BuildStateName } from "@/lib/api"

/** Build states plus "stopped" for containers that are not running. */
export type BuildBadgeState = BuildStateName | "stopped"

const LOOK: Record<
  BuildBadgeState,
  { variant: "default" | "secondary" | "destructive" | "outline"; className?: string }
> = {
  ok: { variant: "default", className: "bg-emerald-600 hover:bg-emerald-600/90" },
  building: { variant: "default", className: "bg-sky-600 hover:bg-sky-600/90" },
  failed: { variant: "destructive" },
  starting: { variant: "secondary" },
  waiting: { variant: "outline" },
  unknown: { variant: "outline", className: "text-muted-foreground" },
  stopped: { variant: "outline", className: "border-dashed text-muted-foreground" },
}

export function StateBadge({ state }: { state: BuildBadgeState }) {
  const look = LOOK[state]
  return (
    <Badge variant={look.variant} className={look.className} data-state={state}>
      {state}
    </Badge>
  )
}
