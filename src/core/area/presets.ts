/**
 * Ready-made areas for common spells (SRD 5.1 names and sizes) and the colours offered for templates.
 * `aura`: carried by the caster's token (it moves with it).
 */
import { DEFAULT_CYLINDER_HEIGHT, DEFAULT_LINE_WIDTH, type AreaShape } from "./types"

export interface AreaPreset {
  id: string
  name: string
  shape: AreaShape
  size: number
  width: number
  height: number
  color: string
  aura?: boolean
}

/** Swatches offered for templates (the first is the default for new custom areas). */
export const AREA_COLORS = ["#f97316", "#facc15", "#84cc16", "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6", "#e2e8f0"] as const

const preset = (id: string, name: string, shape: AreaShape, size: number, color: string, more: Partial<AreaPreset> = {}): AreaPreset => ({
  id,
  name,
  shape,
  size,
  width: DEFAULT_LINE_WIDTH,
  height: DEFAULT_CYLINDER_HEIGHT,
  color,
  ...more,
})

export const AREA_PRESETS: readonly AreaPreset[] = [
  preset("burning-hands", "Burning Hands", "cone", 15, "#f97316"),
  preset("thunderwave", "Thunderwave", "cube", 15, "#60a5fa"),
  preset("shatter", "Shatter", "sphere", 10, "#a78bfa"),
  preset("web", "Web", "cube", 20, "#e2e8f0"),
  preset("fog-cloud", "Fog Cloud", "sphere", 20, "#e2e8f0"),
  preset("moonbeam", "Moonbeam", "cylinder", 5, "#22d3ee"),
  preset("spirit-guardians", "Spirit Guardians", "sphere", 15, "#facc15", { aura: true }),
  preset("fireball", "Fireball", "sphere", 20, "#f97316"),
  preset("lightning-bolt", "Lightning Bolt", "line", 100, "#facc15"),
  preset("cloudkill", "Cloudkill", "sphere", 20, "#84cc16"),
  preset("cone-of-cold", "Cone of Cold", "cone", 60, "#22d3ee"),
  preset("flame-strike", "Flame Strike", "cylinder", 10, "#f97316"),
]
