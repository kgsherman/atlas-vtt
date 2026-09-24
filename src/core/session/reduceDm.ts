/**
 * DM commands on the authoritative GameState (docs/ARCHITECTURE.md §6.2). The DM is trusted, but ids
 * are still looked up with Object.hasOwn and unknown targets are no-ops. Play actions (token moves,
 * doors, lights) change GameState.scene directly and never enter the editor's undo history; editor
 * edits arrive as immer patches ("apply-scene-patches").
 */
import { applyPatches, enablePatches, produce, type Patch } from "immer"

import { levelById } from "../scene/queries"
import { SCENE_LIMITS } from "../scene/schema"
import { applyConditionChange, applyHpChange } from "../scene/tokenStatus"
import type { GridSettings, Id, Scene } from "../scene/types"
import { normalizeFreeAssetCategories } from "./freeAssets"
import { tokenWithStatus } from "./tokenStatus"
import { remapExplored } from "./masks"
import { sanitizeObject } from "./sanitize"
import { staticLightWorldY } from "./memory"
import { attachedLightIds, emptyDelta, nextPlayerColor, own, type ReduceResult, type SceneDelta } from "./state"
import { isTableCommand, pruneCombat, rebindTable, reduceTableDm, tableOf } from "./table"
import type { DmCommand, GameState, PlayerObject } from "./types"

enablePatches()

const noop = (state: GameState, error?: string): ReduceResult => {
  const out: ReduceResult = { state, delta: emptyDelta(), dirtyPlayers: [] }
  if (error) out.error = error
  return out
}

const sorted = (ids: Iterable<Id>): Id[] => [...new Set(ids)].sort()

/** Is this a patch of a level's terrain edits (levels/<id>/terrainEdits/…)? */
const isTerrainEditsPatch = (p: Patch): boolean => p.path.length >= 3 && p.path[0] === "levels" && p.path[2] === "terrainEdits"

/**
 * Do these patches change only DM-only terrain editing data (Level.terrainEdits: shapes and painted base,
 * never sent to players)? Such an edit changes nothing any player sees or knows: the baked result, when
 * there is one, arrives as heightmap patches.
 */
export function onlyTerrainEdits(patches: readonly Patch[]): boolean {
  return patches.length > 0 && patches.every(isTerrainEditsPatch)
}

/**
 * Changes of a scene revision, derived from the paths of the immer patches that produced it.
 * levels/<id>/terrainEdits/… is ignored (DM-only editing data; the visual change is in the heightmap patches).
 */
export function deltaFromPatches(prev: Scene, next: Scene, patches: readonly Patch[]): SceneDelta {
  const objects = new Set<Id>()
  const tokens = new Set<Id>()
  const terrain = new Set<Id>()
  let structure = false
  const allOf = (a: Record<Id, unknown>, b: Record<Id, unknown>, into: Set<Id>) => {
    for (const id of Object.keys(a)) into.add(id)
    for (const id of Object.keys(b)) into.add(id)
  }
  for (const p of patches) {
    const path = p.path.map(String)
    if (path.length === 0) {
      structure = true
      allOf(prev.objects, next.objects, objects)
      allOf(prev.tokens, next.tokens, tokens)
      continue
    }
    switch (path[0]) {
      case "objects":
        if (path.length >= 2) objects.add(path[1])
        else allOf(prev.objects, next.objects, objects)
        break
      case "tokens":
        if (path.length >= 2) tokens.add(path[1])
        else allOf(prev.tokens, next.tokens, tokens)
        break
      case "levels": {
        const levelId = path[1]
        if (levelId !== undefined && path[2] === "terrainEdits") break
        if (levelId !== undefined && path[2] === "heightmap") {
          // Chunk edits are terrain changes; creating/removing a heightmap or changing its resolution
          // changes the level's structure.
          const a = Object.hasOwn(prev.levels, levelId) ? prev.levels[levelId].heightmap : null
          const b = Object.hasOwn(next.levels, levelId) ? next.levels[levelId].heightmap : null
          if (path.length >= 4 || (a !== null && b !== null && a.resolution === b.resolution)) terrain.add(levelId)
          else structure = true
        } else structure = true
        break
      }
      case "grid":
      case "environment":
        structure = true
        break
      default:
        // name, meta, timestamps: nothing geometric (the view's scene name is refreshed on every filter).
        break
    }
  }
  return { objects: sorted(objects), tokens: sorted(tokens), terrain: sorted(terrain), structure }
}

