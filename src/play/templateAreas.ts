/**
 * Areas of effect as a play page shows them (ARCHITECTURE §6.6): the templates of the game (the host's
 * state for the DM, the view for a player) plus the one being placed, each with what it reaches in the
 * scene this page has (core/area computeAreaEffect, tested against the page's occlusion world), and the
 * engine overlays that draw them.
 *
 * Framework-free and memoised: covered cells are recomputed only when a template's area or the
 * geometry changes (world version, levels, objects), affected tokens also when tokens move; overlays
 * keep their identity while unchanged (the renderer rebuilds only templates whose overlay changed).
 */
import {
  areaOutline,
  computeAreaEffect,
  describeArea,
  type AreaGeometry,
} from "@/core/area"
import type { OcclusionWorld } from "@/core/occlusion/types"
import type { Id, SceneLike } from "@/core/scene/types"
import { DM_NAME } from "@/core/session/table"
import { templateArea } from "@/core/session/templates"
import type {
  AreaTemplateInput,
  GameState,
  PlayerView,
} from "@/core/session/types"
import type { TemplateOverlay } from "@/render/contracts"

import type { TemplateDraft, TemplateSpec } from "./templateTool"

/** Id of the template being placed (a new one). */
export const DRAFT_ID = "__draft"

/** A template as a page lists it (whoever placed it). */
export interface TemplateItem {
  id: Id
  /** Its stored / sent area (a carried one stands where its token is). */
  source: AreaGeometry & { tokenId: Id | null }
  color: string
  label: string
  /** Who placed it ("DM" for the DM). */
  name: string
  /** Placed by this viewer (the DM: by the DM). */
  mine: boolean
  dm: boolean
  /** Kept from players (the DM's view only). */
  hidden: boolean
  /** This viewer may move and remove it (their own; the DM: any). */
  canEdit: boolean
}

/** A template with what it reaches now. */
export interface TemplateView extends TemplateItem {
  /** Its area now (carried ones around their token). */
  geometry: AreaGeometry
  /** Covered cells per level. */
  cells: Readonly<Record<Id, readonly number[]>>
  /** Affected tokens (of those this page has), sorted. */
  tokenIds: readonly Id[]
  /** Being placed (the draft, or a template being moved). */
  draft: boolean
}

