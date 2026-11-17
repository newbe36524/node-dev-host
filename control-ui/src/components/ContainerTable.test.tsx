import { render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ContainerTable, openUrl } from "@/components/ContainerTable"
import { container, hostMountsContainer, hostPidContainer, privilegedContainer, setViewport } from "@/test/fakeApi"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ContainerTable", () => {
  it("renders two containers with their port, image, state and build badge", () => {
    const containers = [
      container(),
      container({
        name: "nd-site-b",
        id: "def456",
        image: "node-dev-host:alpine",
        port: 43102,
        state: "exited",
        health: null,
        build: { state: "failed", builds: 1, failures: 1, finishedAt: null },
      }),
    ]

    render(<ContainerTable containers={containers} readOnly={false} onChanged={() => {}} />)

    const rowA = screen.getByRole("row", { name: /nd-site-a/ })
    expect(within(rowA).getByText("43101")).toBeInTheDocument()
    expect(within(rowA).getByText("node-dev-host:test")).toBeInTheDocument()
    expect(within(rowA).getByText("running")).toBeInTheDocument()
    expect(within(rowA).getByText("healthy")).toBeInTheDocument()
    expect(within(rowA).getByText("ok", { selector: "[data-state]" })).toBeInTheDocument()

    const rowB = screen.getByRole("row", { name: /nd-site-b/ })
    expect(within(rowB).getByText("43102")).toBeInTheDocument()
    expect(within(rowB).getByText("exited")).toBeInTheDocument()
    // A stopped container shows the "stopped" build badge, not its last build state.
    expect(within(rowB).getByText("stopped", { selector: "[data-state]" })).toBeInTheDocument()
    expect(within(rowB).queryByText("failed", { selector: "[data-state]" })).toBeNull()
  })

  it("shows an empty-state message instead of an error when there are no containers", () => {
    render(<ContainerTable containers={[]} readOnly={false} onChanged={() => {}} />)

    expect(screen.getByText(/No dev-host containers yet/)).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("opens the port on the page's host, using 127.0.0.1", () => {
    vi.stubGlobal("location", { protocol: "http:", hostname: "127.0.0.1" })

    render(<ContainerTable containers={[container()]} readOnly={false} onChanged={() => {}} />)

    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "http://127.0.0.1:43101/")
  })

  it("opens the port on the page's host, using devbox.local", () => {
    vi.stubGlobal("location", { protocol: "http:", hostname: "devbox.local" })

    render(<ContainerTable containers={[container()]} readOnly={false} onChanged={() => {}} />)

    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "http://devbox.local:43101/")
  })

  it("builds the open URL from protocol, hostname and port", () => {
    expect(openUrl(43101, { protocol: "https:", hostname: "devbox.local" })).toBe("https://devbox.local:43101/")
  })

  it("in read-only mode shows an alert, keeps the rows and disables every action", () => {
    render(
      <ContainerTable
        containers={[container(), container({ name: "nd-site-b", id: "def456", state: "exited", port: 43102 })]}
        readOnly
        onChanged={() => {}}
      />,
    )

    expect(screen.getByRole("alert")).toHaveTextContent("Read-only mode is on")
    expect(screen.getByText("nd-site-a")).toBeInTheDocument()
    expect(screen.getByText("nd-site-b")).toBeInTheDocument()

    for (const name of ["Rebuild", "Restart", "Stop", "Start", "Remove"]) {
      for (const button of screen.queryAllByRole("button", { name })) {
        expect(button).toBeDisabled()
      }
    }
  })

  it("shows active and ended auto-start windows as quiet time values", () => {
    render(
      <ContainerTable
        containers={[
          container({ schedule: { state: "active", until: "2026-11-18T10:00:00Z", daysLeft: 6 } }),
          container({ id: "def456", name: "nd-site-b", schedule: { state: "ended", until: "2026-11-10T10:00:00Z", daysLeft: 0 } }),
          container({ id: "ghi789", name: "nd-site-c" }),
        ]}
        readOnly={false}
        onChanged={() => {}}
      />,
    )

    const active = screen.getByRole("row", { name: /nd-site-a/ })
    const activeSchedule = within(active).getAllByRole("cell")[7]
    expect(within(activeSchedule).getByText(/6 days left/)).toBeInTheDocument()
    expect(within(activeSchedule).getByText(/Until/).tagName).toBe("TIME")
    const ended = screen.getByRole("row", { name: /nd-site-b/ })
    const endedSchedule = within(ended).getAllByRole("cell")[7]
    expect(within(endedSchedule).getByText(/Ended/)).toBeInTheDocument()
    const noWindow = screen.getByRole("row", { name: /nd-site-c/ })
    expect(within(within(noWindow).getAllByRole("cell")[7]).getByText("—")).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Auto-start" })).toHaveClass("hidden", "md:table-cell")
  })

  it("keeps an unregistered row unscheduled and omits node-only actions", () => {
    render(<ContainerTable containers={[container({ state: "exited" })]} readOnly={false} onChanged={() => {}} />)

    const row = screen.getByRole("row", { name: /nd-site-a/ })
    expect(within(row).getByText("—")).toBeInTheDocument()
    expect(within(row).queryByRole("button", { name: "Recreate" })).toBeNull()
    expect(within(row).queryByRole("button", { name: "Delete node" })).toBeNull()
  })

  it("shows a failed operation, error and warning on a narrow not-created card", () => {
    const restoreViewport = setViewport(false)
    render(
      <ContainerTable
        containers={[
          container({
            id: "node:nd-site-a",
            state: "not created",
            registered: true,
            operation: { phase: "creating", since: "2026-11-11T10:00:00Z" },
            error: "Docker refused the create",
            warning: "Latest image could not be pulled: pull access denied for node-dev-host, repository does not exist or may require 'docker login'",
          }),
        ]}
        readOnly={false}
        onChanged={() => {}}
      />,
    )

    const row = screen.getByRole("row", { name: /nd-site-a/ })
    const state = within(row).getByText("not created")
    expect(state).toHaveClass("border-dashed")
    expect(within(row).getByText("stopped", { selector: "[data-state]" })).toBeInTheDocument()
    expect(within(row).getByTestId("pending-action")).toHaveTextContent("creating…")
    expect(within(row).getByTestId("row-error")).toHaveTextContent("Docker refused the create")
    expect(within(row).getByTestId("row-warning")).toHaveTextContent("Latest image could not be pulled")
    expect(within(row).getByTestId("row-warning")).toHaveClass("w-72", "break-words")
    expect(within(row).queryByRole("link", { name: "Open" })).toBeNull()
    restoreViewport()
  })

  const configuredProject = {
    name: "jjb",
    description: "Personal JJB site",
    configSource: ".node-dev-host.yaml",
    configError: null,
    warnings: [],
  }

  it("shows the project name and description under a configured container name, with the full text on hover", () => {
    render(
      <ContainerTable
        containers={[container({ project: configuredProject })]}
        readOnly={false}
        onChanged={() => {}}
      />,
    )

    const row = screen.getByRole("row", { name: /nd-site-a/ })
    const line = within(row).getByTestId("project-line")
    expect(line).toHaveTextContent("jjb · Personal JJB site")
    expect(line).toHaveAttribute("title", "jjb · Personal JJB site")
    expect(line).toHaveClass("hidden", "md:block")
    expect(within(row).queryByTestId("config-error")).toBeNull()
    expect(within(row).queryByTestId("project-warning")).toBeNull()
  })

  it("leaves a row without a configuration exactly as before: no project, error or warning lines", () => {
    render(
      <ContainerTable
        containers={[container({ project: { name: "stale", description: "stale", configSource: null, configError: null, warnings: ["copy retried once"] } })]}
        readOnly={false}
        onChanged={() => {}}
      />,
    )

    const row = screen.getByRole("row", { name: /nd-site-a/ })
    expect(within(row).queryByTestId("project-line")).toBeNull()
    expect(within(row).queryByTestId("project-name")).toBeNull()
    expect(within(row).queryByTestId("project-warning")).toBeNull()
    expect(within(row).queryByText(/stale/)).toBeNull()
  })

  it("shows a configuration error as a Config: line beside a failed build badge", () => {
    render(
      <ContainerTable
        containers={[
          container({
            name: "nd-broken",
            build: { state: "failed", builds: 2, failures: 2, finishedAt: null },
            project: { ...configuredProject, name: null, description: null, configError: 'unknown field "ignor"' },
          }),
        ]}
        readOnly={false}
        onChanged={() => {}}
      />,
    )

    const row = screen.getByRole("row", { name: /nd-broken/ })
    expect(within(row).getByText("failed", { selector: "[data-state]" })).toBeInTheDocument()
    const error = within(row).getByTestId("config-error")
    expect(error).toHaveTextContent('Config: unknown field "ignor"')
    expect(error).toHaveClass("text-destructive")
  })

  it("does not show a configuration error on a container whose build is not failed", () => {
    render(
      <ContainerTable
        containers={[container({ project: { ...configuredProject, configError: "stale reason" } })]}
        readOnly={false}
        onChanged={() => {}}
      />,
    )

    expect(within(screen.getByRole("row", { name: /nd-site-a/ })).queryByTestId("config-error")).toBeNull()
  })

  it("shows the warnings as quiet lines, not in the fault colour", () => {
    render(
      <ContainerTable
        containers={[
          container({
            project: { ...configuredProject, warnings: ["copy retried once: files changed while copying", "serve settings changed: restart the container to apply"] },
          }),
        ]}
        readOnly={false}
        onChanged={() => {}}
      />,
    )

    const row = screen.getByRole("row", { name: /nd-site-a/ })
    const warnings = within(row).getAllByTestId("project-warning")
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toHaveTextContent("copy retried once: files changed while copying")
    expect(warnings[0]).toHaveClass("text-muted-foreground")
    expect(warnings[0]).not.toHaveClass("text-destructive")
  })

  it("renders markup in the description as characters and runs nothing", () => {
    const { container: root } = render(
      <ContainerTable
        containers={[
          container({
            project: { ...configuredProject, description: "<script>window.__pwned = true</script><b>bold</b>" },
          }),
        ]}
        readOnly={false}
        onChanged={() => {}}
      />,
    )

    const row = screen.getByRole("row", { name: /nd-site-a/ })
    expect(within(row).getByTestId("project-line")).toHaveTextContent("<script>window.__pwned = true</script><b>bold</b>")
    expect(root.querySelector("script")).toBeNull()
    expect(root.querySelector("b")).toBeNull()
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it("on a narrow screen hides the description but keeps the name, the error and the warnings", () => {
    const restoreViewport = setViewport(false)
    render(
      <ContainerTable
        containers={[
          container({
            name: "nd-broken",
            build: { state: "failed", builds: 2, failures: 2, finishedAt: null },
            project: { ...configuredProject, configError: "build.distDir must not contain \"..\" segments", warnings: ["copy retried once: files changed while copying"] },
          }),
        ]}
        readOnly={false}
        onChanged={() => {}}
      />,
    )

    const row = screen.getByRole("row", { name: /nd-broken/ })
    expect(within(row).getByTestId("project-line")).toHaveClass("hidden", "md:block")
    expect(within(row).getByTestId("project-name")).toHaveTextContent("jjb")
    expect(within(row).getByTestId("project-name")).toHaveClass("md:hidden")
    expect(within(row).getByTestId("config-error")).not.toHaveClass("hidden")
    expect(within(row).getByTestId("project-warning")).not.toHaveClass("hidden")
    restoreViewport()
  })
})