/** Keep per-player knowledge consistent with a new scene revision (grid changes, deleted levels/tokens). */
function reconcileKnowledge(state: GameState, prev: Scene, next: Scene): GameState {
  let out = state
  const gridChanged = prev.grid.width !== next.grid.width || prev.grid.depth !== next.grid.depth || prev.grid.cellSize !== next.grid.cellSize
  const deletedLevels = Object.keys(prev.levels).filter((id) => !Object.hasOwn(next.levels, id))
  if (gridChanged || deletedLevels.length > 0) {
    const gone = new Set(deletedLevels)
    const explored: GameState["explored"] = {}
    for (const uid of Object.keys(state.explored)) {
      const rec: Record<Id, (typeof state.explored)[string][string]> = {}
      for (const levelId of Object.keys(state.explored[uid])) {
        if (gone.has(levelId)) continue
        const enc = state.explored[uid][levelId]
        const mapped = gridChanged ? remapExplored(enc, prev.grid, next.grid) : enc
        if (mapped) rec[levelId] = mapped
      }
      explored[uid] = rec
    }
    out = { ...out, explored }
    if (gone.size > 0) {
      const memory: GameState["memory"] = {}
      for (const uid of Object.keys(state.memory)) {
        const rec: Record<Id, PlayerObject> = {}
        for (const [id, o] of Object.entries(state.memory[uid])) {
          if (gone.has(o.levelId) || (o.type === "connector" && gone.has(o.toLevelId))) continue
          rec[id] = o
        }
        memory[uid] = rec
      }
      out = { ...out, memory }
    }
  }
  // Ownership of tokens that no longer exist is dropped.
  const deadOwners = Object.keys(state.owners).filter((id) => !Object.hasOwn(next.tokens, id))
  if (deadOwners.length > 0) {
    const owners = { ...out.owners }
    for (const id of deadOwners) delete owners[id]
    out = { ...out, owners }
  }
  return out
}

/**
 * A token position the scene schema accepts (grid extent ± SCENE_LIMITS.coordMargin). The live scene is
 * persisted with the session and must stay loadable by parseScene, like every editor revision.
 */
function positionInScene(grid: GridSettings, x: number, z: number): boolean {
  const m = SCENE_LIMITS.coordMargin
  return x >= -m && z >= -m && x <= grid.width * grid.cellSize + m && z <= grid.depth * grid.cellSize + m
}

function tokenDelta(scene: Scene, tokenId: Id): SceneDelta {
  return { objects: attachedLightIds(scene, tokenId), tokens: [tokenId], terrain: [], structure: false }
}

/** Every player (or one) — used by the per-player commands. */
function targets(state: GameState, userId: string | undefined): string[] {
  if (userId === undefined) return Object.keys(state.players).sort()
  return Object.hasOwn(state.players, userId) ? [userId] : []
}

