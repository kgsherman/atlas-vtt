/**
 * Home: brand hero (a new world, the sample, quick join), "Your worlds" (ARCHITECTURE §6.9: each world
 * holds its scenes, characters and players; its page is where they are managed), and "Tables & games"
 * (my open tables, the worlds I joined as a player).
 */
import * as React from "react"
import { GlobeIcon, HardDriveIcon, PlusIcon, UserRoundIcon } from "lucide-react"
import { toast } from "sonner"
import { useLocation } from "wouter"

import { describeJoinError } from "@/app/joinErrors"
import { createFromSample, sweepUnusedImages, userMessage } from "@/app/library"
import { currentMode, modeSwitchUrl } from "@/app/mode"
import { paths, preloadRoute } from "@/app/routes"
import { useServices } from "@/app/services"
import { useAsync, useOnFocus } from "@/app/useAsync"
import { AppHeader } from "@/components/app/AppHeader"
import { HomeHero } from "@/components/app/HomeHero"
import { SessionsPanel } from "@/components/app/SessionsPanel"
import { SignInButtons } from "@/components/app/SignInButtons"
import { WorldCard, WorldCardSkeleton } from "@/components/app/WorldCard"
import { WorldNameDialog } from "@/components/world/WorldDialogs"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { formatRoomCode } from "@/net/roomCodes"
import type { SceneSummary } from "@/net/scenesRepo"
import type { WorldSummary } from "@/net/worldsRepo"

const SAMPLE_ID = "crooked-lantern"

