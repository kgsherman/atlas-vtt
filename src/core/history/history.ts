/**
 * Undo/redo over immer patches (docs/ARCHITECTURE.md §7).
 *
 * The history never touches the document itself: callers produce patches with
 * `produceWithPatches`, push them here, and apply whatever undo()/redo() return. That keeps it
 * usable for the editor's working scene and for a live session's GameState.scene alike.
 *
 * Transactions group many pushes (e.g. every pointer move of a drag) into ONE undo step. On commit
 * they are squashed to NET patches by replaying the forward patches onto the transaction's base
 * document inside produceWithPatches, so a drag of 200 moves stores one replace per changed field
 * and an object added then removed inside a transaction leaves no entry at all.
 */
import { applyPatches, enablePatches, produceWithPatches, type Objectish, type Patch } from "immer"

enablePatches()

/** Maximum number of undo steps kept (oldest are dropped). */
export const HISTORY_LIMIT = 200
/** Pushes with the same coalesce key within this window merge into one undo step. */
export const DEFAULT_COALESCE_MS = 1000

export interface HistoryEntry {
  label: string
  patches: Patch[]
  inversePatches: Patch[]
}

/** Patches to apply to the current document for an undo or redo. */
export interface HistoryStep {
  label: string
  patches: Patch[]
}

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  undoDepth: number
  redoDepth: number
  /**
   * Identity of the document revision the undo stack currently ends at. Two equal heads mean the
   * document is in the same state (used for the editor's dirty flag: dirty = head !== savedHead).
   */
  head: number
  transaction: { id: number; label: string } | null
}

export interface PushOptions {
  /**
   * Consecutive pushes with the same key (within the coalesce window, redo stack empty, outside
   * transactions) merge into one undo step — e.g. repeated arrow-key nudges or slider drags.
   */
  coalesceKey?: string
}

export interface HistoryOptions {
  /** Max undo depth (default HISTORY_LIMIT). */
  limit?: number
  /** Coalesce window in ms (default DEFAULT_COALESCE_MS). */
  coalesceMs?: number
  /** Clock (injectable for tests). */
  now?: () => number
}

export interface History {
  /** Record a change. Inside a transaction it is appended to the transaction instead. Clears redo. */
  push(entry: HistoryEntry, opts?: PushOptions): void
  /** Pop the newest undo step; returns the (inverse) patches to apply, or null (nothing to undo, or a transaction is open). */
  undo(): HistoryStep | null
  /** Re-apply the newest undone step; returns its patches, or null. */
  redo(): HistoryStep | null
  /** Drop the top entry of a stack (e.g. after its patches failed to apply to a document changed externally). */
  discard(stack: "undo" | "redo"): void
  /**
   * Open a transaction. `base` is the document before the transaction (required for net squashing;
   * without it the transaction's patches are concatenated). Nested begin() calls join the open
   * transaction and return its id.
   */
  begin(label: string, base?: Objectish): number
  /** Close the (outermost) transaction and record it as one step; returns the recorded entry or null (nested / no net change). */
  commit(): HistoryEntry | null
  /** Abort the open transaction (all nesting levels); returns the patches that revert its changes (apply them to the document). */
  cancel(): Patch[]
  readonly inTransaction: boolean
  readonly transactionId: number | null
  clear(): void
  state(): HistoryState
  /** Listen to every change of state(). Returns an unsubscribe function. */
  subscribe(listener: (state: HistoryState) => void): () => void
}

interface StoredEntry extends HistoryEntry {
  id: number
  coalesceKey: string | null
  time: number
}

interface Transaction {
  id: number
  label: string
  depth: number
  base: Objectish | undefined
  patches: Patch[]
  /** Inverse patches in application order (already reversed: newest change first). */
  inversePatches: Patch[]
}

/**
 * Squash a sequence of changes to net patches by replaying them onto `base`. Without a base the
 * sequence is kept as-is (forward in order, inverses newest-first).
 */
export function squashPatches(base: Objectish | undefined, patches: Patch[], inversePatches: Patch[]): { patches: Patch[]; inversePatches: Patch[] } {
  if (base === undefined || patches.length === 0) return { patches, inversePatches }
  try {
    const [, net, netInverse] = produceWithPatches(base, (draft) => {
      applyPatches(draft, patches)
    })
    return { patches: net, inversePatches: netInverse }
  } catch {
    // The document was replaced underneath the transaction (e.g. a live host sync), so the forward
    // patches no longer replay onto `base`: keep the exact sequence instead.
    return { patches, inversePatches }
  }
}