describe("ContainerTable privileged marker", () => {
  it("marks a privileged row with the word Privileged and its host-level access name at wide width", () => {
    const restoreViewport = setViewport(true)
    render(<ContainerTable containers={[privilegedContainer(), container({ name: "nd-site-a" })]} readOnly={false} onChanged={() => {}} />)
    try {
      const row = screen.getByRole("row", { name: /nd-my-ansible/ })
      const marker = within(row).getByRole("group", { name: "Privileged: this node has host-level access" })
      expect(marker).toHaveAttribute("data-privileged", "true")
      expect(within(marker).getByText("Privileged")).toBeInTheDocument()
      // The marker sits in the Name cell, next to the name.
      expect(within(row).getAllByRole("cell")[0]).toContainElement(marker)
      expect(screen.getAllByText("Privileged")).toHaveLength(1)
    } finally {
      restoreViewport()
    }
  })

  it("keeps the marker on the card below md, on the name line", () => {
    const restoreViewport = setViewport(false)
    render(<ContainerTable containers={[privilegedContainer()]} readOnly={false} onChanged={() => {}} />)
    try {
      const card = screen.getByRole("row", { name: /nd-my-ansible/ })
      const marker = within(card).getByRole("group", { name: /host-level access/ })
      expect(within(card).getAllByRole("cell")[0]).toContainElement(marker)
    } finally {
      restoreViewport()
    }
  })

  it("shows no marker on an ordinary row, and the marker is text, not colour alone", () => {
    render(<ContainerTable containers={[container({ name: "nd-site-a" })]} readOnly={false} onChanged={() => {}} />)

    expect(screen.queryByText("Privileged")).toBeNull()
    expect(document.querySelector("[data-privileged]")).toBeNull()
  })

  it("uses no status hue for the marker: no green, blue or red class", () => {
    render(<ContainerTable containers={[privilegedContainer()]} readOnly={false} onChanged={() => {}} />)

    const marker = document.querySelector('[data-privileged="true"]') as HTMLElement
    // Only classes that apply to the marker itself: variant-prefixed ones (aria-invalid:, focus-visible:) are inert here.
    const applied = marker.className.split(/\s+/).filter((token) => !token.includes(":"))
    expect(applied.filter((token) => /emerald|green|sky|blue|red|destructive|amber|yellow/.test(token))).toEqual([])
    expect(applied).toContain("bg-foreground")
    expect(applied).toContain("text-background")
    expect(applied).not.toContain("bg-primary")
  })

  it("keeps the marker in place when the same row refreshes", () => {
    const { rerender } = render(<ContainerTable containers={[privilegedContainer()]} readOnly={false} onChanged={() => {}} />)
    rerender(<ContainerTable containers={[privilegedContainer({ state: "running", health: "healthy" })]} readOnly={false} onChanged={() => {}} />)

    expect(document.querySelectorAll('[data-privileged="true"]')).toHaveLength(1)
    expect(within(screen.getByRole("row", { name: /nd-my-ansible/ })).getByText("Privileged")).toBeInTheDocument()
  })
})

