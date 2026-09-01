import type * as React from "react"

import { cn } from "@/lib/utils"

export function FieldNote({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-xs leading-5 text-muted-foreground", className)} {...props} />
}