export default function HomePage() {
  const services = useServices()
  const [, navigate] = useLocation()
  const who = `${services.mode}:${services.identity.userId}`
  const worldsQ = useAsync(`worlds:${who}`, () => services.worlds.list())
  const scenesQ = useAsync(`scenes:${who}`, () => services.scenes.list())
  const tablesQ = useAsync(`tables:${who}`, () => services.sessions.listMySessions())
  const { reload: reloadWorlds } = worldsQ
  const { reload: reloadScenes } = scenesQ
  const { reload: reloadTables } = tablesQ
  const reloadAll = React.useCallback(() => {
    reloadWorlds()
    reloadScenes()
    reloadTables()
  }, [reloadWorlds, reloadScenes, reloadTables])
  useOnFocus(reloadAll)

  // Map images no scene uses any more (at most daily, in the background; Supabase only).
  React.useEffect(() => {
    void sweepUnusedImages(services)
  }, [services])

  const [newWorld, setNewWorld] = React.useState(false)
  const [sampleBusy, setSampleBusy] = React.useState(false)
  const [joinCode, setJoinCode] = React.useState("")
  const [joinHint, setJoinHint] = React.useState<string | null>(null)
  const [joining, setJoining] = React.useState(false)

  const worlds = React.useMemo(() => worldsQ.data ?? [], [worldsQ.data])
  const scenes = React.useMemo(() => scenesQ.data ?? [], [scenesQ.data])
  const scenesByWorld = React.useMemo(() => {
    const out = new Map<string, SceneSummary[]>()
    for (const s of scenes) out.set(s.worldId, [...(out.get(s.worldId) ?? []), s])
    return out
  }, [scenes])
  const worldNames = React.useMemo(() => new Map(worlds.map((w) => [w.id, w.name])), [worlds])
  const sceneNames = React.useMemo(() => new Map(scenes.map((s) => [s.id, s.name])), [scenes])
  const openWorlds = new Set((tablesQ.data ?? []).filter((t) => t.status === "active" && t.worldId).map((t) => t.worldId!))
  // Worlds whose scenes were edited last come first.
  const lastEdit = (id: string, fallback: string) => {
    const latest = scenesByWorld.get(id)?.[0]?.updatedAt
    return latest && latest > fallback ? latest : fallback
  }
  const sorted = [...worlds].sort((a, b) => lastEdit(b.id, b.updatedAt).localeCompare(lastEdit(a.id, a.updatedAt)))

  // ---- the sample, in a world of its own ------------------------------------------------------------------

  const openSample = async () => {
    if (sampleBusy) return
    setSampleBusy(true)
    let world: WorldSummary | null = null
    try {
      world = await services.worlds.create("The Crooked Lantern")
      const { summary } = await createFromSample(services, SAMPLE_ID, world.id)
      const created = world
      toast.success(`Created the world “${created.name}”`, { action: { label: "Open world", onClick: () => navigate(paths.world(created.id)) } })
      navigate(paths.scene(summary.id, { mode: "edit" }))
    } catch (err) {
      // No empty world left behind (best effort).
      if (world) await services.worlds.remove(world.id).catch(() => undefined)
      toast.error("Couldn't set up the sample", { description: userMessage(err) })
      setSampleBusy(false)
      reloadWorlds()
    }
  }

  // ---- quick join ------------------------------------------------------------------------------

  const join = async () => {
    if (joinCode.length !== 8 || joining) return
    const name = services.identity.displayName
    if (!name) {
      navigate(paths.join(formatRoomCode(joinCode)))
      return
    }
    setJoining(true)
    try {
      const joined = await services.worlds.join(joinCode, name)
      navigate(joined.sessionId ? paths.play(joined.sessionId) : paths.worldPlay(joined.worldId))
    } catch (err) {
      const f = describeJoinError(err, services.mode)
      if (f.isDm) {
        const mine = worlds.find((w) => w.roomCode === joinCode)
        toast.info(f.title, { description: f.description, action: mine ? { label: "Open it", onClick: () => navigate(paths.world(mine.id)) } : undefined })
      } else {
        toast.error(f.title, { description: f.description })
      }
      setJoining(false)
    }
  }

  const onJoinCodeChange = (code: string, info: { rejected: string[] }) => {
    setJoinCode(code)
    const bad = info.rejected.filter((c) => /\S/u.test(c))
    setJoinHint(bad.length > 0 ? `“${bad[0]}” never appears in room codes — they use digits and letters except I, L, O and U.` : null)
  }

  const warmEditor = () => preloadRoute("host")

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <AppHeader />
      <main className="flex-1">
        <HomeHero
          onNewWorld={() => setNewWorld(true)}
          onSampleWorld={() => void openSample()}
          sampleBusy={sampleBusy}
          onIntent={warmEditor}
          joinCode={joinCode}
          onJoinCodeChange={onJoinCodeChange}
          onJoin={() => void join()}
          joining={joining}
          joinHint={joinHint}
        />

        <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:py-10">
          {services.mode === "local" && <LocalModeNotice />}
          {services.mode === "supabase" && services.identity.isAnonymous && worlds.length > 0 && <GuestAccountNotice />}

          {/* Narrow: worlds, then tables. Wide: worlds beside a sticky tables column. */}
          <div className="grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_22rem] xl:gap-x-8">
            <section aria-labelledby="my-worlds" className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <h2 id="my-worlds" className="flex items-center gap-2 font-heading text-lg font-semibold tracking-tight">
                    Your worlds
                    {worlds.length > 0 && <span className="text-sm font-normal text-muted-foreground tabular-nums">{worlds.length}</span>}
                    {worldsQ.refreshing && <Spinner className="size-3.5 text-muted-foreground" />}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    One per campaign: its scenes, characters and players.{" "}
                    {services.mode === "local"
                      ? "Stored in this browser."
                      : services.identity.isAnonymous
                        ? "Saved to your guest account in this browser."
                        : "Saved to your Atlas account."}
                  </p>
                </div>
                {worlds.length > 0 && (
                  <Button onClick={() => setNewWorld(true)} className="max-sm:w-full">
                    <PlusIcon data-icon="inline-start" />
                    New world
                  </Button>
                )}
              </div>

              {(worldsQ.error !== undefined && !worldsQ.data) || (scenesQ.error !== undefined && !scenesQ.data) ? (
                <Alert variant="destructive">
                  <AlertTitle>Couldn't load your worlds</AlertTitle>
                  <AlertDescription>{userMessage(worldsQ.error ?? scenesQ.error)}</AlertDescription>
                  <AlertAction>
                    <Button size="xs" variant="outline" onClick={reloadAll}>
                      Retry
                    </Button>
                  </AlertAction>
                </Alert>
              ) : !worldsQ.data || !scenesQ.data ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {[0, 1, 2].map((i) => (
                    <WorldCardSkeleton key={i} />
                  ))}
                </div>
              ) : worlds.length === 0 ? (
                <Empty className="border bg-card/30 py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <GlobeIcon />
                    </EmptyMedia>
                    <EmptyTitle>No worlds yet</EmptyTitle>
                    <EmptyDescription>
                      A world is one campaign — say, Tyranny of Dragons for one group and Storm King's Thunder for another. Create one, or explore the sample.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent className="flex-row justify-center">
                    <Button onClick={() => setNewWorld(true)}>
                      <PlusIcon data-icon="inline-start" />
                      New world
                    </Button>
                    <Button variant="outline" onClick={() => void openSample()} onPointerEnter={warmEditor} disabled={sampleBusy}>
                      {sampleBusy && <Spinner className="size-3.5" data-icon="inline-start" />}
                      Try the sample
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {sorted.map((world) => (
                    <WorldCard key={world.id} world={world} scenes={scenesByWorld.get(world.id) ?? []} tableOpen={openWorlds.has(world.id)} />
                  ))}
                </div>
              )}
            </section>

            <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-20 xl:self-start">
              <SessionsPanel
                tables={tablesQ.data}
                tablesError={tablesQ.error !== undefined && !tablesQ.data ? tablesQ.error : undefined}
                onRetryTables={reloadTables}
                worldNames={worldNames}
                sceneNames={sceneNames}
              />
            </aside>
          </div>
        </div>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-[0.7rem] text-muted-foreground sm:px-6">
          <span>Atlas VTT · DM-authoritative play: players only ever receive what their tokens can see.</span>
        </div>
      </footer>

      <WorldNameDialog open={newWorld} world={null} onClose={() => setNewWorld(false)} onDone={(w) => navigate(paths.world(w.id))} />
    </div>
  )
}

