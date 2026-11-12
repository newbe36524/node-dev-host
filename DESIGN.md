---
name: node-dev-host control dashboard
description: A neutral, state-first instrument panel that shows the build state, freshness and health of every node-dev-host container on one Docker host.
colors:
  ink: "oklch(0.145 0 0)"
  paper: "oklch(1 0 0)"
  graphite: "oklch(0.205 0 0)"
  chalk: "oklch(0.985 0 0)"
  mist: "oklch(0.97 0 0)"
  hairline: "oklch(0.922 0 0)"
  quiet-text: "oklch(0.556 0 0)"
  focus-ring: "oklch(0.708 0 0)"
  fault-red: "oklch(0.577 0.245 27.325)"
  signal-ok: "oklch(0.508 0.118 165.612)"
  signal-building: "oklch(0.5 0.134 242.749)"
  night-surface: "oklch(0.205 0 0)"
  night-raised: "oklch(0.269 0 0)"
  night-text: "oklch(0.985 0 0)"
  night-quiet-text: "oklch(0.708 0 0)"
  night-fault-red: "oklch(0.704 0.191 22.216)"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.025em"
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  pill: "1.625rem"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
components:
  button-default:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 10px"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 10px"
  badge-build-ok:
    backgroundColor: "{colors.signal-ok}"
    textColor: "{colors.chalk}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: "20px"
    padding: "2px 8px"
  badge-build-building:
    backgroundColor: "{colors.signal-building}"
    textColor: "{colors.chalk}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: "20px"
    padding: "2px 8px"
  badge-build-failed:
    textColor: "{colors.fault-red}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: "20px"
    padding: "2px 8px"
  alert-stale:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.fault-red}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  container-table:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
---

# Design System: node-dev-host control dashboard

## Overview

**Creative North Star: "The Bridge Instrument Panel"**

node-dev-host does its real work out of sight. A container copies a project, builds it, and serves it with Caddy, and you never open a window onto any of that. The control dashboard is the only place the work becomes visible. It is the product's observation deck, not an admin extra. If a build fails, a refresh stalls, or a container sits in `unknown`, the dashboard is the single surface that tells you, so the whole design is arranged to make that answer readable at a glance.

Think of a ship's bridge panel. Every gauge has one job and one place. Normal readings are quiet, and the eye learns to skip them. A fault changes the picture, so you see it before you have read a word. The system is neutral grey with exactly three signal hues (one for "ok", one for "in progress", one for "fault") so that colour keeps its meaning. Everything else steps back: system fonts, hairline borders, flat surfaces, no decoration. Density is moderate: one row per container, and every column answers a question an operator actually asks (is it up, is it built, how fresh is the build, can I open it).

Observability here has three duties, and the design holds each as an invariant. **State is the lead.** The build state and its freshness outrank names, images and actions. **Staleness is a state.** The panel says when its own data is old instead of silently showing the last good rows as if they were current. **Silence is honest.** Missing information is shown as `unknown` or an em dash, never as a guess and never as a blank.

**Key Characteristics:**
- State first: build state, freshness and health are the loudest things on screen; actions are the quietest.
- Neutral by default, colour only as signal. Three hues, each tied to one meaning.
- Every status is carried by a word as well as a colour, so it survives colour blindness and greyscale.
- The panel reports on itself: last-refresh time, refreshing indicator, stale warning, read-only mode.
- Flat and calm. Depth is a hairline border; motion is limited to the refresh spinner and state transitions.
- Same hierarchy on a wide table and on a phone-width stacked card.

## Colors

A restrained neutral grey ramp with three signal hues. The palette is shadcn "neutral", expressed in OKLCH, and light and dark share the same roles.

### Primary
- **Graphite** (`oklch(0.205 0 0)`): the primary button and the strongest neutral fill in light mode. In dark mode the roles invert and primary becomes a light neutral (`oklch(0.922 0 0)`). It is a tool colour, not a brand colour, so it never competes with a status signal.

### Secondary (signal hues)
- **Signal Ok** (`oklch(0.508 0.118 165.612)`, emerald-700): build state `ok`. The only green on screen. It tells the operator the served output is current.
- **Signal Building** (`oklch(0.5 0.134 242.749)`, sky-700): build state `building`. The only blue on screen. It marks work in progress that will resolve on its own.
- **Fault Red** (`oklch(0.577 0.245 27.325)`; dark `oklch(0.704 0.191 22.216)`): build state `failed`, destructive actions, and the stale-data alert. The only red on screen. It is reserved for "needs a human".

