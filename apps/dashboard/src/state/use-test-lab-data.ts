import * as React from "react"

import type { TestLabBootstrap } from "@/features/test-lab/types"

export function useTestLabData(initial: TestLabBootstrap) {
  const [snapshot, setSnapshot] = React.useState(initial)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const mutate = React.useCallback(async <Result,>(operation: () => Promise<Result>) => {
    setPending(true)
    setError(null)
    try {
      return await operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The operation failed.")
      throw cause
    } finally {
      setPending(false)
    }
  }, [])

  return { snapshot, setSnapshot, pending, error, setError, mutate }
}
