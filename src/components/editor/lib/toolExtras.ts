/**
 * Tool options the editor's ToolSettings do not carry (door hinge/swing/initial state, token senses,
 * light colour/radii/flicker overrides). The viewport wraps the placing click in one transaction and
 * applies these to the items the tool just created, so a placement stays a single undo step.
 */
import type { Draft } from "immer"
import { createStore, type StoreApi } from "zustand/vanilla"

import { LIGHT_PRESETS } from "@/core/scene/defaults"
import type { DoorObject, DoorState, FlickerSettings, Id, LightPreset, Scene, VisionSettings } from "@/core/scene/types"
import type { ToolId } from "@/editor/tools/types"

export interface LightOverrides {
  /** The preset these values were derived from (overrides apply only to lights of this preset). */
  preset: LightPreset
  color: string
  intensity: number
  brightRadius: number
  dimRadius: number
  flicker: FlickerSettings
  castsShadows: boolean
}

export interface ToolExtras {
  door: { hinge: DoorObject["hinge"]; swing: DoorObject["swing"]; state: DoorState }
  token: { vision: VisionSettings }
  /** null = the preset's own values. */
  light: LightOverrides | null
}

export function defaultToolExtras(): ToolExtras {
  return {
    door: { hinge: "start", swing: 1, state: "closed" },
    token: { vision: { darkvision: 0, blindsight: 0, blind: false } },
    light: null,
  }
}

export function lightOverridesFromPreset(preset: LightPreset): LightOverrides {
  const def = LIGHT_PRESETS[preset]
  return {
    preset,
    color: def.color,
    intensity: def.intensity,
    brightRadius: def.brightRadius,
    dimRadius: def.dimRadius,
    flicker: { ...def.flicker },
    castsShadows: true,
  }
}

/** Effective light values for the tool options UI. */
export function effectiveLightOverrides(extras: ToolExtras, preset: LightPreset): LightOverrides {
  return extras.light && extras.light.preset === preset ? extras.light : lightOverridesFromPreset(preset)
}

/** Whether placing with `tool` needs a post-placement pass. */
export function extrasApply(tool: ToolId, extras: ToolExtras): boolean {
  switch (tool) {
    case "door": {
      const d = defaultToolExtras().door
      return extras.door.hinge !== d.hinge || extras.door.swing !== d.swing || extras.door.state !== d.state
    }
    case "token": {
      const v = extras.token.vision
      return v.darkvision !== 0 || v.blindsight !== 0 || v.blind
    }
    case "light":
      return extras.light !== null
    default:
      return false
  }
}

/** Objects and tokens present in `after` but not in `before`. */
export function newItemIds(before: Pick<Scene, "objects" | "tokens">, after: Pick<Scene, "objects" | "tokens">): { objects: Id[]; tokens: Id[] } {
  if (before === after) return { objects: [], tokens: [] }
  const objects = after.objects === before.objects ? [] : Object.keys(after.objects).filter((id) => !Object.hasOwn(before.objects, id))
  const tokens = after.tokens === before.tokens ? [] : Object.keys(after.tokens).filter((id) => !Object.hasOwn(before.tokens, id))
  return { objects, tokens }
}

/** Recipe body: apply the extras to newly created items. */
export function applyExtras(draft: Draft<Scene>, created: { objects: Id[]; tokens: Id[] }, extras: ToolExtras): void {
  for (const id of created.objects) {
    const o = draft.objects[id]
    if (!o) continue
    if (o.type === "door") {
      o.hinge = extras.door.hinge
      o.swing = extras.door.swing
      o.state = extras.door.state
    } else if (o.type === "light" && extras.light && extras.light.preset === o.preset) {
      const l = extras.light
      o.color = l.color
      o.intensity = l.intensity
      o.brightRadius = l.brightRadius
      o.dimRadius = Math.max(l.dimRadius, l.brightRadius)
      o.flicker = { ...l.flicker }
      o.castsShadows = l.castsShadows
    }
  }
  for (const id of created.tokens) {
    const t = draft.tokens[id]
    if (t) t.vision = { ...extras.token.vision }
  }
}

export type ToolExtrasStore = StoreApi<ToolExtras & { set(partial: Partial<ToolExtras>): void }>

export function createToolExtrasStore(): ToolExtrasStore {
  return createStore<ToolExtras & { set(partial: Partial<ToolExtras>): void }>()((set) => ({
    ...defaultToolExtras(),
    set: (partial) => set(partial),
  }))
}
