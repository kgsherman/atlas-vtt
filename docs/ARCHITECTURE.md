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
    post/               High / ultra post-processing (HDR MSAA target, AO, bloom, tone mapping, grain)
    cameras/            Editor orbit camera, player 2.5D camera
    overlays/           Grid, selection, tool previews, ruler, pending paths, ghost levels, gizmos
    picking/            Ground/object/token picking
  editor/               DM editor state (zustand) + tools
  play/                 Play-mode controllers (token selection, drag-to-move, ruler, level switching)
  net/                  Supabase client, auth, repositories, transports, host runner (+ vision worker), player client
    assets/             Map images: import (decode / resample / WebP), DM asset stores, per-player tile chunks
    host/               DM-side host runner, vision worker client, flush pipeline, persistence, backdrop tiler
    player/             Player client (sync rules, requests), backdrop compositor
  app/                  Service wiring (Supabase or local mode), router + lazy routes, library, scene digests
  components/           React + shadcn UI (app shell, editor panels, play HUD, host console, lobby)
  routes/               Page-level components (home, editor, host, play, join, shared scene)
  dev/                  Dev-only render harness (`dev/render.html`) and the Vineyard build helpers
  integration/          Cross-module consistency tests (render ↔ occlusion, vision ↔ movement, host → player, editor → session)
