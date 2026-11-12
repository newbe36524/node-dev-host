import { useEffect, useMemo, useState } from "react"
import type { ContainerList } from "@/lib/api"
import { emptyLog, lastChangeById, recordSnapshot, type SessionLog } from "@/lib/fleet"

/** Folds every list the page shows into an in-memory record of state changes since the tab opened. */
export function useSessionLog(list: ContainerList | undefined) {
  const [log, setLog] = useState<SessionLog>(() => emptyLog(Date.now()))

  useEffect(() => {
    if (!list) return
    setLog((prev) => recordSnapshot(prev, list.containers, Date.now()))
  }, [list])

  const changedAt = useMemo(() => lastChangeById(log), [log])
  return { log, changedAt }
}