function LocalModeNotice() {
  const { cloudAvailable } = currentMode()
  return (
    <Alert>
      <HardDriveIcon />
      <AlertTitle>Local mode</AlertTitle>
      <AlertDescription>
        Worlds and scenes are stored in this browser and games only work between its tabs — each tab is a separate user. Use it for testing; it is not secure.
      </AlertDescription>
      {cloudAvailable && (
        <AlertAction>
          <Button size="xs" variant="outline" onClick={() => window.location.assign(modeSwitchUrl("supabase", window.location.origin + "/"))}>
            Switch to Cloud
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}

const GUEST_NOTICE_KEY = "atlas-vtt:guest-notice-dismissed"

/** Cloud guests with worlds: nudge towards a permanent account (dismissible per browser). */
function GuestAccountNotice() {
  const [dismissed, setDismissed] = React.useState(() => {
    try {
      return localStorage.getItem(GUEST_NOTICE_KEY) === "1"
    } catch {
      return false
    }
  })
  if (dismissed) return null

  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(GUEST_NOTICE_KEY, "1")
    } catch {
      // Storage blocked: hidden for this page only.
    }
  }

  return (
    <Alert className="border-primary/30 bg-primary/8 *:[svg]:text-primary">
      <UserRoundIcon />
      <AlertTitle>Keep your worlds</AlertTitle>
      <AlertDescription>
        You're a guest: your worlds and scenes live in this browser only. Create an account to keep them and open them anywhere.
      </AlertDescription>
      {/* In the flow rather than an AlertAction: the provider buttons don't fit beside the title on phones. */}
      <div className="col-start-2 mt-1.5 flex flex-wrap items-center gap-1">
        <SignInButtons orientation="horizontal" size="xs" className="flex-wrap" />
        <Button size="xs" variant="ghost" onClick={dismiss}>
          Not now
        </Button>
      </div>
    </Alert>
  )
}
