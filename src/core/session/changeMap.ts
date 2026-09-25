/**
 * Changing the map mid-game and bringing the party along (docs/ARCHITECTURE.md §6.7).
 *
 * `carryParty` composes the new map: the target scene plus the chosen tokens of the current one, copied
 * whole (hit points, conditions, portrait, model, senses…) with the lights they carry, standing on free,
 * standable squares around the arrival point (core/movement arrivalAnchors). Token ids are kept, so their
 * owners, the players' selections and anything keyed by token id carry over; a token of the target with
 * the same id (a duplicated map holds the same ids) or of the same world character (Token.characterId,
 * §6.9: the DM placed the party there beforehand) is replaced by the one arriving, lights it carried
 * included. An id that clashes with a level or object of the target is renamed (`carried` maps old → new).
 * Neither scene is changed.
 *
 * `changeMapCommand` builds the `load-scene` command that swaps the game to it atomically on the host state
 * (the reducer keeps only the carried tokens' owners and posts the notice): build it from the host's current
 * state and dispatch it in the same step.
 */
import { cleanText } from "../dice/dice"
import { arrivalAnchors, arrivalOrder, type Arrival } from "../movement/arrival"
import { anchorPosition } from "../movement"
import { buildOcclusionWorld } from "../occlusion"
import type { OcclusionWorld } from "../occlusion/types"
import { newId as sceneId } from "../scene/factory"
import { levelById } from "../scene/queries"
import { SCENE_LIMITS } from "../scene/schema"
import type { Id, LightObject, Scene, SceneObject, Token } from "../scene/types"
import { attachedLightIds } from "./state"
import { TABLE_LIMITS, tableStamp, type TableContext } from "./table"
import type { DmCommand, GameState, SceneOrigin } from "./types"
import { own } from "./util"

export type { Arrival } from "../movement/arrival"

export interface CarryOptions {
  /** Tokens of the current map to bring (unknown ids are ignored). */
  tokenIds: readonly Id[]
  /** Where they land on the target map. */
  arrival: Arrival
}

export type CarryError = "unknown-level" | "too-many" | "no-room"

export type CarryResult =
  | {
      ok: true
      scene: Scene
      /** Carried token ids: old id → id in `scene` (the same unless it had to be renamed). */
      carried: Record<Id, Id>
    }
  | { ok: false; error: CarryError; unplaced: Id[] }

export interface CarryDeps {
  /** The occlusion world of `target` (tokens and lights are not occluders, so it is the result's too). Built when absent. */
  world?: OcclusionWorld
  newId?: () => Id
}

