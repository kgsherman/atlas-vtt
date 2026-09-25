/**
 * Public API of core/area — areas of effect (spell templates) and what they reach through the 3D
 * geometry (docs/ARCHITECTURE.md §6.6).
 */
export * from "./types"
export { AREA_EPS, areaOutline, areaVolume, describeArea, normalizeAngle, normalizeArea, type AreaBounds, type AreaVolume } from "./shape"
export { areaAroundToken, CELL_COLUMN_HIGH, CELL_COLUMN_LOW, computeAreaEffect, type AreaEffect, type AreaEffectOptions } from "./effect"
export { AREA_COLORS, AREA_PRESETS, type AreaPreset } from "./presets"
