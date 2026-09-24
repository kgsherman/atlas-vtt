/**
 * filterForPlayer — THE ONLY path by which scene data reaches a player (docs/ARCHITECTURE.md §6.2).
 *
 * Every field of the PlayerView is built explicitly from allowlisted sources:
 *  - objects come from the player's MEMORY only (never straight from the scene), clipped to explored
 *    cells without dilation (clip.ts). The live scene is consulted only to drop things that must not
 *    exist for players any more (hidden objects, secret doors not revealed to this player);
 *  - wall pieces keep `followTerrain`; a follow-terrain piece on a heightmap level also carries the host's
 *    base line along its centreline (`terrainProfile`, at core/scene/wallProfile `wallBaseKnots`), so the
 *    client draws the host's tops and opening heights even where its clipped terrain lacks samples. It
 *    reveals only the ground under the piece's centreline, which the piece's own top already reveals;
 *  - lights: remembered static lights (emitting = currently illuminating something perceived) and lights
 *    carried by tokens in the view (resolved, emitting = on). Never attachment ids;
 *  - tokens: controlled + vision tokens always, others while visible, never hidden ones; DM names,
 *    senses, speed and exact hit points only for tokens the player controls or sees through (others: a
 *    coarse health band unless the DM hides wounds); conditions for every token sent;
 *  - levels: explored ("known") levels + stubs for levels referenced by sent connectors, tokens, lights;
 *  - terrain chunks overlapping explored cells with unexplored samples zeroed; masks;
 *  - backdrops: placement only (rect, opacity, tintWalls, tile size) for known levels with a map image —
 *    never the asset id, its name or any pixels (tiles of explored cells travel separately, net/assets);
 *  - table (`playerTable`): the messages this player may read (public ones, their own, whispers to them)
 *    without any user id; the combat entries not hidden by the DM whose token is in this view (or custom
 *    entries), named like the view's tokens, and the acting entry only when it is one of them.
 * Pings (`pingForPlayer`, sent outside the view) reach a player only on levels they know.
 * Masked floors are clipped by their covered rects (floorRects) and sent as plain rect pieces: a floor
 * mask never reaches a player.
 * Precondition: updateKnowledge(state, uid, vis) has been applied for the same `vis`.
 */
import type { RolledTerm, RollResult } from "../dice/dice"
import { TerrainSampler } from "../occlusion/terrain"
import { sampleSpacing } from "../scene/heightmap"
import { groundHeightAt, levelById, lightEffectivelyHidden, lightWorldPosition, sortedLevels, wallLength } from "../scene/queries"
import { healthBand } from "../scene/tokenStatus"
import type { ConnectorObject, Environment, Id, Level, LightObject, Scene, SceneObject, Token, Vec2 } from "../scene/types"
import { wallBaseKnots, wallProfile, type WallProfile } from "../scene/wallProfile"
import { encodeGrades, encodeMask, createCellMask, getCell, setCell } from "../vision/mask"
import { objectFootprint } from "../vision/observe"
import type { EncodedGrades, EncodedMask, VisibilityResult } from "../vision/types"
import { clipTerrainChunk, exploredLevel, footprintTouchesExplored, maskedFloorExploredRects, mergeRuns, wallExploredRuns, type ExploredLevel, type Run } from "./clip"
import { emptyEncodedCellMask, emptyEncodedGrades, encodedMaskIsEmpty, maskMatchesGrid } from "./masks"
import { connectorsOnly, rememberedFootprint } from "./memory"
import { MAX_TERRAIN_PROFILE } from "./playerViewSchema"
import { sanitizeLight, type MemoryFloor } from "./sanitize"
import { controlledTokenIds, movementLockedFor, own, tokenExistsForPlayers, viewerTokenIds } from "./state"
import { canRead, TABLE_LIMITS } from "./table"
import {
  PLAYER_VIEW_VERSION,
  type GameState,
  type PlayerBackdrop,
  type PlayerConnector,
  type PlayerDoor,
  type PlayerFloor,
  type PlayerLevel,
  type PlayerLevelMasks,
  type PlayerCombat,
  type PlayerLight,
  type PlayerObject,
  type PlayerPing,
  type PlayerTable,
  type PlayerTableMessage,
  type PlayerToken,
  type PlayerView,
  type PlayerWall,
  type PlayerWindow,
  type TableMessage,
} from "./types"
import { playerBackdrop } from "./backdrop"
import { pieceId, sortedKeys } from "./util"
import { levelFromPlayer, objectFromPlayer } from "./viewToScene"

