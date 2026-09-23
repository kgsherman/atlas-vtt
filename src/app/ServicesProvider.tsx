/**
 * Creates the app services once (createServices), shows a splash while signing in, and an
 * actionable error screen when that fails (anonymous sign-ins disabled, offline, …). Provides
 * ServicesContext; `setDisplayName` also refreshes the identity seen by React consumers.
 */
import * as React from "react"
import { CloudOffIcon, HardDriveIcon, RotateCcwIcon, ShieldAlertIcon } from "lucide-react"

import { ErrorAction, ErrorScreen } from "@/components/app/ErrorScreen"
import { Splash } from "@/components/app/Splash"
import { onAuthChange } from "@/net/auth"
import { describeNetError, isNetError } from "@/net/supabase"

import { createServices } from "./createServices"
import { currentMode, modeSwitchUrl } from "./mode"
import { ServicesContext, type AppServices } from "./services"

type BootState = { status: "loading" } | { status: "ready"; services: AppServices } | { status: "error"; error: unknown }

// One bootstrap per page load, shared across StrictMode's double effects.
let boot: Promise<AppServices> | null = null
function bootServices(fresh = false): Promise<AppServices> {
  if (fresh || !boot) boot = createServices()
  return boot
}

export function ServicesProvider({ children }: { children: React.ReactNode }) {
  const [attempt, setAttempt] = React.useState(0)
  const [state, setState] = React.useState<BootState>({ status: "loading" })
  const [displayName, setDisplayNameState] = React.useState<string | null | undefined>(undefined)

  React.useEffect(() => {
    let alive = true
    bootServices(attempt > 0).then(
      (services) => {
        if (!alive) return
        setState({ status: "ready", services })
        setDisplayNameState(services.identity.displayName)
      },
      (error: unknown) => {
        if (alive) setState({ status: "error", error })
      }
    )
    return () => {
      alive = false
    }
  }, [attempt])

  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])

  // Cloud identity changed underneath us (signed out elsewhere, storage cleared): start over.
  const ready = state.status === "ready" ? state.services : null
  React.useEffect(() => {
    if (!ready || ready.mode !== "supabase") return
    const userId = ready.identity.userId
    let unsubscribe = () => {}
    try {
      unsubscribe = onAuthChange((uid) => {
        if (uid !== userId) retry()
      })
    } catch {
      // not configured — cannot happen in supabase mode
    }
    return unsubscribe
  }, [ready, retry])

  const value = React.useMemo<AppServices | null>(() => {
    if (!ready) return null
    return {
      ...ready,
      identity: { ...ready.identity, displayName: displayName ?? ready.identity.displayName },
      async setDisplayName(name: string) {
        const stored = await ready.setDisplayName(name)
        setDisplayNameState(stored)
        return stored
      },
    }
  }, [ready, displayName])

  if (state.status === "error") return <BootError error={state.error} onRetry={retry} />
  if (!value) return <Splash label={currentMode().mode === "supabase" ? "Connecting to Atlas Cloud…" : "Opening your local library…"} />
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>
}

function BootError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const mode = currentMode()
  const useLocal = () => window.location.assign(modeSwitchUrl("local", window.location.href))
  const localButton = mode.mode === "supabase" && (
    <ErrorAction variant="outline" onClick={useLocal}>
      <HardDriveIcon data-icon="inline-start" />
      Continue in local mode
    </ErrorAction>
  )
  const retryButton = (
    <ErrorAction onClick={onRetry}>
      <RotateCcwIcon data-icon="inline-start" />
      Try again
    </ErrorAction>
  )
  const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error)

  if (isNetError(error, "anonymous_disabled")) {
    return (
      <ErrorScreen
        icon={<ShieldAlertIcon className="size-5" />}
        title="Anonymous sign-ins are disabled"
        description="Atlas signs every DM and player in anonymously, so nobody needs an account to join a game. This Supabase project doesn't allow that yet."
        steps={[
          <>
            Open the Supabase dashboard for this project → <span className="font-medium">Authentication</span> →{" "}
            <span className="font-medium">Sign In / Providers</span>.
          </>,
          <>
            Turn on <span className="font-medium">Allow anonymous sign-ins</span> and save.
          </>,
          <>Come back here and try again.</>,
        ]}
        actions={
          <>
            {retryButton}
            {localButton}
          </>
        }
        details={details}
      />
    )
  }
  if (isNetError(error, "network")) {
    return (
      <ErrorScreen
        icon={<CloudOffIcon className="size-5" />}
        title="Can't reach Atlas Cloud"
        description="Check your internet connection and try again. You can also keep working offline in local mode (scenes stay in this browser)."
        actions={
          <>
            {retryButton}
            {localButton}
          </>
        }
        details={details}
      />
    )
  }
  return (
    <ErrorScreen
      title="Atlas couldn't start"
      description={isNetError(error) ? describeNetError(error.code) : "Something went wrong while signing in."}
      actions={
        <>
          {retryButton}
          {localButton}
        </>
      }
      details={details}
    />
  )
}