### Neutral
- **Paper** (`oklch(1 0 0)`) / **Night Surface** (`oklch(0.205 0 0)`): page and card background. Dark mode page background is `oklch(0.145 0 0)`.
- **Ink** (`oklch(0.145 0 0)`) / **Night Text** (`oklch(0.985 0 0)`): primary text.
- **Mist** (`oklch(0.97 0 0)`) / **Night Raised** (`oklch(0.269 0 0)`): hover rows, muted and secondary fills.
- **Quiet Text** (`oklch(0.556 0 0)`) / **Night Quiet Text** (`oklch(0.708 0 0)`): counts, timestamps, helper copy and the neutral states `waiting`, `unknown` and `stopped`.
- **Hairline** (`oklch(0.922 0 0)`; dark `oklch(1 0 0 / 10%)`): table and card borders, dividers.
- **Focus Ring** (`oklch(0.708 0 0)`): keyboard focus, drawn at half opacity as a 3px ring.

### Named Rules
**The Three Signals Rule.** Green, blue and red each mean one thing: ok, building, failed. No other element on the dashboard may use those hues. A brand accent, a decorative gradient or a coloured link would dilute the signal, so none exist.

**The Word Beside the Colour Rule.** A status is never colour alone. Every badge prints its state name (`ok`, `building`, `failed`, `starting`, `waiting`, `unknown`, `stopped`). Colour speeds the scan; the word is the record.

**The Quiet Normal Rule.** The healthy path is the quietest. Neutral states (`waiting`, `unknown`, `stopped`) are outline badges in quiet text, `stopped` is dashed. Only `failed` and a stale refresh are allowed to raise the visual volume.

## Typography

**Display Font:** the system UI stack, `ui-sans-serif, system-ui, sans-serif`
**Body Font:** the same system stack
**Label/Mono Font:** none for labels. Log text only uses Tailwind's default monospace stack (`font-mono`, 0.75rem). Numbers use the system stack with `tabular-nums`.

**Character:** Native and unadorned, so the dashboard reads like part of the operating system and loads no font files. It is a tool that is opened for a few seconds at a time, and type should add no personality between the operator and the status.

### Hierarchy
- **Display** (600, 1.25rem, 1.4, -0.025em): the single page title, "Dev host control". One per screen.
- **Body** (400 to 500, 0.875rem, 1.43): table cells, alert text, the count line "3 containers, 2 running". Container names are medium weight.
- **Label** (500, 0.75rem, 1.33): status badges, the "Updated hh:mm:ss" refresh indicator.

### Named Rules
**The Tabular Numbers Rule.** Ports, counts and times use `tabular-nums` or an equivalent fixed-width figure so a polled value changing does not shift the layout under the operator's eye.

**The One Title Rule.** The page has one heading. Hierarchy below it comes from weight, colour and position, not from more heading sizes.

## Layout

A single centred column, `max-w-6xl` (72rem), padded 16px on small screens and 24px from the `md` breakpoint (768px). Sections are stacked with a 16px rhythm. Top to bottom the order is fixed and follows the order of importance for observation:

1. **Header strip:** title and the live count on the left; Add node, Scan, Commands, theme toggle, read-only badge and refresh indicator on the right. This strip is the panel's own health readout and wraps rather than truncates.
2. **Alerts:** the stale-data alert, read-only alert and persistence alerts, directly above the data they qualify.
3. **Fleet ribbon:** one band for the whole host, a segment per container, with the totals above it, faults first.
4. **Container table:** the instrument cluster. Columns run from identity to state to action: Name, Port, Image, State, Health, Build, Last build, Auto-start, Open, Actions.
5. **Session timeline:** what this tab has seen change since it was opened. It sits below the table because it is context, not the reading.

Below `md` the table becomes a stack of cards. Image, Health, Last build and Auto-start drop out of view first (`hidden md:table-cell`), and the name takes a full line. State, Build, Open and Actions always stay, because they are the observation and the response. Row errors and warnings remain inside the card. The header row stays in the DOM for screen readers (`sr-only`). Row actions collapse into a menu on narrow screens so the row stays one glance tall.

Data refreshes by polling every 3 seconds, scheduled after each attempt finishes so requests never pile up. The layout must not move when data refreshes: row identity is the container id, widths come from content that is stable (fixed-width figures, short state words).

## Elevation & Depth

Flat. The dashboard uses borders and tonal fills, not shadows, to separate things: a hairline border around the table and cards, `Mist` on hover, a slightly lighter card surface in dark mode. The only shadow in the system is the faint `shadow-xs` on the outline button. Depth is reserved for layers that interrupt: the logs sheet, the confirm dialog and the theme menu sit above the page on the popover surface.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. Nothing on the data surface casts a shadow, so the eye is never pulled toward decoration and away from a state change.