export { MAX_BACKDROP_TILE_PX, playerBackdrop } from "./backdrop"

// ---------------------------------------------------------------------------
// Memoisation of per-object clipping (memory entries and explored masks are immutable values).
// ---------------------------------------------------------------------------

interface Memo<T> {
  deps: readonly unknown[]
  value: T
}

/** Two-level cache: by the player's explored level (so players sharing an object don't thrash), then by object. */
type MemoCache<T> = WeakMap<object, WeakMap<object, Memo<T>>>

const NO_LEVEL = {}

function memo<T>(cache: MemoCache<T>, level: object | null, key: object, deps: readonly unknown[], fn: () => T): T {
  const primary = level ?? NO_LEVEL
  let byKey = cache.get(primary)
  if (!byKey) cache.set(primary, (byKey = new WeakMap()))
  const hit = byKey.get(key)
  if (hit && hit.deps.length === deps.length && hit.deps.every((d, k) => d === deps[k])) return hit.value
  const value = fn()
  byKey.set(key, { deps, value })
  return value
}

const wallRunsCache: MemoCache<Run[]> = new WeakMap()
const floorCache: MemoCache<{ x: number; z: number; w: number; d: number }[]> = new WeakMap()
const wholeCache: MemoCache<boolean> = new WeakMap()
const attachedCache = new WeakMap<object, LightObject[]>()
/** Base line of a remembered follow-terrain wall on the host terrain, per heightmap revision (shared by players). */
const hostProfileCache: MemoCache<WallProfile> = new WeakMap()
/** terrainProfile per piece span of a host base line (the same array across flushes and players). */
const pieceProfileCache = new WeakMap<WallProfile, Map<string, number[]>>()
const PIECE_PROFILE_LIMIT = 64

/** Lights attached to a token (cached per objects-record revision). */
function attachedLights(scene: Pick<Scene, "objects">): LightObject[] {
  let out = attachedCache.get(scene.objects)
  if (!out) {
    out = []
    for (const id of Object.keys(scene.objects).sort()) {
      const o = scene.objects[id]
      if (o.type === "light" && o.attachedTokenId !== null) out.push(o)
    }
    attachedCache.set(scene.objects, out)
  }
  return out
}

// ---------------------------------------------------------------------------
// Explicit builders (never spread DM objects)
// ---------------------------------------------------------------------------

function playerToken(t: Token, full: boolean, wounds: boolean): PlayerToken {
  const out: PlayerToken = {
    id: t.id,
    levelId: t.levelId,
    position: { x: t.position.x, z: t.position.z },
    size: t.size,
    height: t.height,
    color: t.color,
    imageUrl: t.imageUrl,
    label: t.label,
  }
  // What the token looks like: every player who sees it may see its figure.
  if (t.model !== undefined) out.model = t.model
  if (full) {
    out.name = t.name
    out.eyeHeight = t.eyeHeight
    out.vision = { darkvision: t.vision.darkvision, blindsight: t.vision.blindsight, blind: t.vision.blind }
    out.speed = t.speed
  }
  // Health: exact for the player's own (and party) tokens, else at most the coarse band.
  if (t.hp) {
    if (full) out.hp = { current: t.hp.current, max: t.hp.max, temp: t.hp.temp }
    else if (wounds) out.health = healthBand(t.hp)
  }
  // Conditions show on the token: whoever sees it sees them.
  if (t.conditions && t.conditions.length > 0) out.conditions = [...t.conditions]
  return out
}

function playerEnvironment(e: Environment): Environment {
  const d = e.directional
  return {
    skyLevel: e.skyLevel,
    ambientLevel: e.ambientLevel,
    ambientColor: e.ambientColor,
    ambientIntensity: e.ambientIntensity,
    directional: {
      enabled: d.enabled,
      kind: d.kind,
      azimuth: d.azimuth,
      elevation: d.elevation,
      color: d.color,
      intensity: d.intensity,
      grants: d.grants,
    },
    backgroundColor: e.backgroundColor,
  }
}

function playerLevel(l: Level, known: boolean): PlayerLevel {
  return {
    id: l.id,
    known,
    name: known ? l.name : null,
    elevation: l.elevation,
    height: l.height,
    floorThickness: l.floorThickness,
    terrainResolution: known && l.heightmap ? l.heightmap.resolution : null,
  }
}

