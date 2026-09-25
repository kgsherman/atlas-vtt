/**
 * The DM closed the table (ARCHITECTURE §6.8): the player's client has stopped. The screen asks
 * session_info every few seconds and hands over to a new client once the table is open again (or
 * says the game ended / the player was removed meanwhile).
 */
import * as React from "react"
import { DoorClosed } from "lucide-react"

import { useServices } from "@/app/services"
import { Spinner } from "@/components/ui/spinner"

import {
  BlockingScreen,
  EndedScreen,
  HomeButton,
  KickedScreen,
} from "../StatusScreens"

export const REOPEN_POLL_MS = 5000

export function ClosedTableScreen({
  sessionId,
  onReopened,
}: {
  sessionId: string
  onReopened(): void
}) {
  const { sessions } = useServices()
  const [outcome, setOutcome] = React.useState<"ended" | "kicked" | null>(null)
  const reopened = React.useRef(onReopened)
  React.useEffect(() => {
    reopened.current = onReopened
  })
  React.useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const check = async () => {
      try {
        const info = await sessions.sessionInfo(sessionId)
        if (!alive) return
        if (!info || info.status === "ended") return setOutcome("ended")
        if (info.memberStatus === "kicked") return setOutcome("kicked")
        if (info.status === "active") return reopened.current()
      } catch {
        // Offline or a hiccup: ask again later.
      }
      if (alive) timer = setTimeout(() => void check(), REOPEN_POLL_MS)
    }
    timer = setTimeout(() => void check(), REOPEN_POLL_MS)
    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [sessions, sessionId])

  if (outcome === "ended") return <EndedScreen />
  if (outcome === "kicked") return <KickedScreen />
  return (
    <BlockingScreen
      icon={<DoorClosed />}
      title="The table is closed"
      description={
        <>
          The DM closed the table for now. You'll be let back in as soon as they
          open it again.
          <span className="mt-3 flex items-center justify-center gap-2 text-xs">
            <Spinner className="size-3.5" /> Waiting for the DM…
          </span>
        </>
      }
      actions={<HomeButton variant="outline" />}
    />
  )
}
