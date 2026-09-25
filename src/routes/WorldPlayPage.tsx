/**
 * /world/:worldId/play — a player's way into a world (ARCHITECTURE §6.9): its open table (/play/:sid), or,
 * while every table of it is closed, a wait for the DM to open one (world_info every few seconds), with the
 * characters the DM gave the player. The world's DM lands on the world page instead.
 */
import * as React from "react"
import { BanIcon, DoorClosedIcon, GlobeIcon, HomeIcon } from "lucide-react"
import { useLocation, useParams } from "wouter"

import { paths, preloadRoute } from "@/app/routes"
import { useServices } from "@/app/services"
import { AppHeader } from "@/components/app/AppHeader"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import type { WorldInfo } from "@/net/worldsRepo"

export const WORLD_POLL_MS = 5000

export default function WorldPlayPage() {
  const { worlds } = useServices()
  const params = useParams<{ worldId: string }>()
  const [, navigate] = useLocation()
  const worldId = params.worldId ?? ""
  const [info, setInfo] = React.useState<WorldInfo | null | undefined>(undefined)

  React.useEffect(() => {
    preloadRoute("play")
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const check = async () => {
      try {
        const next = await worlds.info(worldId)
        if (!alive) return
        setInfo(next)
        if (next?.role === "dm") return navigate(paths.world(worldId), { replace: true })
        if (next?.memberStatus === "active" && next.openSessionId) return navigate(paths.play(next.openSessionId), { replace: true })
        if (!next || next.memberStatus === "kicked") return
      } catch {
        // Offline or a hiccup: ask again later.
      }
      if (alive) timer = setTimeout(() => void check(), WORLD_POLL_MS)
    }
    void check()
    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [worlds, worldId, navigate])

  const home = (
    <Button variant="outline" onClick={() => navigate(paths.home())}>
      <HomeIcon data-icon="inline-start" /> Back to home
    </Button>
  )

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <AppHeader />
      <main className="grid flex-1 place-items-center p-6">
        {info === undefined ? (
          <Spinner className="size-5 text-muted-foreground" />
        ) : info === null ? (
          <Empty className="max-w-md border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GlobeIcon />
              </EmptyMedia>
              <EmptyTitle>You're not in this world</EmptyTitle>
              <EmptyDescription>Join it with the room code your DM shared, or it may have been deleted.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex-row justify-center">
              <Button onClick={() => navigate(paths.join())}>Join with a code</Button>
              {home}
            </EmptyContent>
          </Empty>
        ) : info.memberStatus === "kicked" ? (
          <Empty className="max-w-md border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BanIcon />
              </EmptyMedia>
              <EmptyTitle>You were removed from {info.name}</EmptyTitle>
              <EmptyDescription>The DM removed you from the world. Ask them to let you back in if this was a mistake.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{home}</EmptyContent>
          </Empty>
        ) : (
          <Empty className="max-w-md border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <DoorClosedIcon />
              </EmptyMedia>
              <EmptyTitle>{info.name}</EmptyTitle>
              <EmptyDescription>
                You're in {info.dmDisplayName ? `${info.dmDisplayName}'s` : "the DM's"} world as {info.displayName}. No table is open yet: you'll be let in as
                soon as the DM opens one.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="gap-4">
              {info.characters.length > 0 ? (
                <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted-foreground">
                  You play
                  {info.characters.map((c) => (
                    <Badge key={c} variant="secondary">
                      {c}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">The DM hasn't given you a character yet.</p>
              )}
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3.5" /> Waiting for the DM…
              </span>
              {home}
            </EmptyContent>
          </Empty>
        )}
      </main>
    </div>
  )
}