function copyConnector(m: PlayerConnector): PlayerConnector {
  return {
    id: m.id,
    type: "connector",
    levelId: m.levelId,
    style: m.style,
    toLevelId: m.toLevelId,
    rect: { x: m.rect.x, z: m.rect.z, w: m.rect.w, d: m.rect.d },
    direction: m.direction,
    material: m.material,
  }
}

function copyOpening(m: PlayerDoor | PlayerWindow, wallId: Id, offset: number): PlayerDoor | PlayerWindow {
  if (m.type === "door") {
    return {
      id: m.id,
      type: "door",
      levelId: m.levelId,
      wallId,
      offset,
      width: m.width,
      height: m.height,
      leaves: m.leaves,
      hinge: m.hinge,
      swing: m.swing,
      state: m.state,
      style: m.style,
    }
  }
  return { id: m.id, type: "window", levelId: m.levelId, wallId, offset, width: m.width, sillHeight: m.sillHeight, height: m.height }
}

/** Pillars and props are sent whole (as remembered) or not at all. */
function copyWhole(m: PlayerObject): PlayerObject | null {
  switch (m.type) {
    case "pillar":
      return { id: m.id, type: "pillar", levelId: m.levelId, position: { x: m.position.x, z: m.position.z }, shape: m.shape, size: m.size, height: m.height, material: m.material }
    case "prop":
      return {
        id: m.id,
        type: "prop",
        levelId: m.levelId,
        kind: m.kind,
        position: { x: m.position.x, y: m.position.y, z: m.position.z },
        rotationY: m.rotationY,
        scale: { x: m.scale.x, y: m.scale.y, z: m.scale.z },
        color: m.color,
        blocksSight: m.blocksSight,
        castsShadows: m.castsShadows,
      }
    default:
      return null
  }
}

/**
 * PlayerWall.terrainProfile of the piece a→b spanning [t0, t1] along its host wall: the host's base line
 * (world Y) at the piece's base knots (wallBaseKnots, u feet from a ⇒ t0 + u on the host). Points on the
 * piece's centreline only. null when it would exceed the wire limit (the client then uses its own ground).
 */
function pieceTerrainProfile(host: WallProfile, spacing: number, t0: number, t1: number, a: Vec2, b: Vec2): number[] | null {
  let byPiece = pieceProfileCache.get(host)
  if (!byPiece) pieceProfileCache.set(host, (byPiece = new Map()))
  const key = `${t0},${t1}`
  let out = byPiece.get(key)
  if (out === undefined) {
    out = wallBaseKnots({ a, b }, spacing).map((u) => host.baseAt(t0 + u))
    if (byPiece.size >= PIECE_PROFILE_LIMIT) byPiece.clear()
    byPiece.set(key, out)
  }
  return out.length <= MAX_TERRAIN_PROFILE ? out : null
}

interface LightOut {
  base: PlayerLight
  levelId: Id
  x: number
  worldY: number
  z: number
  emitting: boolean
}

// ---------------------------------------------------------------------------
// filterForPlayer
// ---------------------------------------------------------------------------

