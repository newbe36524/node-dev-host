// Client for the control server JSON API (see rootfs/usr/local/lib/dev-host/control/server.mjs).
// Every POST and DELETE must carry the control header or the server refuses it.

export type ContainerState =
  | "running"
  | "exited"
  | "created"
  | "paused"
  | "restarting"
  | "dead"

export type ContainerHealth = "healthy" | "unhealthy" | "starting"

export type BuildStateName =
  | "ok"
  | "building"
  | "failed"
  | "starting"
  | "waiting"
  | "unknown"

export interface ContainerBuild {
  state: BuildStateName
  builds: number | null
  failures: number | null
  finishedAt: string | null
}

export interface ContainerInfo {
  name: string
  id: string
  image: string
  port: number
  state: ContainerState
  health: ContainerHealth | null
  build: ContainerBuild
}

export interface ContainerList {
  readOnly: boolean
  containers: ContainerInfo[]
}

export type ContainerAction = "start" | "stop" | "restart" | "rebuild"

export const CONTROL_HEADER = "X-Dev-Host-Control"

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text()
  try {
    const body = JSON.parse(text) as { error?: unknown } | null
    if (body && typeof body.error === "string" && body.error) {
      return body.error
    }
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return `Request failed with HTTP ${res.status}`
}

async function request(method: "GET" | "POST" | "DELETE", path: string): Promise<Response> {
  const headers = new Headers()
  if (method !== "GET") {
    headers.set(CONTROL_HEADER, "1")
  }
  let res: Response
  try {
    res = await fetch(path, { method, headers })
  } catch {
    throw new ApiError("Cannot reach the control server", 0)
  }
  if (!res.ok) {
    throw new ApiError(await errorMessage(res), res.status)
  }
  return res
}

export async function listContainers(): Promise<ContainerList> {
  const res = await request("GET", "/api/containers")
  return (await res.json()) as ContainerList
}

export async function runContainerAction(name: string, action: ContainerAction): Promise<void> {
  await request("POST", `/api/containers/${encodeURIComponent(name)}/${action}`)
}

export async function removeContainer(name: string): Promise<void> {
  await request("DELETE", `/api/containers/${encodeURIComponent(name)}`)
}

export async function fetchLogs(name: string, tail = 200): Promise<string> {
  const res = await request("GET", `/api/containers/${encodeURIComponent(name)}/logs?tail=${tail}`)
  return res.text()
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
