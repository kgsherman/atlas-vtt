/**
 * The DM closed the table, or it ended (ARCHITECTURE §6.8, §6.9): the player's client has stopped. The
 * screen asks session_info every few seconds and hands over to a new client once the table is open again.
 * The player is in the table's WORLD, so when the DM opens another scene's table there instead, they are
 * taken to it. It says so when the player was removed from the world, or the table ended with no world.
 */
import * as React from "react"
import { DoorClosed } from "lucide-react"
import { useLocation } from "wouter"

import { paths } from "@/app/routes"
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
  ended = false,
  onReopened,
}: {
  sessionId: string
  /** The table ended (it never reopens): wait only for another table of its world. */
  ended?: boolean
  onReopened(): void
}) {
  const { sessions, worlds } = useServices()
  const [, navigate] = useLocation()
  const [outcome, setOutcome] = React.useState<"ended" | "kicked" | null>(null)
  const [worldName, setWorldName] = React.useState<string | null>(null)
  // The table ended while the player waited (its scene deleted, say): they wait for the world's next table.
  const [gone, setGone] = React.useState(ended)
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
        if (!info) return setOutcome("ended")
        if (info.memberStatus === "kicked") return setOutcome("kicked")
        if (info.status === "ended") setGone(true)
        if (info.worldId) {
          const world = await worlds.info(info.worldId).catch(() => null)
          if (!alive) return
          setWorldName(world?.name ?? info.worldName)
          if (world?.memberStatus === "kicked") return setOutcome("kicked")
          // The DM opened another scene's table in the world: the players go there.
          if (world?.openSessionId && world.openSessionId !== sessionId)
            return navigate(paths.play(world.openSessionId), { replace: true })
        } else if (info.status === "ended") return setOutcome("ended")
        if (info.status === "active" && !ended) return reopened.current()
      } catch {
        // Offline or a hiccup: ask again later.
      }
      if (alive) timer = setTimeout(() => void check(), REOPEN_POLL_MS)
    }
    timer = setTimeout(() => void check(), ended ? 0 : REOPEN_POLL_MS)
    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [sessions, worlds, sessionId, ended, navigate])

  if (outcome === "ended") return <EndedScreen />
  if (outcome === "kicked") return <KickedScreen />
  return (
    <BlockingScreen
      icon={<DoorClosed />}
      title={gone ? "This table has ended" : "The table is closed"}
      description={
        <>
          {gone
            ? `The DM ended this scene's table. You'll be let in as soon as they open a table${worldName ? ` in ${worldName}` : ""}.`
            : `The DM closed the table for now. You'll be let back in as soon as they open it again${worldName ? `, or another table in ${worldName}` : ""}.`}
          <span className="mt-3 flex items-center justify-center gap-2 text-xs">
            <Spinner className="size-3.5" /> Waiting for the DM…
          </span>
        </>
      }
      actions={<HomeButton variant="outline" />}
    />
  )
}
