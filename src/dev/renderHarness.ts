/**
 * Dev render harness (served by Vite at /dev/render.html): one engine on a full-window canvas, set up
 * from URL parameters, for eyeballing the renderer and for browser automation. Not part of the app.
 *
 * Parameters (all optional):
 *   sample    crooked-lantern | stress-test | empty | vineyard-test (crooked-lantern). vineyard-test: the
 *             Forgotten Adventures maps in test_maps/ as a 27×47, 3-level scene with backdrops (dev/vineyard.ts)
 *   mode      editor | dm-play | player                              (editor)
 *   vision    off | fog | preview                                    (player → fog, otherwise off)
 *   level     active level index in elevation order (0 = lowest)    (the first viewer's level, else the
 *             lowest level with a floor at elevation ≥ 0)
 *   viewer    token name(s), comma separated; case-insensitive prefix match on name or label
 *             (fog/preview default: the first PC by name)
 *   place     "name@level:x,z;…" moves tokens before anything else (level = index in elevation order)
 *   camera    orbit | topdown                                        (editor → orbit, otherwise topdown)
 *   quality   low | medium | high | ultra | auto                     (high; auto = probeQuality(), cached per
 *             GPU in localStorage; reprobe=1 ignores the cache)
 *   backdrop  "<levelIndex>:<url>", repeatable: a battlemap image over the whole grid of that level
 *             (decoded with createImageBitmap at 140 px per cell, e.g. /test_maps/<file>)
 *   opacity   backdrop opacity 0..1 (1); tint 0 | 1 wall tint from the image (1)
 *   adaptive  1 = adaptive quality on (default 0: the requested tier stays fixed for measurements)
 *   portraits 1 = give every token a generated portrait image (token imageUrl)
 *   models    "<url prefix>": token models are loaded from `<prefix>/<assetId>.glb`; with `modelids`
 *             "id,id,…" the tokens (by name) get these free models in turn (e.g. the output folder of
 *             scripts/free-assets/build-token-models.mjs, served with CORS)
 *   postview  ao | bloom: show one post-processing buffer (high / ultra tuning)
 *   floor     material id: every floor of the scene uses it (eyeballing procedural materials)
 *   tilt      player camera tilt, degrees                            (15)
 *   rotate    player camera quarter turns
 *   at        "x,z" look-at point on the active level                (player/dm-play: the first viewer)
 *   zoom      top-down view height / orbit distance, feet
 *   orbit     "azimuthDeg,elevationDeg" orbit camera direction (azimuth 0 = from +Z, 90 = from +X)
 *   refine    0 | 1 GPU line-of-sight refinement                     (1)
 *   explored  perceived | all                                        (perceived: explored = perceived ∪ trail)
 *   trail     "x,z;x,z" earlier positions of the first viewer; what it perceived there is explored
 *   ghost     1 = editor ghosts of the adjacent levels
 *   grid, helpers, cutaway   0 | 1
 *   dark      1 = DM dark vision (vision off only)
 *   stats     0 hides the stats corner (F3 toggles it)
 *   moon      0 | 1 overrides the directional light's on/off state
 *   lights    0 turns every point light off; "name,name" keeps only these lights on
 *   pipeline  1 = player mode renders what a player is actually sent: GameState → core/vision →
 *             updateKnowledge → filterForPlayer → viewToScene, with the view's own masks (ARCHITECTURE §6.2)
 *
 * Player mode renders the full document minus hidden objects and tokens the viewers cannot see (the
 * editor's "preview player view"; ARCHITECTURE §7), with host masks computed here by core/vision, or,
 * with pipeline=1, the scene rebuilt from the filtered PlayerView.
 * Automation: window.__atlas = { engine, bench, stats, hostMasks, scene, view, frames, ready, error, info }.
 * `ready` waits for the first frames AND every backdrop image; `info.quality` records an auto pick.
 */
