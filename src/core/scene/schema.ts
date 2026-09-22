/**
 * zod schema + parsing for the scene document. STUB — implemented by the core-scene module (docs/ARCHITECTURE.md §3).
 */
import type { Scene } from "./types"

export type ParseSceneResult =
  | { ok: true; scene: Scene; migratedFrom: number | null }
  | { ok: false; error: "too-new" | "invalid"; issues: string[] }

/** Migrate (if needed), validate strictly, and check references. */
export function parseScene(_json: unknown): ParseSceneResult {
  throw new Error("parseScene: not implemented")
}

export function serializeScene(scene: Scene): string {
  return JSON.stringify(scene)
}
