/**
 * Public API of core/history: undo/redo over immer patches with transactions (docs/ARCHITECTURE.md §7).
 */
export {
  createHistory,
  DEFAULT_COALESCE_MS,
  HISTORY_LIMIT,
  squashPatches,
  type History,
  type HistoryEntry,
  type HistoryOptions,
  type HistoryState,
  type HistoryStep,
  type PushOptions,
} from "./history"