supabase/migrations/    SQL: schema, RLS, RPCs, realtime policies
```

Dependency rule: `core` imports nothing outside `core` (immer types allowed). `render` imports `core`.
`editor`/`play`/`net` import `core` and `render/contracts.ts`. `components`/`routes` import everything.
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
  `render/builders` (walls.ts, ground.ts) and `core/occlusion` (build.ts, terrain.ts) implement these rules
  independently and identically; `src/integration` checks they agree on the sample scenes.
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
  cell beyond, on `toLevelId`). Ladders (1×1): switch in place. Connector footprints are **cut out** of the
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
  primitives containing the segment's start are ignored. Light origins and eyes are pushed out of solid
  light/sight blockers (0.3 ft past the nearest face) when placed; the light tool snaps wall-mounted lights to
  `hitPoint + 0.3·normal`.

---

## 3. Scene document & versioning

- Types `core/scene/types.ts`, presets `core/scene/defaults.ts`. `SCENE_SCHEMA_VERSION = 1`.
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
  only dirty chunks.
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
   bound is `uLightCount`, so light count changes never recompile. Per light: skip if `d > dimRadius`,
   gate by `N·L > 0`, then shadow test. Flicker modulates intensity only; radii are static.
2. **Shadows**: point lights sample the **light atlas** (§4.2), bilinear-weighted 2×2 PCF via `texelFetch`
   (3×3 on high for the 4 strongest lights). Sun: hardware PCF `sampler2DShadow`.
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
4. **Fog**: perceived → lit colour (grey/tinted per grade); else explored (host explored mask) → memory
   style: desaturated albedo × constant, **no light terms** (stale lights can't make memory look lit);
   else black. Player mode: directional term = local sun shadow × `sunlit` mask.

The DM sees everything (`vision:"off"`); "preview" darkens unperceived areas using masks computed locally by
core/vision for the previewed token. Rules to avoid recompiles/hitches: no `THREE.Light`, `scene.fog`,
`renderer.shadowMap` or clipping planes in rendered scenes; fixed tone mapping/colour space; InstancedMeshes
always have `instanceColor`; ghost/token variants created up front; `renderer.compileAsync` at load.
The world shader never uses `discard`/`gl_FragDepth` (keeps early-Z).

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
- Player / dm-play: levels above the active level are not drawn (cutaway). Sent tokens on levels above are
  drawn as faded outline markers. Draw order: `renderOrder` = rank by descending elevation (active level first)
  so lower storeys are early-Z rejected; nested containers are plain `Object3D`, not `Group`.
- Editor: per-level visibility toggles; ghosts of adjacent levels draw after opaques as depth-only pre-pass
  (clone, `colorWrite:false`) then colour (`depthWrite:false`, `LessEqual`, opacity ≈ 0.25).
- Tokens are drawn whole if present in the scene data (no per-pixel discard), with a 150 ms fade on appear/disappear.

### 4.4 Host mask textures (`render/fog`)

Per level, the engine expands `HostLevelMasks` into R8 layers of `DataArrayTexture`s at 4 texels per cell
(coarse bits + 4×4 partial sub-cells): perception grade (0..3 scaled), explored, sunlit. LINEAR filtering with
`smoothstep(0.5, 1.0, v)` so edges only feather **inward**. Only changed levels are re-uploaded (`addLayerUpdate`).

### 4.5 Cameras & quality

- Editor: perspective orbit (near 0.5 ft, far = 4× scene diagonal), focus on selection, optional top view.
- Player: orthographic, tilt 0–35° (default 15°), pan/zoom, rotate by 90°, follows the selected token.
- Pixel budget: cap physical pixels at ~2.1 MP (medium) / ~1.3 MP (low) instead of raw DPR; high / ultra render
  natively up to 2× DPR (§10). MSAA on medium and above.
- Start-up tier: `render/engine/autoQuality.ts` classifies the GPU renderer string (software → low, mobile →
  medium, Intel UHD → medium, Iris / integrated Radeon → ≤ high, discrete / Apple silicon → ultra) and times a
  short synthetic world-shader workload in its own tiny WebGL2 context, then picks the highest tier whose
  predicted frame cost leaves headroom (cached per GPU for 30 days). The user's choice ("Auto" or a tier) is
  the ceiling.
- Adaptive quality (`render/engine/quality.ts`) steps one **whole tier** down when p95 frame cost > 18 ms for
  2 s and up when < 12 ms for 5 s, never above the ceiling; a step up that has to be undone soon doubles the
  next wait (≤ 60 s). Frame cost is max(CPU time, GPU time from `EXT_disjoint_timer_query_webgl2`) when the
  timer query exists, otherwise the frame interval (a steady vsync-locked interval counts as headroom).

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
Samples inside a sight blocker P count as seen via a side probe (the
ray first hits P → its entry point, pulled back 0.1 ft, is the probe point) or a top probe
(`top(P) + 0.25`, if below the next ceiling).

**Light level** at p: `max(ambientAt(p), sun(p), max_i light_i(p))` where
- `ambientAt(p) = skyExposed(p) ? env.skyLevel : env.ambientLevel` (sky-exposed: vertical light ray escapes);
- `sun(p) = directional.enabled && ray toward the sun escapes the scene bounds (light channel) ? grants : dark`;
- `light_i(p)`: lights that are `on` and not effectively hidden; 3D distance with static radii; blocked only if
  `castsShadows` and the light-channel segment is blocked (ignoring the light's own fixture).

**Perception** per sample for a viewer with LOS (sight channel, from the clamped eye) and distance d:
3 if `!blind && light ≥ dim`; else 2 if `!blind && d ≤ darkvision`; else 1 if `d ≤ blindsight`; else 0.
A blind viewer with no blindsight perceives only its own footprint. A cell's grade = max over its samples and
viewers; cells whose samples disagree get a 4×4 sub-cell refinement (`partial`).

**Caches** (incremental; run in the host's vision Worker):
- `LightField` (viewer-independent): per level, light level per sample, with per-light contribution bits.
  A light change recomputes only its old/new dim sphere; an occluder change recomputes lights whose sphere
  meets the dirty region, plus sky/sun bits under it.
- `ViewerLos` per viewer: seen bits per sample keyed by (eye, level, occlusion version), invalidated by dirty
  regions within range. LOS is only tested on samples that could pass (lit, or within darkvision/blindsight
  range), so darkness is cheap.

**Tokens** are visible if any test point passes: footprint centre + 4 corners inset 0.5 ft (+ edge midpoints for
≥3-cell footprints) × heights (ground+0.25, height/2, height−0.1), each capped below the ceiling; off-centre
points whose segment from the centre is sight-blocked are skipped. (No "stands in a visible cell" rule.)

**Moves**: the host evaluates visibility at every step of an applied path and ORs each result into explored
and memory, so corridors walked past are explored.

### 5.3 Movement (`core/movement`)

A path is a list of `PathStep {cell (anchor), levelId}` starting at the token's current anchor. Each step is to
an 8-neighbour anchor on the same level, a ladder switch in place, or a stairs top-edge crossing. The token's
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
   patch{epoch, baseSeq, seq, ops, results} on view:{uid}   (+ throttled player_views upsert ≤ every 5 s)
```

