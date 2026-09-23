/**
 * Lighting presets for the Scene panel and for scenes created in the editor (pure data).
 */
import type { DirectionalLightSettings, Environment } from "@/core/scene/types"
import type { EnvironmentUpdate } from "@/editor/store"

export type EnvPresetId = "day" | "dusk" | "moonlit" | "night" | "dungeon"

export const SUN_DEFAULTS: Record<DirectionalLightSettings["kind"], Pick<DirectionalLightSettings, "color" | "intensity" | "grants">> = {
  sun: { color: "#fff1d6", intensity: 1.1, grants: "bright" },
  moon: { color: "#9fb4ff", intensity: 0.35, grants: "dim" },
}

const deg = (d: number) => (d * Math.PI) / 180

export const ENV_PRESETS: Record<EnvPresetId, { label: string; env: EnvironmentUpdate }> = {
  day: {
    label: "Day",
    env: { skyLevel: "bright", ambientLevel: "dim", ambientColor: "#b8c4d8", ambientIntensity: 0.35, backgroundColor: "#4d6b8a", directional: { enabled: true, kind: "sun", ...SUN_DEFAULTS.sun, elevation: deg(55) } },
  },
  dusk: {
    label: "Dusk",
    env: { skyLevel: "dim", ambientLevel: "dark", ambientColor: "#a08aa8", ambientIntensity: 0.2, backgroundColor: "#2a2238", directional: { enabled: true, kind: "sun", color: "#ffb070", intensity: 0.7, grants: "dim", elevation: deg(12) } },
  },
  moonlit: {
    label: "Moonlit",
    env: { skyLevel: "dim", ambientLevel: "dark", ambientColor: "#8090b0", ambientIntensity: 0.12, backgroundColor: "#0b0d10", directional: { enabled: true, kind: "moon", ...SUN_DEFAULTS.moon, elevation: deg(54) } },
  },
  night: {
    label: "Dark night",
    env: { skyLevel: "dark", ambientLevel: "dark", ambientColor: "#6070a0", ambientIntensity: 0.08, backgroundColor: "#06070a", directional: { enabled: false } },
  },
  dungeon: {
    label: "Dungeon",
    env: { skyLevel: "dark", ambientLevel: "dark", ambientColor: "#706860", ambientIntensity: 0.06, backgroundColor: "#050505", directional: { enabled: false } },
  },
}

/** A full Environment with a preset applied (for scenes built outside the store). */
export function withPreset(env: Environment, id: EnvPresetId): Environment {
  const { directional, ...rest } = ENV_PRESETS[id].env
  return { ...env, ...rest, directional: { ...env.directional, ...directional } }
}

/** Lighting that suits battlemaps with these file names ("…-Day.jpg" → day, "…-Night…" / unknown → moonlit). */
export function presetForFileNames(names: readonly string[]): EnvPresetId {
  const text = names.join(" ").toLowerCase()
  if (/(^|[^a-z])(day|daylight|noon|morning)([^a-z]|$)/.test(text) && !/night/.test(text)) return "day"
  if (/(dusk|sunset|evening|dawn)/.test(text)) return "dusk"
  if (/(dungeon|cave|crypt|sewer)/.test(text) && !/night|day/.test(text)) return "dungeon"
  return "moonlit"
}
