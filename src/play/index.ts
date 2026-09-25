/**
 * Play-mode controllers (ARCHITECTURE §8): token selection, drag-to-move with A* path previews and a
 * ruler, the Measure tool, ladder and stairs climbs, door clicks, long-press pings and the play keymap. Framework-free: the play
 * pages (routes/PlayPage, routes/HostPage) feed DOM input in and push overlays to the engine.
 */
export {
  PlayController,
  DEFAULT_TEMPLATE_SPEC,
  DRAG_THRESHOLD_PX,
  LONG_PRESS_MS,
  type CommittedMove,
  type PlayControllerHost,
  type PlayOverlays,
  type PlayPointerEvent,
  type PlayRole,
  type PlayTool,
  type StrandedMove,
} from "./controller"
export { SentRoutes, tokenRouter } from "./routes"
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
export {
  damageInput,
  DRAFT_ID,
  hostTemplateItems,
  inputOf,
  playerTemplateItems,
  specOf,
  TemplateAreas,
  templateInput,
  templateTitle,
  type TemplateItem,
  type TemplateView,
} from "./templateAreas"
export {
  AIMED_ELEVATION,
  snapAngle,
  TemplateTool,
  tokenEdgePoint,
  type TemplateDraft,
  type TemplatePointer,
  type TemplateSpec,
} from "./templateTool"
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
  drapeRoute,
  formatFeet,
  groundY,
  pathPoints,
  pathRoute,
  pathRuler,
  routeRuler,
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
  PLAY_COMMANDS,
  PLAY_POINTER_HELP,
  playBindings,
  type PlayBinding,
  type PlayCommand,
  type PlayKeyAction,
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
  setTokenImagePatches,
  setTokenModelPatches,
  setTokensHiddenPatches,
} from "./host"
