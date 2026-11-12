import { ShieldAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ContainerInfo } from "@/lib/api"
import { ContainerActions } from "./ContainerActions"
import { StateBadge } from "./StateBadge"

type LocationLike = Pick<Location, "protocol" | "hostname">

/** Link to a container's published port on the same host the dashboard was loaded from. */
export function openUrl(port: number, loc: LocationLike = window.location): string {
  return `${loc.protocol}//${loc.hostname}:${port}/`
}

function formatTime(iso: string | null) {
  if (iso === null) return "—"
  const date = new Date(iso)
  return <time dateTime={iso}>{Number.isNaN(date.getTime()) ? iso : date.toLocaleString()}</time>
}

interface ContainerTableProps {
  containers: ContainerInfo[]
  readOnly: boolean
  onChanged: () => void
}

export function ContainerTable({ containers, readOnly, onChanged }: ContainerTableProps) {
  return (
    <div className="space-y-4">
      {readOnly && (
        <Alert>
          <ShieldAlert />
          <AlertTitle>Read-only mode is on</AlertTitle>
          <AlertDescription>
            The control server does not accept changes, so container actions are disabled.
          </AlertDescription>
        </Alert>
      )}
      {containers.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No dev-host containers yet. Start a container with the node-dev-host.port label and it will appear here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table className="block md:table">
            <TableHeader className="sr-only md:not-sr-only">
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Port</TableHead>
                <TableHead className="hidden md:table-cell">Image</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="hidden md:table-cell">Health</TableHead>
                <TableHead>Build</TableHead>
                <TableHead className="hidden md:table-cell">Last build</TableHead>
                <TableHead>Open</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="block md:table-row-group">
              {containers.map((c) => (
                // Below md each row stacks as a card; from md it is a table row.
                <TableRow key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 md:table-row md:py-0">
                  <TableCell className="w-full font-medium md:w-auto">{c.name}</TableCell>
                  <TableCell className="tabular-nums">{c.port}</TableCell>
                  <TableCell className="hidden max-w-48 truncate md:table-cell" title={c.image}>
                    {c.image}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{c.state}</Badge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{c.health ?? "—"}</TableCell>
                  <TableCell>
                    <StateBadge state={c.state === "running" ? c.build.state : "stopped"} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{formatTime(c.build.finishedAt)}</TableCell>
                  <TableCell>
                    <Button variant="link" size="sm" asChild>
                      <a href={openUrl(c.port)} target="_blank" rel="noopener noreferrer">
                        Open
                      </a>
                    </Button>
                  </TableCell>
                  <TableCell>
                    <ContainerActions container={c} readOnly={readOnly} onChanged={onChanged} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