## Shapes

Gently rounded and consistent. The radius base is 0.625rem (10px) and everything derives from it: small controls 6px, buttons and the table frame 8px, alerts and cards 10px. Status badges are fully rounded pills (`rounded-4xl`), so a status reads as a distinct object from the rectangular buttons and cells around it. The empty state uses a dashed border to signal "nothing here yet" rather than an error; the `stopped` badge uses a dashed border for the same reason.

## Components

The system is shadcn "radix-vega" on neutral, built on Radix primitives and Tailwind CSS v4. Only the pieces below carry observation meaning; the rest are standard.

### Build state badge (signature component)
The most important component. A pill with the build state as its text, `h-5` (20px), 12px medium text.
- **ok:** solid Signal Ok with light text.
- **building:** solid Signal Building with light text.
- **failed:** a soft red tint (red at 10% opacity, 20% in dark) with Fault Red text.
- **starting:** secondary fill. **waiting:** outline. **unknown:** outline in quiet text. **stopped:** dashed outline in quiet text, shown for any container that is not running regardless of its last build.
- The badge exposes `data-state` so tests and tooling can read the state without parsing colour.
- Both fills keep white 12px text above 4.5:1 (about 5.4:1 and 5.9:1). Re-check this if either hue changes.

### Container state badge
A neutral outline pill showing the Docker state (`running`, `exited`, ...). It is deliberately uncoloured. Lifecycle is context; the build state beside it is the signal. Do not give it a hue.

The registered-node state `not created` uses a dashed quiet-text outline, like `stopped`; its build badge is also `stopped`. It is a useful state, not an error.

### Refresh indicator
Right side of the header: a small icon plus "Updated hh:mm:ss" in quiet text. While a request is in flight the icon becomes a spinner with the label "Refreshing". Before the first response it reads "Waiting for first update". This is the answer to "can I trust what I see right now".

### Stale-data alert
A bordered card with Fault Red text, announced as an alert, shown when the latest refresh failed. Title "Data may be stale", body says why, and whether the rows below are the last good data or no list has loaded. The rows stay visible, since an old reading beats a blank, but the alert must stay above them for as long as the failure lasts.

### Read-only badge and alert
When the control server rejects changes, a "Read-only" secondary badge appears in the header and an alert sits above the table. Action buttons are disabled; Logs stays available because observation is never blocked.

### Persistence alerts
When node records are not on a separate mount, a neutral alert says they can be lost when the control container is recreated and names the data directory. When the store is not writable, a Fault Red alert says node changes cannot be saved and Add node is disabled. Neither alert uses a signal hue as decoration.

### Container table
The primary data surface. Bordered, 8px radius, horizontal scroll as a safety net, one row per labelled container or saved node. Port in tabular figures. Image truncates with the full value on hover. "Last build" renders a `<time>` element with the ISO value, and an em dash when no build has finished. Auto-start is quiet text after Last build: an active window shows its expiry in a `<time>` and days left, an ended window says it ended with the date, and an unset or unregistered row shows an em dash. Row order is the server's; the table does not reorder under the operator on its own.

### Fleet ribbon
A flex-wrapped band of status cells, one per container, each printing the container name and its state word. Fill follows the three signals (ok green, building blue); failed is a soft red cell with a 2px inset outline, and it is the only cell that pings, once, when a container turns failed during the session. Neutral states stay outlined, `stopped` dashed. Pressing a cell moves the keyboard cursor to that row. The totals above it read `1 failed 2 ok 1 stopped`, only non-zero states, failed first.

### Live rows
Rows react without moving. A refresh that changes a state is applied inside a same-document View Transition, so the build badge morphs instead of snapping; the page itself swaps at once (the root transition is disabled), and only the named badges animate. The badge that just changed gets a dashed neutral ring that settles and fades in about 2.6s. "Last build" is a relative age (`12s ago`) ticking from one shared one-second clock, with the full local time in the tooltip and the ISO value in `dateTime`. An action shows its word beside the badge (`rebuilding…`) from the press until the first refresh that lands after it succeeds, and ends at once if it fails. Without View Transitions, or with `prefers-reduced-motion`, the same updates happen instantly and the ring fades without scaling.

### Session timeline
One lane per container: a track whose segments are the states this tab has seen, the current state as a word at the lane's end, and the last five changes spelled out below ("nd-docs went from building to ok"). The window is at least two minutes and at most an hour, ending now. It is client-side only and the caption says so: "The server keeps no history, so earlier changes are not shown." A container that disappears keeps its lane and ends in a dashed `removed` segment. Empty: "No state changes since you opened this page."

