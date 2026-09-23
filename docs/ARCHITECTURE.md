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
  `groundHeightAt`, `hasGroundAt` and `effectiveFloorRects` (`core/scene/queries`) scan the scene's objects on
  every call. `groundIndex(scene)` is the cached form for callers that query many points (path overlays,
  planners, per-pointer-move tools); it is valid only on a scene that is never changed after creation (not an
  immer draft, not a scene mutated in place). The free functions stay uncached.
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
- Tokens are drawn whole if present in the scene data (no per-pixel discard), with a 150 ms fade on appear/disappear.

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
  predicted frame cost leaves headroom (cached per GPU for 30 days under `atlas:quality-probe:v2`).
  `EngineCanvas` runs `pickInitialQuality()` whenever it is given no tier, i.e. for "Auto" on every route
  (editor, host console, player), before it creates the engine (one probe at a time; later pages hit the
  cache). On "Auto" the probed tier is both the starting tier and the adaptive ceiling; an explicit tier is
  the ceiling. The editor, the host console and the player page each have a quality selector
  (`components/canvas/QualitySelect`, choice stored per browser under `atlas:quality`).
- Adaptive quality (`render/engine/quality.ts`) steps one **whole tier** down when p95 frame cost > 18 ms for
  2 s. It steps up when p95 < 12 ms for 5 s **and** p95 × the next tier's cost ratio fits ~14 ms, never above
  the ceiling. A tier whose step up failed (had to be undone) is not retried until the ceiling or the viewport
  changes, so a scene on the edge settles instead of oscillating (the timer query under-reads a frame by
  15–25%, so "< 12 ms" alone kept promoting a tier that could not hold). Frame cost is max(CPU time, GPU time
  from `EXT_disjoint_timer_query_webgl2`) when the timer query exists, otherwise the frame interval (a steady
  vsync-locked interval counts as headroom).

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
   patch{epoch, baseSeq, seq, ops, results} on view:{uid}   (+ throttled player_views upsert ≤ every 5 s)