/** A player's templates, from their view. */
export function playerTemplateItems(view: PlayerView | null): TemplateItem[] {
  if (!view?.templates) return []
  return Object.values(view.templates)
    .map((t) => ({
      id: t.id,
      source: t,
      color: t.color,
      label: t.label,
      name: t.name,
      mine: t.mine,
      dm: t.dm,
      hidden: false,
      canEdit: t.mine,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The DM's templates, from the host state (placement order). */
export function hostTemplateItems(
  state: Pick<GameState, "templates" | "players">
): TemplateItem[] {
  return (state.templates ?? []).map((t) => ({
    id: t.id,
    source: t,
    color: t.color,
    label: t.label,
    name:
      t.owner === null
        ? DM_NAME
        : Object.hasOwn(state.players, t.owner)
          ? state.players[t.owner].displayName
          : "",
    mine: t.owner === null,
    dm: t.owner === null,
    hidden: t.hidden,
    canEdit: true,
  }))
}

/** What a template sends to the host (the request's or command's input). */
export function templateInput(
  draft: TemplateDraft,
  spec: Pick<TemplateSpec, "label" | "color">
): AreaTemplateInput {
  return {
    ...draft.geometry,
    label: spec.label,
    color: spec.color,
    tokenId: draft.tokenId,
  }
}

/** What places `item` again as it is (e.g. to change only whether players see it). */
export function inputOf(item: TemplateItem): AreaTemplateInput {
  const s = item.source
  return {
    shape: s.shape,
    levelId: s.levelId,
    x: s.x,
    z: s.z,
    elevation: s.elevation,
    angle: s.angle,
    size: s.size,
    width: s.width,
    height: s.height,
    label: item.label,
    color: item.color,
    tokenId: s.tokenId,
  }
}

/** The spec that places a template like `item` (to move it). */
export function specOf(item: TemplateItem): TemplateSpec {
  const s = item.source
  return {
    shape: s.shape,
    size: s.size,
    width: s.width,
    height: s.height,
    color: item.color,
    label: item.label,
    elevation: s.elevation,
    aura: s.tokenId !== null,
  }
}

/** The title of a template: its label, or its shape ("20 ft sphere"). */
export function templateTitle(
  item: Pick<TemplateItem, "label" | "source">
): string {
  return item.label || describeArea(item.source)
}

const geometryKey = (g: AreaGeometry): string =>
  `${g.shape}|${g.levelId}|${g.x}|${g.z}|${g.elevation}|${g.angle}|${g.size}|${g.width}|${g.height}`

interface CellEntry {
  key: string
  world: OcclusionWorld
  version: number
  levels: unknown
  objects: unknown
  cells: Record<Id, number[]>
}

interface TokenEntry extends Omit<CellEntry, "cells"> {
  tokens: unknown
  tokenIds: Id[]
}

export class TemplateAreas {
  private cells = new Map<Id, CellEntry>()
  private tokens = new Map<Id, TokenEntry>()
  private overlays = new Map<
    Id,
    { deps: unknown[]; overlay: TemplateOverlay }
  >()

  /**
   * The templates with what they reach in `scene` (tested in `world`, its occlusion world). `draft`:
   * the template being placed; when it moves an existing one (`editing`), it replaces it.
   */
  compute(
    scene: SceneLike,
    world: OcclusionWorld,
    items: readonly TemplateItem[],
    draft: { draft: TemplateDraft; spec: TemplateSpec } | null
  ): TemplateView[] {
    const cs = scene.grid.cellSize
    const editing = draft?.draft.editing ?? null
    const list: { item: TemplateItem; draft: boolean }[] = items
      .filter((i) => i.id !== editing)
      .map((item) => ({ item, draft: false }))
    if (draft) {
      const base = editing ? items.find((i) => i.id === editing) : undefined
      const d = draft.draft
      list.push({
        item: {
          id: editing ?? DRAFT_ID,
          source: { ...d.geometry, tokenId: d.tokenId },
          color: draft.spec.color,
          label: draft.spec.label,
          name: base?.name ?? "",
          mine: true,
          dm: base?.dm ?? false,
          hidden: base?.hidden ?? false,
          canEdit: true,
        },
        draft: true,
      })
    }
    const out: TemplateView[] = []
    const seen = new Set<Id>()
    for (const { item, draft: isDraft } of list) {
      seen.add(item.id)
      const geometry = templateArea(item.source, scene.tokens, cs)
      const key = geometryKey(geometry)
      let c = this.cells.get(item.id)
      if (
        !c ||
        c.key !== key ||
        c.world !== world ||
        c.version !== world.version ||
        c.levels !== scene.levels ||
        c.objects !== scene.objects
      ) {
        const r = computeAreaEffect(scene, world, geometry, { tokens: [] })
        c = {
          key,
          world,
          version: world.version,
          levels: scene.levels,
          objects: scene.objects,
          cells: r.cells,
        }
        this.cells.set(item.id, c)
      }
      let t = this.tokens.get(item.id)
      if (
        !t ||
        t.key !== key ||
        t.world !== world ||
        t.version !== world.version ||
        t.levels !== scene.levels ||
        t.objects !== scene.objects ||
        t.tokens !== scene.tokens
      ) {
        const r = computeAreaEffect(scene, world, geometry, { noCells: true })
        t = {
          key,
          world,
          version: world.version,
          levels: scene.levels,
          objects: scene.objects,
          tokens: scene.tokens,
          tokenIds: r.tokenIds,
        }
        this.tokens.set(item.id, t)
      }
      out.push({
        ...item,
        geometry,
        cells: c.cells,
        tokenIds: t.tokenIds,
        draft: isDraft,
      })
    }
    for (const id of [...this.cells.keys()])
      if (!seen.has(id)) this.cells.delete(id)
    for (const id of [...this.tokens.keys()])
      if (!seen.has(id)) this.tokens.delete(id)
    return out
  }

  /** Engine overlays of computed templates (the same object while a template's drawing is unchanged). */
  overlaysOf(
    views: readonly TemplateView[],
    selectedId: Id | null
  ): TemplateOverlay[] {
    const seen = new Set<Id>()
    const out = views.map((v) => {
      seen.add(v.id)
      const state: TemplateOverlay["state"] = v.draft
        ? "draft"
        : v.id === selectedId
          ? "selected"
          : "normal"
      const deps = [geometryKey(v.geometry), v.cells, v.color, state]
      const hit = this.overlays.get(v.id)
      if (hit && hit.deps.every((d, k) => d === deps[k])) return hit.overlay
      const overlay: TemplateOverlay = {
        id: v.id,
        levelId: v.geometry.levelId,
        outline: areaOutline(v.geometry),
        origin: { x: v.geometry.x, z: v.geometry.z },
        color: v.color,
        cells: v.cells,
        state,
      }
      this.overlays.set(v.id, { deps, overlay })
      return overlay
    })
    for (const id of [...this.overlays.keys()])
      if (!seen.has(id)) this.overlays.delete(id)
    return out
  }
}
