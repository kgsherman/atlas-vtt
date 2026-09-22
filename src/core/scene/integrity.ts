/**
 * Referential integrity for the scene document. STUB bodies — implemented by the core-scene module
 * (docs/ARCHITECTURE.md §7). All mutators operate on an immer draft (or a plain mutable Scene).
 */
import type { Id, Scene, SceneObject, Token, Vec2, WallObject } from "./types"

export interface AtlasClipboard {
  kind: "atlas-clipboard"
  schemaVersion: number
  /** Level the selection was copied from (pasted objects are remapped to the target level). */
  sourceLevelId: Id
  /** Anchor point (centre of the selection bounds) used to place the paste at the pointer. */
  origin: Vec2
  objects: SceneObject[]
  tokens: Token[]
}

/** Delete ids and everything that depends on them (wall → openings; level → its objects, tokens, connectors; token → detach its lights). */
export function deleteWithDependents(_draft: Scene, _ids: Id[]): void {
  throw new Error("deleteWithDependents: not implemented")
}

export function copySelection(_scene: Scene, _ids: Id[]): AtlasClipboard {
  throw new Error("copySelection: not implemented")
}

/** Paste with fresh ids at `at` on `targetLevelId`. Returns the new ids (objects and tokens). */
export function pasteClipboard(_draft: Scene, _clip: AtlasClipboard, _opts: { targetLevelId: Id; at: Vec2 }): Id[] {
  throw new Error("pasteClipboard: not implemented")
}

/** Keep a wall's openings valid after its geometry changed (flip → mirror offsets; shorten → drop non-fitting). */
export function reprojectOpenings(_draft: Scene, _wallId: Id, _before: Pick<WallObject, "a" | "b">): void {
  throw new Error("reprojectOpenings: not implemented")
}

/** Human-readable reference problems (dangling wallId/levelId/toLevelId/attachedTokenId…); empty = valid. */
export function validateReferences(_scene: Scene): string[] {
  throw new Error("validateReferences: not implemented")
}
