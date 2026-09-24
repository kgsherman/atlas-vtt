/**
 * Test harness for core/session: a minimal host (the same pipeline as ARCHITECTURE §6.2) driving the
 * REAL vision engine — reduce → vision update → compute → updateKnowledge → filter → diff.
 */
import { createFloor, createLevel, createScene, createToken } from "../scene/factory"
import type { Id, Level, Rect, Scene, SceneObject, Token } from "../scene/types"
import { VisionEngineImpl } from "../vision/engine"
import type { VisibilityResult } from "../vision/types"
import { applyPatchOps, diffViews } from "./diff"
import { filterForPlayer } from "./filter"
import { updateKnowledge } from "./memory"
import { reduceDm } from "./reduceDm"
import { reduceRequest, type StateRequest } from "./reduceRequest"
import type { TableContext } from "./table"
import { createGameState, perceivedCellLookup, sceneWithTokenAt, viewerTokenIds, type ReduceResult, type RequestOutcome, type SceneDelta } from "./state"
import type { DmCommand, GameState, PatchOp, PlayerView } from "./types"

export class TestHost {
  state: GameState
  readonly engine: VisionEngineImpl
  /** Last view sent per player (as the client holds it: built by applying patches). */
  readonly sent = new Map<string, PlayerView>()
  readonly lastVis = new Map<string, VisibilityResult>()

  constructor(scene: Scene, players: string[] = ["p1"]) {
    this.state = createGameState({ sessionId: "sess-1", roomCode: "ROOM1234", scene })
    this.engine = new VisionEngineImpl(scene)
    for (const uid of players) this.dm({ t: "add-player", userId: uid, displayName: uid })
  }

  get scene(): Scene {
    return this.state.scene
  }

  private sync(delta: SceneDelta): void {
    if (delta.structure || delta.objects.length || delta.tokens.length || delta.terrain.length) {
      this.engine.update(this.state.scene, { objects: delta.objects, tokens: delta.tokens, terrain: delta.terrain, structure: delta.structure })
    }
  }

  dm(cmd: DmCommand): ReduceResult {
    const r = reduceDm(this.state, cmd)
    this.state = r.state
    this.sync(r.delta)
    return r
  }

  assign(tokenId: Id, uid = "p1"): void {
    this.dm({ t: "assign-token", tokenId, userId: uid, assigned: true })
  }

  /** Visibility for a player's viewers on the current scene. */
  vis(uid = "p1"): VisibilityResult {
    const viewers = viewerTokenIds(this.state, uid).map((id) => this.engine.viewerFor(this.state.scene.tokens[id]))
    const v = this.engine.compute(viewers)
    this.lastVis.set(uid, v)
    return v
  }

  /** Recompute a player's knowledge and view; returns the view and the ops that were "sent". */
  refresh(uid = "p1"): { view: PlayerView; ops: PatchOp[]; vis: VisibilityResult } {
    const vis = this.vis(uid)
    this.state = updateKnowledge(this.state, uid, vis)
    const view = filterForPlayer(this.state, uid, vis)
    const prev = this.sent.get(uid) ?? null
    const ops = diffViews(prev, view)
    this.sent.set(uid, prev ? applyPatchOps(prev, ops) : view)
    return { view, ops, vis }
  }

  /** A player request through reduceRequest, with per-step knowledge passes for applied moves. */
  request(uid: string, msg: StateRequest, table?: TableContext): RequestOutcome {
    const out = reduceRequest(this.state, uid, msg, {
      world: this.engine.world,
      currentView: this.sent.get(uid) ?? null,
      perceivedByPlayer: perceivedCellLookup(this.lastVis.get(uid) ?? this.vis(uid)),
      ...(table ? { table } : {}),
    })
    this.state = out.state
    if (out.tokenId && out.visited.length > 1) {
      // Every intermediate position gets a visibility pass (ARCHITECTURE §5.2 "Moves").
      for (const step of out.visited.slice(0, -1)) {
        const scene = sceneWithTokenAt(this.state.scene, out.tokenId, step)
        this.engine.update(scene, { tokens: [out.tokenId], objects: out.delta.objects })
        const viewers = viewerTokenIds(this.state, uid).map((id) => this.engine.viewerFor(scene.tokens[id]))
        this.state = updateKnowledge(this.state, uid, this.engine.compute(viewers))
      }
    }
    this.sync(out.delta)
    return out
  }
}

// ---------------------------------------------------------------------------
// Scene builders
// ---------------------------------------------------------------------------

/** One level with a full floor. Light "bright" everywhere or "dark" everywhere. */
export function flatScene(width: number, depth: number, light: "bright" | "dark" = "bright"): { scene: Scene; ground: Id } {
  const scene = createScene({ width, depth })
  scene.environment.skyLevel = light
  scene.environment.ambientLevel = light
  return { scene, ground: Object.keys(scene.levels)[0] }
}

export function add<T extends SceneObject>(scene: Scene, o: T): T {
  scene.objects[o.id] = o
  return o
}

export function addLevel(scene: Scene, partial: Partial<Level>, floor?: Rect): Level {
  const level = createLevel(partial)
  scene.levels[level.id] = level
  if (floor) add(scene, createFloor(level.id, floor))
  return level
}

export function addToken(scene: Scene, levelId: Id, x: number, z: number, partial: Partial<Token> = {}): Token {
  const t = createToken(levelId, { x, z }, partial)
  scene.tokens[t.id] = t
  return t
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