import { orInto, createCellMask, createGradeMask, encodeGrades, encodeMask, perceivedCells, setCell, createVisionEngine } from "@/core/vision"
import type { CellMask, VisibilityResult } from "@/core/vision"
import { effectiveFloorRects, sortedLevels, tokenGroundY } from "@/core/scene/queries"
import { sampleById, SAMPLE_SCENES } from "@/core/scene/samples"
import { MATERIAL_COLORS } from "@/core/scene/defaults"
import type { Id, MaterialId, Scene, SceneLike, Token, Vec2, Vec3 } from "@/core/scene/types"
import { createGameState, filterForPlayer, reduceDm, updateKnowledge, viewerTokenIds, viewToScene, type GameState } from "@/core/session"
import { createEngine, DEFAULT_VIEW, pickInitialQuality, probeQuality, type QualityProbe } from "@/render"
import type { Engine, FrameStats, HostLevelMasks, Quality, RenderMode, ViewState, VisionMode } from "@/render"
import { AtlasEngine } from "@/render/engine/engine"
import { buildVineyardScene, decodeMapImage } from "./vineyard"

interface HarnessInfo {
  sample: string
  mode: RenderMode
  vision: VisionMode
  activeLevel: string | null
  viewers: string[]
  visibleTokens: string[]
  visionMs: number
  gl: { renderer: string; vendor: string; version: string }
  quality: Quality
  /** Auto quality probe (quality=auto). */
  probe: QualityProbe | null
  /** Backdrop decode times (ms) by level index. */
  backdrops: Record<number, number>
}

interface AtlasHandle {
  engine: Engine
  /** Synchronised per-frame timing (AtlasEngine.benchmark), for automation. */
  bench(frames?: number): { frames: number; meanMs: number; medianMs: number; p95Ms: number } | null
  stats: FrameStats | null
  hostMasks: Record<Id, HostLevelMasks>
  scene: SceneLike
  view: ViewState
  frames: number
  ready: boolean
  /** Images still loading. */
  pending: number
  error: string | null
  info: HarnessInfo
}

declare global {
  interface Window {
    __atlas?: AtlasHandle
  }
}

const params = new URLSearchParams(location.search)

