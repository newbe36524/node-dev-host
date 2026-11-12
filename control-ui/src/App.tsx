import { Loader2, RefreshCw, ShieldAlert } from "lucide-react"
import { ThemeProvider } from "next-themes"
import { ContainerTable } from "@/components/ContainerTable"
import { ThemeToggle } from "@/components/ThemeToggle"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Toaster } from "@/components/ui/sonner"
import { usePolling } from "@/hooks/usePolling"
import { errorText, listContainers } from "@/lib/api"

function countText(total: number, running: number) {
  const noun = total === 1 ? "container" : "containers"
  return `${total} ${noun}, ${running} running`
}

export default function App() {
  // Adds or removes the `dark` class on <html>. The default follows the OS setting until the user picks one.
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="dev-host-theme">
      <Dashboard />
    </ThemeProvider>
  )
}

function Dashboard() {
  const { data, error, stale, updatedAt, polling, refresh } = usePolling(listContainers)
  const running = data?.containers.filter((c) => c.state === "running").length ?? 0

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Dev host control</h1>
          <p className="text-sm text-muted-foreground" data-testid="container-count">
            {data ? countText(data.containers.length, running) : "Loading containers…"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          {data?.readOnly && (
            <Badge variant="secondary" data-testid="read-only-status">
              <ShieldAlert />
              Read-only
            </Badge>
          )}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="refresh-indicator">
            {polling ? (
              <Loader2 className="size-3.5 animate-spin" aria-label="Refreshing" />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden="true" />
            )}
            {updatedAt
              ? `Updated ${updatedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
              : "Waiting for first update"}
          </span>
        </div>
      </header>

      {stale && (
        <Alert variant="destructive">
          <AlertTitle>Data may be stale</AlertTitle>
          <AlertDescription>
            The last refresh failed ({errorText(error)}).{" "}
            {data ? "The rows below are from the last good refresh." : "No list has loaded yet."}
          </AlertDescription>
        </Alert>
      )}

      {data ? (
        <ContainerTable containers={data.containers} readOnly={data.readOnly} onChanged={refresh} />
      ) : (
        !stale && <p className="text-sm text-muted-foreground">Loading containers…</p>
      )}
      <Toaster />
    </main>
  )
}
