import { Eye, HardDrive } from "lucide-react"
import { Badge } from "@/components/ui/badge"

/**
 * Host-access markers for a row: `Host PID` when the node shares the host PID namespace, and `Host mounts <n>` when it
 * binds host paths read-only. They are outline neutrals beside the solid Privileged pill, so the Privileged marker stays
 * the strongest. They never use the green, blue or red status hues. Each one is words, and the paths are printed as
 * monospace text under the name, so greyscale and assistive technology get the same facts as a sighted reader.
 */
export function HostAccessBadges({ pidHost, hostMounts }: { pidHost: boolean; hostMounts: string[] }) {
  if (!pidHost && hostMounts.length === 0) return null
  const paths = hostMounts.join(", ")
  return (
    <>
      {pidHost && (
        <Badge
          variant="outline"
          role="group"
          aria-label="Host PID: this node shares the host process namespace"
          data-host-access="pid"
          className="gap-1 text-muted-foreground"
        >
          <Eye aria-hidden="true" className="size-3" />
          Host PID
        </Badge>
      )}
      {hostMounts.length > 0 && (
        <Badge
          variant="outline"
          role="group"
          aria-label={`Host mounts ${hostMounts.length}, read-only: ${paths}`}
          data-host-access="mounts"
          className="gap-1 text-muted-foreground"
        >
          <HardDrive aria-hidden="true" className="size-3" />
          Host mounts {hostMounts.length}
        </Badge>
      )}
      {hostMounts.length > 0 && (
        <span
          className="mt-0.5 block max-w-72 truncate font-mono text-xs font-normal text-muted-foreground"
          data-testid="host-mount-paths"
          title={paths}
        >
          {paths}
        </span>
      )}
    </>
  )
}
