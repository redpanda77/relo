// A render error anywhere in the notch would otherwise unmount the whole tree and the notch would vanish from the
// screen (the window stays, transparent and empty). The boundary logs the error to relo-windows.log and keeps a
// small notch on screen with a way back, the way the Mac never leaves the notch blank.
import { Component, type ErrorInfo, type ReactNode } from "react"
import { logEvent } from "./client/native"

type State = { error: Error | null; key: number }

const describe = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack.split("\n").slice(1, 6).join("\n")}` : ""}` : String(error)

/** Errors outside React's render (event handlers, promises) are logged too: they leave no trace otherwise. */
export function logUncaughtErrors(): void {
  window.addEventListener("error", (event) => logEvent("error", `notch: uncaught ${describe(event.error ?? event.message)}`))
  window.addEventListener("unhandledrejection", (event) => logEvent("error", `notch: unhandled rejection ${describe(event.reason)}`))
}

export class NotchBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, key: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logEvent("error", `notch: render failed ${describe(error)}${info.componentStack ? `\n${info.componentStack.split("\n").slice(0, 6).join("\n")}` : ""}`)
  }

  private retry = () => this.setState((s) => ({ error: null, key: s.key + 1 }))

  render(): ReactNode {
    if (!this.state.error) return <div key={this.state.key}>{this.props.children}</div>
    return (
      <div className="flex justify-center" style={{ paddingTop: 0 }}>
        <div
          className="flex items-center gap-3 rounded-b-[14px] px-4 py-2 text-[12px]"
          style={{ background: "#000", color: "rgb(255 255 255 / 0.85)", border: "0.75px solid rgb(255 255 255 / 0.14)", borderTop: "none" }}
        >
          <span>Relo hit a problem</span>
          <button type="button" className="rounded-full px-2.5 py-0.5 font-medium" style={{ background: "#ff7a66", color: "#000" }} onClick={this.retry}>
            Try again
          </button>
        </div>
      </div>
    )
  }
}
