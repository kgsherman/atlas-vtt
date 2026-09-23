/**
 * Render entry point (ARCHITECTURE §4). React, the editor and play controllers use only the Engine
 * interface from ./contracts.
 */
import type { CreateEngine } from "./contracts"
import { AtlasEngine } from "./engine/engine"

export type * from "./contracts"
/** The view a new engine starts with (editor, orbit camera, 15° player tilt, grid and helpers on). */
export { DEFAULT_VIEW } from "./engine/defaults"
/**
 * Startup quality pick (ARCHITECTURE §10): `await pickInitialQuality()` before createEngine(canvas,
 * { quality }). Renderer heuristics + a ~100 ms synthetic benchmark, run once and remembered (localStorage;
 * `cachedQuality()` reads it synchronously).
 */
export { cachedQuality, pickInitialQuality, probeQuality, type ProbeOptions, type QualityProbe } from "./engine/autoQuality"

/**
 * Max texels of one level image per quality ceiling (the engine's own cap, engine/backdrops.ts). Give a
 * player's backdrop compositor `backdropTexelBudget(engine.getQualityCeiling())` as its canvas budget so the
 * canvas is uploaded as is instead of being copied into a second, downscaled canvas.
 */
export { BACKDROP_MAX_TEXELS, backdropTexelBudget } from "./engine/backdrops"

export const createEngine: CreateEngine = (canvas, opts) => new AtlasEngine(canvas, opts)
