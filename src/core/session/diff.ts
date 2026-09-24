/**
 * PlayerView diffs (docs/ARCHITECTURE.md §6.2, §6.3). Path-based ops at a fixed granularity so a patch
 * only carries what changed:
 *   objects/{id}, tokens/{id}, backdrops/{level}, scene/levels/{id}, terrain/{level}/{chunk}, masks/{level}/{kind},
 *   table/log/{id}, table/combat, and whole values for everything else (scene name/grid/environment, id
 *   lists, flags…).
 * Invariant (property-tested): applyPatchOps(prev, diffViews(prev, next)) deep-equals next, and
 * identical views give no ops.
 */
import type { PatchOp, PlayerView } from "./types"
import { deepEqual, isPlainObject } from "./util"

/** Whether a path is a leaf (compared and replaced whole) in the diff granularity. */
function isLeaf(path: readonly string[]): boolean {
  const n = path.length
  if (n === 0) return false
  switch (path[0]) {
    case "scene":
      return n >= (path[1] === "levels" ? 3 : 2)
    case "objects":
    case "tokens":
    case "backdrops":
      return n >= 2
    case "terrain":
    case "masks":
      return n >= 3
    case "table":
      return n >= (path[1] === "log" ? 3 : 2)
    default:
      return true
  }
}

function diffInto(path: string[], a: unknown, b: unknown, ops: PatchOp[]): void {
  if (isLeaf(path) || !isPlainObject(a) || !isPlainObject(b)) {
    if (!deepEqual(a, b)) ops.push({ op: "set", path: [...path], value: b })
    return
  }
  for (const key of Object.keys(a).sort()) {
    if (!Object.hasOwn(b, key)) ops.push({ op: "del", path: [...path, key] })
  }
  for (const key of Object.keys(b).sort()) {
    path.push(key)
    if (!Object.hasOwn(a, key)) ops.push({ op: "set", path: [...path], value: b[key] })
    else diffInto(path, a[key], b[key], ops)
    path.pop()
  }
}

/** Ops turning `prev` into `next` (a single root `set` when there is no previous view). */
export function diffViews(prev: PlayerView | null, next: PlayerView): PatchOp[] {
  if (prev === null) return [{ op: "set", path: [], value: next }]
  const ops: PatchOp[] = []
  diffInto([], prev, next, ops)
  return ops
}

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"])

/**
 * Apply ops immutably (the input view is never modified; containers along each path are copied once
 * per call). Throws on malformed paths so the caller can resynchronise.
 */
export function applyPatchOps(view: PlayerView, ops: readonly PatchOp[]): PlayerView {
  let root: unknown = view
  // Containers created by this call may be mutated in place by later ops.
  const fresh = new WeakSet<object>()
  const writable = (v: unknown): Record<string, unknown> => {
    if (isPlainObject(v) && fresh.has(v)) return v
    const copy: Record<string, unknown> = isPlainObject(v) ? { ...v } : {}
    fresh.add(copy)
    return copy
  }
  for (const op of ops) {
    const path = op.path
    for (const seg of path) {
      if (typeof seg !== "string" || FORBIDDEN.has(seg)) throw new Error("applyPatchOps: invalid path")
    }
    if (path.length === 0) {
      if (op.op !== "set") throw new Error("applyPatchOps: cannot delete the root")
      root = op.value
      continue
    }
    const top = writable(root)
    root = top
    let node = top
    for (let k = 0; k < path.length - 1; k++) {
      const key = path[k]
      const child = writable(Object.hasOwn(node, key) ? node[key] : undefined)
      node[key] = child
      node = child
    }
    const last = path[path.length - 1]
    if (op.op === "set") node[last] = op.value
    else delete node[last]
  }
  return root as PlayerView
}
