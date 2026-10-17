import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * One family of actions. Primary is the one solid light button a view leads with; secondary is
 * the quiet fill beside it; outline is the same with a hairline, for a button that sits on bare
 * page; ghost has no face until hovered; destructive is red words on a whisper of red; link is
 * coral text. No gradients, glows or inner highlights. Focus is the shared 2px ring outline.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding font-medium whitespace-nowrap press select-none pointer-coarse:min-h-11 disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-[var(--primary-fill)] text-[var(--primary-ink)] hover:bg-[var(--primary-fill-hover)]",
        outline:
          "border-[var(--control-border)] bg-[var(--control-fill)] text-foreground hover:border-[var(--hairline-strong)] hover:bg-[var(--control-fill-hover)] aria-expanded:bg-[var(--control-fill-active)]",
        secondary:
          "bg-[var(--control-fill)] text-foreground hover:bg-[var(--control-fill-hover)] aria-expanded:bg-[var(--control-fill-active)]",
        ghost:
          "text-muted-foreground hover:bg-[var(--control-fill)] hover:text-foreground aria-expanded:bg-[var(--control-fill)] aria-expanded:text-foreground",
        destructive:
          "bg-destructive/12 text-destructive hover:bg-destructive/18 aria-expanded:bg-destructive/18",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Three heights, one radius each: 32 (sm, r8), 36 (default, r10), 44 (lg, r12); xs (24) is
      // for inline use only. On a touch screen every button is at least 44px tall
      // (pointer-coarse:min-h-11 above), so call sites never add min-h-11 by hand; icon buttons
      // also grow to 44px wide.
      size: {
        default:
          "h-9 gap-1.5 rounded-[10px] px-3.5 text-sm has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-[6px] px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-[8px] px-3 text-[13px] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 rounded-[12px] px-5 text-[15px] has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-8 rounded-[8px] pointer-coarse:min-w-11",
        "icon-xs":
          "size-6 rounded-[6px] pointer-coarse:min-w-11 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-[8px] pointer-coarse:min-w-11",
        "icon-lg": "size-9 rounded-[10px] pointer-coarse:min-w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
