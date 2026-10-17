import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-lg px-3 py-1 text-base border border-input bg-white/[0.03] transition-colors outline-none hover:border-[var(--hairline-strong)] focus-visible:border-ring/70 focus-visible:ring-3 focus-visible:ring-ring/25 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