/** The ONLY path by which data reaches a player (allowlists, clipping, memory). */
export function filterForPlayer(state: GameState, userId: string, vis: VisibilityResult): PlayerView {
  const scene = state.scene
  const grid = scene.grid
  const cellSize = grid.cellSize
  const exploredRec = own(state.explored, userId) ?? {}
  const memory = own(state.memory, userId) ?? {}
  const revealed = new Set(own(state.revealed, userId) ?? [])

  const exploredCache = new Map<Id, ExploredLevel | null>()
  const exploredOf = (levelId: Id): ExploredLevel | null => {
    let ex = exploredCache.get(levelId)
    if (ex === undefined) {
      const enc = own(exploredRec, levelId)
      ex = levelById(scene, levelId) && enc && maskMatchesGrid(enc, grid) && !encodedMaskIsEmpty(enc) ? exploredLevel(enc) : null
      exploredCache.set(levelId, ex)
    }
    return ex
  }

  // ---- tokens ------------------------------------------------------------
  const controlled = controlledTokenIds(state, userId)
  const visionIds = viewerTokenIds(state, userId)
  const full = new Set([...controlled, ...visionIds])
  const tokenIds = new Set(full)
  for (const id of vis.visibleTokenIds) tokenIds.add(id)
  const tokens: Record<Id, PlayerToken> = {}
  for (const id of [...tokenIds].sort()) {
    const t = tokenExistsForPlayers(state, id)
    if (t) tokens[id] = playerToken(t, full.has(id), state.hideWounds !== true)
  }

  // ---- objects from memory ------------------------------------------------
  const objects: Record<Id, PlayerObject> = {}
  const walls = new Map<Id, { wall: PlayerWall; runs: Run[] }>()
  const openings: (PlayerDoor | PlayerWindow)[] = []
  const staticLights: PlayerLight[] = []
  for (const id of sortedKeys(memory)) {
    const m = memory[id]
    const cur = own(scene.objects, id)
    // Things that must not exist for this player any more, whatever they remember: hidden objects
    // (lights carried by hidden tokens included) and secret doors not revealed to this player.
    if (cur && (cur.hidden || (cur.type === "light" && lightEffectivelyHidden(scene, cur)) || (cur.type === "door" && cur.style === "secret" && !revealed.has(id)))) continue
    if (!levelById(scene, m.levelId)) continue
    switch (m.type) {
      case "wall": {
        const ex = exploredOf(m.levelId)
        if (ex) walls.set(id, { wall: m, runs: memo(wallRunsCache, ex, m, [], () => wallExploredRuns(grid, m, ex.mask)) })
        break
      }
      case "floor": {
        const ex = exploredOf(m.levelId)
        if (!ex) break
        // Masked floors clip their covered rects; the mask itself stays in host memory.
        for (const r of memo(floorCache, ex, m, [], () => maskedFloorExploredRects(grid, m as MemoryFloor, ex.mask))) {
          const pid = pieceId(id, r.x, r.z)
          const piece: PlayerFloor = { id: pid, type: "floor", levelId: m.levelId, rect: { x: r.x, z: r.z, w: r.w, d: r.d }, material: m.material }
          if (m.thickness !== undefined) piece.thickness = m.thickness
          objects[pid] = piece
        }
        break
      }
      case "door":
      case "window":
        openings.push(m)
        break
      case "connector": {
        if (!levelById(scene, m.toLevelId)) break
        const exA = exploredOf(m.levelId)
        const exB = exploredOf(m.toLevelId)
        const touches = memo(wholeCache, exA, m, [exB], () =>
          footprintTouchesExplored(objectFootprint({ objects: {} }, m as unknown as SceneObject, () => []), exploredOf, cellSize)
        )
        if (touches) objects[id] = copyConnector(m)
        break
      }
      case "pillar":
      case "prop": {
        const ex = exploredOf(m.levelId)
        if (!ex) break
        const touches = memo(wholeCache, ex, m, [], () => footprintTouchesExplored(objectFootprint({ objects: {} }, m as unknown as SceneObject, () => []), exploredOf, cellSize))
        const copy = touches ? copyWhole(m) : null
        if (copy) objects[id] = copy
        break
      }
      case "light":
        staticLights.push(m)
        break
    }
  }

  // Openings: sent when their remembered host wall is sent and they overlap explored cells.
  const wallOpenings = new Map<Id, { o: PlayerDoor | PlayerWindow; t0: number; t1: number }[]>()
  for (const o of openings) {
    const w = walls.get(o.wallId)
    if (!w) continue
    const ex = exploredOf(o.levelId)
    const touches = memo(wholeCache, ex, o, [w.wall], () => footprintTouchesExplored(rememberedFootprint(o, memory, scene), exploredOf, cellSize))
    if (!touches) continue
    const len = wallLength(w.wall)
    const t0 = Math.max(0, Math.min(len, o.offset - o.width / 2))
    const t1 = Math.max(0, Math.min(len, o.offset + o.width / 2))
    let list = wallOpenings.get(o.wallId)
    if (!list) wallOpenings.set(o.wallId, (list = []))
    list.push({ o, t0, t1 })
  }

  // Host terrain per level, built only when a follow-terrain wall's base line is not cached yet.
  const grounds = new Map<Id, TerrainSampler>()
  const hostGround = (level: Level): TerrainSampler => {
    let g = grounds.get(level.id)
    if (!g) grounds.set(level.id, (g = new TerrainSampler(level, grid)))
    return g
  }

  // Walls → pieces (runs widened to contain their sent openings), openings re-parented. Pieces keep the
  // wall's followTerrain; on heightmap levels follow-terrain pieces carry the host's base line, so the
  // client's tops and opening heights are the host's whatever terrain it lacks (no rebasing needed).
  for (const [id, { wall, runs }] of walls) {
    const ops = wallOpenings.get(id) ?? []
    const rs = mergeRuns([...runs.map((r): Run => [r[0], r[1]]), ...ops.map((op): Run => [op.t0, op.t1])])
    if (rs.length === 0) continue
    const len = wallLength(wall)
    const ux = (wall.b.x - wall.a.x) / len
    const uz = (wall.b.z - wall.a.z) / len
    const at = (t: number) => (t <= 0 ? wall.a : t >= len ? wall.b : { x: wall.a.x + ux * t, z: wall.a.z + uz * t })
    // Memory written before followTerrain existed: such walls follow the terrain (like migrated scenes).
    const follow = wall.followTerrain !== false
    const level = levelById(scene, wall.levelId)!
    const hm = follow ? level.heightmap : null
    const host = hm
      ? memo(hostProfileCache, hm, wall, [level.elevation, cellSize, grid.width, grid.depth], () => {
          const hostWall = { a: wall.a, b: wall.b, height: wall.height, thickness: wall.thickness, followTerrain: true }
          return wallProfile(hostWall, hostGround(level), level.elevation, { a: 0, b: 0 })
        })
      : null
    const spacing = hm ? sampleSpacing(cellSize, hm.resolution) : 0
    const pieces: { pid: Id; t0: number; t1: number }[] = []
    for (const [t0, t1] of rs) {
      if (!(t1 - t0 > 1e-6)) continue
      const pa = at(t0)
      const pb = at(t1)
      const pid = pieceId(id, pa.x, pa.z)
      const piece: PlayerWall = {
        id: pid,
        type: "wall",
        levelId: wall.levelId,
        a: { x: pa.x, z: pa.z },
        b: { x: pb.x, z: pb.z },
        height: wall.height,
        thickness: wall.thickness,
        material: wall.material,
        followTerrain: follow,
      }
      const profile = host ? pieceTerrainProfile(host, spacing, t0, t1, piece.a, piece.b) : null
      if (profile) piece.terrainProfile = profile
      objects[pid] = piece
      pieces.push({ pid, t0, t1 })
    }
    for (const op of ops) {
      const k = pieces.findIndex((p) => p.t0 <= op.t0 + 1e-6 && op.t1 <= p.t1 + 1e-6)
      if (k >= 0) objects[op.o.id] = copyOpening(op.o, pieces[k].pid, op.o.offset - pieces[k].t0)
    }
  }

  // ---- lights ---------------------------------------------------------------
  const lights = new Map<Id, LightOut>()
  for (const m of staticLights) {
    const cur = own(scene.objects, m.id)
    // A remembered fixture of a light that has since been picked up by a token no longer emits here.
    const movedAway = cur !== undefined && cur.type === "light" && cur.attachedTokenId !== null
    lights.set(m.id, { base: m, levelId: m.levelId, x: m.position.x, worldY: m.position.y, z: m.position.z, emitting: !movedAway && vis.illuminatingLightIds.has(m.id) })
  }
  const liteScene = { levels: scene.levels, grid, objects: connectorsOnly(scene), tokens: scene.tokens }
  for (const l of attachedLights(scene)) {
    const carrierId = l.attachedTokenId!
    // Carried lights exist only while their carrier is in this view (hidden carriers never are).
    if (l.hidden || !Object.hasOwn(tokens, carrierId)) continue
    const carrier = scene.tokens[carrierId]
    const wp = lightWorldPosition(liteScene, l)
    lights.set(l.id, { base: sanitizeLight(l, wp.y), levelId: carrier.levelId, x: wp.x, worldY: wp.y, z: wp.z, emitting: l.on })
  }

  // ---- levels ----------------------------------------------------------------
  const known = new Set<Id>()
  for (const l of sortedLevels(scene)) if (exploredOf(l.id)) known.add(l.id)
  const referenced = new Set<Id>(known)
  for (const o of Object.values(objects)) {
    referenced.add(o.levelId)
    if (o.type === "connector") referenced.add(o.toLevelId)
  }
  for (const t of Object.values(tokens)) referenced.add(t.levelId)
  for (const l of lights.values()) referenced.add(l.levelId)
  const levels: Record<Id, PlayerLevel> = {}
  for (const l of sortedLevels(scene)) {
    if (referenced.has(l.id)) levels[l.id] = playerLevel(l, known.has(l.id))
  }

  // ---- terrain -----------------------------------------------------------------
  const terrain: Record<Id, Record<string, string>> = {}
  for (const levelId of known) {
    const hm = scene.levels[levelId].heightmap
    const ex = exploredOf(levelId)
    if (!hm || !ex) continue
    const chunks: Record<string, string> = {}
    let any = false
    for (const key of Object.keys(hm.chunks).sort()) {
      const clipped = clipTerrainChunk(hm.chunks[key], key, hm.resolution, grid, ex.mask)
      if (clipped !== null) {
        chunks[key] = clipped
        any = true
      }
    }
    if (any) terrain[levelId] = chunks
  }

  // ---- lights, resolved against the ground the player's client will compute ----------------
  const clientLevels: Record<Id, Level> = {}
  for (const id of Object.keys(levels)) clientLevels[id] = levelFromPlayer(levels[id], own(terrain, id))
  const clientConnectors: Record<Id, ConnectorObject> = {}
  for (const o of Object.values(objects)) {
    if (o.type === "connector") clientConnectors[o.id] = objectFromPlayer(o) as ConnectorObject
  }
  const clientScene = { grid, levels: clientLevels, objects: clientConnectors }

  for (const id of [...lights.keys()].sort()) {
    const l = lights.get(id)!
    if (!Object.hasOwn(levels, l.levelId)) continue
    const b = l.base
    const y = l.worldY - groundHeightAt(clientScene, l.levelId, { x: l.x, z: l.z })
    objects[id] = {
      id,
      type: "light",
      levelId: l.levelId,
      position: { x: l.x, y, z: l.z },
      color: b.color,
      intensity: b.intensity,
      brightRadius: b.brightRadius,
      dimRadius: b.dimRadius,
      flicker: { enabled: b.flicker.enabled, speed: b.flicker.speed, amount: b.flicker.amount },
      on: b.on,
      castsShadows: b.castsShadows,
      emitting: l.emitting,
    }
  }

  // ---- masks ---------------------------------------------------------------------
  const masks: Record<Id, PlayerLevelMasks> = {}
  for (const levelId of known) {
    const enc = own(exploredRec, levelId)!
    const explored: EncodedMask = { width: enc.width, depth: enc.depth, b64: enc.b64 }
    if (enc.partial) explored.partial = enc.partial
    const gm = own(vis.perception, levelId)
    let perception: EncodedGrades
    let sunlit: EncodedMask
    if (gm && maskMatchesGrid(gm, grid)) {
      perception = encodeGrades(gm)
      const sm = own(vis.sunlit, levelId)
      if (sm && maskMatchesGrid(sm, grid)) {
        // sunlit ∧ perceived (coarse cells).
        const out = createCellMask(grid.width, grid.depth)
        for (let c = 0; c < gm.grades.length; c++) if (gm.grades[c] > 0 && getCell(sm, c)) setCell(out, c, true)
        sunlit = encodeMask(out)
      } else {
        sunlit = emptyEncodedCellMask(grid.width, grid.depth)
      }
    } else {
      perception = emptyEncodedGrades(grid.width, grid.depth)
      sunlit = emptyEncodedCellMask(grid.width, grid.depth)
    }
    masks[levelId] = { perception, explored, sunlit }
  }

  // ---- backdrops (placement only) --------------------------------------------------
  const backdrops: Record<Id, PlayerBackdrop> = {}
  for (const levelId of known) {
    const b = playerBackdrop(scene, levelId)
    if (b) backdrops[levelId] = b
  }

  const view: PlayerView = {
    viewVersion: PLAYER_VIEW_VERSION,
    sessionId: state.sessionId,
    userId,
    scene: {
      name: scene.name,
      grid: { cellSize: grid.cellSize, width: grid.width, depth: grid.depth, diagonalRule: grid.diagonalRule },
      environment: playerEnvironment(scene.environment),
      levels,
    },
    objects,
    tokens,
    terrain,
    masks,
    controlledTokenIds: controlled,
    visionTokenIds: visionIds,
    flags: {
      movementLocked: movementLockedFor(state, userId),
      sharedVision: state.sharedVision,
      enforceSpeed: state.enforceSpeed,
      ...(state.freeMovement ? { freeMovement: true } : {}),
    },
  }
  if (Object.keys(backdrops).length > 0) view.backdrops = backdrops
  const table = playerTable(state, userId, tokens, full)
  if (table) view.table = table
  return view
}

