import * as React from "react"
import { ArrowRightIcon, EyeIcon, GlobeIcon, LayersIcon, SparklesIcon, SunIcon, UsersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

import { IsoLevels } from "./IsoLevels"
import { RoomCodeInput } from "./RoomCodeInput"

export interface HomeHeroProps {
  onNewWorld(): void
  /** A world holding a copy of the Crooked Lantern, opened in Edit. */
  onSampleWorld(): void
  sampleBusy: boolean
  onIntent(): void
  joinCode: string
  onJoinCodeChange(code: string, info: { rejected: string[] }): void
  onJoin(): void
  joining: boolean
  joinHint: string | null
}

export function HomeHero(props: HomeHeroProps) {
  return (
    <section className="relative isolate overflow-hidden border-b border-border/60">
      {/* Ambient glow + fading grid */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 h-[28rem] w-[56rem] -translate-x-1/2 rounded-full bg-primary/12 blur-3xl" />
        <div className="absolute inset-0 atlas-grid-backdrop opacity-60" />
      </div>
      <div className="mx-auto grid w-full max-w-7xl items-center gap-10 px-4 pt-10 pb-10 sm:px-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:pt-14 lg:pb-14">
        <div className="flex flex-col gap-7">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="gap-1 bg-background/60 backdrop-blur-sm">
                <LayersIcon data-icon="inline-start" />
                Multi-level
              </Badge>
              <Badge variant="outline" className="gap-1 bg-background/60 backdrop-blur-sm">
                <SunIcon data-icon="inline-start" />
                Dynamic light & shadow
              </Badge>
              <Badge variant="outline" className="gap-1 bg-background/60 backdrop-blur-sm">
                <EyeIcon data-icon="inline-start" />
                Fog of war
              </Badge>
            </div>
            <h1 className="font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Multi-level 3D scenes.
              <br />
              <span className="bg-linear-to-r from-sidebar-primary via-foreground/90 to-foreground bg-clip-text text-transparent">True line of sight.</span>
            </h1>
            <p className="max-w-xl text-sm/relaxed text-pretty text-muted-foreground sm:text-base/relaxed">
              Build every storey of your dungeon in 3D, then let your players explore it top-down — with light, shadows and fog of war computed from the real
              geometry. Each player sees only what their tokens can see.
            </p>
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="grid gap-2.5 sm:grid-cols-2">
              <ActionTile
                primary
                icon={<GlobeIcon />}
                title="New world"
                description="A campaign: its scenes, characters and players"
                onClick={props.onNewWorld}
              />
              <ActionTile
                icon={props.sampleBusy ? <Spinner /> : <SparklesIcon />}
                title="Try the sample"
                description="The Crooked Lantern, in a world of its own"
                onClick={props.onSampleWorld}
                onIntent={props.onIntent}
              />
            </div>
            <QuickJoin {...props} />
          </div>
        </div>

        <div className="relative hidden lg:block">
          <div aria-hidden className="absolute inset-8 -z-10 rounded-full bg-primary/10 blur-3xl" />
          <IsoLevels className="mx-auto max-h-[32rem] w-full" />
          <p className="mt-1 text-center text-[0.7rem] text-muted-foreground">The Crooked Lantern — four storeys, one of the sample scenes.</p>
        </div>
      </div>
    </section>
  )
}

function ActionTile({
  icon,
  title,
  description,
  onClick,
  onIntent,
  primary,
}: {
  icon: React.ReactNode
  title: string
  description: string
  onClick(): void
  onIntent?(): void
  primary?: boolean
}) {
  return (
    <Item
      variant="outline"
      render={<button type="button" onClick={onClick} onPointerEnter={onIntent} onFocus={onIntent} />}
      className={cn(
        "relative cursor-pointer bg-card/70 text-left backdrop-blur-sm transition-[transform,box-shadow,background-color,border-color] duration-200 hover:-translate-y-0.5 hover:bg-card hover:shadow-lg active:translate-y-0 sm:flex-col sm:items-start sm:gap-3 sm:p-3.5",
        primary ? "border-primary/40 hover:border-primary/70" : "hover:border-foreground/20"
      )}
    >
      <ItemMedia
        className={cn(
          "size-9 rounded-lg ring-1 [&_svg]:size-4",
          primary ? "bg-primary text-primary-foreground ring-primary/40" : "bg-muted text-foreground ring-foreground/10"
        )}
      >
        {icon}
      </ItemMedia>
      <ItemContent className="gap-0.5">
        <ItemTitle className="text-sm">{title}</ItemTitle>
        <ItemDescription>{description}</ItemDescription>
      </ItemContent>
    </Item>
  )
}

function QuickJoin({ joinCode, onJoinCodeChange, onJoin, joining, joinHint }: HomeHeroProps) {
  const complete = joinCode.length === 8
  return (
    <Item variant="outline" className="flex-col items-stretch gap-3 bg-card/70 backdrop-blur-sm sm:p-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5">
          <ItemMedia className="size-9 rounded-lg bg-muted text-foreground ring-1 ring-foreground/10 [&_svg]:size-4">
            <UsersIcon />
          </ItemMedia>
          <ItemContent className="gap-0.5">
            <ItemTitle className="text-sm">Join a game</ItemTitle>
            <ItemDescription className="whitespace-nowrap">Room code from your DM</ItemDescription>
          </ItemContent>
        </div>
        <form
          className="flex flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            onJoin()
          }}
        >
          <RoomCodeInput value={joinCode} onChange={onJoinCodeChange} className="h-8 flex-1" />
          <Button type="submit" size="lg" disabled={!complete || joining} className="px-3">
            Join
            {joining ? <Spinner className="size-3.5" data-icon="inline-end" /> : <ArrowRightIcon data-icon="inline-end" />}
          </Button>
        </form>
      </div>
      {joinHint && <p className="text-[0.7rem] text-muted-foreground">{joinHint}</p>}
    </Item>
  )
}
