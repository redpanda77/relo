import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * One family of capsule actions. The default is the one filled button a view leads with: filled
 * with `--btn-tone` (the violet unless a `tone` is given: orange for a question's answers), dark
 * ink and a soft glow of the same tone. Secondary and outline are white .12 glass with a .14
 * hairline; ghost has no face until hovered; destructive is a quiet glass with red words and a red
 * hairline; link is violet text. Focus is the shared 2px ring outline.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding font-medium whitespace-nowrap press select-none pointer-coarse:min-h-11 disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--btn-tone,var(--now-violet))] text-[var(--primary-ink)] shadow-[0_0_16px_color-mix(in_srgb,var(--btn-tone,var(--now-violet))_40%,transparent)] hover:bg-[var(--primary-fill-hover)]",
        outline:
          "border-[var(--control-border)] bg-[var(--control-fill)] text-foreground hover:border-[var(--hairline-strong)] hover:bg-[var(--control-fill-hover)] aria-expanded:bg-[var(--control-fill-active)]",
        secondary:
          "bg-[var(--control-fill)] text-foreground hover:bg-[var(--control-fill-hover)] aria-expanded:bg-[var(--control-fill-active)]",
        ghost:
          "text-muted-foreground hover:bg-[var(--control-fill)] hover:text-foreground aria-expanded:bg-[var(--control-fill)] aria-expanded:text-foreground",
        destructive:
          "border-destructive/35 bg-white/[0.04] text-destructive hover:bg-destructive/12 aria-expanded:bg-destructive/12",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Three heights, all capsules: 32 (sm), 36 (default), 44 (lg); xs (24) is
      // for inline use only. On a touch screen every button is at least 44px tall
      // (pointer-coarse:min-h-11 above), so call sites never add min-h-11 by hand; icon buttons
      // also grow to 44px wide.
      size: {
        default:
          "h-9 gap-1.5 rounded-full px-4 text-sm has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-full px-2.5 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-full px-3.5 text-[13px] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 rounded-full px-5 text-[15px] has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-8 rounded-full pointer-coarse:min-w-11",
        "icon-xs":
          "size-6 rounded-full pointer-coarse:min-w-11 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-full pointer-coarse:min-w-11",
        "icon-lg": "size-9 rounded-full pointer-coarse:min-w-11",
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
  tone,
  style,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** The default variant's fill and glow (a `--tone` colour, e.g. "var(--neon-orange)"); violet if omitted. */
    tone?: string
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      style={tone ? ({ ...style, "--btn-tone": tone } as React.CSSProperties) : style}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
