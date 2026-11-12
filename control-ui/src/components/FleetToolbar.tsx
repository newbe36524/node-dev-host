import type { Ref } from "react"
import { Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { type FleetFilter, filterActive } from "@/lib/fleet"

interface FleetToolbarProps {
  filter: FleetFilter
  onChange: (next: FleetFilter) => void
  shown: number
  total: number
  inputRef?: Ref<HTMLInputElement>
}

/**
 * The one control that makes a long list short. The state filters live on the fleet summary above
 * (the counts are the filters), so this row only holds the text search and what it did to the list.
 */
export function FleetToolbar({ filter, onChange, shown, total, inputRef }: FleetToolbarProps) {
  const active = filterActive(filter)
  return (
    <div
      role="search"
      className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/80"
      data-testid="fleet-toolbar"
    >
      <div className="relative min-w-0 flex-1 sm:max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          aria-label="Filter containers"
          aria-keyshortcuts="/"
          placeholder="Filter by name or port"
          value={filter.query}
          onChange={(event) => onChange({ ...filter, query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return
            // Esc clears the text first, then leaves the box, so one more Esc reaches the page shortcuts.
            if (filter.query) {
              event.preventDefault()
              event.stopPropagation()
              onChange({ ...filter, query: "" })
            } else {
              event.currentTarget.blur()
            }
          }}
          className="h-9 w-full rounded-md border border-input bg-transparent pr-9 pl-8 text-sm md:pr-14 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-search-cancel-button]:hidden"
        />
        {filter.query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onChange({ ...filter, query: "" })}
            className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded-sm border px-1 text-[11px] text-muted-foreground md:inline">/</kbd>
        )}
      </div>
      {/* Below sm the page header already says how many there are; the count only appears once it means something. */}
      <p className={`tabular shrink-0 text-sm text-muted-foreground ${active ? "" : "max-sm:hidden"}`} aria-live="polite" data-testid="filter-result">
        {active ? `${shown} of ${total} shown` : `${total} ${total === 1 ? "container" : "containers"}`}
      </p>
      {active && (
        <Button size="sm" variant="ghost" aria-label="Clear filters" onClick={() => onChange({ query: "", states: [] })}>
          <span className="sm:hidden">Clear</span>
          <span className="max-sm:hidden">Clear filters</span>
        </Button>
      )}
      <p className="ml-auto hidden text-xs text-muted-foreground lg:block">Failed first, then by name</p>
    </div>
  )
}