/** The target scene with the chosen tokens of `source` (and their lights) standing around the arrival point. */
export function carryParty(source: Pick<Scene, "tokens" | "objects">, target: Scene, opts: CarryOptions, deps: CarryDeps = {}): CarryResult {
  const { arrival } = opts
  if (!levelById(target, arrival.levelId) || !Number.isFinite(arrival.x) || !Number.isFinite(arrival.z))
    return { ok: false, error: "unknown-level", unplaced: [] }
  const party = [...new Set(opts.tokenIds)].filter((id) => Object.hasOwn(source.tokens, id)).sort()
  if (party.length === 0) return { ok: true, scene: target, carried: {} }
  const partySet = new Set(party)
  const nextId = deps.newId ?? sceneId

  // The target without the tokens being replaced (the same id, or the same world character: a character is
  // never twice on a scene) and the lights they carried.
  const characters = new Set(party.map((id) => source.tokens[id].characterId).filter((c): c is Id => !!c))
  const replaced = (t: Token) => partySet.has(t.id) || (!!t.characterId && characters.has(t.characterId))
  const tokens: Record<Id, Token> = {}
  const gone = new Set<Id>()
  for (const id of Object.keys(target.tokens).sort()) {
    if (replaced(target.tokens[id])) gone.add(id)
    else tokens[id] = target.tokens[id]
  }
  const objects: Record<Id, SceneObject> = {}
  for (const id of Object.keys(target.objects).sort()) {
    const o = target.objects[id]
    if (o.type === "light" && o.attachedTokenId !== null && gone.has(o.attachedTokenId)) continue
    objects[id] = o
  }
  const taken = new Set<string>([...Object.keys(target.levels), ...Object.keys(objects), ...Object.keys(tokens)])
  const fresh = (): Id => {
    for (;;) {
      const id = nextId()
      if (!taken.has(id)) return id
    }
  }

  // Ids: kept unless they clash with the target's levels or objects (tokens with the same id were removed).
  const carried: Record<Id, Id> = {}
  for (const id of party) {
    const to = taken.has(id) ? fresh() : id
    taken.add(to)
    carried[id] = to
  }

  // Places, in arrival order, on the target as it will stand (its remaining visible tokens avoided).
  const world = deps.world ?? buildOcclusionWorld(target)
  const arriving = party.map((id) => source.tokens[id])
  const anchors = arrivalAnchors({ ...target, tokens, objects }, world, arriving, arrival, { standing: Object.values(tokens) })
  const unplaced = arrivalOrder(arriving)
    .filter((t) => !anchors.has(t.id))
    .map((t) => t.id)
  if (unplaced.length > 0) return { ok: false, error: "no-room", unplaced }

  for (const id of party) {
    const t = source.tokens[id]
    tokens[carried[id]] = { ...t, id: carried[id], levelId: arrival.levelId, position: anchorPosition(target, t.size, anchors.get(id)!) }
  }
  // Lights travel with their carrier: the same offset from it, on its new level.
  for (const id of party) {
    for (const lightId of attachedLightIds(source, id)) {
      const l = source.objects[lightId] as LightObject
      const to = taken.has(lightId) ? fresh() : lightId
      taken.add(to)
      objects[to] = { ...l, id: to, levelId: arrival.levelId, attachedTokenId: carried[id] }
    }
  }
  if (Object.keys(tokens).length > SCENE_LIMITS.maxTokens || Object.keys(objects).length > SCENE_LIMITS.maxObjects)
    return { ok: false, error: "too-many", unplaced: [] }
  return { ok: true, scene: { ...target, tokens, objects }, carried }
}

/** The notice posted when the game moves to `name`. */
export function travelNotice(name: string, carried: number): string {
  const where = cleanText(name, TABLE_LIMITS.maxName) || "a new scene"
  return carried > 0 ? `The party travels to ${where}` : `The game moves to ${where}`
}

export type ChangeMapResult =
  { ok: true; cmd: Extract<DmCommand, { t: "load-scene" }>; carried: Record<Id, Id> } | { ok: false; error: CarryError; unplaced: Id[] }

/**
 * The `load-scene` command that moves the game to `target`, bringing `opts.tokenIds` of the current map
 * (the host's `state`) along. Build and dispatch it together: it copies the tokens as they are now.
 */
export function changeMapCommand(
  state: Pick<GameState, "scene">,
  target: Scene,
  opts: CarryOptions & { origin?: SceneOrigin | null },
  ctx: Pick<TableContext, "now" | "newId"> & { world?: OcclusionWorld }
): ChangeMapResult {
  const r = carryParty(state.scene, target, opts, { world: ctx.world, newId: ctx.newId })
  if (!r.ok) return r
  const cmd: Extract<DmCommand, { t: "load-scene" }> = {
    t: "load-scene",
    scene: r.scene,
    carried: r.carried,
    stamp: tableStamp(ctx),
    // Public: hidden arrivals do not count (players must not learn one came along).
    notice: travelNotice(target.name, Object.values(r.carried).filter((to) => !r.scene.tokens[to]?.hidden).length),
  }
  if (opts.origin !== undefined) cmd.origin = opts.origin
  return { ok: true, cmd, carried: r.carried }
}

/** Owners after a map change that carried `carried` (old id → new id): only carried tokens keep theirs. */
export function carriedOwners(owners: GameState["owners"], carried: Record<Id, Id>, scene: Pick<Scene, "tokens">): GameState["owners"] {
  const out: GameState["owners"] = {}
  for (const from of Object.keys(carried).sort()) {
    const to = carried[from]
    const list = own(owners, from)
    if (list && list.length > 0 && typeof to === "string" && Object.hasOwn(scene.tokens, to)) out[to] = [...list]
  }
  return out
}
