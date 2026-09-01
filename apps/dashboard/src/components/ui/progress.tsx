"use client"

import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const normalizedValue = Math.min(100, Math.max(0, value ?? 0))

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={normalizedValue}
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    >
      <svg
        aria-hidden="true"
        data-slot="progress-indicator"
        className="size-full fill-primary"
        preserveAspectRatio="none"
        viewBox="0 0 100 4"
      >
        <rect width={normalizedValue} height="4" rx="2" />
      </svg>
    </ProgressPrimitive.Root>
  )
}

export { Progress }
