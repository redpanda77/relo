import { ChevronDown } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export function FilterChip({
  label,
  name,
  value,
  icon: Icon,
  children,
  className,
  onValueChange,
}: {
  label: string
  name: string
  value: string
  icon: LucideIcon
  children: ReactNode
  className?: string
  onValueChange?: (value: string) => void
}) {
  return (
    <label
      className={cn(
        "relative flex h-11 max-w-full min-w-0 items-center rounded-full border border-border bg-card/55 text-muted-foreground transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40 hover:bg-card data-[active=true]:border-primary/45 data-[active=true]:bg-primary/10 data-[active=true]:text-foreground",
        className
      )}
      data-active={value ? "true" : "false"}
    >
      <Icon
        className="pointer-events-none absolute left-3 size-4 shrink-0"
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        name={name}
        value={value}
        onChange={(event) => {
          if (onValueChange) {
            onValueChange(event.currentTarget.value)
          } else {
            event.currentTarget.form?.requestSubmit()
          }
        }}
        className="h-full max-w-full min-w-0 appearance-none bg-transparent py-0 pr-9 pl-9 text-sm font-medium text-current outline-none"
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 size-3.5 opacity-65"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </label>
  )
}