### Command palette and shortcuts
`Ctrl K` (`Cmd K` on macOS) opens a palette: Logs, Open, Rebuild, Restart, Stop or Start, Recreate, Extend 7 days, Stop auto-start, Scan, Refresh now, and the theme. Start uses the same prompt as the row action when its window is not active. Words filter it in any order. Remove container and Delete node are left out because they need confirmation. In read-only mode commands that change a node are hidden and a line says why. Single-letter shortcuts act on the keyboard cursor row: `j` and `k` move it, `L` opens logs, `R` rebuilds, `S` starts a stopped node through the shared prompt, `Esc` clears it. They stay quiet while typing and while any dialog, menu or sheet is open.

### Container actions
Rebuild, Restart and Stop for a running container, Start for a stopped or not-created node, Logs, Recreate, Extend 7 days, Stop auto-start, Remove container and Delete node. Quiet outline and ghost buttons so they sit behind the state. Remove container and Delete node are destructive and always ask for confirmation; Delete node says the record is deleted too. New lifecycle actions are hidden for unregistered containers and disabled in read-only mode. Failure of any action raises a toast that names the node and action.

### Add node dialog
A shadcn dialog with name, workspace, port, image and environment fields. The port starts at the server's `nextPort`; the image starts at the default allowed repository. A rejected request leaves the dialog open, keeps all entered values and shows the server's validation message beside the form.

### Start prompt
When a node has no active auto-start window, Start asks whether to start only, start and auto-start for seven days, or cancel. Cancel sends no request. A node with an active window starts without asking, and the prompt is shared by the row, `S` shortcut and command palette.

### Operation details
While the control node pulls, creates or starts a node, a quiet `pulling…`, `creating…` or `starting…` word stays beside the state on both wide and narrow rows. A failed operation stays as a Fault Red line until a later operation succeeds. A local-image fallback is a quiet warning line. These are row-level status, not decoration.

### Logs sheet
A side sheet with the last 200 log lines in a muted monospace block, the observability tool of last resort. It opens from the row, in place, with no navigation away from the panel, and the row's state badge travels into the sheet header through a shared View Transition name. It follows the tail every 3 seconds while the reader is at the bottom and leaves them alone once they scroll up; Pause freezes it. If a later refresh fails it keeps the last lines and says so in red. It has its own loading, empty ("(no log lines)") and error states.

### Theme toggle
An icon-only outline button (Light, Dark, System). System is the default and follows the OS. The choice persists in `localStorage` under `dev-host-theme`.

### Empty state
A dashed-border block with one instruction sentence: containers carrying the `node-dev-host.port` label will appear here. It teaches the way in, rather than apologising.

## Do's and Don'ts

### Do:
- **Do** lead every container row with state: the build badge and the last-build time are the first things a scan should land on after the name.
- **Do** print the state name inside every status badge (The Word Beside the Colour Rule).
- **Do** show the panel's own health in the header: last update time, refreshing indicator, read-only mode.
- **Do** keep the last good data on screen when a refresh fails, and put the stale alert above it.
- **Do** show `unknown` or an em dash when a value cannot be read. Never invent a state, never leave a blank cell.
- **Do** keep layout stable across polls: fixed-width figures, content-driven widths, rows keyed by container id.
- **Do** keep Logs reachable in every mode, including read-only and for stopped containers.
- **Do** keep auto-start text, operation labels and warnings neutral; the schedule is not a build signal.
- **Do** keep the status hues to their three meanings (green ok, blue building, red failed) in both themes.
- **Do** check any new status colour in light and dark for 4.5:1 text contrast before shipping it.

### Don't:
- **Don't** use green, blue or red for decoration, links, hover states or branding. The signals only work if nothing else uses them.
- **Don't** communicate a state by colour alone, or by an icon without a word.
- **Don't** hide, collapse or silently clear failure information. A `failed` build and a failed refresh must stay visible until they are resolved.
- **Don't** add a hero, a marketing banner, illustrations or large decorative empty space above the table. The first screen of the page is the instrument cluster.
- **Don't** add shadows, gradients or glass effects to the data surface.
- **Don't** reorder rows or reflow columns when data refreshes.
- **Don't** present the session timeline as server history, or draw it without its caption.
- **Don't** add a second motion moment: the badge morph, the settle ring and the one-time fault ping are the whole budget.
- **Don't** let actions outrank status. Action buttons stay quiet and sit last in the row.
- **Don't** colour the Docker container state badge. It is context, and the build badge is the signal.
- **Don't** use a signal hue for Auto-start, a persistence warning, an operation word or a pull-fallback note.
- **Don't** add a custom font, a second accent colour or a bespoke component where a shadcn primitive already fits.