// ---------------------------------------------------------------------------
// The table (chat, dice, combat) and pings
// ---------------------------------------------------------------------------

function copyRoll(r: RollResult): RollResult {
  return {
    formula: r.formula,
    total: r.total,
    terms: r.terms.map(
      (t): RolledTerm =>
        t.kind === "const"
          ? { kind: "const", sign: t.sign, value: t.value }
          : {
              kind: "dice",
              sign: t.sign,
              count: t.count,
              sides: t.sides,
              explode: t.explode,
              keep: t.keep ? { mode: t.keep.mode, n: t.keep.n } : null,
              rolls: [...t.rolls],
              dropped: [...t.dropped],
            }
    ),
  }
}

/** Wire messages per (message, reader): the same object across flushes, so diffs compare by identity. */
const messageCache = new WeakMap<TableMessage, Map<string, PlayerTableMessage>>()

function playerMessage(m: TableMessage, userId: string): PlayerTableMessage {
  let byUser = messageCache.get(m)
  if (!byUser) messageCache.set(m, (byUser = new Map()))
  let out = byUser.get(userId)
  if (!out) {
    out = {
      id: m.id,
      at: m.at,
      kind: m.kind,
      name: m.name,
      color: m.color,
      mine: m.from === userId,
      dm: m.from === null && m.kind !== "system",
      whisper: m.to !== "all",
      text: m.text,
    }
    if (m.roll) out.roll = copyRoll(m.roll)
    byUser.set(userId, out)
  }
  return out
}

