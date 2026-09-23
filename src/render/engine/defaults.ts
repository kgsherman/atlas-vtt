import type { ViewState } from "../contracts"

/** Initial view of a new engine. */
export const DEFAULT_VIEW: ViewState = {
  mode: "editor",
  camera: "orbit",
  activeLevelId: null,
  levelVisibility: {},
  ghostAdjacent: false,
  cutaway: true,
  showGrid: true,
  vision: "off",
  viewerTokenIds: [],
  hostMasks: {},
  gpuVisionRefine: true,
  dimmedTokenIds: [],
  primaryViewerId: null,
  tilt: (15 * Math.PI) / 180,
  showHelpers: true,
  darkVision: false,
}

/** Player camera tilt range, radians (ARCHITECTURE §4.5: 0–35°). */
export const MAX_TILT = (35 * Math.PI) / 180
