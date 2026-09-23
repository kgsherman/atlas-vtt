/**
 * Editor tools (docs/ARCHITECTURE.md §7). Each tool implements `Tool` from ./types, reads and writes
 * the editor store, and exposes preview() for the canvas to draw via engine overlays.
 */
import { createConnectorTool } from "./connector"
import { createFloorTool } from "./floor"
import { createLightTool } from "./light"
import { createMeasureTool, type MeasureTool } from "./measure"
import { createOpeningTool } from "./opening"
import { createPillarTool } from "./pillar"
import { createPropTool } from "./prop"
import { createSelectTool, type SelectTool } from "./select"
import type { ToolDeps } from "./shared"
import { createTerrainTool, type TerrainTool } from "./terrain"
import { createTokenTool } from "./token"
import type { Tool, ToolId } from "./types"
import { createWallTool, type WallTool } from "./wall"

export type { ToolDeps } from "./shared"
export type { MeasureTool } from "./measure"
export type { SelectTool } from "./select"
export type { TerrainTool } from "./terrain"
export type { WallTool } from "./wall"

export interface ToolSet extends Record<ToolId, Tool> {
  select: SelectTool
  wall: WallTool
  terrain: TerrainTool
  measure: MeasureTool
}

export function createTools(deps: ToolDeps): ToolSet {
  return {
    select: createSelectTool(deps),
    floor: createFloorTool(deps),
    wall: createWallTool(deps),
    door: createOpeningTool(deps, "door"),
    window: createOpeningTool(deps, "window"),
    connector: createConnectorTool(deps),
    pillar: createPillarTool(deps),
    prop: createPropTool(deps),
    light: createLightTool(deps),
    terrain: createTerrainTool(deps),
    token: createTokenTool(deps),
    measure: createMeasureTool(deps),
  }
}

export {
  createConnectorTool,
  createFloorTool,
  createLightTool,
  createMeasureTool,
  createOpeningTool,
  createPillarTool,
  createPropTool,
  createSelectTool,
  createTerrainTool,
  createTokenTool,
  createWallTool,
}
