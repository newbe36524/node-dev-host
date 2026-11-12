// Client for the control server JSON API (see rootfs/usr/local/lib/dev-host/control/server.mjs).
// Every POST and DELETE must carry the control header or the server refuses it.

export type ContainerState =
  | "running"
  | "created"
  | "exited"
  | "created"
  | "paused"
  | "restarting"
  | "dead"
  | "not created"

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

export interface NodeSchedule {
  state: "active" | "ended" | "none"
  until: string | null
  daysLeft: number | null
}

export interface NodeOperation {
  phase: "pulling" | "creating" | "starting" | "removing"
  since: string
}

export interface ContainerInfo {
  name: string
  id: string
  image: string
  port: number
  state: ContainerState
  health: ContainerHealth | null
  build: ContainerBuild
  registered: boolean
  schedule: NodeSchedule
  operation: NodeOperation | null
  error: string | null
  warning: string | null
}

export interface Persistence {
  dir: string
  writable: boolean
  mounted: boolean
  warning: string | null
}

// Console-wide defaults. npmRegistry is passed to node containers as NPM_REGISTRY on create and recreate.
export interface ControlSettings {
  npmRegistry: string | null
}

export interface ContainerList {
  readOnly: boolean
  containers: ContainerInfo[]
  persistence: Persistence
  nextPort: number | null
  settings?: ControlSettings
}

export type ContainerAction = "start" | "stop" | "restart" | "rebuild"
export type NodeInput = { name: string; workspace: string; port: number; image: string; env?: Record<string, string> }
export interface ScanResult {
  imported: string[]
  skipped: { name: string; reason: string }[]
}

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

async function request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Response> {
  const headers = new Headers()
  if (method !== "GET") {
    headers.set(CONTROL_HEADER, "1")
  }
  if (body !== undefined) headers.set("Content-Type", "application/json")
  let res: Response
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
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

export async function runContainerAction(name: string, action: ContainerAction, autoStart = false): Promise<void> {
  await request("POST", `/api/containers/${encodeURIComponent(name)}/${action}`, autoStart ? { autoStart: true } : undefined)
}

export async function removeContainer(name: string): Promise<void> {
  await request("DELETE", `/api/containers/${encodeURIComponent(name)}`)
}

export async function recreateContainer(name: string): Promise<void> {
  await request("POST", `/api/containers/${encodeURIComponent(name)}/recreate`)
}

export async function addNode(node: NodeInput): Promise<void> {
  await request("POST", "/api/nodes", node)
}

export async function saveSettings(settings: ControlSettings): Promise<ControlSettings> {
  const res = await request("POST", "/api/settings", settings)
  return ((await res.json()) as { settings: ControlSettings }).settings
}

export async function deleteNode(name: string): Promise<void> {
  await request("DELETE", `/api/nodes/${encodeURIComponent(name)}`)
}

export async function extendAutoStart(name: string): Promise<void> {
  await request("POST", `/api/nodes/${encodeURIComponent(name)}/auto-start`)
}

export async function stopAutoStart(name: string): Promise<void> {
  await request("DELETE", `/api/nodes/${encodeURIComponent(name)}/auto-start`)
}

export async function scanNodes(): Promise<ScanResult> {
  const res = await request("POST", "/api/scan")
  return (await res.json()) as ScanResult
}

export async function fetchLogs(name: string, tail = 200): Promise<string> {
  const res = await request("GET", `/api/containers/${encodeURIComponent(name)}/logs?tail=${tail}`)
  return res.text()
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
