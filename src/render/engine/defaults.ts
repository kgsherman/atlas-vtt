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
  showHelpers: true,
  darkVision: false,
}

