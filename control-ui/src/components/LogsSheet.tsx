import { useEffect, useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { errorText, fetchLogs } from "@/lib/api"

const LOG_TAIL = 200

interface LogsSheetProps {
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LogsSheet({ name, open, onOpenChange }: LogsSheetProps) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setText(null)
    setError(null)
    fetchLogs(name, LOG_TAIL)
      .then((body) => {
        if (active) setText(body)
      })
      .catch((err: unknown) => {
        if (active) setError(errorText(err))
      })
    return () => {
      active = false
    }
  }, [open, name])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-hidden sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Logs: {name}</SheetTitle>
          <SheetDescription>Last {LOG_TAIL} lines</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-auto px-4 pb-4">
          {error !== null ? (
            <Alert variant="destructive">
              <AlertTitle>Could not load logs</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : text === null ? (
            <p className="text-sm text-muted-foreground">Loading logs…</p>
          ) : (
            <pre className="rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
              {text || "(no log lines)"}
            </pre>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
