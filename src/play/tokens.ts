/**
 * Token helpers for the play HUDs: display names, senses summaries, selection defaults and Tab
 * cycling over the tokens a user controls.
 */
import type { Id, SceneLike, Token, VisionSettings } from "@/core/scene/types"

/** Name shown for a token (label for other players' tokens, name when known). */
export function tokenDisplayName(t: Pick<Token, "name" | "label">): string {
  const n = t.name?.trim() || t.label?.trim()
  return n || "Unnamed"
}

/** Initials for avatar fallbacks ("Mira Stonefist" → "MS"). */
export function tokenInitials(t: Pick<Token, "name" | "label">): string {
  const words = tokenDisplayName(t).split(/\s+/u).filter(Boolean)
  const letters =
    words.length > 1
      ? [words[0], words[words.length - 1]].map((w) => [...w][0])
      : [...(words[0] ?? "?")].slice(0, 2)
  return letters.join("").toUpperCase()
}

export interface SenseLine {
  kind: "normal" | "darkvision" | "blindsight" | "blind"
  label: string
}

/** Senses as short lines ("Darkvision 60 ft", "Blindsight 10 ft", "Blind", or "Normal vision"). */
export function describeSenses(v: VisionSettings | undefined): SenseLine[] {
  if (!v) return [{ kind: "normal", label: "Normal vision" }]
  const out: SenseLine[] = []
  if (v.blind) out.push({ kind: "blind", label: "Blind" })
  else if (v.darkvision > 0)
    out.push({
      kind: "darkvision",
      label: `Darkvision ${Math.round(v.darkvision)} ft`,
    })
  if (v.blindsight > 0)
    out.push({
      kind: "blindsight",
      label: `Blindsight ${Math.round(v.blindsight)} ft`,
    })
  if (out.length === 0) out.push({ kind: "normal", label: "Normal vision" })
  return out
}

/** Controlled tokens that exist in the scene, in the given order. */
export function presentTokens(
  scene: Pick<SceneLike, "tokens"> | null,
  ids: readonly Id[]
): Token[] {
  if (!scene) return []
  const out: Token[] = []
  for (const id of ids)
    if (Object.hasOwn(scene.tokens, id)) out.push(scene.tokens[id])
  return out
}

/** Keep the current selection when still valid, else the first available token (or null). */
export function resolveSelection(
  current: Id | null,
  available: readonly Id[]
): Id | null {
  if (current && available.includes(current)) return current
  return available[0] ?? null
}

/** Next (or previous) token for Tab / Shift+Tab cycling. */
export function cycleToken(
  current: Id | null,
  available: readonly Id[],
  dir: 1 | -1 = 1
): Id | null {
  if (available.length === 0) return null
  const k = current ? available.indexOf(current) : -1
  if (k < 0) return dir === 1 ? available[0] : available[available.length - 1]
  return available[(k + dir + available.length) % available.length]
}

/** Human readable token kind. */
export const TOKEN_KIND_LABELS: Record<Token["kind"], string> = {
  pc: "Player character",
  npc: "NPC",
  monster: "Monster",
}
