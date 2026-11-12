import { useEffect, useState } from "react"
import { errorText, saveSettings } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface NpmRegistryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: string | null
  disabled?: boolean
  onSaved: () => void
}

export function NpmRegistryDialog({ open, onOpenChange, current, disabled = false, onSaved }: NpmRegistryDialogProps) {
  const [registry, setRegistry] = useState(current ?? "")
  const [failure, setFailure] = useState<string>()
  const [saving, setSaving] = useState(false)

  // Start from the saved value each time the dialog opens.
  useEffect(() => {
    if (open) {
      setRegistry(current ?? "")
      setFailure(undefined)
    }
  }, [open, current])

  async function save(value: string) {
    setFailure(undefined)
    setSaving(true)
    try {
      await saveSettings({ npmRegistry: value.trim() || null })
      onOpenChange(false)
      onSaved()
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>npm registry</DialogTitle>
          <DialogDescription>
            New and recreated nodes get this registry as <code>NPM_REGISTRY</code>, so their pnpm and npm installs use it. Nodes that already exist keep their
            current value until you recreate them. Empty uses each workspace&apos;s .npmrc or the default registry.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save(registry)
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="npm-registry">Registry URL</Label>
            <Input
              id="npm-registry"
              autoComplete="off"
              placeholder="http://mirror.example:4873/"
              value={registry}
              onChange={(event) => setRegistry(event.target.value)}
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">http or https only. Do not put credentials in the URL; use the workspace .npmrc.</p>
          </div>
          {failure && (
            <p role="alert" data-testid="npm-registry-error" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving || disabled} onClick={() => void save("")}>
              Use default
            </Button>
            <Button type="submit" disabled={saving || disabled}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