/**
 * What a player may see of the table: messages they may read (newest TABLE_LIMITS.maxViewLog), and
 * combat entries not hidden by the DM that are custom or a token in this view (`tokens`: the view's
 * tokens; `full`: those whose DM name the player may see). null when there is nothing to show.
 */
function playerTable(state: GameState, userId: string, tokens: Record<Id, PlayerToken>, full: ReadonlySet<Id>): PlayerTable | null {
  const table = state.table
  if (!table) return null
  const log: Record<Id, PlayerTableMessage> = {}
  let n = 0
  for (let k = table.log.length - 1; k >= 0 && n < TABLE_LIMITS.maxViewLog; k--) {
    const m = table.log[k]
    if (!canRead(m, userId)) continue
    log[m.id] = playerMessage(m, userId)
    n++
  }
  let combat: PlayerCombat | null = null
  const c = table.combat
  if (c) {
    const entries: PlayerCombat["entries"] = []
    for (const e of c.entries) {
      if (e.hidden) continue
      if (e.tokenId === null) {
        entries.push({ id: e.id, tokenId: null, name: e.name, initiative: e.initiative })
        continue
      }
      const t = own(tokens, e.tokenId)
      if (!t) continue
      const name = (full.has(e.tokenId) ? t.name : null) ?? t.label ?? ""
      entries.push({ id: e.id, tokenId: e.tokenId, name, initiative: e.initiative })
    }
    const activeId = c.activeId !== null && entries.some((e) => e.id === c.activeId) ? c.activeId : null
    combat = { round: c.round, activeId, entries }
  }
  if (n === 0 && combat === null) return null
  return { log, combat }
}

/** Whether a view shows a level as explored (not a stub): the levels a player may ping on and be pinged on. */
export function levelKnown(view: PlayerView | null, levelId: Id): boolean {
  return view !== null && own(view.scene.levels, levelId)?.known === true
}

/** A ping as the host holds it (the sender's name and colour resolved by the host, never from a payload). */
export interface TablePing {
  levelId: Id
  x: number
  z: number
  name: string
  color: string
  focus: boolean
}

/**
 * What a player is sent of a ping: nothing unless its level is one they know (explored), so a ping never
 * reveals a level. `view`: the view last sent to that player.
 */
export function pingForPlayer(ping: TablePing, view: PlayerView | null): PlayerPing | null {
  if (!Number.isFinite(ping.x) || !Number.isFinite(ping.z) || !levelKnown(view, ping.levelId)) return null
  return { levelId: ping.levelId, x: ping.x, z: ping.z, name: ping.name, color: ping.color, focus: ping.focus }
}
