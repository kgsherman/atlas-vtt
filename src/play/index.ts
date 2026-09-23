/**
 * Play-mode controllers (ARCHITECTURE §8): token selection, drag-to-move with A* path previews and a
 * ruler, the Measure tool, ladder and stairs climbs, door clicks and the play keymap. Framework-free: the play
 * pages (routes/PlayPage, routes/HostPage) feed DOM input in and push overlays to the engine.
 */
export {
  PlayController,
  DRAG_THRESHOLD_PX,
  type CommittedMove,
  type PlayControllerHost,
  type PlayOverlays,
  type PlayPointerEvent,
  type PlayRole,
  type PlayTool,
} from "./controller"
export {
  blindLandingOk,
  MovePlanner,
  runsBelowTop,
  unexploredIn,
  type PlannedMove,
  type PlannerOptions,
  type RunBelowTop,
} from "./planner"
export { MeasureTool } from "./measure"
export { climbOptions, type ClimbOption } from "./connectors"
export {
  doorAt,
  footprintRect,
  tokensInReach,
  DOOR_PICK_RADIUS,
  type DoorHit,
} from "./doors"
export {
  anchorForPoint,
  formatFeet,
  groundY,
  pathPoints,
  pathRuler,
  snapToCellCenter,
  straightRuler,
} from "./geometry"
export {
  cycleToken,
  describeSenses,
  presentTokens,
  resolveSelection,
  tokenDisplayName,
  tokenInitials,
  TOKEN_KIND_LABELS,
  type SenseLine,
} from "./tokens"
export {
  PLAY_SHORTCUTS,
  resolvePlayKey,
  type PlayKeyAction,
  type PlayKeyEvent,
  type PlayShortcut,
} from "./keys"
export {
  isEmptyChange,
  previewDimmedTokens,
  previewSeenTokens,
  previewHostMasks,
  sceneChangeBetween,
  scenePatches,
  setDirectionalPatches,
  setObjectsHiddenPatches,
  setTokensHiddenPatches,
} from "./host"
