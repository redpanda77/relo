import * as React from "react"

import type { InboxService } from "@/services/inbox-service"

export const defaultInboxActionReconciliation = {
  reload: () => window.location.reload(),
}

export function useInboxAction(
  service: InboxService,
  onSuccess: () => void = () => defaultInboxActionReconciliation.reload()
) {
  const operations = React.useRef(new Map<string, symbol>())
  const reconciliationRequested = React.useRef(false)
  const [pendingCodes, setPendingCodes] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [errors, setErrors] = React.useState<ReadonlyMap<string, string>>(
    () => new Map()
  )

  const decide = React.useCallback(
    async (code: string, decision: "approve" | "deny") => {
      if (operations.current.has(code)) return false
      const operation = Symbol(code)
      operations.current.set(code, operation)
      setPendingCodes((current) => new Set(current).add(code))
      setErrors((current) => {
        const next = new Map(current)
        next.delete(code)
        return next
      })
      let succeeded = false
      let reconcile = false
      try {
        await service.decideApproval(code, decision)
        succeeded = true
        reconciliationRequested.current = true
      } catch (cause) {
        const message =
          cause instanceof Error
            ? cause.message
            : "The approval decision failed."
        setErrors((current) => new Map(current).set(code, message))
      } finally {
        if (operations.current.get(code) === operation) {
          operations.current.delete(code)
          setPendingCodes((current) => {
            const next = new Set(current)
            next.delete(code)
            return next
          })
          if (
            operations.current.size === 0 &&
            reconciliationRequested.current
          ) {
            reconciliationRequested.current = false
            reconcile = true
          }
        }
      }
      if (reconcile) onSuccess()
      return succeeded
    },
    [onSuccess, service]
  )

  return {
    pendingCodes,
    errorFor: (code: string) => errors.get(code) ?? null,
    decide,
  }
}