function param<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = params.get(name)
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function numParam(name: string): number | null {
  const v = params.get(name)
  if (v === null || v.trim() === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function flag(name: string, fallback: boolean): boolean {
  const v = params.get(name)
  return v === null ? fallback : v !== "0" && v !== "false"
}

function xz(text: string | null): Vec2 | null {
  if (!text) return null
  const [x, z] = text.split(",").map(Number)
  return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null
}

/** Tokens matching a comma-separated list of names (case-insensitive prefix of name or label). */
function findTokens(scene: Scene, list: string | null): Token[] {
  if (!list) return []
  const tokens = Object.values(scene.tokens).sort((a, b) => a.name.localeCompare(b.name))
  const out: Token[] = []
  for (const raw of list.split(",")) {
    const q = raw.trim().toLowerCase()
    if (!q) continue
    const t = tokens.find((t) => t.name.toLowerCase().startsWith(q) || (t.label ?? "").toLowerCase().startsWith(q))
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** Apply "name@level:x,z;…" token placements (level = index in elevation order). */
function placeTokens(scene: Scene, spec: string | null): void {
  if (!spec) return
  const levels = sortedLevels(scene)
  for (const entry of spec.split(";")) {
    const m = /^([^@]+)@(\d+):(.+)$/.exec(entry.trim())
    if (!m) continue
    const [token] = findTokens(scene, m[1])
    const level = levels[Number(m[2])]
    const p = xz(m[3])
    if (token && level && p) scene.tokens[token.id] = { ...token, levelId: level.id, position: p }
  }
}

/** moon / lights parameters: switch the directional light and point lights for isolated checks. */
function overrideEnvironment(scene: Scene): void {
  const moon = params.get("moon")
  if (moon !== null) scene.environment.directional = { ...scene.environment.directional, enabled: moon !== "0" }
  const lights = params.get("lights")
  if (lights === null) return
  const keep = lights === "0" ? [] : lights.toLowerCase().split(",").map((s) => s.trim())
  for (const [id, o] of Object.entries(scene.objects)) {
    if (o.type !== "light") continue
    const name = (o.name ?? "").toLowerCase()
    scene.objects[id] = { ...o, on: keep.some((k) => k && name.startsWith(k)) }
  }
}

/** Every cell of the grid set (explored=all). */
function fullMask(width: number, depth: number): CellMask {
  const m = createCellMask(width, depth)
  for (let k = 0; k < width * depth; k++) setCell(m, k, true)
  return m
}

interface VisionOutcome {
  masks: Record<Id, HostLevelMasks>
  result: VisibilityResult
  ms: number
}

/**
 * Host masks for the viewers, computed with core/vision exactly as the host would: perception and
 * sunlit from the current positions; explored = everything perceived now and at the trail positions
 * of the first viewer (or every cell with explored=all).
 */
function computeVision(scene: Scene, viewers: Token[], trail: Vec2[], exploreAll: boolean): VisionOutcome {
  const t0 = performance.now()
  const { width, depth } = scene.grid
  const engine = createVisionEngine(scene)
  const explored = new Map<Id, CellMask>()
  const addExplored = (res: VisibilityResult) => {
    for (const [levelId, grades] of Object.entries(res.perception)) {
      let m = explored.get(levelId)
      if (!m) explored.set(levelId, (m = createCellMask(width, depth)))
      orInto(m, perceivedCells(grades))
    }
  }
  const lead = viewers[0]
  if (lead && trail.length > 0) {
    for (const p of trail) {
      const moved: Scene = { ...scene, tokens: { ...scene.tokens, [lead.id]: { ...lead, position: p } } }
      engine.update(moved, { tokens: [lead.id] })
      addExplored(engine.compute(viewers.map((t) => engine.viewerFor(moved.tokens[t.id]))))
    }
    engine.update(scene, { tokens: [lead.id] })
  }
  const result = engine.compute(viewers.map((t) => engine.viewerFor(t)))
  addExplored(result)
  const masks: Record<Id, HostLevelMasks> = {}
  for (const level of sortedLevels(scene)) {
    const grades = result.perception[level.id] ?? createGradeMask(width, depth)
    const exp = exploreAll ? fullMask(width, depth) : (explored.get(level.id) ?? createCellMask(width, depth))
    masks[level.id] = {
      perception: encodeGrades(grades),
      explored: encodeMask(exp),
      sunlit: encodeMask(result.sunlit[level.id] ?? createCellMask(width, depth)),
    }
  }
  return { masks, result, ms: performance.now() - t0 }
}

/**
 * What a player is actually sent (ARCHITECTURE §6.2): one player controlling the viewers, knowledge
 * accumulated at the trail positions of the first viewer and at the current positions, then the
 * filtered PlayerView rebuilt into a scene by viewToScene, with the view's own masks.
 */
function playerPipeline(scene: Scene, viewers: Token[], trail: Vec2[]): { scene: SceneLike; masks: Record<Id, HostLevelMasks>; visible: Id[]; ms: number } {
  const t0 = performance.now()
  const uid = "harness-player"
  let state: GameState = createGameState({ sessionId: "harness", roomCode: "HARNESS1", scene })
  state = reduceDm(state, { t: "add-player", userId: uid, displayName: "Player" }).state
  for (const t of viewers) state = reduceDm(state, { t: "assign-token", tokenId: t.id, userId: uid, assigned: true }).state
  const engine = createVisionEngine(state.scene)
  const pass = (at: Scene): VisibilityResult => {
    const vis = engine.compute(viewerTokenIds(state, uid).map((id) => engine.viewerFor(at.tokens[id])))
    state = updateKnowledge(state, uid, vis)
    return vis
  }
  const lead = viewers[0]
  if (lead && trail.length > 0) {
    for (const p of trail) {
      const moved: Scene = { ...state.scene, tokens: { ...state.scene.tokens, [lead.id]: { ...lead, position: p } } }
      engine.update(moved, { tokens: [lead.id] })
      pass(moved)
    }
    engine.update(state.scene, { tokens: [lead.id] })
  }
  const vis = pass(state.scene)
  const view = filterForPlayer(state, uid, vis)
  return { scene: viewToScene(view), masks: view.masks, visible: [...vis.visibleTokenIds], ms: performance.now() - t0 }
}

/** What a player would be sent (approximately): no hidden objects/tokens, only visible tokens. */
function playerScene(scene: Scene, keepTokens: Set<Id>): SceneLike {
  const objects: Scene["objects"] = {}
  for (const [id, o] of Object.entries(scene.objects)) {
    if (o.hidden) continue
    if (o.type === "light" && o.attachedTokenId && !keepTokens.has(o.attachedTokenId)) continue
    objects[id] = o
  }
  const tokens: Scene["tokens"] = {}
  for (const [id, t] of Object.entries(scene.tokens)) if (!t.hidden && keepTokens.has(id)) tokens[id] = t
  return { grid: scene.grid, environment: scene.environment, levels: scene.levels, objects, tokens }
}

function glInfo(canvas: HTMLCanvasElement): HarnessInfo["gl"] {
  // Returns the engine's existing context.
  const gl = canvas.getContext("webgl2")
  if (!gl) return { renderer: "none", vendor: "none", version: "none" }
  const dbg = gl.getExtension("WEBGL_debug_renderer_info")
  return {
    renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
    vendor: String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
    version: String(gl.getParameter(gl.VERSION)),
  }
}

function formatStats(s: FrameStats, info: HarnessInfo): string {
  return [
    `${info.sample} · ${info.mode} · vision ${info.vision}`,
    `fps ${s.fps.toFixed(1)}  frame ${s.frameMs.toFixed(1)} ms  p95 ${s.frameMsP95.toFixed(1)} ms`,
    `draws ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(1)}k`,
    `lights ${s.activeLights}  tiles ${s.shadowTilesUpdated}/${s.shadowTilesTotal}  shadow ${s.shadowUpdateMs.toFixed(2)} ms`,
    `quality ${s.quality}${info.probe ? ` (auto: ${info.probe.reason})` : ""}  px ratio ${s.pixelRatio.toFixed(2)}`,
    info.viewers.length > 0 ? `viewers ${info.viewers.join(", ")}  (vision ${info.visionMs.toFixed(0)} ms)` : "",
    `${info.gl.renderer}`,
  ]
    .filter(Boolean)
    .join("\n")
}

async function main(): Promise<void> {
  const canvas = document.getElementById("atlas-canvas") as HTMLCanvasElement
  const statsEl = document.getElementById("atlas-stats") as HTMLDivElement
  if (!flag("stats", true)) statsEl.hidden = true
  // F3 toggles the stats corner (PERFORMANCE.md dev overlay).
  window.addEventListener("keydown", (e) => {
    if (e.key !== "F3") return
    e.preventDefault()
    statsEl.hidden = !statsEl.hidden
  })

  const sampleId = param("sample", [...SAMPLE_SCENES.map((s) => s.id), "vineyard-test"], "crooked-lantern")
  const vineyard = sampleId === "vineyard-test" ? await buildVineyardScene() : null
  const scene = vineyard ? vineyard.scene : sampleById(sampleId)!.build()
  const mode = param<RenderMode>("mode", ["editor", "dm-play", "player"], "editor")
  const vision = param<VisionMode>("vision", ["off", "fog", "preview"], mode === "player" ? "fog" : "off")
  const qualityParam = param<Quality | "auto">("quality", ["low", "medium", "high", "ultra", "auto"], "high")
  const probe = qualityParam === "auto" ? await probeQuality({ force: flag("reprobe", false) }) : null
  const quality: Quality = probe ? probe.tier : qualityParam === "auto" ? await pickInitialQuality() : qualityParam
  const camera = param("camera", ["orbit", "topdown"] as const, mode === "editor" ? "orbit" : "topdown")
  const levels = sortedLevels(scene)
  placeTokens(scene, params.get("place"))
  overrideEnvironment(scene)
  const floorMaterial = params.get("floor")
  if (floorMaterial && floorMaterial in MATERIAL_COLORS) {
    for (const o of Object.values(scene.objects)) if (o.type === "floor") scene.objects[o.id] = { ...o, material: floorMaterial as MaterialId }
  }

  let viewers = findTokens(scene, params.get("viewer"))
  if (viewers.length === 0 && vision !== "off") {
    const pcs = Object.values(scene.tokens)
      .filter((t) => t.kind === "pc" && !t.hidden)
      .sort((a, b) => a.name.localeCompare(b.name))
    viewers = pcs.slice(0, 1)
  }

  const levelIndex = numParam("level")
  const groundIndex = Math.max(0, levels.findIndex((l) => l.elevation >= 0 && effectiveFloorRects(scene, l.id).length > 0))
  const active =
    levelIndex !== null ? levels[Math.min(levels.length - 1, Math.max(0, Math.round(levelIndex)))] : viewers[0] ? scene.levels[viewers[0].levelId] : levels[groundIndex]

  let engineScene: SceneLike = scene
  let hostMasks: Record<Id, HostLevelMasks> = {}
  let dimmed: Id[] = []
  let visibleTokens: Id[] = []
  let visionMs = 0
  if (vision !== "off" && viewers.length > 0) {
    const trail = (params.get("trail") ?? "")
      .split(";")
      .map((s) => xz(s))
      .filter((p): p is Vec2 => p !== null)
    if (mode === "player" && flag("pipeline", false)) {
      const outcome = playerPipeline(scene, viewers, trail)
      engineScene = outcome.scene
      hostMasks = outcome.masks
      visionMs = outcome.ms
      visibleTokens = outcome.visible
    } else {
      const outcome = computeVision(scene, viewers, trail, params.get("explored") === "all")
      hostMasks = outcome.masks
      visionMs = outcome.ms
      visibleTokens = [...outcome.result.visibleTokenIds]
      const keep = new Set<Id>([...viewers.map((t) => t.id), ...visibleTokens])
      if (mode === "player") engineScene = playerScene(scene, keep)
      else dimmed = Object.keys(scene.tokens).filter((id) => !keep.has(id))
    }
  }

  if (flag("portraits", false)) {
    for (const t of Object.values(scene.tokens)) scene.tokens[t.id] = { ...t, imageUrl: portraitUrl(t.name, t.color) }
    if (engineScene !== scene) for (const t of Object.values(engineScene.tokens)) engineScene.tokens[t.id] = { ...t, imageUrl: portraitUrl(t.name, t.color) }
  }
  const modelPrefix = params.get("models")
  const modelIds = (params.get("modelids") ?? "").split(",").filter(Boolean)
  if (modelIds.length > 0) {
    const byName = Object.values(scene.tokens).sort((a, b) => a.name.localeCompare(b.name))
    byName.forEach((t, k) => {
      const model = `free:${modelIds[k % modelIds.length]}`
      scene.tokens[t.id] = { ...t, model }
      if (engineScene !== scene && Object.hasOwn(engineScene.tokens, t.id)) engineScene.tokens[t.id] = { ...engineScene.tokens[t.id], model }
    })
  }
  const engine = createEngine(canvas, {
    quality,
    tokenModels: modelPrefix ? { resolveUrl: async (ref) => `${modelPrefix}/${ref.replace(/^free:/, "")}.glb` } : undefined,
  })
  if (engine instanceof AtlasEngine) engine.debugFreezeQuality(!flag("adaptive", false))
  engine.setScene(engineScene)
  const postView = params.get("postview")
  if (postView && engine instanceof AtlasEngine) engine.debugPostSettings({ view: postView === "ao" ? 1 : postView === "bloom" ? 2 : 0 })
  const view: Partial<ViewState> = {
    ...DEFAULT_VIEW,
    mode,
    camera,
    activeLevelId: active?.id ?? null,
    vision,
    viewerTokenIds: viewers.map((t) => t.id),
    hostMasks,
    dimmedTokenIds: dimmed,
    gpuVisionRefine: flag("refine", true),
    ghostAdjacent: flag("ghost", false),
    cutaway: flag("cutaway", true),
    showGrid: flag("grid", mode === "editor"),
    showHelpers: flag("helpers", mode === "editor"),
    darkVision: flag("dark", false),
  }
  const tilt = numParam("tilt")
  if (tilt !== null) view.tilt = (tilt * Math.PI) / 180
  engine.setView(view)
  if (viewers[0] && mode !== "editor") engine.setOverlays({ selectedIds: [viewers[0].id] })

  // Camera placement.
  const at = xz(params.get("at"))
  const zoom = numParam("zoom")
  const focusToken = viewers[0] && viewers[0].levelId === active?.id ? viewers[0] : null
  const lookAt: Vec3 | null = at
    ? { x: at.x, y: active?.elevation ?? 0, z: at.z }
    : focusToken && mode !== "editor"
      ? { x: focusToken.position.x, y: tokenGroundY(scene, focusToken), z: focusToken.position.z }
      : null
  if (lookAt) engine.focus(lookAt, { immediate: true, distance: zoom ?? (camera === "topdown" ? 90 : 110) })
  else if (zoom !== null) engine.focus({ ...center(scene), y: active?.elevation ?? 0 }, { immediate: true, distance: zoom })
  const quarter = numParam("rotate")
  if (quarter) engine.rotateCamera(quarter)
  const orbit = params.get("orbit")
  if (orbit && engine instanceof AtlasEngine) {
    const [az, el] = orbit.split(",").map(Number)
    if (Number.isFinite(az) && Number.isFinite(el)) engine.setOrbitAngles((az * Math.PI) / 180, (el * Math.PI) / 180)
  }

  const info: HarnessInfo = {
    sample: sampleId,
    mode,
    vision,
    activeLevel: active?.name ?? null,
    viewers: viewers.map((t) => t.name),
    visibleTokens: visibleTokens.map((id) => scene.tokens[id]?.name ?? id),
    visionMs,
    gl: glInfo(canvas),
    quality,
    probe,
    backdrops: {},
  }
  const handle: AtlasHandle = {
    engine,
    bench: (frames) => (engine instanceof AtlasEngine ? engine.benchmark(frames) : null),
    stats: null,
    hostMasks,
    scene: engineScene,
    view: engine.getView(),
    frames: 0,
    ready: false,
    pending: 0,
    error: null,
    info,
  }
  window.__atlas = handle

  // Battlemap backdrops: the vineyard sample's own images, plus backdrop=<levelIndex>:<url> parameters.
  const rect = { x: 0, z: 0, w: scene.grid.width * scene.grid.cellSize, d: scene.grid.depth * scene.grid.cellSize }
  const opacity = numParam("opacity")
  const tint = params.get("tint")
  const imageOpts = { opacity: opacity ?? undefined, tintWalls: tint === null ? undefined : tint !== "0" }
  if (vineyard) for (const [levelId, img] of vineyard.images) engine.setLevelImage(levelId, img, vineyard.rect, imageOpts)
  for (const spec of params.getAll("backdrop")) {
    const m = /^(\d+):(.+)$/.exec(spec)
    const level = m ? levels[Number(m[1])] : undefined
    if (!m || !level) continue
    handle.pending++
    decodeMapImage(m[2], scene.grid)
      .then((d) => {
        info.backdrops[Number(m[1])] = d.ms
        engine.setLevelImage(level.id, d.bitmap, rect, { opacity: opacity ?? 1, tintWalls: tint !== "0" })
      })
      .catch((err: unknown) => console.error("backdrop failed", spec, err))
      .finally(() => handle.pending--)
  }

  let lastText = 0
  engine.onFrame((s) => {
    handle.stats = s
    handle.frames++
    if (handle.frames >= 2 && handle.pending === 0) handle.ready = true
    const now = performance.now()
    if (!statsEl.hidden && now - lastText > 250) {
      lastText = now
      statsEl.textContent = formatStats(s, info)
    }
  })
}

/** A generated portrait (initials on a gradient) as an SVG data URL, for testing token images. */
function portraitUrl(name: string, color: string): string {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><radialGradient id="g" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.5" stop-color="${color}"/><stop offset="1" stop-color="#111"/></radialGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="128" cy="104" r="46" fill="#1c1917" fill-opacity="0.55"/><path d="M40 256c10-60 50-90 88-90s78 30 88 90z" fill="#1c1917" fill-opacity="0.55"/><text x="128" y="236" font-family="Georgia,serif" font-size="54" font-weight="700" text-anchor="middle" fill="#fafaf9">${initials}</text></svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

function center(scene: SceneLike): Vec2 {
  return { x: (scene.grid.width * scene.grid.cellSize) / 2, z: (scene.grid.depth * scene.grid.cellSize) / 2 }
}

main().catch((err: unknown) => {
  console.error("render harness failed", err)
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)
  window.__atlas = { ...(window.__atlas ?? ({} as AtlasHandle)), error: msg, ready: false }
  const el = document.getElementById("atlas-stats")
  if (el) el.textContent = `harness error: ${msg}`
})
