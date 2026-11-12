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

interface StartPromptProps {
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onChoose: (autoStart: boolean) => void
}

export function StartPrompt({ name, open, onOpenChange, onChoose }: StartPromptProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Start {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This node has no active auto-start window. Choose whether it should also start the next time this console starts.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="outline" onClick={() => onChoose(false)}>
            Start only
          </AlertDialogAction>
          <AlertDialogAction onClick={() => onChoose(true)}>Start and auto-start</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
