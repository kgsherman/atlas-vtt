# Atlas VTT — Architecture

Atlas is a browser VTT where the DM builds multi-level 3D scenes and players experience them
in a 2.5D top-down view whose lighting, shadows and line of sight come from the real 3D geometry.

This document is the contract between modules. When code and this document disagree, fix one of them.
Performance techniques and budgets: `docs/PERFORMANCE.md`.

---

## 1. Module map

```
src/
  core/                 Pure TypeScript. No DOM, no three.js, no React. Runs in the main thread, a Worker, or vitest.
    scene/              Scene types, zod schema, migrations, factories, queries, heightmap, integrity (refs/paste)
    grid/               Cell math, snapping, distance rules, supercover rasterisation
    geometry/           Vector / box / segment / ray / polygon-clip math shared by occlusion, movement, filter
    occlusion/          CPU occluder model (boxes, cylinders, heightfields) + ray queries  ← single source of blocking truth
    vision/             Authoritative visibility: light field, per-viewer LOS, perception masks, observation
    movement/           Move validation (walls/doors/windows/props, connectors), ruler measurement
    history/            Undo/redo over immer patches with transactions
    session/            GameState reducer, request validation, memory, filter, diff/apply, viewToScene
  render/               three.js (WebGL2). Knows nothing about React or the network.
    engine/             Renderer, frame loop, resize, adaptive quality, stats
    builders/           Scene → visual meshes per level (floors, terrain, walls w/ openings, doors, props, tokens…)
    occluders/          OcclusionWorld.primitives → occluder proxy meshes (LIGHT / SIGHT layers)
    shadows/            Octahedral distance atlases (light shadows; viewer line-of-sight maps), sun shadow map
    lighting/           Light manager: culling, flicker, slot + tile assignment, update scheduling
    materials/          World material (custom GLSL: lighting + perception + fog in one pass), token material
    fog/                Host-mask textures (perception / explored / sunlit) as DataArrayTexture layers
    post/               Medium / high / ultra post (MSAA scene target; high/ultra: HDR, AO, bloom, tone mapping, grain)
    cameras/            Editor orbit camera, player 2.5D camera
    overlays/           Grid, selection, tool previews, ruler, pending paths, ghost levels, gizmos
    picking/            Ground/object/token picking
  editor/               DM editor state (zustand) + tools
  play/                 Play-mode controllers (token selection, drag-to-move, ruler, level switching)
  net/                  Supabase client, auth, repositories, transports, host runner (+ vision worker), player client,
                        free asset catalog (freeAssets.ts)
    assets/             Map images: import (decode / resample / WebP), DM asset stores, per-player tile chunks
    host/               DM-side host runner, vision worker client, flush pipeline, persistence, backdrop tiler
    player/             Player client (sync rules, requests), backdrop compositor
  app/                  Service wiring (Supabase or local mode), router + lazy routes, library, scene digests
  lib/                  keymap (pure: remappable command tables, overrides), hotkeys (TanStack Hotkeys wrapper, key labels), utils
  components/           React + shadcn UI (app shell, editor panels, play HUD, host console, lobby)
  routes/               Page-level components (home, editor, host, play, join, shared scene)
  dev/                  Dev-only render harness (`dev/render.html`) and the Vineyard build helpers
  integration/          Cross-module consistency tests (render ↔ occlusion, vision ↔ movement, host → player, editor → session)
supabase/migrations/    SQL: schema, RLS, RPCs, realtime policies
scripts/free-assets/    Build (STL → LOD GLB + thumbnail) and publish free token models (§4.3, §6.4)
```

Dependency rule: `core` imports nothing outside `core` (immer types allowed). `render` imports `core`.
`editor`/`play`/`net` import `core` and `render/contracts.ts` (`editor`/`play` also the pure `lib/keymap`). `components`/`routes` import everything.
Bundling: `/editor`, `/host` and `/play` are lazy routes (`app/routes.ts`), so three.js and the renderer load
only there; the home, join and shared-scene routes never download them.

UI rule: compose from shadcn components in `src/components/ui` (preset `b5UKukPFuS` → style `base-mira`,
Base UI primitives, zinc/emerald, Outfit + Roboto Slab, lucide). Dark theme first.

---

## 2. World conventions & blocking

