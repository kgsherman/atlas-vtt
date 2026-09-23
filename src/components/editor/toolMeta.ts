/**
 * Tool rail metadata: icon, label, shortcut and a one-line usage hint per editor tool.
 */
import {
  AppWindow,
  Archive,
  Armchair,
  Barrel,
  BedDouble,
  Box,
  Caravan,
  Church,
  CircleDot,
  LibraryBig,
  PersonStanding,
  RectangleHorizontal,
  Shrub,
  Stone,
  TreeDeciduous,
  BrickWall,
  CircleUserRound,
  Cylinder,
  DoorOpen,
  Flame,
  Grid2x2,
  Mountain,
  MousePointer2,
  Package,
  Ruler,
  createLucideIcon,
  type LucideIcon,
} from "lucide-react"

import type { PropKind } from "@/core/scene/types"
import type { ToolId } from "@/editor/tools/types"

export interface ToolMeta {
  id: ToolId
  label: string
  icon: LucideIcon
  hint: string
}

/** Lucide has no stairs glyph: a staircase drawn in the same 24 px / 2 px stroke style. */
const Stairs = createLucideIcon("stairs", [
  ["path", { d: "M3 20h5v-5h5v-5h5V5h3", key: "steps" }],
  ["path", { d: "M3 20V14", key: "rail" }],
])

const meta = (id: ToolId, label: string, icon: LucideIcon, hint: string): ToolMeta => ({ id, label, icon, hint })

/** Tools in rail order, grouped by separators after "select", "window", "light" and "token". */
export const TOOLS: ToolMeta[] = [
  meta("select", "Select", MousePointer2, "Click to select, Shift-click to add, drag empty ground to box-select, drag a selection to move it."),
  meta("floor", "Floor", Grid2x2, "Drag a rectangle to lay a floor slab; click to add a single cell."),
  meta("wall", "Wall", BrickWall, "Click to chain wall segments. Double-click, Enter or right-click finishes. Shift snaps to 45°."),
  meta("door", "Door", DoorOpen, "Hover a wall and click to place a door."),
  meta("window", "Window", AppWindow, "Hover a wall and click to place a window."),
  meta("connector", "Stairs / ladder / ramp", Stairs, "Drag from the bottom of the run to the top. It leads to the level directly above."),
  meta("pillar", "Pillar", Cylinder, "Click to place a pillar."),
  meta("prop", "Prop", Package, "Click to place the chosen prop. R rotates the preview."),
  meta("light", "Light", Flame, "Click the ground, a wall (wall-mounted) or a token (carried light)."),
  meta("terrain", "Terrain brush", Mountain, "Paint the level's heightmap. [ and ] change the brush size."),
  meta("token", "Token", CircleUserRound, "Click to place a token on the active level."),
  meta("measure", "Measure", Ruler, "Click to add waypoints; double-click, Enter or right-click ends the ruler."),
]

export const TOOL_GROUP_ENDS: ReadonlySet<ToolId> = new Set<ToolId>(["select", "window", "light", "token"])

export function toolMeta(id: ToolId): ToolMeta {
  return TOOLS.find((t) => t.id === id) ?? TOOLS[0]
}

export const PROP_ICONS: Record<PropKind, LucideIcon> = {
  table: RectangleHorizontal,
  chair: Armchair,
  crate: Box,
  barrel: Barrel,
  chest: Archive,
  bookshelf: LibraryBig,
  bed: BedDouble,
  altar: Church,
  statue: PersonStanding,
  tree: TreeDeciduous,
  bush: Shrub,
  rock: Stone,
  well: CircleDot,
  cart: Caravan,
}