export function reduceDm(state: GameState, cmd: DmCommand): ReduceResult {
  // Chat, dice and combat (core/session/table.ts).
  if (isTableCommand(cmd)) return reduceTableDm(state, cmd)
  switch (cmd.t) {
    case "move-token": {
      const t = own(state.scene.tokens, cmd.tokenId)
      if (!t || !levelById(state.scene, cmd.levelId) || !Number.isFinite(cmd.x) || !Number.isFinite(cmd.z)) return noop(state, "unknown token or level")
      if (!positionInScene(state.scene.grid, cmd.x, cmd.z)) return noop(state, "position outside the scene")
      if (t.levelId === cmd.levelId && t.position.x === cmd.x && t.position.z === cmd.z) return noop(state)
      const next = produce(state, (d) => {
        const tok = d.scene.tokens[cmd.tokenId]
        tok.levelId = cmd.levelId
        tok.position = { x: cmd.x, z: cmd.z }
        d.seq++
      })
      return { state: next, delta: tokenDelta(next.scene, cmd.tokenId), dirtyPlayers: "all" }
    }
    case "set-door": {
      const o = own(state.scene.objects, cmd.doorId)
      if (!o || o.type !== "door") return noop(state, "unknown door")
      if (o.state === cmd.state) return noop(state)
      const next = produce(state, (d) => {
        const door = d.scene.objects[cmd.doorId]
        if (door.type === "door") door.state = cmd.state
        d.seq++
      })
      return { state: next, delta: { ...emptyDelta(), objects: [cmd.doorId] }, dirtyPlayers: "all" }
    }
    case "set-light": {
      const o = own(state.scene.objects, cmd.lightId)
      if (!o || o.type !== "light") return noop(state, "unknown light")
      if (o.on === cmd.on) return noop(state)
      const next = produce(state, (d) => {
        const light = d.scene.objects[cmd.lightId]
        if (light.type === "light") light.on = cmd.on
        d.seq++
      })
      return { state: next, delta: { ...emptyDelta(), objects: [cmd.lightId] }, dirtyPlayers: "all" }
    }
    case "set-movement-locked": {
      if (cmd.userId !== undefined) {
        const p = own(state.players, cmd.userId)
        if (!p) return noop(state, "unknown player")
        if (p.movementLocked === cmd.locked) return noop(state)
        const next = produce(state, (d) => {
          d.players[cmd.userId!].movementLocked = cmd.locked
          d.seq++
        })
        return { state: next, delta: emptyDelta(), dirtyPlayers: [cmd.userId] }
      }
      if (state.movementLocked === cmd.locked) return noop(state)
      return { state: { ...state, movementLocked: cmd.locked, seq: state.seq + 1 }, delta: emptyDelta(), dirtyPlayers: "all" }
    }
    case "set-shared-vision":
      if (state.sharedVision === cmd.enabled) return noop(state)
      return { state: { ...state, sharedVision: cmd.enabled, seq: state.seq + 1 }, delta: emptyDelta(), dirtyPlayers: "all" }
    case "set-free-assets": {
      const categories = normalizeFreeAssetCategories(cmd.categories)
      const current = state.freeAssets ?? []
      if (categories.length === current.length && categories.every((c, k) => c === current[k])) return noop(state)
      // DM-only: no player's view depends on it.
      return { state: { ...state, freeAssets: categories, seq: state.seq + 1 }, delta: emptyDelta(), dirtyPlayers: [] }
    }
    case "set-token-status":
    case "change-token-status": {
      const t = own(state.scene.tokens, cmd.tokenId)
      if (!t) return noop(state, "unknown token")
      const next =
        cmd.t === "set-token-status"
          ? tokenWithStatus(t, cmd.hp, cmd.conditions)
          : tokenWithStatus(
              t,
              cmd.hp && t.hp ? applyHpChange(t.hp, cmd.hp) : undefined,
              cmd.conditions ? applyConditionChange(t.conditions ?? [], cmd.conditions) : undefined
            )
      if (next === t) return noop(state)
      // A play action (like a move): no map edit, no undo entry; views change, vision does not.
      return { state: { ...state, scene: { ...state.scene, tokens: { ...state.scene.tokens, [t.id]: next } }, seq: state.seq + 1 }, delta: emptyDelta(), dirtyPlayers: "all" }
    }
    case "set-hide-wounds":
      if ((state.hideWounds ?? false) === cmd.hidden) return noop(state)
      return { state: { ...state, hideWounds: cmd.hidden, seq: state.seq + 1 }, delta: emptyDelta(), dirtyPlayers: "all" }
    case "set-enforce-speed":
      if (state.enforceSpeed === cmd.enabled) return noop(state)
      return { state: { ...state, enforceSpeed: cmd.enabled, seq: state.seq + 1 }, delta: emptyDelta(), dirtyPlayers: "all" }
    case "set-free-movement":
      if ((state.freeMovement ?? false) === cmd.enabled) return noop(state)
      return { state: { ...state, freeMovement: cmd.enabled, seq: state.seq + 1 }, delta: emptyDelta(), dirtyPlayers: "all" }
    case "assign-token": {
      if (!own(state.scene.tokens, cmd.tokenId)) return noop(state, "unknown token")
      const current = own(state.owners, cmd.tokenId) ?? []
      const has = current.includes(cmd.userId)
      if (has === cmd.assigned) return noop(state)
      if (cmd.assigned && !Object.hasOwn(state.players, cmd.userId)) return noop(state, "unknown player")
      const owners = { ...state.owners }
      const list = cmd.assigned ? [...current, cmd.userId].sort() : current.filter((u) => u !== cmd.userId)
      if (list.length > 0) owners[cmd.tokenId] = list
      else delete owners[cmd.tokenId]
      // With shared vision a PC changing hands changes every party member's viewers.
      const dirty = state.sharedVision ? "all" : [cmd.userId]
      return { state: { ...state, owners, seq: state.seq + 1 }, delta: emptyDelta(), dirtyPlayers: dirty }
    }
    case "reveal-object": {
      const o = own(state.scene.objects, cmd.objectId)
      if (!o || o.type !== "door" || o.style !== "secret") return noop(state, "not a secret door")
      const uids = targets(state, cmd.userId)
      if (uids.length === 0) return noop(state, "unknown player")
      const revealed = { ...state.revealed }
      const memory = { ...state.memory }
      const lightY = staticLightWorldY(state.scene)
      for (const uid of uids) {
        const list = own(revealed, uid) ?? []
        if (!list.includes(o.id)) revealed[uid] = [...list, o.id].sort()
        // Revealing is the DM telling the player: remember the door now (the filter still clips it to
        // explored cells and requires its remembered host wall).
        if (!o.hidden) memory[uid] = { ...(own(memory, uid) ?? {}), [o.id]: sanitizeObject(o, lightY) }
      }
      return { state: { ...state, revealed, memory, seq: state.seq + 1 }, delta: emptyDelta(), dirtyPlayers: uids }
    }
    case "apply-scene-patches": {
      if (cmd.patches.length === 0) return noop(state)
      let scene: Scene
      try {
        scene = applyPatches(state.scene, cmd.patches)
      } catch (e) {
        return noop(state, `patches do not apply: ${e instanceof Error ? e.message : String(e)}`)
      }
      const delta = deltaFromPatches(state.scene, scene, cmd.patches)
      const edited: GameState = { ...state, scene, seq: state.seq + 1 }
      // The live map now differs from the library version it came from.
      if (state.origin && !state.origin.dirty) edited.origin = { ...state.origin, dirty: true }
      // Deleted tokens leave combat (the turn passes on if one was acting).
      const next = pruneCombat(reconcileKnowledge(edited, state.scene, scene))
      // Terrain-edit bookkeeping only (e.g. a shape renamed, or painting under a shape): no player view changes.
      return { state: next, delta, dirtyPlayers: onlyTerrainEdits(cmd.patches) ? [] : "all" }
    }
    case "set-origin": {
      const o = cmd.origin
      const cur = state.origin
      if (o === null ? cur === null : cur && cur.sceneId === o.sceneId && cur.version === o.version && cur.dirty === o.dirty) return noop(state)
      return { state: { ...state, origin: o && { sceneId: o.sceneId, version: o.version, dirty: o.dirty }, seq: state.seq + 1 }, delta: emptyDelta(), dirtyPlayers: [] }
    }
    case "load-scene": {
      const prev = state.scene
      const owners: GameState["owners"] = {}
      for (const [id, list] of Object.entries(state.owners)) if (Object.hasOwn(cmd.scene.tokens, id)) owners[id] = list
      // Another map: the old origin no longer applies.
      const origin = cmd.origin ? { sceneId: cmd.origin.sceneId, version: cmd.origin.version, dirty: cmd.origin.dirty } : null
      const next: GameState = { ...state, scene: cmd.scene, owners, explored: {}, memory: {}, revealed: {}, seq: state.seq + 1, origin }
      // Combat is about the old map's tokens; the table log stays.
      if (state.table?.combat) next.table = { ...tableOf(state), combat: null }
      const delta: SceneDelta = {
        objects: sorted([...Object.keys(prev.objects), ...Object.keys(cmd.scene.objects)]),
        tokens: sorted([...Object.keys(prev.tokens), ...Object.keys(cmd.scene.tokens)]),
        terrain: [],
        structure: true,
      }
      return { state: next, delta, dirtyPlayers: "all" }
    }
    case "add-player": {
      const p = own(state.players, cmd.userId)
      if (p && p.displayName === cmd.displayName) return noop(state)
      const player = p ? { ...p, displayName: cmd.displayName } : { userId: cmd.userId, displayName: cmd.displayName, color: nextPlayerColor(state), movementLocked: false }
      return { state: { ...state, players: { ...state.players, [cmd.userId]: player }, seq: state.seq + 1 }, delta: emptyDelta(), dirtyPlayers: [cmd.userId] }
    }
    case "remove-player": {
      if (!Object.hasOwn(state.players, cmd.userId)) return noop(state, "unknown player")
      const without = <T>(rec: Record<string, T>): Record<string, T> => {
        const out = { ...rec }
        delete out[cmd.userId]
        return out
      }
      const owners: GameState["owners"] = {}
      for (const [id, list] of Object.entries(state.owners)) {
        const rest = list.filter((u) => u !== cmd.userId)
        if (rest.length > 0) owners[id] = rest
      }
      const next: GameState = {
        ...state,
        players: without(state.players),
        explored: without(state.explored),
        memory: without(state.memory),
        revealed: without(state.revealed),
        owners,
        seq: state.seq + 1,
      }
      return { state: next, delta: emptyDelta(), dirtyPlayers: "all" }
    }
    case "rebind-player": {
      const { fromUserId: from, toUserId: to } = cmd
      if (from === to || !Object.hasOwn(state.players, from)) return noop(state, "unknown player")
      const move = <T>(rec: Record<string, T>, fix?: (v: T) => T): Record<string, T> => {
        const out = { ...rec }
        if (Object.hasOwn(rec, from)) {
          out[to] = fix ? fix(rec[from]) : rec[from]
          delete out[from]
        }
        return out
      }
      const owners: GameState["owners"] = {}
      for (const [id, list] of Object.entries(state.owners)) owners[id] = [...new Set(list.map((u) => (u === from ? to : u)))].sort()
      const next: GameState = {
        ...state,
        players: move(state.players, (p) => ({ ...p, userId: to })),
        explored: move(state.explored),
        memory: move(state.memory),
        revealed: move(state.revealed),
        owners,
        seq: state.seq + 1,
      }
      if (state.table) next.table = rebindTable(state.table, from, to)
      return { state: next, delta: emptyDelta(), dirtyPlayers: [from, to] }
    }
    case "reset-fog": {
      const uids = cmd.userId === undefined ? Object.keys(state.players) : [cmd.userId]
      const explored = { ...state.explored }
      const memory = { ...state.memory }
      for (const uid of uids) {
        explored[uid] = {}
        memory[uid] = {}
      }
      return { state: { ...state, explored, memory, seq: state.seq + 1 }, delta: emptyDelta(), dirtyPlayers: cmd.userId === undefined ? "all" : [cmd.userId] }
    }
  }
}