- Request handling is event-driven (no rAF). The Supabase client uses `realtime.worker = true`.
- `filterForPlayer(state, uid, vis)` is the **only** path to a player. It builds every field explicitly
  (allowlist types in `core/session/types.ts`, zod `.strict()` schema test):
  - **viewers**: the player's tokens (owners) + party PC tokens if shared vision and the player owns ≥ 1 PC.
  - **objects**: from `memory[uid]` only (observed objects are refreshed there first), CLIPPED to explored
    cells with no dilation: walls → parametric runs whose inflated footprint overlaps explored cells, widened to
    contain any sent opening; floors → per-row runs of explored cells merged to rects; piece ids
    `${id}@${x},${z}`; openings re-parented (`wallId` = piece, `offset` rebased). Connectors, pillars, props:
    whole or nothing. Secret doors are omitted unless `revealed[uid]` contains them (auto-revealed when observed
    open, or by `reveal-object`) and then sent as style "wood"; the host wall renders solid without them.
    Props never carry `blocksMovement` (DM-only); `viewToScene` assumes the `PROP_LIBRARY` default, so a
    client path preview can differ from the host's validation for props whose flag the DM changed.
  - **lights**: static lights from memory with `emitting = (in illuminatingLightIds)`; attached lights only while
    their carrier token is in the view (resolved position, `emitting = on`). Never `attachedTokenId`.
  - **tokens**: controlled + vision tokens always; others only while in `visibleTokenIds`; never hidden. Other
    players' tokens get `label` only; `name/eyeHeight/vision/speed` only for controlled/vision tokens.
  - **levels**: known levels (any explored cell) + stubs (`known:false`, `name:null`) for levels referenced by a
    sent connector or own token. **terrain**: chunks overlapping explored cells, samples touching no explored cell
    zeroed. **masks**: perception (current), explored (persistent), sunlit (current ∧ perceived).
- Request rules: ≤ 8 req/s per player (burst 16), one in-flight move per token, paths ≤ 256 steps.
  Door requests: the door must be in the player's current view, a controlled token on its level must be within
  one cell of the door segment, movement not locked; failures reply `"cannot"`; `"locked"` only after the
  adjacency check passes. Players can never unlock.
- DM edits during a live session: the editor applies immer patches to `GameState.scene`
  (`apply-scene-patches`); play actions (token moves, door/light toggles) are DmCommands and never enter undo.
  Grid resizes remap explored masks; deleting a level drops its masks/memory.

### 6.3 Sync, reconnection, persistence

- Per-player `seq` (increments only for non-empty patches) + host `epoch`. Host keeps per player
  `{lastSent: PlayerView, seq, log}`; the log holds recent patches (≥ 90 s and ≤ 200 KB).
- Client rule: apply a patch iff `epoch === local.epoch && baseSeq === local.seq`; otherwise send
  `hello{nonce, epoch, lastSeq}`. Host answers: in-sync → `sync`; catch-up from log → one concatenated patch;
  otherwise → `snapshot` (≤ 200 KB) or awaited `player_views` upsert then `snapshot_ready{epoch, seq}` (client
  reloads the row, accepts only matching epoch and `seq ≥`). Replies echo `nonce` so other tabs ignore them.
  Further client rules (`net/player/playerClient.ts`): a HostBroadcast `status` retires every other epoch the
  client has seen (epochs are random, so this is how a stale host is told from a new one); a `nonce: null` is
  treated as absent; same-epoch snapshots/patches older than the local seq are ignored without a hello; a
  standalone `result` or `sync` with `seq` > local (or another epoch) triggers a hello. Hellos are coalesced and
  retried with backoff (2.5 s doubling to 15 s).
- Join order (client): subscribe `view:{uid}` → SUBSCRIBED → subscribe `req:{uid}` → send hello. Host: on every
  `req:{uid}` SUBSCRIBED (boot, reconnect, new member) push a snapshot/snapshot_ready. Host sends `sync` on idle
  (~10 s) so a lost final patch is detected.
