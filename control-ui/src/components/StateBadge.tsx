import { Badge } from "@/components/ui/badge"
import type { CSSProperties } from "react"
import type { BuildBadgeState } from "@/lib/fleet"

export type { BuildBadgeState }

const LOOK: Record<
  BuildBadgeState,
  { variant: "default" | "secondary" | "destructive" | "outline"; className?: string }
> = {
  // The 700 steps keep white 12px text above 4.5:1 (about 5.4:1 and 5.9:1).
  ok: { variant: "default", className: "bg-emerald-700 hover:bg-emerald-700/90" },
  building: { variant: "default", className: "bg-sky-700 hover:bg-sky-700/90" },
  failed: { variant: "destructive" },
  starting: { variant: "secondary" },
  waiting: { variant: "outline" },
  unknown: { variant: "outline", className: "text-muted-foreground" },
  stopped: { variant: "outline", className: "border-dashed text-muted-foreground" },
}

/** `transitionName` lets the badge morph between places (table row and logs sheet) through a View Transition. */
export function StateBadge({ state, transitionName }: { state: BuildBadgeState; transitionName?: string }) {
  const look = LOOK[state]
  return (
    <Badge
      variant={look.variant}
      className={look.className}
      data-state={state}
      style={transitionName ? ({ viewTransitionName: transitionName } as CSSProperties) : undefined}
    >
      {state}
    </Badge>
  )
}

export function ContainerStateBadge({ state }: { state: string }) {
  return (
    <Badge variant="outline" className={state === "not created" ? "border-dashed text-muted-foreground" : undefined}>
      {state}
    </Badge>
  )
}