```

- Request handling is event-driven (no rAF). The Supabase client uses `realtime.worker = true`.
- `filterForPlayer(state, uid, vis)` is the **only** path to a player. It builds every field explicitly
  (allowlist types in `core/session/types.ts`, zod `.strict()` schema test):
  - **viewers**: the player's tokens (owners) + party PC tokens if shared vision and the player owns ≥ 1 PC.
  - **objects**: from `memory[uid]` only (observed objects are refreshed there first), CLIPPED to explored
    cells with no dilation: walls → parametric runs whose inflated footprint overlaps explored cells, widened to
    contain any sent opening; floors → per-row runs of explored cells merged to rects; piece ids
    `${id}@${x},${z}`; openings re-parented (`wallId` = piece, `offset` rebased). On heightmap levels a
    wall's base is the ground at *its own* midpoint (Terrain rule, §2), and the client computes it at the
    piece's midpoint, so pieces are sent with `height` (and their doors' `height`, windows' `sillHeight` /
    `height`) rebased by `hostBase − clientGround(piece midpoint)`: the client then reproduces the host's
    absolute wall top, door heads, sills and lintels. A piece whose rebased height would be ≤ 0 (buried) is
    omitted. Connectors, pillars, props: whole or nothing. Secret doors are omitted unless `revealed[uid]`
    contains them (auto-revealed when observed open, or by `reveal-object`) and then sent as style "wood";
    the host wall renders solid without them.
    Props never carry `blocksMovement` (DM-only); `viewToScene` assumes the `PROP_LIBRARY` default, so a
    client path preview can differ from the host's validation for props whose flag the DM changed.
  - **lights**: static lights from memory with `emitting = (in illuminatingLightIds)`; attached lights only while
    their carrier token is in the view (resolved position, `emitting = on`). Never `attachedTokenId`.
  - **tokens**: controlled + vision tokens always; others only while in `visibleTokenIds`; never hidden. Other
    players' tokens get `label` only; `name/eyeHeight/vision/speed` only for controlled/vision tokens.
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
  and `HostSnapshot.library = {sceneId, version, dirty} | null` exposes the origin.
  The host console's "Save map to library" button and "Save map & end" (end-session dialog, offered when
  the map has unsaved edits) currently go through `components/play/host/useSaveMap` instead: it finds the
  library scene from the DM's session list, and saves the live scene with `ScenesRepo.saveVersion` — the
  first save of a session treats a library scene updated after the session started as a conflict, later
  saves pass the version it saved last as `baseVersion`; the conflict toast offers "Overwrite" (force).
  Its "unsaved edits" flag is set by Edit map changes and remembered per session in `localStorage`.

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
- Join order (client): subscribe `view:{uid}` → SUBSCRIBED → subscribe `req:{uid}` → send hello. Host: on every
  `req:{uid}` SUBSCRIBED (boot, reconnect, new member) push a snapshot/snapshot_ready. Host sends `sync` on idle
  (~10 s) so a lost final patch is detected.
- Host liveness = DM presence on `session:{sid}:host` (1.5 s grace after the host channel joins). On leave: the
  client loads its `player_views` row (adopted only if it has no view, or the row is the same epoch with a
  higher seq), shows "Waiting for DM", disables moves. While not live, the client re-checks
  `session_info(sid)` every ~10 s, so it notices a kick or a session ended from the library (where no host is
  running to broadcast `ended`) and shows the ended / kicked screen. Pending optimistic moves are overlays
  only; they clear when their result is applied, on snapshot/epoch change, or after 5 s ("DM not responding").
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
  or DM; no client INSERT/UPDATE; writes via RPCs. A display name changes only by joining again
  (`join_session`), which refuses (`name_taken`) names that pose as the DM ("DM", "GM", "Dungeon Master",
  the DM's profile name, …) or that another member of the session uses (case-insensitive).
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
The limits are per anonymous account: abuse spread over many accounts is bounded only by Supabase's per-IP
anonymous sign-in rate limit (README).
Realtime: `realtime.messages` policies per the §6.1 table, checking `extension` ('broadcast'/'presence').
Dashboard settings (not SQL): enable anonymous sign-ins; disable Realtime "Allow public access"; keep the
anonymous sign-in rate limit low for public deployments (Authentication → Rate Limits, default 30 per hour
per IP).

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

---

## 8. Play mode

- Player: select a controlled token; drag shows a path (A* over legal steps, core/movement) with ruler (feet,
  diagonal rule); release sends `move`. The pending path is an overlay only; the token moves when the patch
  arrives. Drags target the token's view level (`tokenViewLevelId`, §2), and a drag aimed at the cell just
  beyond a stairs/ramp top edge prefers the run's upper level (falling back to the token's level if the upper
  one is unreachable), so a staircase inside a room with known floor beyond its top is climbed rather than
  walked around. A token whose footprint's leading row is on the run's top row gets a "Go up" HUD button,
  and one on the landing cell just beyond the top gets "Go down", validated like ladder climbs. Ladders keep
  "Climb up/down".
- Door requests: a click on a door leaf, its top-down marker (§4.3) or the ground next to its segment
  (`doorAt()` proximity) toggles it. Hover highlight and the pointer cursor use the same `doorAt()` rule, so
  a door is discoverable wherever a click would work.
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
  stored px per cell, a chunk image is 4·tilePx square, ≤ 1024 px). A chunk is clipped to the player's
  explored 4×4 **sub-cells** (1.25 ft on a 5 ft grid): a cell explored only on one side of a wall carries
  only that side's art, and everything else is transparent. What remains beyond the explored area is at most
  the canvas's antialiasing at the clip edges.
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
    `AssetStore` in `net/assets/types.ts`). The DM deletes the session's chunks when it ends.
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
`pickInitialQuality()` (GPU renderer string + a short timed render of a synthetic world-shader workload,
cached per GPU), which `EngineCanvas` runs on every route whenever it is given no tier, and then adapted at
runtime (§4.5).

| Tier   | Pixel budget | MSAA (post scene target) | Light atlas tile | PCF | GPU LOS refine | Post |
|--------|--------------|------|------------------|-----|----------------|------|
| low    | 1.3 MP       | off (direct to the canvas) | 256²   | 1 tap | off          | none |
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
shaders), not MSAA. The world material is compiled once per tier (a tier change is a deliberate one-time
recompile).

---

## Appendix: Implementation status (2026-09-23)

Everything above is implemented. Final verification of the current tree (after the wave-3 review fixes):
`npx tsc -b --force` (0 errors), `npx vitest run` (113 files, 1317 tests pass and 3 opt-in live Supabase
tests are skipped; one early run hit a timing-dependent assertion in `net/player/playerClient.test.ts`,
which was fixed, and the 7 full runs since were green),
`npx eslint .` (clean) and `npm run build` all pass. Every end-to-end script in `e2e/` passed against a Vite
dev server (Chromium, NVIDIA through WSL d3d12 unless noted):

| Script | Result |
|---|---|
| `editor-smoke` | 32/32 (quality probe, menus, labels, options bar at 1280 px, tools, undo / redo, shortcuts, save, reload) |
| `vineyard-build` | 23/23 (builds and exports `test_maps/vineyard.atlas.json`) |
| `multiplayer-local` | 53/53 on the Crooked Lantern; 55/55 on the Vineyard (host menus, oracle-equal views, moves, doors, stairs, lock, reloads, leak scan) |
| `multiplayer-supabase` | 22/22 on the Crooked Lantern, 31/31 on the Vineyard with map chunks (incl. sub-cell clipping of downloaded chunks) |
| `multiplayer-latency` | 7/7 (120×120 daylit field: a 20-step move answered in 320–616 ms, a concurrent 1-step move in ~600 ms, over two runs) |
| `host-save-map` | 12/12 |
| `engine-leak` | 5/5 (24 editor visits, every engine context collected) |
| `perf` | 36/36 (AMD iGPU medium and NVIDIA ultra × Crooked Lantern, Stress Test, Vineyard; numbers in `docs/PERFORMANCE.md`) |
| `showcase` | 5/5 (`docs/screenshots/` regenerated) |

On the Vineyard the `multiplayer-local` stairs step needs two things the Crooked Lantern does not: the
manor stairs are behind closed doors, so the DM opens the storey's doors first (the planner only paths
through open, known space), and the upper landing cannot be seen from the foot of the stairs, so the token
walks up to the top step (where its view level switches) before the drag past the top climbs.

The SQL suites run on the linked project, each in a transaction that is rolled back:

| Suite | Result |
|---|---|
| `rls_test.sql` | 326/326 (re-run in the final verification; checks run against `realtime.messages`) |
| `assets_storage_test.sql` | 25/25 (the legacy per-cell tile checks now assert the API is gone) |
| `tile_chunks_test.sql` | 22/22 |
| `quotas_test.sql` | 27/27 |
| `scene_asset_cleanup_test.sql` | passes |

All but `rls_test.sql` were last run right after the wave-3 migrations were applied; no migration or SQL
test changed since. The applied migrations match `supabase/migrations/` one to one.

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
- "Save map to library" exists twice: `HostRunner.saveMapToLibrary` (with `GameState.origin`, §6.2) and the
  host console's own `useSaveMap`, which the UI uses; the host console does not pass
  `HostRunnerOptions.scenes`, so the runner path is unused there.

**Map images**

- Chunks are clipped to explored sub-cells, so what a player can download beyond what they perceived is
  at most the canvas antialiasing at the clip edges. Floors are still clipped per cell (`clip.ts`), which
  reveals only floor extent, not art.
- Chunk images are cropped and encoded on the DM's main thread (OffscreenCanvas → WebP, ~2 ms per tile),
  not in a worker.
- Local mode crops tiles from the locally stored image. It is dev only and not a security boundary, like
  `LocalTransport`.

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

**Play and editor**

- A drop beyond a staircase's top edge climbs only onto upper floor the player already knows. Where the
  upper landing cannot be seen from the foot of the stairs (the Vineyard manor's stairwell), the drop
  walks to the landing cell on the lower level instead; the player walks up the run first (the view level
  switches to the upper storey on the top steps) or uses **Go up** on the top step.
- Shrinking the grid drops heightmap chunks beyond the new lattice but does not zero the padding of the
  boundary chunks (`cropHeightmapToGrid` exists but the editor does not call it). Every read ignores
  samples beyond the lattice, so this only keeps a few unused floats in the document.

**Rendering**

- The Crooked Lantern DM view on an integrated GPU (Radeon iGPU, medium) takes ~13–13.5 ms of GPU time at
  p95, about 81% of the frame budget. The high tier costs ~21–23 ms there (51 fps with vsync); the start-up
  probe (every route, "Auto") and adaptive quality keep such machines on medium, and the host console and
  the player page have a quality selector like the editor.
- A tier change recompiles the world shaders. Adaptive steps compile the next tier in the background, but
  on the tested WSL Mesa d3d12 / ANGLE setup shader compiles are not parallel, so a step still costs two
  frames of ~170–480 ms (one frame of 500–870 ms before). Parallel compilation on native drivers is untested.
- The canvas has no MSAA, and not every overlay has analytic antialiasing yet: 1-px line overlays
  (selection and hover outlines, light radius rings, preview outlines), the 3D drag ghosts, preview fills
  and connector arrows are aliased. Rulers, move paths, brush circles and token markers are smoothed.
- Light origins are resolved (§2) per light on every scene change through `groundHeightAt`, which scans
  the scene's objects; on very large maps a `groundIndex`-based resolve would be cheaper.
- In cutaway views, the part of a lower storey's wall inner face that sits flush with the next storey's
  slab edge (between the cutaway plane and the next elevation) can be lit by lights of the hidden storey:
  the receiver's normal offset puts the test point inside the slab. The cap rule (§4.2) covers wall tops
  only. Repro: `dev/render.html?sample=crooked-lantern&mode=dm-play&at=66,89.5&zoom=3&lights=floating&moon=0&rotate=2&tilt=35`.
- Only Chromium has been tested, on NVIDIA and AMD through WSL d3d12 and on SwiftShader. Firefox and Safari
  are untested.

**Security**

- Quotas (§6.4) are per anonymous account. Abuse spread over many accounts is bounded only by Supabase's
  per-IP rate limit on anonymous sign-ins (keep it low for public deployments, README), and CAPTCHA is not
  supported yet (`describeNetError("captcha_required")` explains the error, but the app has no widget).
- Token portraits are the DM-supplied http(s) `imageUrl`, sent to players who see the token and loaded by
  their browsers from that host (without a referrer). The image host therefore learns the viewers' IP
  addresses. Portraits are not copied into Storage, and there is no CSP `img-src` restriction.

**Bundle** (`npm run build`, minified)

- The home route loads ~1.05 MB of JavaScript (~320 kB gzip): React, Base UI, zod, supabase-js and the
  `core` modules the library needs.
- three.js and the renderer are a separate ~1.06 MB chunk (~308 kB gzip), loaded only by the editor, host
  and play routes. Rolldown names it after a module that imports it (currently `QualitySelect-*.js`); a
  `codeSplitting` group in `vite.config.ts` would give it a clearer name.