- Host liveness = DM presence on `session:{sid}:host` (1.5 s grace after the host channel joins). On leave: the
  client loads its `player_views` row (adopted only if it has no view, or the row is the same epoch with a
  higher seq), shows "Waiting for DM", disables moves. Pending optimistic moves are overlays only; they clear
  when their result is applied, on snapshot/epoch change, or after 5 s ("DM not responding").
- Host timing (`HOST_TIMING`): per-player flush ≤ every 100 ms (so a move's result arrives ~75–100 ms after
  the request), idle `sync` after 10 s, member re-read every 10 s and on lobby presence changes. In browsers
  the host's timers run in a tiny worker (`net/host/timerWorker.ts`) because Chrome throttles main-thread timers
  in hidden tabs.
- Channel supervisor: CHANNEL_ERROR/TIMED_OUT → `realtime.setAuth()` then built-in rejoin; unexpected CLOSED →
  remove and recreate with backoff.
- Persistence (fenced by epoch RPCs): `save_session_state(sid, host_epoch, state)` throttled ~5 s + immediately after
  DM commands that reduce what players may see (hide token, remove token, reset fog, scene edits) + within ~1 s
  after token moves and exploration (so a reloaded host tab resumes where the tokens were) + best-effort on
  `visibilitychange→hidden`; `upsert_player_view(sid, uid, host_epoch, epoch, seq, view)` throttled ≤ 5 s and awaited
  before `snapshot_ready`. `host_epoch` (bigint, from `claim_host`) is the database fence (a stale host gets
  `stale_epoch`); `epoch` (text) is the wire epoch stored with the view so a reloading client can match it.

### 6.4 Database & RLS (`supabase/migrations`)

Tables (RLS enabled on every table; default privileges revoke anon; functions revoke PUBLIC/anon execute):
- `profiles(id → auth.users, display_name)` — own row only.
- `scenes(id, owner_id, name, visibility 'private'|'link', share_slug (≥128-bit random), latest_version, …)` and
  `scene_versions(scene_id, version, schema_version, data jsonb, created_at)` — owner only; versions immutable.
- `sessions(id, dm_id not null, scene_id, room_code unique while active, status, host_epoch, created_at)` —
  DM full access; players no direct SELECT (they use `session_info(sid)` RPC).
- `session_members(session_id, user_id, display_name 1..32, status 'active'|'kicked', joined_at)` — SELECT own row
  or DM; no client INSERT/UPDATE except display_name on own row; writes via RPCs.
- `session_state(session_id, epoch, state jsonb, updated_at)` — DM only; writes via `save_session_state`.
- `player_views(session_id, user_id, epoch, seq, view jsonb, updated_at)` — player SELECT own row while active
  member; writes DM only via `upsert_player_view`.

Helpers in schema `private` (`security definer`, `set search_path = ''`, stable): `topic_sid()`, `topic_kind()`,
`topic_uid()` (regex-validated parsing of `realtime.topic()`), `is_session_dm(sid)` (from `sessions.dm_id` only),
`is_active_member(sid)`. RPCs (`security definer` unless noted, `search_path=''`, execute granted to authenticated
only; return ids/booleans/small records, never whole rows; errors carry a stable MESSAGE code mapped by
`net/supabase.ts`): `create_scene`, `save_scene_version` (optimistic `p_base_version`), `set_scene_visibility`,
`set_display_name` (`security invoker`: own profile row under RLS), `create_session(scene_id)` (owner check, copies the scene into session_state,
generates an 8-char Crockford room code), `join_session(room_code, display_name)`, `session_info(sid)`,
`list_session_members(sid)` (DM; `security invoker`: it reads only rows the DM's RLS already allows),
`set_member_status(sid, uid, status)` (DM), `claim_host(sid)`,
`save_session_state`, `upsert_player_view`, `end_session(sid)`, `get_shared_scene(slug)`.
Realtime: `realtime.messages` policies per the §6.1 table, checking `extension` ('broadcast'/'presence').
Dashboard settings (not SQL): enable anonymous sign-ins; disable Realtime "Allow public access".

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
  detach lights whose token wasn't copied), `reprojectOpenings`, `splitWall(draft, wallId, distance)` (for a wall-splitting tool),
  `validateReferences`. `deleteWithDependents` allows deleting the last level; `removeLevel` in the store keeps
  at least one.
- Document guard (`editor/validate.ts`): `apply()` validates what each edit's patches touched (touched objects /
  tokens plus their host walls, openings and carriers, all levels without terrain; everything after a grid
  change) with the strict schema and `validateReferences`, and refuses the edit (`[]` / `false`, reason in
  `lastRejected`) if the document would no longer load: e.g. content dragged, nudged or pasted beyond the extent
  ± 50 ft, a grid shrunk under objects, out-of-range numbers or strings.
