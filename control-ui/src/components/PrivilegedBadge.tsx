import { Shield } from "lucide-react"
import { Badge } from "@/components/ui/badge"

/**
 * Marks a node that runs in privileged mode. It is the one solid, inverted neutral on the dashboard: ink on paper,
 * flipped in dark mode by the theme tokens. It never uses the green, blue or red status hues, and the word is the
 * text, so it reads in greyscale.
 */
export function PrivilegedBadge() {
  return (
    <Badge
      variant="default"
      role="group"
      aria-label="Privileged: this node has host-level access"
      data-privileged="true"
      className="gap-1 border-transparent bg-foreground text-background hover:bg-foreground/90"
    >
      <Shield aria-hidden="true" className="size-3" />
      Privileged
    </Badge>
  )
}
