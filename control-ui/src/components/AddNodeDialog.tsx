import { useEffect, useRef, useState } from "react"
import { addNode, errorText } from "@/lib/api"
import type { NodeInput } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

const DEFAULT_IMAGE = "ghcr.io/newbe36524/node-dev-host"

interface AddNodeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  nextPort: number | null
  disabled?: boolean
  onAdded: () => void
}

function parseEnvironment(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line) continue
    const equals = line.indexOf("=")
    if (equals < 1) throw new Error(`Environment line ${index + 1} must be KEY=value.`)
    const key = line.slice(0, equals).trim()
    if (!key || Object.hasOwn(env, key)) throw new Error(`Environment line ${index + 1} has an empty or duplicate key.`)
    env[key] = line.slice(equals + 1)
  }
  return env
}

export function AddNodeDialog({ open, onOpenChange, nextPort, disabled = false, onAdded }: AddNodeDialogProps) {
  const [name, setName] = useState("")
  const [workspace, setWorkspace] = useState("")
  const [port, setPort] = useState(nextPort?.toString() ?? "")
  const [image, setImage] = useState(DEFAULT_IMAGE)
  const [environment, setEnvironment] = useState("")
  const [failure, setFailure] = useState<string>()
  const [saving, setSaving] = useState(false)
  const portSeeded = useRef(false)

  useEffect(() => {
    if (!open) {
      portSeeded.current = false
    } else if (!portSeeded.current && nextPort !== null) {
      setPort(String(nextPort))
      portSeeded.current = true
    }
  }, [open, nextPort])

  function changeOpen(next: boolean) {
    if (next && !disabled) {
      setName("")
      setWorkspace("")
      setPort(nextPort?.toString() ?? "")
      setImage(DEFAULT_IMAGE)
      setEnvironment("")
      setFailure(undefined)
    }
    if (!next) setFailure(undefined)
    onOpenChange(next)
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(undefined)
    let node: NodeInput
    try {
      const parsedPort = Number(port)
      if (!Number.isInteger(parsedPort)) throw new Error("Port must be a whole number.")
      node = { name, workspace, port: parsedPort, image, env: parseEnvironment(environment) }
    } catch (error) {
      setFailure(errorText(error))
      return
    }
    setSaving(true)
    try {
      await addNode(node)
      onOpenChange(false)
      onAdded()
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add node</DialogTitle>
          <DialogDescription>Save a node definition first. You can start it from the row after it is added.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="node-name">Name</Label>
            <Input id="node-name" autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="node-workspace">Workspace</Label>
            <Input id="node-workspace" autoComplete="off" value={workspace} onChange={(event) => setWorkspace(event.target.value)} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="node-port">Port</Label>
              <Input id="node-port" type="number" min={43100} max={43299} value={port} onChange={(event) => setPort(event.target.value)} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="node-image">Image</Label>
              <Input id="node-image" value={image} onChange={(event) => setImage(event.target.value)} required />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="node-environment">Environment</Label>
            <Textarea
              id="node-environment"
              placeholder={"NODE_ENV=production\nAPI_URL=https://example.test"}
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">One KEY=value pair per line.</p>
          </div>
          {failure && (
            <p role="alert" data-testid="add-node-error" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => changeOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={disabled || saving}>
              {saving ? "Adding…" : "Add node"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