- 1 unit = **1 foot**, **Y up**, grid on XZ, default cell 5 ft. Cell `(i,j)` covers `[5i,5i+5) × [5j,5j+5)`.
- Levels are a Record keyed by id; their order is `(elevation, id)` via `sortedLevels()`.
- **Ground** of a level at (x,z) = `elevation + heightmap(x,z)`; on a stairs/ramp run it is interpolated
  (`groundHeightAt`). There is **no implicit ground**: tokens stand on floors (after connector cutouts) or
  connectors. `createScene()` adds a full-grid floor to the first level.
  `groundHeightAt`, `hasGroundAt` and `effectiveFloorRects` (`core/scene/queries`) scan the scene's objects on
  every call. `groundIndex(scene)` is the cached form for callers that query many points (path overlays,
  planners, per-pointer-move tools, the renderer's light origins, light fixtures and token visuals); it is
  valid only on a scene that is never changed after creation (not an immer draft, not a scene mutated in
  place). The free functions stay uncached; the token / light helpers (`tokenGroundY`, `lightGroundY`, `lightWorldPosition`,
  `tokenViewLevelId`) take an optional `GroundIndex` of the same scene, and integrity code that reads a
  draft builds a throwaway `GroundIndex` for the duration of one call.
- **Ceiling** of level N = underside of the slabs of the level above (`levelCeilingY`).
- Object Y values are relative to the ground at the object's anchor. Extended objects on terrain
  (the "Terrain rule"). Here "ground" is the **terrain** ground `levelGround` = elevation + heightmap
  (NOT `groundHeightAt`'s stairs interpolation, or a wall along a stair run would float):
  - Floor slab: top = ground surface (displaced by the heightmap), bottom = top − thickness.
  - Wall: base = ground at the wall midpoint; wall top, opening heights, sills and lintels measure from
    that base. The box bottom extends down to the minimum ground along its joint-extended footprint − 0.05 ft
    (exact minimum over the terrain triangles).
  - Pillars/props resting on the ground (`y = 0`): top = ground(centre) + y + height; bottom = min ground
    over the footprint. Stairs/ramp occluder bottoms: min lower-level ground over the rect − 0.05 ft.
  - Lights and tokens follow `groundHeightAt` (so a torch or token on a stair run rises with it).
  `render/builders` (walls.ts, ground.ts, floors.ts) and `core/occlusion` (build.ts, terrain.ts) implement
  these rules separately. Shared quantities come from `core/scene`: slab thickness is
  `floorThickness(scene, floor)` (the floor's own thickness, else its level's; no visual minimum, so a
  0.01 ft slab is drawn and blocks at 0.01 ft). `src/integration/crossModule.test.ts` checks that both sides
  agree on walls (frames, volumes, proxy ↔ primitive mapping), floor / terrain slabs (incl. mask floors;
  terrain top cells = heightfield solid cells), stairs / ramp bottoms and tops, pillars and blocking props,
  on the sample scenes plus a test-only mask-floor fixture (flat and heightmap levels with irregular masks,
  stairs cutting them, every prop kind rotated, a 0.01 ft slab). Door leaves are not compared.
- **Walls** are segments centred on a→b; at shared endpoints (within 1e-3 ft) both ends extend by
  thickness/2 so corners have no notch (in both render and occlusion). Only endpoint–endpoint contacts form
  joints (a T-junction stem is not extended; it already reaches the other wall's centreline).
- **Cell rasterisation** (`core/grid`: `supercoverCells`, `segmentCellIntervals`, `cellsInCircle`,
  `cellsInConvexPolygon`) treats cells as CLOSED with an eps tolerance: a segment on a grid line reports the
  cells on both sides, and `t0 === t1` intervals are touch-only contacts. Anything that must not dilate
  (the player filter's clipping) additionally requires positive-area overlap.
- **Openings** (doors/windows) are hosted by a wall (`wallId`, `offset` centre along a→b, `width`).
  Deleting a wall deletes its openings; moving/flipping/splitting a wall reprojects them (`core/scene/integrity`).
- **Connectors**: `rect` is cell-aligned. Stairs/ramps: tokens on the run stay on the lower level with
  interpolated ground; they change level only by an orthogonal step across the top edge (last row ↔ the
  cell beyond, on `toLevelId`). On the lower level a footprint enters or leaves the run across its bottom
  edge, or across a side only where that footprint cell's ground on the run and off it differ by at most
  `MAX_RUN_SIDE_STEP` (2.5 ft, `core/movement/rules.ts`, measured per footprint cell): the low rows can be
  stepped onto from the side, the high ones are not a shortcut or a jump-off (`"connector-edge"`).
  A token on the run still *sees from* the level the run arrives at once its
  nominal eye (ground + eyeHeight) is above that level's floor: `tokenViewLevelId` returns that level, which
  the player view uses for its cutaway, picking and drags (§4.3); `Token.levelId` is unchanged (ladders
  never switch the view). Ladders (1×1): switch in place. Connector footprints are **cut out** of the
  floors of every level the rise passes through (`effectiveFloorRects`, used by render, occlusion, movement).

### Blocking table (single source of truth: `core/occlusion`, read by the GPU occluder proxies)

| Object                       | Movement | Sight | Light (casts shadow) |
|------------------------------|----------|-------|----------------------|
| Wall                         | yes      | yes   | yes                  |
| Door closed/locked           | yes      | `DOOR_STYLES[style].blocksSightClosed` | `…blocksLightClosed` |
| Door open                    | no       | no    | no (leaf rendered swung/lifted, not an occluder) |
| Window (frame, sill, lintel) | yes (whole opening) | sill & lintel only | sill & lintel only |
| Pillar                       | yes      | yes   | yes                  |
| Floor slab / terrain         | n/a      | yes   | yes                  |
| Stairs / ramp                | connector rules | yes (stepped solid under the run) | yes |
| Ladder                       | connector rules | no | no                  |
| Prop (per `PROP_LIBRARY.parts`) | `blocksMovement` | `blocksSight` | `castsShadows` |
| Token                        | no       | no    | no (blob shadow only) |

- `hidden` objects are never sent to players in any state, but still block on the host. A hidden token and
  every light attached to it do not exist for players (no fixture, no illumination in player vision).
- Occlusion query semantics (CPU and GPU): a primitive blocks a segment only if the segment **enters** it;
  primitives containing the segment's start are ignored. So no query may start inside a blocker it should
  respect:
  - Eyes are pushed out of sight blockers by `resolveViewerEye` (§5.2), except blockers that also contain the
    token's feet (a creature standing in a bush).
  - Light origins are resolved at compute time by `core/vision` `resolveLightOrigin`, which both the vision
    engine and the renderer's light capture (`render/lighting/lights.ts`) use. The origin is pushed 0.3 ft
    past the nearest face of every light blocker that contains it (EPS-closed containment, so a light
    exactly on a floor's top surface counts as inside; re-queried until no blocker contains it), with no
    feet exception. Floor and terrain slabs push vertically toward the light's own level: up out of the
    slab it stands on, down out of a slab above its ground (the next storey's floor). A candle at `y = 0`
    therefore lights the room above the slab, never the cellar below it, and a torch a wall was later drawn
    through lights only the side it was pushed to. This also removes a host vs player difference: a light
    inside a floor that the player's view splits into pieces was ignored by the whole floor on the host but
    only by one piece on the player. The document keeps the position the DM placed.
  - The light tool's wall-mount offset (`hitPoint + 0.3·normal`) remains a placement convenience.

---

## 3. Scene document & versioning

- Types `core/scene/types.ts`, presets `core/scene/defaults.ts`. `SCENE_SCHEMA_VERSION = 2` (v2 added the
  optional `Token.model`; the v1 → v2 migration is the identity).
- `Token.model` (optional): the 3D figure the token is drawn with, a reference `free:<assetId>` into the
  free asset catalog (category `token-models`, §6.4; `core/scene/tokenModel.ts`). The schema accepts only
  that form (`^free:[a-z0-9][a-z0-9-]{0,63}$`), never a URL, so a document cannot make clients fetch an
  arbitrary host. Other sources (e.g. models uploaded with a scene) would get their own prefix.
- `core/scene/schema.ts`: zod **strict** schemas (`z.strictObject` at every depth) for the current version,
  with the bounds exported as `SCENE_LIMITS`:
  - grid ≤ 200×200 integer cells, cell size 0.5–100 ft; 1–32 levels, ≤ 20k objects, ≤ 1000 tokens (counted
    on the raw input before per-entry validation); strings ≤ 2k; every number finite;
  - ids `^[A-Za-z0-9_-]{1,64}$` and never `"__proto__"` (every id generator must use this alphabet;
    `factory.newId` / nanoid does); record keys must equal the entry's id;
  - `dimRadius ≥ brightRadius`, wall thickness > 0 and length ≥ 0.01 ft, `#rrggbb` colours,
    `imageUrl` http(s) or an absolute path, |elevation| and object y ≤ 1000 ft;
  - points and rects within the grid extent ± 50 ft (`coordMargin`); connector rects cell-aligned, ladders
    exactly 1×1 cell; attached-light offsets ≤ 50 ft;
  - heightmap resolution ∈ {1,2,4}; chunk keys canonical `^(0|[1-9]\d*),(0|[1-9]\d*)$` and inside the grid's
    chunk range; exact base64 / byte length; finite samples within ±500 ft.
- `core/scene/migrations.ts`: migrations (`MIGRATIONS[v]`: vN → vN+1) operate on unknown JSON (deep-copied
  first). `parseScene(json)` → `{ok:true, scene, migratedFrom}` | `{ok:false, error:'too-new'|'invalid', issues}`
  (≤ 50 issues); `too-new` opens read-only. `parseScene` also runs `validateReferences` (integrity);
  `parseSceneJson(text)` wraps JSON syntax errors as `invalid`.
- The editor never commits a revision `parseScene` would refuse (`editor/validate.ts`, see §7), so every
  saved version can be reopened.
- Heightmaps are chunked (8×8 cells per chunk, base64 Float32) so edits, undo patches and network diffs touch
  only dirty chunks. Samples beyond the grid's lattice read as 0 everywhere (`sampleHeight` with the grid,
  like the occlusion terrain sampler), and a grid resize in the editor crops each heightmap to the new
  lattice (`cropHeightmapToGrid`: chunks beyond it dropped, the padding of boundary chunks zeroed), so old
  heights cannot come back if the grid grows again.
- Storage: `scenes` + immutable `scene_versions` in Supabase; `.atlas.json` export/import; import regenerates `Scene.id`.
- Sharing: `visibility: 'private' | 'link'`. Link shares are read only through the `get_shared_scene(slug)` RPC and
  publish the FULL DM document (the UI warns). Scene ids are never capabilities; session membership never grants
  scene access.

---

## 4. Rendering (three.js, WebGL2)

### 4.1 World material (one custom GLSL3 `ShaderMaterial`, `render/materials/worldMaterial.ts`)

Per fragment, in one forward pass:
1. **Lighting**: ambient + directional (sun/moon; own shadow map) + up to `MAX_LIGHTS = 32` point lights in
   **uniform arrays** (`vec4 uLights[32*4]`: pos+dim, colour×intensity×flicker + bright, tile rect, misc).
   The CPU culls/sorts lights (frustum ∩ dim sphere, level cutaway, priority) into the 32 slots; the loop
   bound is `uLightCount`, so light count changes never recompile. A per-cell slot mask
   (`render/lighting/lightMask.ts`: an R32UI texture over XZ, 10 ft cells, bit i = slot i's dim disc
   reaches the cell, rebuilt only when the slot list changes) lets a fragment skip the slots whose disc
   misses its cell before fetching their uniforms. It is XZ only, so conservative across levels. Per
   remaining light: skip if `d > dimRadius`, gate by `N·L > 0`, then shadow test. Flicker modulates
   intensity only; radii are static.
2. **Shadows**: point lights sample the **light atlas** (§4.2), bilinear-weighted 2×2 PCF via `texelFetch`;
   a 3×3 (2-texel box) filter instead for the 8 strongest shadowed lights on medium and for every light on
   high / ultra (`widePcfLights` in `render/lighting/system.ts` `QUALITY_CONFIG`; ultra adds PCSS-style soft
   shadows, §10). Sun: hardware PCF `sampler2DShadow`.
3. **Perception** (`vision != "off"`): the cell's host grade from the perception texture (§4.4) decides
   colour / greyscale (darkvision) / blindsight tint / unperceived. If `gpuVisionRefine`, per-pixel line of
   sight against the **viewer atlas** can only *remove* perception inside host-perceived cells (never add).
   Receiver rules for the GPU LOS test (surface class baked per vertex by builders, `aSurf`):
   - walkable (floors, terrain, connector tops): test point `p + (0, 0.25, 0)` (matches CPU samples);
   - vertical faces: require `dot(n, eye − p) > 0`; test point `p − n·0.05`;
   - caps (tops of walls, doors, pillars, props with n.y > 0.7): test point `p − n·0.25 + horiz(eye − p)·0.1`
     (0.25 keeps it clear of the top edge at the viewer atlas' texel size), and the host-mask lookup uses
     `p.xz + horiz(eye − p)·0.6` (the cell on the viewer's side);
   - a fragment passes if `|q − eye| ≤ stored(q) + 0.05` with the normal-offset rule of §4.2.
   Host-mask lookups for non-walkable fragments use `p.xz + n.xz·0.3` (the cell a face faces).
   Darkvision (grade 2) and blindsight (grade 1) also end at their range per pixel (3D distance from the
   eye, over the last `AT_SENSE_EDGE` = 0.5 ft), where the host's cells and sub-cells draw the range as a
   staircase; this too only removes perception, needs every viewer in the uniform slots, and never removes
   a viewer's own footprint cells (perceived by touch). With more than `MAX_VIEWERS` viewers (a large party
   with shared vision) both the GPU refinement and this range cut are off (`uViewersAll`), because a viewer
   without a slot may perceive what the slotted ones do not. The darkvision colour lift fades over the last
   `AT_DV_FEATHER` = 1.5 ft of its range (a look, not a rule), and scales a dark colour up (hue kept, at
   most 3×) before adding any grey, so painted night battlemaps keep their colours; grade 2 stays grey.
4. **Fog**: perceived → lit colour (grey/tinted per grade); else explored (host explored mask) → memory
   style: desaturated albedo × constant, **no light terms** (stale lights can't make memory look lit);
   else black. Player mode: directional term = local sun shadow × `sunlit` mask.

The DM sees everything (`vision:"off"`); "preview" darkens unperceived areas using masks computed locally by
core/vision for the previewed token. **DM dark vision** (`ViewState.darkVision`, the editor's moon toggle / B;
shared uniform `uDarkVision`, honoured only with vision "off" outside player mode) lifts what is dark by the
rules (`litHere < 1` in `atDmColour`) to `AT_DM_DV_FLOOR` instead of `AT_DM_FLOOR`, and marks it by how dark it
is: desaturated, blue-tinted, with screen-space diagonal hatching (`DARK_VISION_STRIPE_PX` CSS px). Lit areas
render exactly as without it, so the DM can build a dark level and still see which parts of it are dark. Rules to avoid recompiles/hitches: no `THREE.Light`, `scene.fog`,
`renderer.shadowMap` or clipping planes in rendered scenes; fixed tone mapping/colour space; InstancedMeshes
always have `instanceColor`; ghost/token variants created up front; `renderer.compileAsync` at load.
The world shader never uses `discard`/`gl_FragDepth` (keeps early-Z).

Start-up hold (`Engine.getLoadState` / `onLoadState`, `EngineLoadState`): after a scene is set, a user quality
change or a context restore, the engine compiles every program with `KHR_parallel_shader_compile` (material
variants, the lighting system's capture programs against a render target, then stand-ins for whatever the
live scene draws, per target) and draws nothing until they have landed ("compiling"); the frame's updates
still run, so overlays and defines are current when the live scene is compiled. It then pays each program's
first-use work (three.js reads the info logs and reflects uniforms) a few programs per frame under an 8 ms
budget. Drawing earlier made three.js wait for every link on the main thread: ~2 s frozen and dark on the
Vineyard's first load (RTX 5070 Ti, ultra), now a responsive page with a progress card and a 16.7 ms first
frame. After the hold, "lighting" lasts until the first shadow / vision captures are done (≤ 1.5 s). The hold
gives up after 20 s. Without the extension (Firefox) the first query of any program blocks the main thread
until the GPU process has compiled everything submitted before it (~6 s of frozen, dark page on Windows /
D3D11, ~11 s under the profiler, all inside one `PWebGL::Msg_GetLinkResult`), so the engine compiles
serially instead: one program per unit, submitted and queried at once, units within the same 8 ms budget
(at least one per frame), after a 250 ms head start for the loading card. Same total time, but one short
block per program with progress in between.
`EngineCanvas` shows the probe and both stages in a non-blocking card (`components/canvas/EngineLoading`).

### 4.2 Distance atlases

A point light's shadow and a token's line of sight are the same query ("nearest occluder from P in
direction D"), stored as octahedral linear-distance maps:

- **Light atlas**: R32F 4096×2048, 512² tiles → 32 shadowed lights (low tier 2048×1024 / 256²).
- **Viewer atlas**: R32F 4096×2048, 1024² tiles → `MAX_VIEWERS = 8` (low tier: GPU refinement off).
- Render targets: `FloatType, RedFormat, depthBuffer:false, Nearest, no mipmaps`; each tile write sets
  viewport + scissor (`scissorTest`), autoClear off. Cube pass: R32F faces with depth, cleared to 1e6
  (256² for lights, 512² for viewers).
- Encoding axis −Y (seams go to the upward hemisphere, hidden by cutaway); the re-encode pass fills a 1-texel
  guard ring with the octahedral wrap, and takes the MIN of 4 cube taps per texel (conservative).
- Occluder proxies are rendered **BackSide** (second-depth) as closed volumes; camera near 0.05 ft.
  Compare `|q − src| ≤ stored(q) + 0.05` with receiver normal offset `q = p + n·k·d`,
  `k = 1.5·sqrt(4π)/(tileTexels − 2)`. Source-containing primitives are excluded via a per-instance key.
  Exception, caps (SURF.CAP) for light / sky / sun tests: `q = p − n·0.03` (just inside their own solid) with a
  strict comparison `|q − src| < stored(q) − 0.01`, because a cap touching the underside of the next storey's
  slab lies exactly on that slab's stored back face and the outward offset would read it as lit.
  Cutaway rule: in player and dm-play views with the cutaway on, a cap more than `AT_CAP_INSET` above the
  cutaway plane (the underside of the next storey's slab) gets no radiance from shadow-casting point lights
  above that plane (uniform `uCutawayY`, set by the lighting system; `1e9` when there is no cutaway). A hidden
  storey's walls rest on the lower walls' caps, and a cap flush with the upper slab's top face lies in front
  of the stored (back-face) depth, so the depth-map test cannot resolve that contact and drew a lit sawtooth
  along every wall top under a lit storey.
- Each tile stores its **capture origin**; the shader measures from it (a moving source lags until refreshed).
- Update priority: (a) sources that moved (the locally controlled/selected token's tile always, even over
  budget), (b) dirty viewer tiles, (c) on-screen lights by coverage, (d) rest. Budget: `SHADOW_UPDATES_PER_FRAME`
  = 4 tiles AND ~2 ms CPU (`shadowUpdateMs`). Invalidation: a tile is dirty when its source moved/changed radius,
  or an `OcclusionWorld.update` dirty region intersects its sphere. Occluder proxies follow authoritative door
  state instantly (only the visual leaf animates). Lights beyond the tile budget are **not drawn** (never unshadowed).
- Sun/moon: static cached `DepthTexture` (2048², ortho over the scene bounds), re-rendered on occluder or sun change.
  A second vertical map (1024², looking down) gives sky exposure for the `skyLevel`/`ambientLevel` split. It
  drives the visual fill only outside player fog mode (the player's scene lacks unexplored roofs); in fog mode
  the GPU perception refinement reads it only as an upper bound, which can never remove perception wrongly.

### 4.3 Levels, cutaway, ghosts, draw order

- Each level: a Group of merged visual meshes (per material, with `aSurf`), InstancedMeshes (props, pillars),
  door/window meshes (animated), terrain mesh, token meshes, editor gizmos. Occluder proxies live in a separate
  `occluderScene` built from `OcclusionWorld.primitives` (instanced unit boxes / 16-sided prisms per
  (level, channel mask) + closed heightfield meshes; layers LIGHT=1, SIGHT=2), `matrixWorldAutoUpdate=false`.
- **DM modes** use the full scene. **Player mode** has only the scene rebuilt from its PlayerView
  (`viewToScene`); unexplored geometry is absent, which is why fog and sun are clamped by host masks, and why
  the clear colour is black (not `environment.backgroundColor`) whenever vision is "fog".
  `/dev/render.html?mode=player&pipeline=1` renders exactly what a player is sent (GameState → vision →
  `updateKnowledge` → `filterForPlayer` → `viewToScene`).
- Player / dm-play: levels above the active level are not drawn (cutaway). The player's active level is the
  selected token's view level, `tokenViewLevelId` (§2 Connectors): the token's own level, or the level a
  stairs/ramp run arrives at once the token's nominal eye is above that level's floor. It is also the pick
  and drag level, so a token on the upper steps of a staircase sees the room it is climbing into instead of a
  dimmed lower storey. The lighting system sets the shader's `uCutawayY` from `cutawayPlaneY` (the cap
  cutaway rule of §4.2). Sent tokens on levels above are drawn as faded outline markers. Draw order:
  `renderOrder` = rank by descending elevation (active level first) so lower storeys are early-Z rejected;
  nested containers are plain `Object3D`, not `Group`.
- Door markers: lintels hide closed leaves from above, and a leaf in a wall running up/down the screen is a
  2–3 px sliver. So each door leaf also gets a top-down marker on the wall top, visible only with the top-down
  camera, pickable as the door, following the leaf's pose (animated swing / lift) and tinted by state
  (closed / locked / open).
- Editor: per-level visibility toggles; ghosts of adjacent levels draw after opaques as depth-only pre-pass
  (clone, `colorWrite:false`) then colour (`depthWrite:false`, `LessEqual`, opacity ≈ 0.25).
- **Token models** (`render/engine/tokenModels.ts`): a token with `model` draws that figure on its base
  instead of the default body and portrait, once the model has loaded (until then, or if it fails, the
  default body). The engine resolves references through `EngineOptions.tokenModels` (the app passes the
  free asset catalog: `EngineCanvas` → `services.freeAssets.tokenModelUrl`) and loads every model the scene
  references when the scene syncs; GLTFLoader and the meshopt decoder are imported with the first one.
  Files are GLBs in footprint units (1 = the footprint side, feet on y = 0, facing +Z) with meshes `lod0`,
  `lod1`, … (most detailed first); parsed geometry is cached per URL for the page. The figure is scaled to
  the base disc (side × 0.9), coloured as unpainted resin with a hint of the token colour, and drawn with
  a second instance of the token material whose rim light is faint (`TOKEN_MODEL_RIM`: a sculpt's grazing
  surfaces would otherwise wash out); same program, no recompile. One InstancedMesh per (level, LOD
  geometry), sharing the geometry's buffers. The LOD is chosen per token from its footprint's size in
  physical pixels (`chooseLod`: the most detailed LOD with at least `MODEL_PX_PER_TRIANGLE[tier]` px² per
  triangle — 4 / 3 / 2 / 1.25 from low to ultra — with a 10% hysteresis), because sub-pixel triangles cost
  the lit token shader 2×2 quads each; the layer re-buckets when the zoom changes a token's LOD. Picking
  raycasts an invisible body-shaped proxy as tall as the figure, never the sculpt. The free models are
  24k / 6k / 1.5k triangles (`scripts/free-assets/build-token-models.mjs`).
- Tokens are drawn whole if present in the scene data (no per-pixel discard), with a 150 ms fade on appear/disappear.
  They are opaque at rest and transparent only while that fade runs (PERFORMANCE §5). Their ground heights,
  like the light fixtures', come from the scene's `groundIndex` (one object scan per scene, not per token).

### 4.4 Host mask textures (`render/fog`)

Per level, the engine expands `HostLevelMasks` into R8 layers of `DataArrayTexture`s at 4 texels per cell
(coarse bits + 4×4 partial sub-cells): perception grade (0..3 scaled), explored, sunlit. LINEAR filtering with
`smoothstep(0.5, 1.0, v)` so edges only feather **inward**. Only changed levels are re-uploaded (`addLayerUpdate`).

### 4.5 Cameras & quality

- Editor: perspective orbit (near 0.5 ft, far = 4× scene diagonal), focus on selection, optional top view.
  The top view never follows the selection: dragging or editing a selected token must not move the camera
  (the ground point under the cursor would shift and the drag would run away).
- Player: orthographic, tilt 0–35° (default 15°), pan/zoom, rotate by 90°. Only the player and dm-play views
  glide to the selected token's confirmed position (`checkFollow`).
- Pixel budget: cap physical pixels at ~2.1 MP (medium) / ~1.3 MP (low) instead of raw DPR; high / ultra render
  natively up to 2× DPR (§10). The WebGL context never has MSAA; medium and above get MSAA from the post
  pipeline's scene target (§10).
- Start-up tier: `render/engine/autoQuality.ts` classifies the GPU renderer string (software → low, mobile →
  medium, Intel UHD → medium, Iris / integrated Radeon → ≤ high, discrete / Apple silicon → ultra) and times a
  short synthetic world-shader workload in its own tiny WebGL2 context, then picks the highest tier whose
  predicted frame cost leaves headroom (cached per GPU for 30 days under `atlas:quality-probe:v2`; the tier is
  re-derived from the cached measurement for the current window size). `EngineCanvas` on "Auto" (every route:
  editor, host console, player) reads the cache synchronously with `cachedQuality()` and creates the engine at
  once; only without a fresh cache entry does it run `pickInitialQuality()` first (one probe at a time). On "Auto" the probed tier is both the starting tier and the adaptive ceiling; an explicit tier is
  the ceiling. The editor, the host console and the player page each have a quality selector
  (`components/canvas/QualitySelect`, choice stored per browser under `atlas:quality`).
- Adaptive quality (`render/engine/quality.ts`) steps one **whole tier** down when p95 frame cost > 18 ms for
  2 s. It steps up when p95 < 12 ms for 5 s **and** p95 × the next tier's cost ratio fits ~14 ms, never above
  the ceiling. A tier whose step up failed (had to be undone) is not retried until the ceiling or the viewport
  changes, so a scene on the edge settles instead of oscillating (the timer query under-reads a frame by
  15–25%, so "< 12 ms" alone kept promoting a tier that could not hold). Frame cost is max(CPU time, GPU time
  from `EXT_disjoint_timer_query_webgl2`) when the timer query exists, otherwise the frame interval (a steady
  vsync-locked interval counts as headroom).
- Tier switches: an adaptive step prepares the next tier while the old one keeps rendering. Its programs
  compile in the background (clones of every material variant with the new `AT_TIER` define,
  `renderer.compileAsync`, i.e. `KHR_parallel_shader_compile` where the driver has it), and the lighting
  system allocates the shadow atlases whose layout changes, unbound, and fills them in later frames under a
  tile budget of their own (`prepareQuality`; lights leaving ultra's hi-res atlas get their 512² tiles).
  The engine commits the tier in one frame once both are ready (`qualityReady`: every ranked shadowed light
  and viewer has a capture where it will draw from), or after `TIER_COMPILE_DEADLINE_MS` (1.5 s), in which
  case the missing tiles are recaptured in that frame. So no light drops out on a switch (before, every
  shadowed light went dark and came back 4 per frame over 4–6 frames). A tier the user picks applies at
  once: a deliberate recompile, with the reallocated atlases recaptured in its first frame (up to
  `TIER_SWITCH_CAPTURE_MS` = 12 ms of CPU). Adaptive steps never resize map images.

---

## 5. Simulation (authoritative, CPU, `core/`)

### 5.1 Occlusion world (`core/occlusion`)

`buildOcclusionWorld(scene: SceneLike)` emits primitives per the blocking table and Terrain rule:
walls split around openings (window sill + lintel pieces; closed-door leaves per style), wall ends extended at
joints, floors as boxes (flat levels) or one `Heightfield` per floor (levels with a heightmap), stepped boxes
under stairs/ramps, pillars (box/cylinder), prop parts (box/cylinder, scaled, rotated). A 2D uniform grid
(5 ft) over XZ accelerates queries (DDA + mailboxing). `update(scene, changedIds)` and
`updateTerrain(scene, levelId, rect)` rebuild incrementally (a wall brings its openings and the neighbours
whose joints change, an opening its host wall only if its span changed, a connector the floors it cuts) and
return dirty regions only for primitives whose value changed; a change of levels/grid rebuilds everything.

- `raycast` reports the nearest entry; exact ties (coplanar faces entered at the same t) go to the smallest
  primitive key, so the reported primitive does not depend on grid registration order (edit history).
- Conventions shared with the GPU proxies (`render/occluders`): `OrientedBox.yaw` is three.js `rotation.y`
  (`Matrix4.makeRotationY`): local +X maps to world `(cos yaw, 0, −sin yaw)`. Heightfield arrays are row-major
  by z then x: `heights[sz·samplesX + sx]` (world Y), `solid[cz·(samplesX−1) + cx]`, same triangle split as
  `core/scene/heightmap`.
- Primitive keys (stable across rebuilds; `sourceType` in brackets): walls `${wallId}` (first full-height piece),
  `${wallId}#after:${openingId}`, `${wallId}#lintel:${openingId}`, `${wallId}#sill:${openingId}` [wall]; closed door
  leaf `${doorId}` [door]; window movement box `${windowId}` [window]; flat-level floor boxes `${floorId}`,
  `${floorId}#k` [floor]; heightmap-level floor heightfield `${floorId}` [terrain]; stairs/ramp rows
  `${connectorId}` / `${connectorId}#k` (row k from the bottom edge) [connector]; pillar `${pillarId}`; prop parts
  `${propId}`, `${propId}#i` [prop]. On heightmap levels a lattice cell is solid when its centre lies in an
  effective floor rect (exact for grid-aligned floors).

### 5.2 Vision (`core/vision`)

**Viewer eye** (`resolveViewerEye`): nominal eye `ground + eyeHeight`, clamped to `ceiling − 0.25` (ceiling from
an upward sight raycast), then pushed out of any containing sight blocker it did not start in.

**Samples**: per cell, centre + 4 points inset `VISION_SAMPLE_INSET` (0.75 ft) from the cell edges, at
`groundHeightAt + 0.25`. A (level, cell) is **sampleable** only if an effective floor / heightfield / connector
footprint covers the sample on that level (stairs/ramps and ladders on their lower level; ladder cells and the
top row of a stairs/ramp run also on the level they arrive at, at that level's ground, so the opening is seen
from above). Every cell a token can stand on (`hasGroundAt`) is sampleable at the same height (checked in
`src/integration`; on heightmap levels up to the floor's lattice rasterisation).
Samples inside a sight blocker P count as seen via a side probe or a top probe (`top(P) + 0.25`, if below the
next ceiling). The side probe succeeds when the ray from the eye, at its first hit parameter, enters one of
the sight blockers containing the sample (ties within 1e-9 count, so which of two coplanar primitives the
query returns does not matter); that entry point, pulled back 0.1 ft, is the probe point. Point lights use
the same rule on the light channel, ignoring the light's own fixture.

**Light level** at p: `max(ambientAt(p), sun(p), max_i light_i(p))` where
- `ambientAt(p) = skyExposed(p) ? env.skyLevel : env.ambientLevel` (sky-exposed: vertical light ray escapes);
- `sun(p) = directional.enabled && ray toward the sun escapes the scene bounds (light channel) ? grants : dark`.
  The scene bounds are the grid extent ∪ the AABB of every occluder primitive, plus 1 ft (top = the highest
  level top or primitive top + 1 ft). A fresh engine computes exactly that; the incremental engine only
  grows them by each dirty box, and larger bounds over empty space give the same answers, so results do
  not depend on edit history. Off-grid geometry within the ±50 ft `coordMargin` (§3) therefore casts sun
  shadows onto the grid;
- `light_i(p)`: lights that are `on` and not effectively hidden; 3D distance with static radii; blocked only if
  `castsShadows` and the light-channel segment is blocked (ignoring the light's own fixture).

**Perception** per sample for a viewer with LOS (sight channel, from the clamped eye) and distance d:
3 if `!blind && light ≥ dim`; else 2 if `!blind && d ≤ darkvision`; else 1 if `d ≤ blindsight`; else 0.
A blind viewer with no blindsight perceives only its own footprint. A cell's grade = max over its samples and
viewers; cells whose samples disagree get a 4×4 sub-cell refinement (`partial`).

**Caches** (incremental; run in the host's vision Worker):
- `LightField` (viewer-independent): per level, light level per sample, with per-light contribution bits.
  A light change recomputes only its old/new dim sphere; an occluder change recomputes lights whose sphere
  meets the dirty region, plus sky/sun bits under it. Sub-cell light (the 4×4 refinement of cells whose
  samples disagree, `subLevels`) can change without any sample changing, because a shadow edge can move
  between sub-cell centres. So an environment change (sun direction or elevation, sky / ambient level)
  re-evaluates the sub-cell refinement of every mixed cell (valid samples at different light levels), and
  an occluder change drops the cached sub-cell light of every mixed cell in the sky/sun-swept region under
  the dirty boxes, flagging those cells for the viewers.
- `ViewerLos` per viewer: seen bits per sample keyed by (eye, level, occlusion version), invalidated by dirty
  regions within range. LOS is only tested on samples that could pass (lit, or within darkvision/blindsight
  range), so darkness is cheap.

**Tokens** are visible if any test point passes: footprint centre + 4 corners inset 0.5 ft (+ edge midpoints for
≥3-cell footprints) × heights (ground+0.25, height/2, height−0.1), each capped below the ceiling; off-centre
points whose segment from the centre is sight-blocked are skipped. (No "stands in a visible cell" rule.)

**Moves**: the host evaluates visibility at every step of an applied path and ORs each result into explored
and memory, so corridors walked past are explored. Only the final position is on the result's critical
path: the intermediate steps are evaluated after the result, as low-priority **probes** in the vision worker
that do not change its revision (one probe per step for all affected players, posted after the move's final
revision). Their exploration arrives in a follow-up patch. A probe is discarded if, before it resolved, the
scene changed in a way that matters (objects, terrain or structure: a door opened, a map edit — the move's
own token change excepted) or a DM command reduced visibility (hide, fog reset…), so a late step can never
see through a door opened after the token walked past.

### 5.3 Movement (`core/movement`)

A path is a list of `PathStep {cell (anchor), levelId}` starting at the token's current anchor. Each step is to
an 8-neighbour anchor on the same level, a ladder switch in place, or a stairs top-edge crossing (runs are
entered and left on their level per the connector-edge rules of §2, incl. `MAX_RUN_SIDE_STEP`). The token's
body, shrunk by a 0.6 ft clearance per side (`MOVE_CLEARANCE`), is swept as a **disc** (a medium token sweeps a
3.8 ft disc, so it fits the default 4 ft door and passes 0.5 ft walls on its cell edges; a large token does not
fit a 4 ft door) along the step against movement blockers on the relevant level (plus the upper level near a
stair top) whose vertical extent overlaps [ground + 0.5 ft step-up, ground + body height]. A disc, not the
body's square, so collisions do not depend on wall direction: battlemap buildings are often rotated, and a
square's corners reach 1.4× further into a 45° wall. Diagonals may not cut corners: both L-shaped routes
through the orthogonal neighbours must be free, counting grid-aligned architecture and other blockers only
(rotated walls have no grid corner; in a rotated corridor the legs would clip its walls while the diagonal
runs clear). Blockers the token already overlaps at the start are ignored (like occlusion's entry rule).
**Doorways**: grid steps rarely cross a door at its centre (never exactly in a rotated wall). A step ignores
the host wall's full-height pieces (not lintels or sills) when an open door at least as wide as the disc is on
it and, over the part of the step where the disc can touch the wall, the centre stays 0.5 ft
(`DOORWAY_MARGIN`) inside the opening; the legs of a diagonal through such a doorway ignore them too. With
snapping on, the editor's door tool puts a door in a rotated wall where a straight grid walk goes through it
(`walkableDoorOffset`: usually where the pointer is, else a foot or two along). Every target
footprint needs ground (`hasGroundAt` at every footprint cell centre). The host applies the **legal prefix**
("bump into a wall") and replies
`{ok:false, reason, applied}`; if the failing step's cell is not perceived by that player the reason is
reported as `blocked`. Distances use `grid.diagonalRule`; speed only when the DM enforces it. Paths > 256 steps
are rejected.

### 5.4 Observation & memory (`core/vision/observe.ts`, `core/session/memory.ts`)

An object is **observed** now if:
- door / window / pillar / prop / connector: a perceived cell (or sub-cell) intersects its own footprint
  (openings: their segment ± half the wall thickness);
- wall / floor: any perceived cell intersects its footprint (walls: segment inflated by thickness/2);
- static light: its source point is in LOS of a viewer, or its cell is perceived;
- attached lights are never observed as objects (they travel with their carrier, see §6.2).

After each visibility update, per player: observed objects overwrite `memory[uid][id]` with the sanitised
current object; memory entries whose remembered footprint lies in a perceived cell but whose object no longer
exists (or became hidden) are deleted. Everything else is unchanged — DM edits out of sight stay invisible.

---

## 6. Multiplayer (DM-authoritative)

### 6.1 Roles, topics, transport

- The DM's tab is the **host**: owns `GameState`, validates requests, runs vision (Worker), filters, diffs, sends.
- Single host: same browser via `navigator.locks` (`atlas-host:{sid}`); across devices via `claim_host(sid)`
  which bumps `sessions.host_epoch`. Each host start also creates a random `epoch` string used on the wire,
  formatted `${hostEpoch}.${uuid}` (`net/host/flush.ts` `makeWireEpoch`). Clients only compare wire epochs for
  equality; hosts parse the number (`hostEpochOfWire`) to tell which of two hosts is newer from status
  broadcasts and presence. A host that sees a higher epoch (broadcast, presence or failed fenced write) stands
  down to "standby" and offers "Take over".
- Transport interface `net/transport.ts`: `SupabaseTransport` (private channels only, via one helper that
  hard-codes `config.private = true`; view channels with `broadcast.ack = true`; never sends while not joined;
  token bucket ≈ 25 msg/s; size guard 200 KB) and `LocalTransport` (BroadcastChannel; dev/testing only, NOT secure).

| Topic                        | INSERT (send)                          | SELECT (receive)          | Carries |
|------------------------------|----------------------------------------|---------------------------|---------|
| `session:{sid}:req:{uid}`    | that player (active member), broadcast | DM + that player (active) | ClientToHost |
| `session:{sid}:view:{uid}`   | DM, broadcast                          | that player (active) + DM | HostToClient (incl. `tiles` chunk announcements, §9) |
| `session:{sid}:host`         | DM, broadcast + presence               | active members + DM       | HostBroadcast; DM presence = host online |
| `session:{sid}:lobby`        | active members, presence only          | active members + DM       | who's online (display only) |

Realtime only lets a client join a private channel it may READ, so the player also has SELECT on its own
req topic (it joins with `broadcast.self = false`; only it can write there, so nothing is exposed).
The sender of a request is the `{uid}` in its topic, never a payload field. Membership comes from
`session_members` (host re-reads it on start and on lobby presence changes), never from presence payloads.

### 6.2 Host pipeline

```
request (req:{uid}) ─▶ zod-validate (strict, limits) ─▶ authorize (owners, locks, door rules) ─▶ reduce (immer)
      DM commands ───────────────────────────────────────────────────────────────────────────▶ reduce
                        ▼ mark changed ids + dirty players
   vision worker: update(scene, change) → per player: compute(viewers) ─▶ {stateSeq, VisibilityResult}
                        ▼ (only if stateSeq matches the state being filtered)
   updateKnowledge: explored |= perceived, memory refresh (§5.4), revealed secret doors
                        ▼
   flush scheduler (per player, ≤ every 100 ms): view' = filterForPlayer(state, uid, vis); ops = diffViews(last, view')
                        ▼ non-empty ops only
   patch{epoch, baseSeq, seq, ops, results} on view:{uid}   (+ player_views upsert: ≤ every 5 s, ~1 s after own tokens / exploration change)
```

- Request handling is event-driven (no rAF). The Supabase client uses `realtime.worker = true`.
- `filterForPlayer(state, uid, vis)` is the **only** path to a player. It builds every field explicitly
  (allowlist types in `core/session/types.ts`, zod `.strict()` schema test):
  - **viewers**: the player's tokens (owners) + party PC tokens if shared vision and the player owns ≥ 1 PC.
  - **objects**: from `memory[uid]` only (observed objects are refreshed there first), CLIPPED to explored
    cells with no dilation: walls → parametric runs whose inflated footprint overlaps explored cells or
    explored sub-cells, widened to contain any sent opening; floors → per-row runs of explored cells (whole
    cells, even partly explored ones) merged to rects; piece ids
    `${id}@${x},${z}`; openings re-parented (`wallId` = piece, `offset` rebased). On heightmap levels a
    wall's base is the ground at *its own* midpoint (Terrain rule, §2), and the client computes it at the
    piece's midpoint, so pieces are sent with `height` (and their doors' `height`, windows' `sillHeight` /
    `height`) rebased by `hostBase − clientGround(piece midpoint)`: the client then reproduces the host's
    absolute wall top, door heads, sills and lintels (`src/integration/crossModule.test.ts` runs vision →
    knowledge → filter → `viewToScene` on a sloped heightmap and checks that the render builders draw the
    player's clipped pieces at the host's heights). A piece whose rebased height would be ≤ 0 (buried) is
    omitted. Connectors, pillars, props: whole or nothing. Secret doors are omitted unless `revealed[uid]`
    contains them (auto-revealed when observed open, or by `reveal-object`) and then sent as style "wood";
    the host wall renders solid without them.
    Props never carry `blocksMovement` (DM-only); `viewToScene` assumes the `PROP_LIBRARY` default, so a
    client path preview can differ from the host's validation for props whose flag the DM changed.
  - **lights**: static lights from memory with `emitting = (in illuminatingLightIds)`; attached lights only while
    their carrier token is in the view (resolved position, `emitting = on`). Never `attachedTokenId`.
  - **tokens**: controlled + vision tokens always; others only while in `visibleTokenIds`; never hidden. Other
    players' tokens get `label` only; `name/eyeHeight/vision/speed` only for controlled/vision tokens.
    `model` (a `free:<id>` reference, §3) is sent with every token sent: it is what the token looks like.
  - **levels**: known levels (any explored cell) + stubs (`known:false`, `name:null`) for levels referenced by a
    sent connector or own token. **terrain**: chunks overlapping explored cells, samples touching no explored cell
    zeroed. **masks**: perception (current), explored (persistent), sunlit (current ∧ perceived).
- Vision worker contract (`VisionClient`, `net/host/types.ts`): `setScene` / `update(scene, change, stateSeq)`
  advance the worker's revision; `compute(viewerTokenIds, stateSeq)` answers for that revision;
  `probe(scene, change, viewerSets)` evaluates each viewer set on the current revision with `change` taken
  from `scene` (a moving token at an intermediate step) without adopting it, and reports the `stateSeq` it
  was applied to; `pendingProbes` counts queued ones. Two lanes: probes wait until no setScene / update /
  compute is outstanding and run one at a time, so a foreground call waits for at most one probe and a
  flush never queues behind a long path's steps (§5.2 Moves).
- Request rules: ≤ 8 req/s per player (burst 16), one in-flight move per token, paths ≤ 256 steps.
  Hellos have their own budget (1/s, burst 4; over-budget hellos are dropped and the client retries with
  backoff) and are coalesced, so at most one is queued per player (the latest nonce wins). A request refused
  by the limiter gets a `rate-limited` reply only within 2/s (burst 4); beyond that it is dropped silently, so
  a flood cannot turn the DM's shared 25 msg/s send bucket into replies.
  Door requests: the door must be in the player's current view, a controlled token on its level must be within
  one cell of the door segment, movement not locked; failures reply `"cannot"`; `"locked"` only after the
  adjacency check passes. Players can never unlock.
- DM edits during a live session: the editor applies immer patches to `GameState.scene`
  (`apply-scene-patches`); play actions (token moves, door/light toggles) are DmCommands and never enter undo.
  Grid resizes remap explored masks; deleting a level drops its masks/memory.
  `GameState.origin = {sceneId, version, dirty}` records the library scene row the session was started from
  and the version the live map is based on; `apply-scene-patches` sets `dirty` (play actions never do), and
  `set-origin` records a save. `HostRunner.saveMapToLibrary({force?})` saves the live map (edits, token
  positions, hidden tokens, door and light state as they are now) as a new version of that library scene
  with a `baseVersion` conflict check: another version saved meanwhile (e.g. from the editor) rejects with
  `version_conflict`, and `force` overwrites (the version history still keeps every earlier version); a
  deleted library scene rejects with `not_found`. It needs `HostRunnerOptions.scenes` (the scene library),
  and `HostSnapshot.library = {sceneId, version, dirty} | null` exposes the origin. The saved version keeps
  the library entry's current name, and edits made while a save is in flight leave `dirty` set.
  The host console passes `services.scenes`, and its "Save map to library" button, Ctrl+S in Edit map and
  "Save map & end" (end-session dialog, offered while `origin.dirty`) all call `saveMapToLibrary` through
  `components/play/host/useSaveMap`; a conflict toast offers "Overwrite" (force). The "unsaved edits" dot is
  `origin.dirty`, stored with the game, so it survives reloads and other devices. A game saved before the
  origin existed resumes with `version: null` (the scene id comes from the DM's session list): its first
  save treats a library scene updated after the session started as changed elsewhere and asks first.

### 6.3 Sync, reconnection, persistence

- Per-player `seq` (increments only for non-empty patches) + host `epoch`. Host keeps per player
  `{lastSent: PlayerView, seq, log}`; the log holds recent patches (≥ 90 s and ≤ 200 KB).
- Client rule: apply a patch iff `epoch === local.epoch && baseSeq === local.seq`; otherwise send
  `hello{nonce, epoch, lastSeq}`. Host answers: in-sync → `sync`; catch-up from log → one concatenated patch;
  otherwise → `snapshot` (≤ 200 KB) or awaited `player_views` upsert then `snapshot_ready{epoch, seq}` (client
  reloads the row, accepts only matching epoch and `seq ≥`). Replies echo `nonce` so other tabs ignore them.
  Because hellos have their own budget and are coalesced (§6.2 Request rules), the snapshots a hello can
  trigger are bounded per player. The backdrop tile table (§9) is resent with every snapshot, because a
  reloaded tab has lost it.
  Further client rules (`net/player/playerClient.ts`): a HostBroadcast `status` retires every other epoch the
  client has seen (epochs are random, so this is how a stale host is told from a new one); a `nonce: null` is
  treated as absent; same-epoch snapshots/patches older than the local seq are ignored without a hello; a
  standalone `result` or `sync` with `seq` > local (or another epoch) triggers a hello. Hellos are coalesced and
  retried with backoff (2.5 s doubling to 15 s).
- Join order (client): subscribe `view:{uid}` → SUBSCRIBED → subscribe `req:{uid}` → send hello. Host: when a
  player's link becomes ready for the first time in this host run (boot, new member) it pushes a
  snapshot / snapshot_ready. A later rejoin of the same link (Realtime error, JWT refresh, network blip), where
  the client most likely still holds its view, gets the backdrop tile table (§9) and `sync` at the current seq
  instead (`resumeLink`): a client that missed patches answers with hello and gets a catch-up, or a snapshot if
  the log no longer covers it. Results whose send failed while the link was down go out with the next flush.
  The host keeps each player's last 32 results with their seq (`ResultLog`): catch-up patches and hello-driven
  snapshots carry the results after the client's `lastSeq`, so a result lost with a patch still arrives (the
  client ignores ones it has already settled). Host sends `sync` on idle (~10 s) so a lost final patch is
  detected.
- Host liveness = DM presence on `session:{sid}:host` (1.5 s grace after the host channel joins). On leave: the
  client loads its `player_views` row (adopted only if it has no view, or the row is the same epoch with a
  higher seq), shows "Waiting for DM", disables moves. While not live, the client re-checks
  `session_info(sid)` every ~10 s, so it notices a kick or a session ended from the library (where no host is
  running to broadcast `ended`) and shows the ended / kicked screen. Pending optimistic moves are overlays
  only; they clear when their result is applied, on snapshot/epoch change, or after 5 s ("DM not responding").
  The client's own network is watched separately (`Transport.networkOnline` / `onNetworkChange`; Supabase:
  `navigator.onLine` plus a socket poll that needs two failures): while it is down, requests are refused
  locally as `not-connected`, an expiring request is not blamed on the DM, and the snapshot's
  `networkOffline` flag lets the HUD say "You're offline, reconnecting…".
- Host timing (`HOST_TIMING`): per-player flush ≤ every 100 ms, idle `sync` after 10 s, member re-read every
  10 s and on lobby presence changes. A move's result latency is the flush throttle (≤ 100 ms) + one vision
  compute of the final position + at most one in-flight step probe (§5.2 Moves). That compute is ~7 ms on
  interior maps but 100–500 ms on large, fully daylit open maps (Node: 120×120 cells ≈ 110 ms, 200×200 ≈
  490 ms; about 3× that in the browser worker), where every sample is lit and LOS is tested everywhere. In browsers
  the host's timers run in a tiny worker (`net/host/timerWorker.ts`) because Chrome throttles main-thread timers
  in hidden tabs.
- Channel supervisor: CHANNEL_ERROR/TIMED_OUT → `realtime.setAuth()` then built-in rejoin; unexpected CLOSED →
  remove and recreate with backoff.
- Persistence (fenced by epoch RPCs): `save_session_state(sid, host_epoch, state)` throttled ~5 s + immediately after
  DM commands that reduce what players may see (hide token, remove token, reset fog, scene edits) + within ~1 s
  after token moves and exploration (so a reloaded host tab resumes where the tokens were) + best-effort on
  `visibilitychange→hidden`; `upsert_player_view(sid, uid, host_epoch, epoch, seq, view)` throttled ≤ 5 s for
  ordinary changes (other tokens, doors, lights), but within ~1 s (`moveSaveGapMs`) when the player's own
  situation changed — which tokens they control or see through (e.g. the first assignment after joining),
  where those tokens stand, what they explored (`viewSaveUrgency`, `net/host/flush.ts`) — and awaited
  before `snapshot_ready`. The row is what a player who reloads while the DM is away sees. `host_epoch`
  (bigint, from `claim_host`) is the database fence (a stale host gets `stale_epoch`); `epoch` (text) is the
  wire epoch stored with the view so a reloading client can match it.

### 6.4 Database & RLS (`supabase/migrations`)

Identity (`net/auth.ts`, `app/account.ts`): every Cloud user is a Supabase user. Visitors start as
anonymous guests (`signInAnonymously`, session in localStorage). "Continue with Discord" first links
Discord to the guest (`linkIdentity`, needs "Allow manual linking"): the user id is unchanged, so every row
keyed by it (scenes, sessions, memberships, Storage folders) stays and the guest becomes permanent. If the
Discord account already belongs to another user, the callback carries `identity_already_exists`, and the
app switches to that account (`signInWithOAuth`, Discord `prompt=none`). A guest that owns scenes or hosts
an active game first takes a merge ticket along (`create_merge_ticket()`, 256 random bits, only the SHA-256
stored, one hour, one per guest), and the account redeems it after signing in through the `merge-guest`
Edge Function (secret key; `verify_jwt` off because user tokens are ES256, so it checks the caller with
`auth.getUser`): `begin_guest_merge` validates the ticket (guest still anonymous, target permanent and not
the guest) and the combined quotas and names the guest's `scene-assets` objects; the function moves them
from `{guest}/…` to `{account}/…` with the Storage API; `finish_guest_merge` (one transaction, both quota
locks) moves scenes and hosted sessions (dropping the account's own membership in them), adopts the
guest's display name only if the account has none, and consumes the ticket; the function then deletes the
guest user. `begin_`/`finish_guest_merge` are executable by `service_role` only, and every step before the
last SQL one can be retried with the same ticket. The guest's memberships in other DMs' games are not
merged (their game state names the guest's user id; the player rejoins by room code). If no ticket can be
made, the app asks before switching, since the guest's work would stay behind. OAuth uses
PKCE: the provider returns to `/auth/callback`, which `ServicesProvider` finishes before services start
(code exchange, then `history.replaceState` to the path saved in sessionStorage, same-origin paths only),
so the callback never signs in a new guest first. Signing out (`scope: "local"`) restarts the app as a new
guest. RLS treats guests and permanent users alike. The display name (`profiles`) belongs to Atlas: a new
account starts with its Discord name if it has none, and after that the two are independent.

Tables (RLS enabled on every table; default privileges revoke anon; functions revoke PUBLIC/anon execute):
- `profiles(id → auth.users, display_name)` — own row only.
- `scenes(id, owner_id, name, visibility 'private'|'link', share_slug (≥128-bit random), latest_version, …)` and
  `scene_versions(scene_id, version, schema_version, data jsonb, created_at)` — owner only; versions immutable.
- `sessions(id, dm_id not null, scene_id, room_code unique while active, status, host_epoch, created_at)` —
  DM full access; players no direct SELECT (they use `session_info(sid)` RPC).
- `session_members(session_id, user_id, display_name 1..32, status 'active'|'kicked', joined_at)` — SELECT own row
  or DM; no client INSERT/UPDATE; writes via RPCs. A display name changes only by joining again
  (`join_session`), which refuses (`name_taken`) names that pose as the DM ("DM", "GM", "Dungeon Master",
  the DM's profile name, …) or that another member of the session uses (case-insensitive).
- `session_state(session_id, epoch, state jsonb, updated_at)` — DM only; writes via `save_session_state`.
- `player_views(session_id, user_id, epoch, seq, view jsonb, updated_at)` — player SELECT own row while active
  member; writes DM only via `upsert_player_view`.
- `free_assets(id slug, category, name, description, path, thumbnail_path, bytes, metadata jsonb, attribution,
  sort_order)` — the free asset catalog (migration `*_free_assets.sql`): SELECT for every signed-in user
  (guests included), no client writes. Files live in the PUBLIC bucket `free-assets` (`{category}/{file}`,
  GLB / PNG / WebP ≤ 20 MiB), served from `/storage/v1/object/public/…` so a player can load a token's model
  without any grant; there is no client write policy on it either, so assets are published with a secret
  key (`scripts/free-assets/upload.mjs`). Categories: `private.free_asset_categories()` (today
  `token-models`), mirrored by the table's check and `FREE_ASSET_CATEGORIES` (`core/session/freeAssets.ts`).
  Token model metadata: `{lods: [triangles…], height, radius (footprint sides), size?}`. `net/freeAssets.ts`
  reads the catalog once per app run; local mode has none.

Helpers in schema `private` (`set search_path = ''`; execute revoked from public / anon / authenticated,
then granted to authenticated only for the ones policies call, which are `security definer` and stable):
- policy helpers: `topic_sid()`, `topic_kind()`, `topic_uid()` (regex-validated parsing of `realtime.topic()`
  via `parse_topic`), `is_session_dm(sid)` (from `sessions.dm_id` only), `is_active_member(sid)`; Storage:
  `can_read_session_tile` / `can_write_session_tile` / `can_delete_session_tile(name)` (`session-tiles`,
  parsing paths with `parse_chunk_path`) and `can_insert_scene_asset(name)` (`scene-assets`: own folder,
  well-formed path, per-owner quota); `normalize_display_name`;
- RPC internals: `lock_fenced_session(sid, host_epoch)` (locks the session row and checks the fence for
  `save_session_state` / `upsert_player_view`), `check_scene_payload` (schema version and size of a scene
  document), `check_owner_scene_quota` / `prune_scene_history` (quotas below), `display_name_taken`,
  `normalize_room_code` / `normalize_scene_name`, `generate_room_code` / `generate_share_slug`, and the
  `max_*()` limit constants;
- triggers: `touch_updated_at`, `forbid_update` (immutable `scene_versions`).

RPCs (`security definer` unless noted, `search_path=''`, execute granted to authenticated
only; return ids/booleans/small records, never whole rows; errors carry a stable MESSAGE code mapped by
`net/supabase.ts`): `create_scene`, `save_scene_version` (optimistic `p_base_version`), `set_scene_visibility`,
`set_display_name` (`security invoker`: own profile row under RLS), `create_session(scene_id, free_assets = '{}')` (owner check, copies the scene into session_state,
generates an 8-char Crockford room code; `free_assets`: the categories the game loads, validated against
`private.free_asset_categories()`, stored de-duplicated and sorted in the seed's `freeAssets`), `join_session(room_code, display_name)`, `session_info(sid)`,
`list_session_members(sid)` (DM; `security invoker`: it reads only rows the DM's RLS already allows),
`set_member_status(sid, uid, status)` (DM), `claim_host(sid)`,
`save_session_state`, `upsert_player_view`, `end_session(sid)`, `get_shared_scene(slug)`, and (`security invoker`,
naming what the client then deletes through the Storage API, since SQL cannot delete Storage objects)
`image_folders_to_free(scene_id)` / `unreferenced_scene_assets(min_age)` for map images no scene uses.

Quotas (migration `*_owner_quotas.sql`; anonymous sign-ins are free, so every write path that can grow the
database or Storage is capped per account or per session, and concurrent calls of one owner queue on an
advisory lock). Sizes are `pg_column_size` (on-disk, compressed). Over a limit, an RPC raises the error code
`quota_exceeded` and a Storage policy refuses the upload (an RLS error):
- scenes: ≤ 50 library scenes and ≤ 200 MB of stored versions per owner (`create_scene`,
  `save_scene_version`); each scene's history keeps ≤ 50 versions and ≤ 100 MB, pruned oldest first (the
  latest version always stays);
- sessions: ≤ 20 active sessions per DM (`too_many_sessions`) and ≤ 50 sessions including ended ones —
  `create_session` deletes the oldest ended sessions beyond that (state, members and views cascade);
- `scene-assets`: ≤ 300 objects and ≤ 1 GiB per owner (storage insert policy; 50 MB per object);
- `session-tiles`: a chunk's `{userId}` must be a member of the session, and a session holds ≤ 20,000
  objects.
The limits are per account (guest or permanent): abuse spread over many accounts is bounded only by
Supabase's per-IP anonymous sign-in rate limit (README).
Realtime: `realtime.messages` policies per the §6.1 table, checking `extension` ('broadcast'/'presence').
Realtime evaluates them when a channel is joined and again when the client sends a new JWT (`access_token`,
e.g. on a token refresh), and caches them in between. So a member kicked while subscribed keeps receiving
the host and lobby topics until their client sends a new JWT, or is disconnected when that JWT expires
(1 h by default); the host stops sending on their view topic at once, and the host topic carries only
`status` (wire epoch, scene name) and `ended`, the lobby only presence. A new join is refused at once.
Dashboard settings (not SQL): enable anonymous sign-ins; for permanent accounts enable the Discord provider
and "Allow manual linking" and allow-list each origin's `/auth/callback`; disable Realtime "Allow public access"; keep the
anonymous sign-in rate limit low for public deployments (Authentication → Rate Limits, default 30 per hour
per IP). Realtime keeps a topic's public and private channels apart (a public subscriber to a session topic
receives none of its private broadcasts, checked by `e2e/multiplayer-supabase.mjs`), so the public-access
switch guards the project's Realtime quota and future channels rather than today's session data; the same
script checks that it is off.

---

## 7. Editor

- Zustand store `editor/store.ts`: working `Scene` (or, during a live session, a proxy onto `GameState.scene`),
  selection, active level, tool, snap mode, view options. Mutations: `editor.apply(recipe, label)` →
  `produceWithPatches`; `core/history` records `{patches, inversePatches, label}`, supports transactions
  (`begin`/`commit` squash to net patches), caps depth (200).
- Tools implement `editor/tools/types.ts` `Tool`. The canvas builds `ToolPointerEvent`s (engine pick on the active
  level + snapping via core/grid; Alt = free placement) and draws `tool.preview()` via engine overlays.
- Heightmap brush: decode dense heights on pointerdown, paint into a scratch array, preview via
  `engine.previewTerrain`, commit once on pointerup writing only dirty chunks (one undo step).
- Integrity (`core/scene/integrity.ts`): `deleteWithDependents`, `copySelection` / `pasteClipboard` (fresh ids via
  idMap, remap level by relative order (`AtlasClipboard.levelOffsets`), drop orphan openings or re-host them on
  the wall under the pointer (`opts.hostWallId`, placed via `openingCenters`), connector target = level above,
  detach lights whose token wasn't copied), `reprojectOpenings`, `splitWall(draft, wallId, distance)` (for a future wall-splitting tool; no editor tool calls it yet),
  `validateReferences`. `deleteWithDependents` allows deleting the last level; `removeLevel` in the store keeps
  at least one.
- Document guard (`editor/validate.ts`): `apply()` validates what each edit's patches touched (touched objects /
  tokens plus their host walls, openings and carriers, all levels without terrain; everything after a grid
  change) with the strict schema and `validateReferences`, and refuses the edit (`[]` / `false`, reason in
  `lastRejected`) if the document would no longer load: e.g. content dragged, nudged or pasted beyond the extent
  ± 50 ft, a grid shrunk under objects, out-of-range numbers or strings.
- Snapping: cell centre / vertex / half / free, plus wall endpoints and wall centrelines for the wall tool.
  Pasting at the pointer (Ctrl+V) snaps the paste translation with the current snap mode, anchored on a
  reference item (the first token, else a structural item, else a point item) with the same rules as a drag,
  so pasted tokens land on cell centres. Free mode, Alt held, or Ctrl+Alt+V keeps the raw pointer point.
- "Preview player view": pick a token → render mode player with masks computed locally by core/vision
  (explored = currently perceived, no memory).
- View options (camera, grid, helpers, ghosts, dark vision) are remembered per scene on the device
  (`components/editor/lib/viewPrefs.ts`); the host's live editor carries ghosts, level visibility and dark
  vision over between "Edit map" sessions. Dark vision (§4.1) is off whenever the host console is in play mode.
- Keyboard (TanStack Hotkeys): keymaps are command tables, `EDITOR_COMMANDS` (`editor/shortcuts.ts`) and
  `PLAY_COMMANDS` (`play/keys.ts`), each command with a stable id, a label, default keys (`Hotkey` strings,
  `Mod` = Cmd on macOS / Ctrl elsewhere) and an action. Users remap keys in the Keyboard shortcuts dialog
  (`components/keybindings`, recording via the library's `HotkeyRecorder`). Remaps are per-command overrides
  saved in localStorage (`atlas-vtt:keymap`, versioned), and a key belongs to at most one command per
  keymap (`lib/keymap.ts`). Pages register the effective bindings through `useAppHotkeys` (`lib/hotkeys.ts`),
  which adds the app's rules to the manager's matching. Shortcuts don't fire in text fields or under
  dialogs or menus. Navigation keys stay with a focused widget (`editorMayHandleKey`). The default is
  prevented only when the handler used the key. Propagation is never stopped. `useEditorHotkeys` (editor
  page and the host's live editor) hands the matched action to `controller.keyDown(e, action)`: the
  active tool sees the key first (Escape, Enter, R), then `runShortcut`. Alt for free placement comes from
  the library's key-state tracker. Map views turn off the theme provider's "D" hotkey
  (`useSuppressThemeHotkey`), because D is a tool and a pan key there. Menus, tooltips and hints show the
  current keys (`useCommandLabel`, `CommandKbd`).

---

## 8. Play mode

- Player: select a controlled token; drag shows a path (A* over legal steps, core/movement) with ruler (feet,
  diagonal rule); release sends `move`. The pending path is an overlay only; the token moves when the patch
  arrives. Drags target the token's view level (`tokenViewLevelId`, §2), and a drag aimed at the cell just
  beyond a stairs/ramp top edge prefers the run's upper level (falling back to the token's level if the upper
  one is unreachable), so a staircase inside a room with known floor beyond its top is climbed rather than
  walked around. A player's scene has floor only where the player explored, so an upper storey never seen
  (a stub level) or an unseen landing has no ground on the client: such a drop is a **blind landing**,
  planned up the run to its top row plus the step across the top edge (`PlannerOptions.unexplored`). The
  client validates everything it knows (walls, doors, the run itself) and the host, which knows the floor,
  validates the landing: a missing or blocked landing stops the token on the top step (the legal prefix,
  §5.3). A token whose footprint's leading row is on the run's top row gets a "Go up" HUD button (also onto
  an unexplored landing), and one on the landing cell just beyond the top gets "Go down", validated like
  ladder climbs. Ladders keep "Climb up/down".
- Door requests: a click on a door leaf, its top-down marker (§4.3) or the ground next to its segment
  (`doorAt()` proximity) toggles it. Hover highlight and the pointer cursor use the same `doorAt()` rule, so
  a door is discoverable wherever a click would work.
- The play-mode Measure tool (players and DM) and the editor's Measure tool share one rule, `rulerDistance`
  (`core/grid`): the king-move cells through the waypoints' cells (`legCells`, diagonals first), priced with
  the grid's diagonal rule over the whole route (`pathDistance`), or the euclidean length in free mode.
- Play keys: `usePlayKeys` registers `PLAY_COMMANDS` (host-only commands, level switching and vision preview,
  only for the DM). WASD / arrow panning is the top-down camera's own held-key input and is not remappable, so
  the dialog refuses those keys for play commands.
- DM play controls: lock/unlock movement (global and per player), shared vision toggle, enforce speed, door and
  light toggles, sun/moon on/off (scene patch), move any token, hide/reveal tokens, reveal secret doors, assign
  tokens to players, preview any token's vision, kick players.
- Free assets: "Start a game" (library and editor, `components/app/StartGameDialog`) chooses the free asset
  categories the game loads (remembered per browser); they reach `GameState.freeAssets` through the seed
  (§6.4) and are DM-only (never sent). The host console's Assets tab switches categories
  (`set-free-assets` DmCommand) and lists their assets: a token model click sets the selected token's
  `model`, a scene patch like hiding a token (so it marks the map as edited and "Save map to library" keeps
  it). The Tokens tab menu and the inspector's Model field (editor: every model; host "Edit map": the
  game's categories, `FreeAssetScopeContext`) offer the same models. Unloading a category keeps the
  models tokens already have.

---

## 9. Map images (battlemap backdrops)

DMs usually start from a battlemap image (e.g. Forgotten Adventures maps: 140 px per 5 ft cell, one image
per storey, transparent outside the drawn area on upper floors/basements).

- **Import** (`net/assets/import.ts`): decode with `createImageBitmap(blob, {resizeWidth, resizeHeight,
  resizeQuality:"high"})` (plain `Image.decode()` fails on 100+ MP images), normalise to ≤ 140 px per cell and
  ≤ 8192 px per side, encode WebP (quality ≈ 0.9; PNG fallback) and store via `AssetStore.putImage`.
  Calibration: the DM enters the grid size in cells (e.g. 27×47) or px-per-cell and an optional offset; a
  new scene can be created "from map images" (grid sized from the first image, one level per image).
- **Document**: `Scene.assets[id]` (metadata only) + `Level.backdrop {assetId, rect, opacity, tintWalls}`.
- **Rendering**: the world material samples the level's backdrop texture (planar XZ projection over
  `rect`) as the albedo of WALKABLE fragments (and of wall/prop caps/faces when `tintWalls`), blended by
  `opacity` × image alpha over the material colour. Lighting, shadows, perception and fog apply as usual
  (explored memory = desaturated image). Textures use anisotropic filtering and mipmaps.
- **From image**: `core/scene/imageTrace.ts` (pure, on `{width, height, data: Uint8ClampedArray}`):
  - `floorMaskFromAlpha(img, calib, spacing = cellSize/4, threshold)` → `FloorMask` (+ bounds) for a floor that
    covers exactly the opaque part (rotated upper storeys, caves).
  - `wallsFromAlpha(img, calib, opts)` → marching-squares contour of the alpha boundary, simplified
    (Douglas–Peucker, tolerance ≈ 0.75 ft), merged into wall segments (cave walls, building outlines).
  Editor commands expose both ("Floor from image", "Walls from image outline").
- **Mask floors** (`FloorObject.mask`): coverage at `spacing` resolution inside `rect`. Every consumer goes
  through `floorRects()` / `effectiveFloorRects()` (greedy-merged rects), so occlusion, vision, movement and
  render need no special cases. Player views never contain masks: the filter clips `floorRects()` to explored
  cells and sends rect pieces.
- **Players never receive a whole image.** During a session the host uploads, **per player**, the part of
  each backdrop that player has explored, in chunks of 4×4 grid cells (`net/assets/chunks.ts`; `tilePx` =
  stored px per cell, a chunk image is 4·tilePx square, ≤ 1024 px). A chunk is clipped to the player's
  explored 4×4 **sub-cells** (1.25 ft on a 5 ft grid): a cell explored only on one side of a wall carries
  only that side's art, and everything else is transparent. What remains beyond the explored area is at most
  the canvas's antialiasing at the clip edges. The tile edge (`tilePx`) and the cells a backdrop covers
  (`backdropCellRange`: positive-area overlap, with calibrated edges within a small tolerance of a grid line
  snapped to it) come from one module, `core/session/backdrop`, which the filter, the host tiler, the tile
  source and the player compositor all use.
  - Supabase: private bucket `session-tiles`, object path `{sessionId}/{userId}/{levelId}/{ci}_{cj}.webp`,
    written only by the DM of the active session, readable only by that user while an active member (and the
    DM) — storage RLS, migration `*_tile_chunks.sql`. After each knowledge update the host re-draws the chunks
    whose explored cells or sub-cells changed (grown as tokens move, smaller or deleted after a fog reset;
    coalesced per chunk) and uploads them in the background (nearest to the player's tokens first, 8 at a
    time, backing off on HTTP 429), then announces them on the view topic:
    `{t: "tiles", epoch, levelId, chunks: [ci, cj, cellMask, rev][], reset?}`. `cellMask` has one bit per
    cell with any explored sub-cell (0 = removed); `rev` identifies the chunk's content (a non-zero hash of
    its cells' explored sub-cell masks; 3-element entries without it are still accepted), so a chunk whose
    cells stay the same but whose sub-cells grew gets a new `rev`, is re-fetched, and the player redraws
    the refreshed cells. The full list, with `reset`, precedes every snapshot. A view waits at most
    `tileWaitMs` (250 ms) for its chunks, so moves usually arrive with their art, but the game never blocks
    on Storage. Why chunks: an open outdoor map's first view is ~70 objects instead of ~1000 per-cell ones,
    which Storage rate-limits. The earlier per-cell layout `{sessionId}/{levelId}/{i}_{j}.webp` is gone
    (migration `*_drop_legacy_tiles.sql`: table `player_tiles` and RPCs `grant_tiles` / `revoke_tiles`
    dropped; the storage policies accept only per-player chunk paths, so legacy per-cell writes are
    refused, while the DM can still read and delete any object under the session's folder, migration
    `*_session_tiles_dm_read.sql`). A chunk's `{userId}` must be a member of the session (§6.4). DM assets
    live in the private bucket `scene-assets` under `{ownerId}/{sceneId}/{assetId}.webp` (owner-only
    policies, per-owner quotas §6.4), where `sceneId` is the document's `Scene.id` (not the library row id;
    `AssetStore` in `net/assets/types.ts`). The DM deletes the session's chunks when it ends
    (`removeSessionTiles`, once, best effort; Storage answers 429 / 5xx or a network failure are retried
    after 1, 2, 4 and 8 s, so rate limiting at that moment does not leave the chunks behind).
  - Image clean-up: deleting a library scene first asks `image_folders_to_free(scene_id)` which image
    folders only this scene's versions use (no other scene's versions, no active session), deletes the row,
    then those folders (`AssetStore.deleteSceneImages`), so a failure leaves an orphan image, never a scene
    with missing images. Folders still in use stay. The home page sweeps images that no saved version,
    active session or editor draft of this browser uses (`AssetStore.sweepUnreferencedImages`, RPC
    `unreferenced_scene_assets`) at most once a day per browser, on Supabase only, skipping images younger
    than a week (an import or an editor in another tab may not have saved its scene yet). An import whose
    image store fails keeps the scene and reports the error (`storeError`) instead of re-importing without
    images.
  - Local mode: the tile source crops from the locally stored asset (dev only, insecure like LocalTransport).
  - `PlayerView.backdrops[levelId] = {rect, opacity, tintWalls, tilePx}`; the player client prefetches the
    announced chunks, crops cell tiles from them and composites them into a per-level canvas (transparent
    where missing) → `engine.setLevelImage(levelId, canvas, rect, opts)` /
    `engine.updateLevelImage(levelId, dirty?: Rect | Rect[])`. The canvas covers only the chunk-aligned
    bounding box of the level's explored cells, at a fixed px per cell, and grows geometrically as
    exploration spreads (a player who knows a few cells of a storey does not hold a full-map canvas and
    texture). Its pixel budget follows the engine's quality ceiling (`getQualityCeiling()` →
    `backdropTexelBudget`, the same `BACKDROP_MAX_TEXELS` the engine applies to DM images); adaptive
    quality steps never resize images. Updates carry **one dirty rect per changed 4×4-cell chunk**, not their
    bounding box, and the engine uploads each rect (`copyTextureToTexture` of that region) and regenerates the
    mipmaps once per update: a bounding box of the scattered cells a move explores re-uploaded up to the
    whole 25 MP Vineyard texture on every move, which cost 100–300 ms frames.
- Export: `.atlas.json` embeds assets as data URLs (`assetsData: Record<id, dataUrl>`) so a file is portable.

## 10. Quality tiers

`Quality = "low" | "medium" | "high" | "ultra"`. With "Auto", the tier is picked at start-up by
`pickInitialQuality()` (`render/engine/autoQuality.ts`), which `EngineCanvas` runs on every route whenever it
is given no tier, and then adapted at runtime (§4.5). The probe reads the GPU renderer string first
(`RENDERER`, or `WEBGL_debug_renderer_info` where `RENDERER` is masked, as in Chromium; Firefox reports its
GPU in `RENDERER` and has deprecated the extension): a
software renderer (SwiftShader, llvmpipe) is classified low without timing, other classes cap the tier. It
then renders a synthetic world-shader-like workload over a 1024² target in its own tiny WebGL2 context:
after a warm-up and a measurement of the sync round-trip (subtracted), the number of full-screen passes per
frame doubles until a frame costs ≥ 6 ms, and 16 timed frames give a median cost per megapixel. That cost,
scaled per tier (`TIER_COST_FACTOR`) at the pixels each tier would render, picks the highest tier within the
renderer cap whose predicted frame fits 14 ms. The measurement is cached per GPU for 30 days
(`atlas:quality-probe:v2`); a cached one is re-mapped to the current window size.

| Tier   | Pixel budget | MSAA (post scene target) | Light atlas tile | PCF | GPU LOS refine | Post |
|--------|--------------|------|------------------|-----|----------------|------|
| low    | 1.3 MP       | off (direct to the canvas) | 256²   | 2×2 bilinear | off   | none |
| medium | 2.1 MP       | 2×   | 512²             | 2×2 (3×3 for 8 strongest) | on | lite: MSAA resolve + Reinhard composite, no bloom or AO |
| high   | native ≤ 2× DPR | 4× | 512²            | 3×3 all | on           | bloom (fixtures), vignette |
| ultra  | native ≤ 2× DPR | 4× | 1024² (16 lights) + 512² | PCSS-style soft shadows (blocker search) | on | GTAO ambient occlusion, bloom, filmic tone mapping, subtle film grain |

The WebGL context is always created **without** MSAA (`antialias: false`): context MSAA is fixed when the
context is created, so an engine started at high kept paying for it on low, and one started at low had no
MSAA on medium. Tier MSAA comes from the post pipeline's scene target instead (`MSAA_SAMPLES`): medium and
above render the world into it (half-float on high / ultra) and composite to the canvas; low renders
directly. Medium uses 2×: on the AMD iGPU (Crooked Lantern DM view, 1080p) the lite path measured
13.8–14.0 ms at 4× and 13.5–13.7 ms at 2×, against 12.8–12.9 ms for the former context-MSAA medium. Overlays (grid,
selection, rulers) are drawn after the composite with analytic antialiasing (smoothed edges in their
shaders), not MSAA. On medium, flames and glow sprites are drawn in that overlay pass too (medium has no
bloom for them to feed, and the composite would flatten them), which keeps the direct path's look. The world
material is compiled once per tier: a tier the user picks recompiles at once, while adaptive steps compile
the next tier and fill its shadow atlases in the background, then switch in one frame (§4.5). What remains
is the cost of the compile and of a canvas resize itself: on the WSL / ANGLE / Mesa d3d12 test machines
shader compiles are not parallel, so an adaptive step still stalls (measured after the background compile
landed: two frames of ~170–480 ms, where one frame of 500–870 ms was measured before; before, too, high →
ultra took 633 ms on the AMD iGPU and 983 ms on NVIDIA, medium → low 250 + 117 ms). Native drivers with
parallel compilation are untested.

---

## Appendix: Implementation status (2026-09-23)

Everything above is implemented, except for the known gaps and deliberate limits listed at the end of
this appendix. Final verification of the current tree (after the wave-4 fixes): `tsc -b --force` (0 errors),
`npx vitest run` three times in a row (each: 115 test files and 1367 tests pass; the 3 opt-in live Supabase
files are skipped), `npx eslint .` (clean) and `npm run build` all pass. The end-to-end scripts in `e2e/` were
run against a Vite dev server (Chromium, NVIDIA through WSL d3d12 unless noted; 2026-09-23, final pass):

| Script | Result |
|---|---|
| `editor-smoke` | 34/34 on NVIDIA (probe picks ultra) and 34/34 on SwiftShader (probe picks low): quality probe, menus, labels, options bar at 1280 px, tools, undo / redo, shortcuts, save, reload |
| `vineyard-build` | 23/23 (import dialog, traced floors and walls, the layout in one undoable edit, every storey reachable, save / reload, export) |
| `multiplayer-local` | 54/54 on the Crooked Lantern and 54/54 on the Vineyard (probed tiers on host and players, host menus, oracle-equal views, moves, doors, stairs incl. a blind landing on the Vineyard, lock, reloads, leak scan) |
| `multiplayer-supabase` | 29/30 on the Crooked Lantern, 38/39 on the Vineyard with map chunks: the one failure is the "Allow public access" dashboard check (see Known gaps, Security); public channels received no session data, the kicked member's subscription stopped after a token refresh, and ending the session deleted the players' chunks |
| `multiplayer-latency` | 7/7 (120×120 daylit field: a 20-step move answered in 325–610 ms, a concurrent 1-step move in 609–617 ms over two runs) |
| `host-save-map` | 12/12 |
| `free-assets` | 12/12 (2026-09-23, against Supabase with the bucket files served from a local build via `ATLAS_FREE_ASSETS_DIR`: start dialog, Assets tab, the host and a player download and draw the model, unloading keeps it) |
| `engine-leak` | 5/5 (24 editor visits, every engine context collected) |
| `perf` | 36/36 (AMD iGPU medium and NVIDIA ultra × Crooked Lantern, Stress Test, Vineyard; numbers in `docs/PERFORMANCE.md`) |
| `showcase` | 5/5 (the screenshots in `docs/screenshots/` were re-shot: the darkvision views changed with the colour lift of §4.1) |
| `firefox-smoke` | 14/14 in headless Firefox 155 (software WebGL2): the library, the editor at all four tiers, a local-mode player whose view equals the oracle, no console errors |

Editing files while these scripts run no longer disturbs them unless the files are modules the page
loads: Tailwind scans only `src/` and `index.html` (`src/index.css` `source(".")`). Before, a change to
any other scanned file (a doc, an e2e script) made the dev server reload every open page, which broke
runs mid-way.

On the Vineyard the `multiplayer-local` stairs step differs from the Crooked Lantern: the manor stairs are
behind closed doors, so the DM opens the storey's doors first (the planner only paths through open, known
space), and the upper landing cannot be seen from the foot of the stairs, so the drag from the foot is a
blind landing that the host validates (§8).

The SQL suites run on the linked project, each in a transaction that is rolled back:

| Suite | Result |
|---|---|
| `rls_test.sql` | 326/326 (checks run against `realtime.messages`) |
| `assets_storage_test.sql` | 25/25 (the legacy per-cell tile checks now assert the API is gone) |
| `tile_chunks_test.sql` | 22/22 |
| `quotas_test.sql` | 27/27 |
| `scene_asset_cleanup_test.sql` | passes |
| `guest_merge_test.sql` | 28/28 |
| `free_assets_test.sql` | 17/17 (catalog and bucket policies, `create_session`'s categories) |

These were last run in wave 3 (`rls_test.sql` in its final verification, the others right after its
migrations were applied); `guest_merge_test.sql` ran right after `*_guest_merge.sql` was applied, and the
guest merge was also checked end to end against the deployed `merge-guest` function
(`src/net/guestMerge.live.supabase.test.ts`). The applied migrations (`list_migrations`, 18) match
`supabase/migrations/` one to one.

Security advisors report only the intentional warnings:
- signed-in users can execute the `SECURITY DEFINER` RPCs;
- RLS policies also apply to anonymous sign-ins;
- leaked-password protection is off, which is unused because sign-in is anonymous.

**Review fixes (wave 3)**, each with regression tests (unit tests next to the code, or the e2e script named):
- Light origins are resolved at compute time (`resolveLightOrigin`, §2), so a light on a floor surface or
  inside a wall no longer lights through it.
- Vision: history-independent sun bounds, sub-cell light invalidation on environment and occluder changes,
  tie-independent buried-sample probes and smallest-key raycast ties (§5.1, §5.2); wall pieces rebased on
  terrain (§6.2); `groundIndex` for per-point ground queries (§2).
- Quality: the start-up probe runs for "Auto" on every route, with a quality selector on the host console
  and the player page too; the step-up rule no longer oscillates (§4.5); no context MSAA, medium gets a
  lite post pass (§10); engines release their WebGL context (`e2e/engine-leak.mjs`).
- Backdrops: one dirty rect per chunk and one mip rebuild per update; player canvases cover only the
  explored area within the ceiling's texel budget; chunks clipped to explored sub-cells (§9).
- Multiplayer: move results no longer wait for intermediate-step vision (§5.2 Moves); hello and
  rate-limited-reply budgets (§6.2); waiting players notice a session ended from the library (§6.3).
- Play and editor: stairs climbed by dragging past the top or with Go up / Go down, and the view level
  follows the token up a staircase (§2, §4.3, §8); door top-down markers and hover (§4.3, §8); the
  editor's top view no longer follows a dragged token (§4.5); pastes snap (§7); "Save map to library"
  (§6.2, `e2e/host-save-map.mjs`).
- UI: the Help menu and the host console's light / "Controlled by" menus no longer crash; shortcuts keep
  working after a Select popup was used; editor fields have programmatic labels; the tool options bar
  wraps instead of hiding controls at 1280 px (`e2e/editor-smoke.mjs`, `e2e/multiplayer-local.mjs`).
- Movement and geometry: a stairs/ramp run can no longer be entered or left across a side where the
  ground differs by more than 2.5 ft (§2); render and occlusion share one floor-thickness rule
  (`floorThickness`, no visual minimum; checked in `src/integration`).
- Backend: per-account quotas (§6.4), the legacy per-cell tile API dropped, display names that pose as the
  DM refused, and map images no scene references any more can be found and deleted (§6.4, §9).

**Review fixes (wave 4)**, finishing the cross-area wiring of wave 3:
- "Save map to library" has one path: the host console calls `HostRunner.saveMapToLibrary`, and the
  unsaved-edits flag is `GameState.origin.dirty`, stored with the game (§6.2, `e2e/host-save-map.mjs`).
- Stairs: a drag past the top step also climbs onto a landing the player has never seen (a blind landing
  the host validates; §8, the Vineyard run of `e2e/multiplayer-local.mjs`).
- Map images: deleting a library scene frees the image folders only its versions used, a daily sweep
  removes images nothing uses any more, and an import whose image store fails keeps the scene (§9).
- The player HUD says "You're offline, reconnecting…" when the player's own network is down (§6.3).
- A grid resize crops heightmaps to the new lattice (§3); the renderer resolves light origins with one
  `groundIndex` per scene instead of a scan of every object per light (§2).
- Rendering: per-cell light mask (§4.1), per-pixel darkvision / blindsight range edges (§4.1), adaptive
  tier switches that prepare the new tier's shadow atlases before switching (§4.5), antialiased 1-px
  overlays (§10), tokens opaque at rest (PERFORMANCE §5), and a guard against deleting GL objects of a
  lost context after a WebGL context restore.
- Bundle: the home route no longer loads the player filter, vision or pathfinding.
- Tooling and tests: `npm run typecheck` runs `tsc -b` (plain `tsc` checked nothing), `npm test`,
  `npm run format:check` and a `.prettierrc` closer to the code; new e2e checks for the probed quality
  tier per GPU on the editor, host console and player page, Realtime public channels and a kicked
  member's subscriptions (`e2e/multiplayer-supabase.mjs`), and monotonic timings in the e2e scripts.
- Final verification pass: the editor's and the play-mode Measure tools share `core/grid` `rulerDistance`
  (their copies are gone, §8); token visuals and light fixtures read ground heights from `groundIndex`
  (§4.3); ending a session retries the players' chunk clean-up when Storage rate-limits it (§9: one
  Vineyard run logged `removing session tiles failed … Too many connections`); the quality probe reads
  `RENDERER` before the deprecated debug extension (§10), which Firefox warned about; Tailwind scans only
  `src/`; and `e2e/firefox-smoke.mjs` is new.

Known gaps and deliberate limits:

**Contracts vs. code**

- `net/player/types.ts` is the minimal `PlayerClient` contract. The implemented client (`AtlasPlayerClient`
  in `net/player/playerClient.ts`) adds backdrop events, `sceneChangeSince`, `hostUnresponsive`, `viewSource`
  and local request outcomes, and the play page uses that type.
- The host console likewise uses `HostRunnerImpl` from `net/host`, which adds `lastCommandError` and debug
  helpers.
- `HostRunner.stop()` leaves the status at `"standby"`, because there is no separate "stopped" status.
- A second move request for a token whose move is still in flight is rejected with `"rate-limited"`. There is
  no dedicated reason.

**Map images**

- Chunks are clipped to explored sub-cells, so what a player can download beyond what they perceived is
  at most the canvas antialiasing at the clip edges. Floors are still clipped per cell (`clip.ts`), which
  reveals only floor extent, not art.
- Chunk images are cropped and encoded on the DM's main thread (OffscreenCanvas → WebP, ~2 ms per tile),
  not in a worker.
- Local mode crops tiles from the locally stored image. It is dev only and not a security boundary, like
  `LocalTransport`.

**Free assets**

- The four token models' creators and licences are not recorded yet (`free_assets.attribution` is null);
  the Assets tab shows an attribution once a row has one.
- Model figures cast no shadows, like every token (blob shadow only, §2 blocking table), and are one
  resin colour: the GLBs carry no materials or textures.
- Publishing needs a secret key (or a dashboard upload): clients have no write path to the bucket or the
  catalog by design.

**Multiplayer**

- A move's result arrives after the flush throttle (≤ 100 ms) plus one vision compute of the final
  position (~7 ms on interior maps, 100–500 ms on large fully daylit open maps, §6.3). Walked-past
  corridors are explored in a follow-up patch.
- Each player has 8 req/s (burst 16), 1 hello/s (burst 4) and 2 `rate-limited` replies/s (burst 4); a
  flooding client gets at most 32 pending results; everything beyond is dropped.
- Over Supabase, joining takes ~4 s (anonymous sign-in, Realtime private channel joins, first snapshot).
- A player that was disconnected for a whole host restart keeps its older in-memory view while the DM is
  offline, and only adopts the new host's view once the DM is back.
- The host's timer worker, which keeps a hidden DM tab ticking, is verified to work. Its benefit could not be
  measured headless, because headless Chromium reports hidden pages as visible.
- Anonymous users created by the live tests and `e2e/multiplayer-supabase.mjs` cannot be deleted with the
  publishable key. They accumulate in the project.
- On heightmap levels a clipped wall piece is rebased so its top, door heads, sills and lintels match the
  host (§6.2), but its below-ground bottom can differ: the host's depends on the terrain under the whole
  wall, which the player is not sent. Nothing above ground is affected.

**Rendering**

- The Crooked Lantern DM view on an integrated GPU (Radeon iGPU, medium) takes 12.3–12.7 ms of GPU time
  at p95, about 74–76% of the frame budget. The high tier costs ~21–23 ms there (51 fps with vsync); the start-up
  probe (every route, "Auto") and adaptive quality keep such machines on medium, and the host console and
  the player page have a quality selector like the editor.
- A tier change recompiles the world shaders. Adaptive steps compile the next tier and fill its shadow
  atlases in the background, so no light drops out, but on the tested WSL Mesa d3d12 / ANGLE setup shader
  compiles are not parallel, so a step still stalls (two frames of ~170–480 ms were measured after the
  background compile landed, one frame of 500–870 ms before). Parallel compilation on native drivers is
  untested.
- The canvas has no MSAA. Overlays are antialiased in their shaders (1-px outlines and rings as screen-space
  quads, rulers, move paths, brush circles, token markers, fills with an outline over their edge), except
  the 3D ghost objects of paste / drag previews and small preview markers, which are aliased.
- In cutaway views, the part of a lower storey's wall inner face that sits flush with the next storey's
  slab edge (between the cutaway plane and the next elevation) can be lit by lights of the hidden storey:
  the receiver's normal offset puts the test point inside the slab. The cap rule (§4.2) covers wall tops
  only. Repro: `dev/render.html?sample=crooked-lantern&mode=dm-play&at=66,89.5&zoom=3&lights=floating&moon=0&rotate=2&tilt=35`.
- Fog and perception edges along diagonal line-of-sight boundaries are scalloped (bumps of a 1.25 ft
  sub-cell). The host sends perception per 4×4 sub-cell, and the GPU line-of-sight refinement can only
  remove perception inside it, so the valleys (sub-cells the host says are not perceived) stay. Straight
  edges would need finer or analytic edges from the host. The darkvision / blindsight range, which the
  host also draws as a staircase, is already cut per pixel (§4.1).
- On low, a thin light leak can show along the base of a wall on the side facing away from the light: a
  coarse 256² light-atlas texel straddles the wall's bottom edge (0.05 ft below the ground), so a
  neighbouring texel passes under it. A smaller receiver epsilon did not help; deeper wall bottoms in
  `core/occlusion` (or a GPU-proxy-only extension, which would depart from the single blocking truth) would.
- Browsers: Chromium is tested end to end, on NVIDIA and AMD through WSL d3d12 and on SwiftShader. Firefox
  155 passes `e2e/firefox-smoke.mjs` (headless, WebGL2 on its software rasteriser: the library, the editor
  on the Crooked Lantern at all four tiers, a local-mode player whose view equals the oracle, no console
  errors). Firefox on a GPU, the multiplayer scripts in Firefox, and Safari are untested.

**Security**

- Quotas (§6.4) are per account, and guests are free to create. Abuse spread over many accounts is bounded only by Supabase's
  per-IP rate limit on anonymous sign-ins (keep it low for public deployments, README), and CAPTCHA is not
  supported yet (`describeNetError("captcha_required")` explains the error, but the app has no widget).
- Token portraits are the DM-supplied http(s) `imageUrl`, sent to players who see the token and loaded by
  their browsers from that host (without a referrer). The image host therefore learns the viewers' IP
  addresses. Portraits are not copied into Storage, and there is no CSP `img-src` restriction.
- Realtime authorises a channel when it is joined and re-checks only when the client sends a new JWT
  (§6.4): a member kicked while subscribed keeps receiving the host topic's `status` broadcasts (wire
  epoch, scene name) and lobby presence until their client refreshes its token, or at most until the JWT
  expires (1 h by default). `e2e/multiplayer-supabase.mjs` shows one broadcast arriving after the kick and
  none after a token refresh; a new join is refused at once. The view topic carries nothing more after the
  kick. Shortening the project's JWT expiry narrows the window.
- Retention: `end_session` keeps an ended session's `session_state`, and the `sessions_delete_dm` policy and
  the `DELETE` grant on `public.sessions` are unused. Growth is bounded (each DM keeps ≤ 50 sessions,
  ended ones included, §6.4), but ended games stay stored until then. A migration that drops the state on
  `end_session`, the unused policy and grant (plus a one-time purge of existing ended sessions' state) was
  drafted in wave 4 and not applied: it needs the project owner's approval.
- On the linked project Realtime's "Allow public access" is still on (a dashboard switch that migrations
  cannot set; README step 2 says to turn it off), so `e2e/multiplayer-supabase.mjs` fails that one check.
  The same run shows that public subscribers to a session's host and view topics receive none of its
  private broadcasts, so no session data is exposed.

**Tooling**

- The tree is not uniformly Prettier-formatted: `.prettierrc` (160 columns; 80 for `src/components/ui`,
  `src/components/play`, `src/play`, `e2e`, `scripts`) matches about two thirds of the source files, and
  `npm run format:check` lists ~170 files under `src` whose widths vary within the file, so formatting is
  not part of `lint`. A one-time `npm run format` would make it enforceable.
- `tsconfig.node.json` (which covers only `vite.config.ts`) does not set `strict`, unlike
  `tsconfig.app.json`; `vite.config.ts` passes under `--strict` today.

**Bundle** (`npm run build`, minified)

- The home route loads ~1.05 MB of JavaScript (~321 kB gzip) in three chunks: React, Base UI, zod,
  supabase-js, sonner, the app shell and repositories, and from `core` only the scene document modules
  (`core/scene`: schema, migrations, factory, queries, integrity, heightmap, samples) plus
  `core/session/backdrop` (the tile rule the asset module shares with the host and the filter). The player
  filter, vision and pathfinding are no longer pulled in (`net/assets/tiles.ts` imports
  `core/session/backdrop` directly, not the session barrel).
- three.js and the renderer are a separate ~1.08 MB chunk (~313 kB gzip), loaded only by the editor, host
  and play routes. Rolldown names chunks after a module in them (currently `QualitySelect-*.js` for
  three.js and `backdrop-*.js` for the shared home chunk); a `codeSplitting` group in `vite.config.ts`
  would give them clearer names.
