import type * as React from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { ActionButton } from "@/components/molecules/action-button"
import { cn } from "@/lib/utils"

/**
 * A button that asks before it acts. With an `icon`, `compact` shows only the icon on phones (its
 * label stays its accessible name) and the label from 640px up. Once confirmed, the dialog closes
 * and the trigger itself carries the work (ActionButton): a spinner named `pendingLabel` at the
 * label's width, then a short `successLabel` if one is given (a removed row simply leaves), or a
 * shake when `failed` is set as `pending` falls.
 */
export function ConfirmationAction({
  label,
  title,
  description,
  pending,
  disabled = false,
  failed = false,
  pendingLabel = "Working…",
  successLabel = null,
  onConfirm,
  variant = "destructive",
  size = "default",
  icon,
  compact = false,
  className,
}: {
  label: string
  title: string
  description: string
  pending: boolean
  /** Unavailable without working (another action on the same item is running). */
  disabled?: boolean
  /** Set in the same update as `pending` falls when the action did not go through. */
  failed?: boolean
  pendingLabel?: string
  successLabel?: string | null
  onConfirm(): void
  variant?: "default" | "outline" | "destructive" | "ghost"
  size?: "default" | "sm" | "lg"
  icon?: React.ReactNode
  compact?: boolean
  className?: string
}) {
  const iconOnPhones = compact && icon
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <ActionButton
          type="button"
          variant={variant}
          size={size}
          aria-label={iconOnPhones && !pending ? label : undefined}
          className={cn(iconOnPhones && "max-sm:size-11 max-sm:bg-transparent max-sm:px-0", className)}
          disabled={disabled}
          pending={pending}
          failed={failed}
          pendingLabel={pendingLabel}
          successLabel={successLabel}
        >
          {icon}
          <span className={iconOnPhones ? "max-sm:sr-only" : undefined}>{label}</span>
        </ActionButton>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={variant === "ghost" ? "destructive" : variant}
            onClick={onConfirm}
          >
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function DestructiveAction(
  props: Omit<React.ComponentProps<typeof ConfirmationAction>, "variant">
) {
  return <ConfirmationAction {...props} variant="destructive" />
}