export function createHistory(opts: HistoryOptions = {}): History {
  const limit = Math.max(1, opts.limit ?? HISTORY_LIMIT)
  const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS
  const now = opts.now ?? (() => Date.now())

  let undoStack: StoredEntry[] = []
  let redoStack: StoredEntry[] = []
  let txn: Transaction | null = null
  let nextId = 1
  /** head() when the undo stack is empty: 0 initially, else the id of the last entry dropped by the depth cap. */
  let floorHead = 0
  const listeners = new Set<(s: HistoryState) => void>()

  const head = () => (undoStack.length > 0 ? undoStack[undoStack.length - 1].id : floorHead)

  const state = (): HistoryState => ({
    canUndo: txn === null && undoStack.length > 0,
    canRedo: txn === null && redoStack.length > 0,
    undoLabel: undoStack.length > 0 ? undoStack[undoStack.length - 1].label : null,
    redoLabel: redoStack.length > 0 ? redoStack[redoStack.length - 1].label : null,
    undoDepth: undoStack.length,
    redoDepth: redoStack.length,
    head: head(),
    transaction: txn ? { id: txn.id, label: txn.label } : null,
  })

  const notify = () => {
    if (listeners.size === 0) return
    const s = state()
    for (const l of [...listeners]) l(s)
  }

  const record = (entry: HistoryEntry, coalesceKey: string | null) => {
    const t = now()
    const top = undoStack[undoStack.length - 1]
    if (coalesceKey !== null && top && top.coalesceKey === coalesceKey && redoStack.length === 0 && t - top.time <= coalesceMs) {
      // Merged steps get a fresh id: the merged state differs from anything saved at the old head.
      undoStack[undoStack.length - 1] = {
        ...top,
        id: nextId++,
        patches: [...top.patches, ...entry.patches],
        inversePatches: [...entry.inversePatches, ...top.inversePatches],
        time: t,
      }
    } else {
      undoStack.push({ ...entry, id: nextId++, coalesceKey, time: t })
      if (undoStack.length > limit) {
        const dropped = undoStack.splice(0, undoStack.length - limit)
        floorHead = dropped[dropped.length - 1].id
      }
    }
    redoStack = []
  }

  return {
    push(entry, pushOpts = {}) {
      if (entry.patches.length === 0 && entry.inversePatches.length === 0) return
      if (txn) {
        txn.patches.push(...entry.patches)
        txn.inversePatches.unshift(...entry.inversePatches)
        return
      }
      record(entry, pushOpts.coalesceKey ?? null)
      notify()
    },

    undo() {
      if (txn) return null
      const entry = undoStack.pop()
      if (!entry) return null
      redoStack.push(entry)
      notify()
      return { label: entry.label, patches: entry.inversePatches }
    },

    redo() {
      if (txn) return null
      const entry = redoStack.pop()
      if (!entry) return null
      // A redone step can never merge with a later push.
      undoStack.push({ ...entry, coalesceKey: null })
      notify()
      return { label: entry.label, patches: entry.patches }
    },

    discard(stack) {
      if (stack === "undo") undoStack.pop()
      else redoStack.pop()
      notify()
    },

    begin(label, base) {
      if (txn) {
        txn.depth++
        return txn.id
      }
      txn = { id: nextId++, label, depth: 1, base, patches: [], inversePatches: [] }
      notify()
      return txn.id
    },

    commit() {
      if (!txn) return null
      if (--txn.depth > 0) return null
      const t = txn
      txn = null
      const net = squashPatches(t.base, t.patches, t.inversePatches)
      let entry: HistoryEntry | null = null
      if (net.patches.length > 0) {
        entry = { label: t.label, patches: net.patches, inversePatches: net.inversePatches }
        record(entry, null)
      }
      notify()
      return entry
    },

    cancel() {
      if (!txn) return []
      const inverse = txn.inversePatches
      txn = null
      notify()
      return inverse
    },

    get inTransaction() {
      return txn !== null
    },

    get transactionId() {
      return txn ? txn.id : null
    },

    clear() {
      undoStack = []
      redoStack = []
      txn = null
      // A fresh head so a cleared history never compares equal to a head saved before clearing.
      floorHead = nextId++
      notify()
    },

    state,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