describe("ContainerTable host-access markers", () => {
  const hostPlusMounts = () =>
    container({ name: "nd-my-ansible", id: "host01", port: 43102, registered: true, pidHost: true, hostMounts: ["/var/lib/steam", "/home/me/.local/share/containers"] })

  it("marks only the rows with host access, each with its own word marker", () => {
    const restoreViewport = setViewport(true)
    render(<ContainerTable containers={[container({ name: "nd-site-a" }), hostPidContainer(), hostMountsContainer()]} readOnly={false} onChanged={() => {}} />)
    try {
      expect(within(screen.getByRole("row", { name: /nd-site-a/ })).queryByText(/Host PID|Host mounts/)).toBeNull()
      const pidRow = screen.getByRole("row", { name: /nd-pid/ })
      expect(within(pidRow).getByText("Host PID")).toBeInTheDocument()
      expect(within(pidRow).queryByText(/Host mounts/)).toBeNull()
      const mountRow = screen.getByRole("row", { name: /nd-mounts/ })
      expect(within(mountRow).getByText("Host mounts 1")).toBeInTheDocument()
      expect(within(mountRow).queryByText("Host PID")).toBeNull()
      expect(document.querySelectorAll("[data-host-access]")).toHaveLength(2)
    } finally {
      restoreViewport()
    }
  })

  it("shows the markers and the paths as text on the narrow card, on the name line", () => {
    const restoreViewport = setViewport(false)
    render(<ContainerTable containers={[hostPlusMounts()]} readOnly={false} onChanged={() => {}} />)
    try {
      const card = screen.getByRole("row", { name: /nd-my-ansible/ })
      const cell = within(card).getAllByRole("cell")[0]
      const pid = within(card).getByRole("group", { name: /Host PID/ })
      const mounts = within(card).getByRole("group", { name: /Host mounts 2/ })
      expect(cell).toContainElement(pid)
      expect(cell).toContainElement(mounts)
      expect(pid).toHaveTextContent("Host PID")
      expect(mounts).toHaveTextContent("Host mounts 2")
      expect(mounts).toHaveAccessibleName(/\/var\/lib\/steam, \/home\/me\/\.local\/share\/containers/)
      expect(within(card).getByText("/var/lib/steam, /home/me/.local/share/containers")).toBeInTheDocument()
    } finally {
      restoreViewport()
    }
  })

  it("uses no status hue for the markers, and they are outline neutrals weaker than the Privileged marker", () => {
    render(<ContainerTable containers={[container({ name: "nd-my-ansible", registered: true, privileged: true, pidHost: true, hostMounts: ["/var/lib/steam"] })]} readOnly={false} onChanged={() => {}} />)

    const markers = Array.from(document.querySelectorAll("[data-host-access]")) as HTMLElement[]
    expect(markers).toHaveLength(2)
    for (const marker of markers) {
      const applied = marker.className.split(/\s+/).filter((token) => !token.includes(":"))
      expect(applied.filter((token) => /emerald|green|sky|blue|red|destructive|amber|yellow/.test(token))).toEqual([])
      expect(applied.filter((token) => /^bg-/.test(token))).toEqual([])
    }
    const privileged = document.querySelector('[data-privileged="true"]') as HTMLElement
    expect(privileged).toHaveClass("bg-foreground")
  })

  it("keeps the name cell markup the same when the same row refreshes", () => {
    const { rerender } = render(<ContainerTable containers={[hostPlusMounts()]} readOnly={false} onChanged={() => {}} />)
    const before = within(screen.getByRole("row", { name: /nd-my-ansible/ })).getAllByRole("cell")[0].innerHTML

    rerender(<ContainerTable containers={[{ ...hostPlusMounts(), state: "running", health: "healthy" }]} readOnly={false} onChanged={() => {}} />)

    const after = within(screen.getByRole("row", { name: /nd-my-ansible/ })).getAllByRole("cell")[0].innerHTML
    expect(after).toBe(before)
    expect(document.querySelectorAll('[data-host-access]')).toHaveLength(2)
  })
})