- Snapping: cell centre / vertex / half / free, plus wall endpoints and wall centrelines for the wall tool.
- "Preview player view": pick a token → render mode player with masks computed locally by core/vision
  (explored = currently perceived, no memory).

---

## 8. Play mode

- Player: select a controlled token; drag shows a path (A* over legal steps, core/movement) with ruler (feet,
  diagonal rule); release sends `move`. The pending path is an overlay only; the token moves when the patch
  arrives. Stairs/ramps are climbed by pathing through the top edge; ladders offer "Climb up/down" in the HUD.
- A standalone Measure tool (players and DM) uses `pathDistance`.
- DM play controls: lock/unlock movement (global and per player), shared vision toggle, enforce speed, door and
  light toggles, sun/moon on/off (scene patch), move any token, hide/reveal tokens, reveal secret doors, assign
  tokens to players, preview any token's vision, kick players.

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
  stored px per cell, a chunk image is 4·tilePx square, ≤ 1024 px; only explored cells are drawn, the rest
  is transparent):
  - Supabase: private bucket `session-tiles`, object path `{sessionId}/{userId}/{levelId}/{ci}_{cj}.webp`,
    written only by the DM of the active session, readable only by that user while an active member (and the
    DM) — storage RLS, migration `*_tile_chunks.sql`. After each knowledge update the host re-draws the chunks
    whose explored cells changed (smaller or deleted after a fog reset) and uploads them in the background
    (nearest to the player's tokens first, 8 at a time, backing off on HTTP 429), then announces them on the
    view topic: `{t: "tiles", epoch, levelId, chunks: [ci, cj, cellMask][], reset?}` (the full list, with
    `reset`, precedes every snapshot). A view waits at most `tileWaitMs` (250 ms) for its chunks, so moves
    usually arrive with their art, but the game never blocks on Storage. Why chunks: an open outdoor map's
    first view is ~70 objects instead of ~1000 per-cell ones, which Storage rate-limits. (The earlier per-cell
    layout `{sessionId}/{levelId}/{i}_{j}.webp` + `player_tiles` grants via `grant_tiles` still passes the
    policies but is no longer used.) DM assets live in the private bucket `scene-assets` under
    `{ownerId}/{sceneId}/{assetId}.webp` (owner-only policies), where `sceneId` is the document's `Scene.id`
    (not the library row id; `AssetStore` in `net/assets/types.ts`). The DM deletes the session's chunks when
    it ends.
  - Local mode: the tile source crops from the locally stored asset (dev only, insecure like LocalTransport).
  - `PlayerView.backdrops[levelId] = {rect, opacity, tintWalls, tilePx}`; the player client prefetches the
    announced chunks, crops cell tiles from them and composites them into a per-level canvas (transparent
    where missing) → `engine.setLevelImage/updateLevelImage`.
- Export: `.atlas.json` embeds assets as data URLs (`assetsData: Record<id, dataUrl>`) so a file is portable.

## 10. Quality tiers

`Quality = "low" | "medium" | "high" | "ultra"`. The default is picked by a startup micro-benchmark
(GPU renderer string + a 30-frame timed render of a synthetic scene) and adapted at runtime (§4.5).

| Tier   | Pixel budget | MSAA | Light atlas tile | PCF | GPU LOS refine | Post |
|--------|--------------|------|------------------|-----|----------------|------|
| low    | 1.3 MP       | off  | 256²             | 1 tap | off          | none |
| medium | 2.1 MP       | 4×   | 512²             | 2×2 (3×3 for 8 strongest) | on | none |
| high   | native ≤ 2× DPR | 4× | 512²            | 3×3 all | on           | bloom (fixtures), vignette |
| ultra  | native ≤ 2× DPR | 4× | 1024² (16 lights) + 512² | PCSS-style soft shadows (blocker search) | on | GTAO ambient occlusion, bloom, filmic tone mapping, subtle film grain |

Post-processing runs through a small composer that renders the main pass into a half-float MSAA target;
the world material is compiled once per tier (a tier change is a deliberate one-time recompile).

---

## Appendix: Implementation status (2026-09-23)

Everything above is implemented. The following checks pass on the current tree: `npx tsc -b`,
`npx vitest run` (1137 tests; the opt-in live Supabase tests are skipped by default), `npx eslint .` and
`npm run build`. The end-to-end scripts in `e2e/` were also run against a Vite dev server:

| Script | Result |
|---|---|
| `editor-smoke` | 15/15 checks pass |
| `multiplayer-local` | 38/38 checks pass (Crooked Lantern and the Vineyard) |
| `multiplayer-supabase` | 22/22 on the Crooked Lantern, 28/28 on the Vineyard with map chunks |

The SQL suites pass on the linked project, each run in a transaction that is rolled back:

| Suite | Result |
|---|---|
| `rls_test.sql` | 321/321 |
| `assets_storage_test.sql` | 64/64 |
| `tile_chunks_test.sql` | 21/21 |

Security advisors report only the intentional warnings:
- signed-in users can execute the `SECURITY DEFINER` RPCs;
- RLS policies also apply to anonymous sign-ins;
- leaked-password protection is off, which is unused because sign-in is anonymous.

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
- The superseded per-cell tile API (`AssetStore.publishTiles` / `grantTiles`, table `player_tiles`, RPCs
  `grant_tiles` / `revoke_tiles`) is still deployed and tested but unused; sessions use per-player chunks (§9).

**Map images**

- A partly explored cell is drawn whole into the player's chunk, so up to one cell of art beyond what the
  player has seen can be downloaded. The renderer's fog still hides it.
- Chunk images are cropped and encoded on the DM's main thread (OffscreenCanvas → WebP, ~2 ms per tile),
  not in a worker.
- Players composite a full-resolution backdrop canvas per level: up to 32 MP, ~100 MB for a Forgotten
  Adventures storey. The engine downsizes the texture per tier, but the play page does not yet pass a smaller
  canvas budget on the low tier.
- Local mode crops tiles from the locally stored image. It is dev only and not a security boundary, like
  `LocalTransport`.

**Multiplayer**

- A move's result arrives ~75–100 ms after the request because of the 100 ms per-player flush throttle.
- A flooding client gets at most 32 pending results per player; later ones are dropped.
- Over Supabase, joining takes ~4 s (anonymous sign-in, Realtime private channel joins, first snapshot).
- A player that was disconnected for a whole host restart keeps its older in-memory view while the DM is
  offline, and only adopts the new host's view once the DM is back.
- The host's timer worker, which keeps a hidden DM tab ticking, is verified to work. Its benefit could not be
  measured headless, because headless Chromium reports hidden pages as visible.
- Anonymous users created by the live tests and `e2e/multiplayer-supabase.mjs` cannot be deleted with the
  publishable key. They accumulate in the project.

**Rendering**

- The Crooked Lantern DM view on an integrated GPU (Radeon iGPU, medium) takes ~13–14 ms of GPU time, about 80%
  of the frame budget. The high tier costs ~23 ms there, so mid-range laptops depend on the start-up
  benchmark and adaptive quality choosing medium.
- Only Chromium has been tested, on NVIDIA and AMD through WSL d3d12 and on SwiftShader. Firefox and Safari
  are untested.

**Bundle** (`npm run build`, minified)

- The home route loads ~1.1 MB of JavaScript (~340 kB gzip): React, Base UI, zod, supabase-js and the
  `core` modules the library needs.
- three.js and the renderer are a separate ~920 kB chunk (~262 kB gzip), loaded only by the editor, host and
  play routes. Rolldown names it after a shadcn component (`toggle-group-*.js`); a `codeSplitting` group in
  `vite.config.ts` would give it a clearer name.
