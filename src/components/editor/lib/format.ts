/**
 * Display helpers for the editor UI (pure, no DOM).
 */
import { DOOR_STYLES, PROP_LIBRARY } from "@/core/scene/defaults"
import type { Id, LightPreset, Scene, SceneObject, SceneObjectType, Token } from "@/core/scene/types"

/** Round to at most `digits` decimals and drop trailing zeros. */
export function trimNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—"
  const f = 10 ** digits
  const r = Math.round(value * f) / f
  return String(Object.is(r, -0) ? 0 : r)
}

/** "10 ft", "2.5 ft". */
export function formatFeet(value: number, digits = 1): string {
  return `${trimNumber(value, digits)} ft`
}

/** "+10 ft", "−10 ft", "0 ft" (typographic minus). */
export function formatElevation(value: number): string {
  const r = Number(trimNumber(value, 1))
  if (r === 0) return "0 ft"
  return `${r > 0 ? "+" : "−"}${trimNumber(Math.abs(r), 1)} ft`
}

export function degrees(radians: number): number {
  return (radians * 180) / Math.PI
}

export function radians(degreesValue: number): number {
  return (degreesValue * Math.PI) / 180
}

/** Relative time for version lists / autosave ("just now", "5 min ago", "2 h ago", else a date). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const s = Math.round((now - t) / 1000)
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d} d ago`
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

/** Local clock time "14:05". */
export function clockTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

export const OBJECT_TYPE_LABELS: Record<SceneObjectType, string> = {
  floor: "Floor",
  wall: "Wall",
  door: "Door",
  window: "Window",
  connector: "Connector",
  pillar: "Pillar",
  prop: "Prop",
  light: "Light",
}

export const LIGHT_PRESET_LABELS: Record<LightPreset, string> = {
  torch: "Torch",
  lantern: "Lantern",
  brazier: "Brazier",
  candle: "Candle",
  magical: "Magical light",
  custom: "Custom",
}

const CONNECTOR_LABELS = { stairs: "Stairs", ladder: "Ladder", ramp: "Ramp" } as const

/** Default label of an object when it has no DM name. */
export function objectKindLabel(o: SceneObject): string {
  switch (o.type) {
    case "door":
      return DOOR_STYLES[o.style].label
    case "connector":
      return CONNECTOR_LABELS[o.style]
    case "prop":
      return PROP_LIBRARY[o.kind].label
    case "light":
      return LIGHT_PRESET_LABELS[o.preset]
    case "pillar":
      return o.shape === "round" ? "Round pillar" : "Square pillar"
    case "floor":
      return o.mask ? "Traced floor" : "Floor"
    default:
      return OBJECT_TYPE_LABELS[o.type]
  }
}

/** Name shown for an object or token in lists ("Torch", "Goblin 2", the DM name when set). */
export function itemLabel(scene: Pick<Scene, "objects" | "tokens">, id: Id): string {
  if (Object.hasOwn(scene.tokens, id)) return tokenLabel(scene.tokens[id])
  if (!Object.hasOwn(scene.objects, id)) return "Unknown"
  const o = scene.objects[id]
  return o.name?.trim() || objectKindLabel(o)
}

export function tokenLabel(t: Pick<Token, "name" | "label">): string {
  return t.name.trim() || t.label?.trim() || "Token"
}

/** "3 walls, 1 door" style summary for a multi-selection. */
export function selectionSummary(scene: Pick<Scene, "objects" | "tokens">, ids: readonly Id[]): string {
  const counts = new Map<string, number>()
  for (const id of ids) {
    const key = Object.hasOwn(scene.tokens, id) ? "token" : Object.hasOwn(scene.objects, id) ? scene.objects[id].type : null
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const order = ["token", "wall", "door", "window", "floor", "connector", "pillar", "prop", "light"]
  return order
    .filter((k) => counts.has(k))
    .map((k) => {
      const n = counts.get(k) ?? 0
      return `${n} ${k}${n === 1 ? "" : "s"}`
    })
    .join(", ")
}

/** First issue of a refused edit, plus a count of the rest. */
export function describeIssues(issues: readonly string[]): string {
  if (issues.length === 0) return "The document would no longer be valid."
  const first = humanizeIssue(issues[0])
  return issues.length > 1 ? `${first} (+${issues.length - 1} more)` : first
}

/** "objects.nIa_wceYq232.rect: rect lies outside the scene extent" → "Rect lies outside the scene extent". */
export function humanizeIssue(issue: string): string {
  const text = issue.replace(/^[A-Za-z0-9_.\-[\]]+:\s+/, "").trim() || issue
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Byte counts for asset info ("12.4 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${trimNumber(bytes / 1024, 1)} KB`
  return `${trimNumber(bytes / (1024 * 1024), 1)} MB`
}
