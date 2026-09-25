/**
 * Pure helpers of the DM's "Change scene" dialog (ChangeMapDialog): who comes along by default, where
 * the party arrives, which save-or-discard choice the unsaved-edits guard offers, and the words for a
 * map change the host refused. No React, no DOM.
 */
import { SCENE_LIMITS } from "@/core/scene/schema"
import type { GridSettings, Id, Scene, Token, Vec2 } from "@/core/scene/types"
import type { Arrival } from "@/core/session/changeMap"
import type { GameState, SceneOrigin } from "@/core/session/types"
import type { HostChangeMapResult } from "@/net/host"
import { tokenDisplayName } from "@/play/tokens"

import { playerLabels } from "./playerLabels"
import type { SaveMap } from "./useSaveMap"

/** What the dialog asks the host console to do. */
export interface ChangeMapRequest {
  /** The map to play (library/loadLibraryScene: migrated, never the live one). */
  scene: Scene
  /** Its library row and the version loaded (the game's origin afterwards). */
  origin: SceneOrigin
  /** The library row's name: what players see. */
  name: string
  /** Tokens of the live map that come along. */
  tokenIds: Id[]
  arrival: Arrival
  /** Save the live map to its library scene first ("Save map & change"). */
  save: boolean
}

/**
 * The console's answer: true = the map changed (the dialog closes); false = stay open, the reason was
 * already shown; a string = stay open and show it (e.g. the map wasn't saved to the library first).
 */
export type ChangeMapOutcome = boolean | string

// ---- the party ----------------------------------------------------------------------------------------

export interface PartyRow {
  token: Token
  /** Names of the players who control it (join order, repeats told apart). */
  owners: string[]
  /** Pre-checked: PCs and every token a player controls. */
  party: boolean
}

const KIND_RANK = { pc: 0, npc: 1, monster: 2 } as const

/** Every token of the live map, PCs first then by name (as in the Players tab). */
export function partyRows(
  state: Pick<GameState, "scene" | "owners" | "players">
): PartyRow[] {
  const labels = playerLabels(Object.values(state.players))
  return Object.values(state.scene.tokens)
    .map((token) => {
      const ids = Object.hasOwn(state.owners, token.id)
        ? state.owners[token.id]
        : []
      const owners = ids
        .map((uid) => labels.get(uid))
        .filter((n): n is string => n !== undefined)
      return { token, owners, party: token.kind === "pc" || ids.length > 0 }
    })
    .sort(
      (a, b) =>
        KIND_RANK[a.token.kind] - KIND_RANK[b.token.kind] ||
        tokenDisplayName(a.token).localeCompare(tokenDisplayName(b.token)) ||
        (a.token.id < b.token.id ? -1 : a.token.id > b.token.id ? 1 : 0)
    )
}

/** The tokens checked when the dialog opens. */
export function defaultParty(rows: readonly PartyRow[]): Id[] {
  return rows.filter((r) => r.party).map((r) => r.token.id)
}

// ---- the arrival ----------------------------------------------------------------------------------------

/** A point on the grid (the arrival must be on the map), to a tenth of a foot. */
export function clampToGrid(
  p: Vec2,
  grid: Pick<GridSettings, "width" | "depth" | "cellSize">
): Vec2 {
  const w = grid.width * grid.cellSize
  const d = grid.depth * grid.cellSize
  const r = (v: number) => Math.round(v * 10) / 10
  const x = Number.isFinite(p.x) ? p.x : w / 2
  const z = Number.isFinite(p.z) ? p.z : d / 2
  return {
    x: r(Math.min(w, Math.max(0, x))),
    z: r(Math.min(d, Math.max(0, z))),
  }
}

/**
 * The default arrival point on a level: the middle of what its thumbnail frames (sceneDigest
 * LevelDigest.bounds: the map image, else the built part), so a tavern in a big yard is entered at
 * the tavern, not in the middle of the lawn. core/movement arrivalAnchors takes the nearest standable
 * squares from there.
 */
export function frameCentre(
  bounds: readonly [number, number, number, number],
  grid: Pick<GridSettings, "width" | "depth" | "cellSize">
): Vec2 {
  const [x, z, w, d] = bounds
  return clampToGrid({ x: x + w / 2, z: z + d / 2 }, grid)
}

// ---- the restore point of the map being left ---------------------------------------------------------

/**
 * What happens to the map the table leaves (ARCHITECTURE §6.8: the table releases it, so what changed on
 * it since its last restore point must reach the library first). Read when the DM confirms: the map may
 * change or be saved while the dialog is open.
 * - clean: nothing to save; "Change scene".
 * - offer: "Change scene" saves a restore point first.
 * - looking-up: the same, disabled until the library scene is found.
 * - unavailable: the library can't be reached; only "Change without saving" (what changed is lost).
 * - deleted: the scene was deleted; "Change scene" (nothing to save it to).
 */
export type SaveChoice =
  | { kind: "clean" }
  | { kind: "offer"; name: string }
  | { kind: "looking-up" }
  | { kind: "unavailable"; error: string }
  | { kind: "deleted" }

export function saveChoice(
  saveMap: Pick<SaveMap, "library" | "dirty">
): SaveChoice {
  if (!saveMap.dirty) return { kind: "clean" }
  const lib = saveMap.library
  switch (lib.status) {
    case "linked":
      return { kind: "offer", name: lib.name }
    case "loading":
      return { kind: "looking-up" }
    case "unavailable":
      return { kind: "unavailable", error: lib.error }
    case "deleted":
      return { kind: "deleted" }
  }
}

/** The guard's explanation (null when there is nothing to say). */
export function saveChoiceText(choice: SaveChoice): string | null {
  switch (choice.kind) {
    case "clean":
      return null
    case "offer":
      return `“${choice.name}” keeps a restore point of how it is now.`
    case "looking-up":
      return "Looking up this scene to keep a restore point of it…"
    case "unavailable":
      return `Your scenes can't be reached (${choice.error}), so this scene can't keep a restore point: what changed on it since the last one is lost if you change now.`
    case "deleted":
      return "This scene has been deleted: what changed on it is lost when the table moves."
  }
}

// ---- refusals --------------------------------------------------------------------------------------------

export type ChangeMapError = Extract<
  HostChangeMapResult,
  { ok: false }
>["error"]

/** "Mira", "Mira and Theron", "Mira, Theron and Bree", "Mira, Theron, Bree and 2 more". */
export function nameList(names: readonly string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? ""
  if (names.length <= max)
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`
}

/** Why the host refused the change; `unplaced`: names of the tokens left without room ("no-room"). */
export function changeMapErrorText(
  error: ChangeMapError,
  unplaced: readonly string[] = []
): string {
  switch (error) {
    case "no-room":
      return unplaced.length > 0
        ? `There's no room on that level for ${nameList(unplaced)}. Pick another level or arrival point, or leave ${unplaced.length === 1 ? "that token" : "them"} behind.`
        : "There's no room on that level for the party. Pick another level or arrival point, or bring fewer tokens."
    case "unknown-level":
      return "The arrival level isn't on the new scene. Pick the level again."
    case "too-many":
      return `The new scene can't hold that many tokens (at most ${SCENE_LIMITS.maxTokens.toLocaleString("en-US")} tokens and ${SCENE_LIMITS.maxObjects.toLocaleString("en-US")} objects). Bring fewer tokens.`
    case "same-map":
      return "That's the scene you're playing. Pick another one."
    case "not-hosting":
      return "This tab isn't hosting the table any more."
    case "map-in-use":
      return "That scene's table is open. Close it first, or duplicate the scene and bring the party to the copy."
  }
}
