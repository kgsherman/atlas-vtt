import * as React from "react"
import { Flame, Lightbulb, LightbulbOff, Link2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Switch } from "@/components/ui/switch"
import { lightLevelId, lightWorldPosition } from "@/core/scene/queries"
import type { Id, LightObject } from "@/core/scene/types"
import { cn } from "@/lib/utils"

import { useEditorContext, useEditorEngine, useEditorState } from "../context"
import { PanelSection } from "../fields"
import { formatFeet, itemLabel, tokenLabel } from "../lib/format"
import { levelsTopDown } from "../lib/levelOps"
import { Swatch } from "../pickers"

function LightRow({ light, selected }: { light: LightObject; selected: boolean }) {
  const { store } = useEditorContext()
  const engine = useEditorEngine()
  const readOnly = useEditorState((s) => s.readOnly)
  const label = useEditorState((s) => itemLabel(s.scene, light.id))
  const carrier = useEditorState((s) => (light.attachedTokenId && Object.hasOwn(s.scene.tokens, light.attachedTokenId) ? tokenLabel(s.scene.tokens[light.attachedTokenId]) : null))

  const select = () => {
    const s = store.getState()
    const levelId = lightLevelId(s.scene, light)
    s.setActiveLevel(levelId)
    s.setTool("select")
    s.select([light.id])
    if (engine) engine.focus(lightWorldPosition(s.scene, light), { distance: Math.max(40, light.dimRadius * 1.6) })
  }

  return (
    <div
      className={cn(
        "group flex h-9 cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 text-xs transition-colors hover:bg-muted/60",
        selected && "border-primary/30 bg-primary/10"
      )}
      onClick={select}
    >
      <span className="relative grid size-5 shrink-0 place-items-center">
        <Swatch color={light.color} className={cn("size-3.5 rounded-full", !light.on && "opacity-30")} />
        {light.on ? <span className="absolute inset-0 rounded-full opacity-40 blur-[6px]" style={{ backgroundColor: light.color }} /> : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className={cn("truncate", light.on ? "text-foreground/90" : "text-muted-foreground")}>{label}</span>
        <span className="flex items-center gap-1 truncate text-[0.625rem] text-muted-foreground">
          {carrier ? (
            <>
              <Link2 className="size-2.5" /> {carrier}
            </>
          ) : (
            <>
              {formatFeet(light.brightRadius, 0)} / {formatFeet(light.dimRadius, 0)}
            </>
          )}
          {light.flicker.enabled ? <Flame className="size-2.5" /> : null}
          {light.hidden ? " · hidden" : null}
        </span>
      </div>
      <Switch
        size="sm"
        checked={light.on}
        disabled={readOnly}
        aria-label={light.on ? "Turn off" : "Turn on"}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={(on) => store.getState().setLightOn(light.id, on)}
      />
    </div>
  )
}

export function LightsPanel() {
  const { store } = useEditorContext()
  const objects = useEditorState((s) => s.scene.objects)
  const tokens = useEditorState((s) => s.scene.tokens)
  const levels = useEditorState((s) => s.scene.levels)
  const selection = useEditorState((s) => s.selection)
  const readOnly = useEditorState((s) => s.readOnly)

  const groups = React.useMemo(() => {
    const byLevel = new Map<Id, LightObject[]>()
    for (const o of Object.values(objects)) {
      if (o.type !== "light") continue
      const levelId = lightLevelId({ tokens }, o)
      let list = byLevel.get(levelId)
      if (!list) byLevel.set(levelId, (list = []))
      list.push(o)
    }
    return levelsTopDown({ levels })
      .map((l) => ({ level: l, lights: (byLevel.get(l.id) ?? []).sort((a, b) => (a.name ?? a.preset).localeCompare(b.name ?? b.preset) || a.id.localeCompare(b.id)) }))
      .filter((g) => g.lights.length > 0)
  }, [objects, tokens, levels])

  const all = groups.flatMap((g) => g.lights)
  const setAll = (on: boolean) => {
    const targets = all.filter((l) => l.on !== on)
    if (targets.length === 0) return
    store.getState().apply(
      (d) => {
        for (const l of targets) {
          const o = d.objects[l.id]
          if (o && o.type === "light") o.on = on
        }
      },
      on ? `Turn ${targets.length} lights on` : `Turn ${targets.length} lights off`
    )
  }

  if (all.length === 0) {
    return (
      <Empty className="mt-6 gap-3 p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Lightbulb />
          </EmptyMedia>
          <EmptyTitle>No lights yet</EmptyTitle>
          <EmptyDescription>Pick the Light tool (L) and click the ground, a wall or a token to place torches, lanterns and braziers.</EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" disabled={readOnly} onClick={() => store.getState().setTool("light")}>
          <Flame data-icon="inline-start" /> Light tool
        </Button>
      </Empty>
    )
  }

  const onCount = all.filter((l) => l.on).length
  return (
    <div className="flex flex-col">
      <PanelSection
        title={`${onCount} of ${all.length} on`}
        action={
          <>
            <Button variant="ghost" size="xs" disabled={readOnly || onCount === all.length} onClick={() => setAll(true)}>
              <Lightbulb data-icon="inline-start" /> All on
            </Button>
            <Button variant="ghost" size="xs" disabled={readOnly || onCount === 0} onClick={() => setAll(false)}>
              <LightbulbOff data-icon="inline-start" /> All off
            </Button>
          </>
        }
      >
        <span className="-mt-1 text-[0.6875rem] text-muted-foreground">On/off here is each light's initial state for sessions.</span>
      </PanelSection>
      {groups.map((g) => (
        <PanelSection key={g.level.id} title={g.level.name}>
          <div className="flex flex-col gap-0.5">
            {g.lights.map((l) => (
              <LightRow key={l.id} light={l} selected={selection.includes(l.id)} />
            ))}
          </div>
        </PanelSection>
      ))}
    </div>
  )
}
