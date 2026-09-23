import * as React from "react"
import { HomeIcon, RefreshCwIcon, RotateCcwIcon, SparklesIcon } from "lucide-react"

import { ErrorAction, ErrorScreen } from "./ErrorScreen"

interface Props {
  children: React.ReactNode
  /** Changing this clears the error (e.g. the current location). */
  resetKey?: string
}

interface State {
  error: Error | null
  resetKey: string | undefined
}

/** A lazily loaded chunk disappeared (the app was redeployed while this tab was open). */
function isChunkLoadError(error: Error): boolean {
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(error.message)
}

/** Catches render errors below it and shows a recoverable error screen. */
export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null }
    return null
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error("[atlas] render error", error, info.componentStack)
  }

  private readonly reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    // In production a missing chunk means a redeploy; in dev it is a module that failed to compile.
    if (isChunkLoadError(error) && !import.meta.env.DEV) {
      return (
        <ErrorScreen
          icon={<SparklesIcon className="size-5" />}
          title="Atlas has been updated"
          description="A newer version of the app is available. Reload to continue — your saved scenes and sessions are safe."
          actions={
            <ErrorAction onClick={() => window.location.reload()}>
              <RefreshCwIcon data-icon="inline-start" />
              Reload
            </ErrorAction>
          }
          details={error.message}
        />
      )
    }
    return (
      <ErrorScreen
        title={isChunkLoadError(error) ? "This page failed to load" : "Something went wrong"}
        description={
          isChunkLoadError(error)
            ? "A module of this page could not be loaded (see the details and the dev server output)."
            : "This page hit an unexpected error. You can try again, or go back to your scenes."
        }
        actions={
          <>
            <ErrorAction onClick={this.reset}>
              <RotateCcwIcon data-icon="inline-start" />
              Try again
            </ErrorAction>
            <ErrorAction variant="outline" onClick={() => window.location.assign("/")}>
              <HomeIcon data-icon="inline-start" />
              Home
            </ErrorAction>
          </>
        }
        details={`${error.name}: ${error.message}${error.stack ? `\n\n${error.stack}` : ""}`}
      />
    )
  }
}
