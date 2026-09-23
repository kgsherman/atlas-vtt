/**
 * Render entry point (ARCHITECTURE §4). React, the editor and play controllers use only the Engine
 * interface from ./contracts.
 */
import type { CreateEngine } from "./contracts"
import { AtlasEngine } from "./engine/engine"

export type * from "./contracts"
/** The view a new engine starts with (editor, orbit camera, 15° player tilt, grid and helpers on). */
export { DEFAULT_VIEW } from "./engine/defaults"

export const createEngine: CreateEngine = (canvas, opts) => new AtlasEngine(canvas, opts)
