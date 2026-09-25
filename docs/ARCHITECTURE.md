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
    scene/              Scene types, zod schema, migrations, factories, queries, heightmap, integrity (refs/paste),
                        terrainShapes (terrain shapes: bake + the single terrain writer), wallProfile (walls on
                        terrain, shared by render / occlusion / filter), polygon (signed area shared with the schema)
    grid/               Cell math, snapping, distance rules, supercover rasterisation
    geometry/           Vector / box / segment / ray / polygon-clip math shared by occlusion, movement, filter;
                        gizmo (translate arrows, rotate ring and height-follow math shared by the terrain tool and overlay)
    occlusion/          CPU occluder model (boxes, cylinders, heightfields, wall strips) + ray queries  ← single source of blocking truth
    vision/             Authoritative visibility: light field, per-viewer LOS, perception masks, observation
    movement/           Move validation (walls/doors/windows/props, connectors), ruler measurement
    history/            Undo/redo over immer patches with transactions
    dice/               Dice notation, unbiased rolls, roll result schema (§6.5)
    area/               Areas of effect (spell templates): 3D volumes, line of effect, covered squares, creatures caught (§6.6)
    session/            GameState reducer, request validation, memory, filter, diff/apply, viewToScene, table and
                        token status (§6.5), templates (§6.6)
    tokenMaker/         Token Maker designs: layers, transforms, masks, validation, frame opening detection (§11)
  render/               three.js (WebGL2). Knows nothing about React or the network.
    engine/             Renderer, frame loop, resize, adaptive quality, stats
    builders/           Scene → visual meshes per level (floors, terrain, walls w/ openings, doors, props, tokens…)
    occluders/          OcclusionWorld.primitives → occluder proxy meshes (LIGHT / SIGHT layers)
    shadows/            Octahedral distance atlases (light shadows; viewer line-of-sight maps), sun shadow map
    lighting/           Light manager: culling, flicker, slot + tile assignment, update scheduling
    materials/          World material (custom GLSL: lighting + perception + fog in one pass), token material,
                        screen-space AA overlay materials (lines, points `aaPointMaterial`, gizmo arrows)
    fog/                Host-mask textures (perception / explored / sunlit) as DataArrayTexture layers
    post/               Medium / high / ultra post (MSAA scene target; high/ultra: HDR, AO, bloom, tone mapping, grain)
    cameras/            Editor orbit camera, player 2.5D camera
    overlays/           Grid, selection, tool previews, ruler, pending paths, ghost levels, gizmos, terrainOverlay (§4.6),
                        areas of effect (templates.ts, §6.6)
    picking/            Ground/object/token picking
  editor/               DM editor state (zustand) + tools (the terrain mode: tools/terrain.ts + tools/terrain/, terrainMath)
  play/                 Play-mode controllers (token selection, drag-to-move, ruler, level switching, the Template tool
                        and the templates' computed areas, §6.6)
  tokenMaker/           Token Maker (§11): Canvas 2D compositor, image import, editor store, draft, flows
  net/                  Supabase client, auth, repositories, transports, host runner (+ vision worker), player client,
                        free asset catalog (freeAssets.ts), token images, image tools, Token Maker link (§11)
    assets/             Map images: import (decode / resample / WebP), DM asset stores, per-player tile chunks
    host/               DM-side host runner, vision worker client, flush pipeline, persistence, backdrop tiler
    player/             Player client (sync rules, requests), backdrop compositor
  app/                  Service wiring (Supabase or local mode), router + lazy routes, library, scene digests
  lib/                  keymap (pure: remappable command tables, overrides), hotkeys (TanStack Hotkeys wrapper, key labels), utils
  components/           React + shadcn UI (app shell, editor panels, play HUD, host console, lobby; play/table: chat,
                        dice, turn order, map markers, areas of effect)
  routes/               Page-level components (home, editor, host, play, join, shared scene, token maker)
  dev/                  Dev-only render harness (`dev/render.html`) and the Vineyard build helpers
  integration/          Cross-module consistency tests (render ↔ occlusion, vision ↔ movement, host → player, editor → session)
supabase/migrations/    SQL: schema, RLS, RPCs, realtime policies
supabase/functions/     Edge Functions: merge-guest (§6.4), remove-background (§11); _shared/imageModels.ts (§11)
dev/imageToolsApi.ts    Dev-server-only /api/image-tools endpoint (§11)
scripts/free-assets/    Build (STL → LOD GLB + thumbnail) and publish free token models (§4.3, §6.4)
```

Dependency rule: `core` imports nothing outside `core` (immer types allowed). `render` imports `core`.
`editor`/`play`/`net` import `core` and `render/contracts.ts` (`editor`/`play` also the pure `lib/keymap`). `components`/`routes` import everything.
Bundling: `/editor`, `/host`, `/play` and `/tokens` are lazy routes (`app/routes.ts`), so three.js and the
renderer load only in the first three; the home, join, shared-scene and token maker routes never download them.

UI rule: compose from shadcn components in `src/components/ui` (preset `b5UKukPFuS` → style `base-mira`,
Base UI primitives, Outfit + Roboto Slab, lucide). Dark theme first.

Theme ("gilded", `src/index.css`): cool slate-blue surfaces and parchment text; teal (`--primary`) marks the
current selection and live state; gold (`--gilt-*`) is an accent only, for frames, corner filigree, section
headings and the primary action. The semi-skeuomorphic pieces are `atlas-*` utilities (`atlas-gilt-frame`,
`atlas-filigree`, `atlas-framed`, `atlas-decision`, `atlas-rubric`, …) used by the ui components, so screens
pick the look up through the components rather than styling it themselves. Button roles follow Crusader
Kings III: `default` is the primary action (a bronze plate in a gold frame), `outline` a secondary one
(slate plate), `selected` the current choice in a set, and `decision` a choice in an event-style prompt
(full-width bands between gold hairlines, stacked: the decision first, backing out last; `useConfirm()`
and the End session dialog).

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
  - Floor slab: top = ground surface (displaced by the heightmap), bottom = top − thickness (the drawn
    terrain mesh has no bottom, only skirts down to it: the cameras never look up at it; the occluder
    proxies are closed solids).
  - Walls, their openings and closed doors: **Walls on terrain** below.
  - Pillars/props resting on the ground (`y = 0`): top = ground(centre) + y + height; bottom = min ground
    over the footprint. Stairs/ramp occluder bottoms: min lower-level ground over the rect − 0.05 ft.
  - Lights and tokens follow `groundHeightAt` (so a torch or token on a stair run rises with it).
  `render/builders` (ground.ts, floors.ts) and `core/occlusion` (build.ts, terrain.ts) implement
  these rules separately; walls are the exception: both take their base line, tops and opening heights
  from `core/scene/wallProfile`. Shared quantities come from `core/scene`: slab thickness is
  `floorThickness(scene, floor)` (the floor's own thickness, else its level's; no visual minimum, so a
  0.01 ft slab is drawn and blocks at 0.01 ft). `src/integration/crossModule.test.ts` checks that both sides
  agree on walls (profiles, joints, volumes, proxy ↔ primitive mapping), floor / terrain slabs (incl. mask floors;
  terrain top cells = heightfield solid cells), stairs / ramp bottoms and tops, pillars and blocking props,
  on the sample scenes plus test-only fixtures: mask floors (flat and heightmap levels with irregular masks,
  stairs cutting them, every prop kind rotated, a 0.01 ft slab) and terrain walls (a slope with a joint
  chain, follow walls crossing both lattice edges, a buried follow-off wall, doors and windows on follow
  walls, and a level with shapes baked in). Door leaves are not compared.
- **Walls** are segments centred on a→b; at shared endpoints (within 1e-3 ft) both ends extend by
  thickness/2 so corners have no notch (in both render and occlusion). Only endpoint–endpoint contacts form
  joints (a T-junction stem is not extended; it already reaches the other wall's centreline).
- **Walls on terrain** (`core/scene/wallProfile`, ONE implementation shared by the render builders, the tool
  previews, `core/occlusion`, the light tool's wall mounts and the session filter). u = feet from a along a→b.
  - `WallObject.followTerrain` true (new walls, `toolSettings.wall.followTerrain`; v1 walls migrate to true,
    §3): the **base line** is the terrain ground `levelGround` on the centreline for u ∈ [0, len], flat
    beyond the ends (the joint extensions take the end's base, so walls meeting at a node have identical
    corner tops). The ground is piecewise linear along the centreline between its crossings of the lattice
    lines x = i·s, z = j·s and the triangle diagonals (`lineLatticeKnots`), so the profile samples it
    exactly there (`wallBaseKnots`: 0, the crossings, len) and drops knots collinear with their original
    neighbours (within 1e-9 ft; the function is unchanged). false, or a level without a heightmap: base =
    the level elevation everywhere (terrain above it buries the wall).
  - Top = base + height. The **bottom** is flat: follow on, min(ground over the joint-extended footprint,
    lowest base) − `WALL_BOTTOM_MARGIN` (0.05 ft); follow off, min(elevation, that ground) − 0.05.
  - **Openings** (`openingFrame`; span clamped to the wall, H = wall height, minTop = lowest top over the
    span): base b_o = base line at the span's centre; door head = max(bottom, min(b_o + clamp(h, 0, H),
    minTop)); window sill top = min(b_o + clamp(sill, 0, H), minTop), head = max(sill top, min(b_o +
    clamp(sill + h, 0, H), minTop)); a window with a raw sill > 0 always has a sill piece (unless thinner
    than 1e-6 ft). The world-Y clamps against minTop keep lintels and sills uninverted on slopes.
  - **Pieces** (keys unchanged, §5.1; `throughDoorway` relies on them): full height [bottom, top(u)] between
    openings, lintels [head, top(u)], window sill [bottom, sill top], closed door box [bottom, head],
    window movement box [bottom, max top over its span]. A piece whose top is constant over its span
    (varies by ≤ 1e-9 ft) is an `OrientedBox` (follow-off walls always; on levels without terrain the
    output is identical to the former midpoint rule's); otherwise it is a `WallStrip` (§5.1) over the
    profile knots inside it (`pieceKnots`). Pieces thinner than 1e-6 ft are dropped. The render draws a
    strip as one closed prism per knot interval without internal faces (`builders/shapes.ts` `writeFrameStrip`).
  - Render-only door rules: a leaf pivots at b_o and spans from the lowest ground under the opening's
    footprint − 0.05 ft up to the head (no huge buried leaf on a slope; a leaf less than 0.05 ft above that
    ground is not drawn: the door is buried); the portcullis lift is 0.9·(head − b_o); the top-down marker
    sits on the highest wall top over the leaf's span. The wall's hole and occlusion's closed-door box
    still reach the wall bottom, so the gap under a leaf shows only from below the terrain slab. Window
    frames use the sill top and head.
  - Known limit: the ground outside the lattice (x < 0 or z < 0) is the elevation, so a follow wall
    crossing the lattice's low edge ramps instead of stepping, wholly outside the lattice (from the wall's
    outside end to the edge crossing). The knot on the edge always samples the lattice: interior knots that
    round to at most 1e-9·max(1, len) ft below 0 are snapped onto the edge.
  Because both sides share the profile, their agreement proves nothing about the rule itself: crossModule
  (and the profile, occlusion and builder unit tests) also check tops at random u against an independent
  oracle built on `levelGround` (+ H for follow walls; elevation + H otherwise), bottoms against the ground
  under the footprint, and door heads and sill tops against the raw formula.
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

- Types `core/scene/types.ts`, presets `core/scene/defaults.ts`. `SCENE_SCHEMA_VERSION = 7` (v2 added the
  optional `Token.model`, the v1 → v2 migration is the identity; v3: terrain shapes, `Level.terrainEdits`,
  `WallObject.followTerrain`; v4 widened enums only, heightmap resolutions 8 and 16 and the `polygon` shape
  kind, so the v3 → v4 migration is the identity and older apps open v4 documents read-only as too-new; v5
  added the optional `TerrainShape.innerEdges` (loop cuts), again an identity migration; v6 added the
  optional `Token.hp` and `Token.conditions`, the v5 → v6 migration is the identity; v7 added the optional
  `TerrainShape.innerPoints`, interior top vertices where loop cuts cross, again an identity migration).
- `Token.hp` / `Token.conditions` (optional; `core/scene/tokenStatus.ts`): hit points `{current, max,
  temp}` (integers, 1 ≤ max ≤ 99 999, 0 ≤ current ≤ max, temp ≥ 0: `tokenHpSchema`; absent = not tracked)
  and conditions from a fixed catalog (`TOKEN_CONDITIONS`: the SRD's fourteen, exhaustion, concentrating,
  dead), each once and in catalog order (`tokenConditionsSchema`; absent = none). They are set in the editor
  and in play (§6.5); what players are sent of them is the filter's call.
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
  - heightmap resolution ∈ {1,2,4,8,16} (`TERRAIN_RESOLUTIONS`), and at most
    `MAX_TERRAIN_SAMPLES_PER_SIDE` = 800 lattice intervals per grid side (`core/scene/heightmap`
    `terrainResolutionFits`: 8× on grids up to 100 cells, 16× up to 50, so no level has more samples than a
    200-cell grid at 4×; the store refuses a resolution that does not fit, clamps grid resizes to the finest
    level's limit, and the Levels / Scene panels disable or cap accordingly); chunk keys canonical `^(0|[1-9]\d*),(0|[1-9]\d*)$` and inside the grid's
    chunk range; exact base64 / byte length; finite samples within ±500 ft;
  - walls require `followTerrain: boolean`; `terrainProfile` (player scenes only, §6.2) is rejected;
  - terrain edits (below): ≤ 1000 shapes per level, 3..64 points per shape, ≤ 16000 points per level
    (`maxTerrainShapesPerLevel`, `maxTerrainShapePoints`, `maxTerrainPointsPerLevel`, counted on the raw input
    by `terrainSizeIssue`); strict shapes (kind / op enums, integer `order` 0..1e6, `name` ≤ 2k, points and
    `base` y within ±500 ft, canonical signed area > 1e-6 ft², `innerPoints` / `innerEdges` valid by `topGraphValid`, ≤ 64 top vertices in all);
    record key == shape id (`validateReferences`;
    ids are level-scoped, not claimed scene-wide); `baseChunks` keys and payloads like heightmap chunks at
    the level's resolution, plus `""`; `terrainEdits` requires a heightmap; shape points within the extent
    ± 50 ft. The schema checks shape and range only, not the bake invariant.
- `core/scene/migrations.ts`: migrations (`MIGRATIONS[v]`: vN → vN+1) operate on unknown JSON (deep-copied
  first). `parseScene(json)` → `{ok:true, scene, migratedFrom}` | `{ok:false, error:'too-new'|'invalid', issues}`
  (≤ 50 issues); `too-new` opens read-only. `parseScene` also runs `validateReferences` (integrity);
  `parseSceneJson(text)` wraps JSON syntax errors as `invalid`. `MIGRATIONS[2]` (v2 → v3): every wall whose
  `followTerrain` is not a boolean gets `true` (the closest v3 equivalent of the old midpoint base; identical
  on flat levels). Duck-typed, idempotent, never throws on garbage (the schema reports it); levels untouched.
- Editor autosave drafts are stored as saved, so a recovered draft goes through `parseScene` too
  (`components/editor/useSceneDocument.ts` `draftScene`): an older draft is migrated, an invalid or too-new
  one is not offered (logged, kept).
- The editor never commits a revision `parseScene` would refuse (`editor/validate.ts`, see §7), so every
  saved version can be reopened.
- Heightmaps are chunked (8×8 cells per chunk, base64 Float32) so edits, undo patches and network diffs touch
  only dirty chunks. Samples beyond the grid's lattice read as 0 everywhere (`sampleHeight` with the grid,
  like the occlusion terrain sampler), and a grid resize (width or depth) in the editor crops each level's
  terrain to the new lattice (`cropTerrainToGrid`: the painted base is cropped, samples beyond the lattice
  dropped, then everything is rebaked), so old painted heights cannot come back if the grid grows again,
  while shapes reappear where a grown grid re-exposes them.
- Storage: `scenes` + immutable `scene_versions` in Supabase; `.atlas.json` export/import; import regenerates `Scene.id`.
- Sharing: `visibility: 'private' | 'link'`. Link shares are read only through the `get_shared_scene(slug)` RPC and
  publish the FULL DM document (the UI warns). Scene ids are never capabilities; session membership never grants
  scene access.

### Terrain edits (`core/scene/terrainShapes`)

`Level.heightmap` stays THE terrain for every consumer (render, occlusion, vision, movement, players).
`Level.terrainEdits` (DM-only editing data, never sent to players or to the vision worker) holds what it is
baked from: `shapes` (`TerrainShape`: `kind` block / ramp / cylinder / polygon is a label; `op` add / carve; integer
`order`; `points` = simple polygon footprint in canonical orientation, each with its top height y relative
to the elevation; `base`, the other end of the prism's sides in the editor, not baked; optional
`innerEdges`, see below) and `baseChunks`
(the painted terrain, "base", where it differs from the baked heightmap).
- Invariant, per heightmap chunk K: base_K = decode(`baseChunks[K]`) if present (`""` = all zero), else
  decode(`heightmap.chunks[K]`) (zeros if absent); `heightmap.chunks[K]` = encode(bake(base_K, shapes))
  (absent when all zero), and K ∈ `baseChunks` ⇔ base_K ≠ baked_K, both in canonical form (−0 → +0,
  samples beyond the grid lattice zeroed). `terrainEdits` exists ⇔ the level has ≥ 1 shape (then it has a
  heightmap). The schema does not check this; a document that breaks it only "jumps" the next time an
  affected chunk is written.
- Bake (`bakeRegion`; deterministic: + − × ÷, sqrt for edge lengths and `Math.fround` only, so a
  whole-level rebake reproduces an incrementally written heightmap bit for bit): shapes apply in ascending
  (order, id) (plain string compare), add → max(terrain, top), carve → min(terrain, top). A shape's top is
  its footprint cut into faces by its inner edges (`topFaces`) and each face triangulated by `triangulateFootprint`
  (`shapeTopTriangles`; own ear clipping, robust for 3..64 vertices
  including collinear and repeated points; zero-area ears dropped; an ear whose diagonal passes within
  `VERTEX_EPS` (1e-6 ft) of another remaining vertex, away from its ends, is clipped only when no other ear
  is left, so simple footprints are covered whole; a stalled clipping returns the triangles found so far,
  never area outside the polygon) with the vertices' heights. Per triangle (doubled area
  > 1e-9) the lattice samples of its XZ bounding box are visited; a sample is inside iff every edge function
  eᵢ ≥ −1e-6·|edgeᵢ|, its value Σλᵢ·yᵢ with λᵢ = max(0, eᵢ)/Σmax(0, eⱼ); a sample inside several triangles
  of one shape takes their max (add) / min (carve). Non-finite values are skipped; results are float32,
  clamped to ±500 ft. "Inside a shape" means inside one of its triangles (`shapeTopAt` uses the same
  arithmetic). Samples beyond the grid lattice are never written.
- `writeTerrain(level, grid, edit)` is THE single writer of `heightmap` + `terrainEdits` (delta form:
  `upsert`, `remove`, `base: {lattice, rects}` authoritative only inside `rects`, `rebake`). It recomputes
  the chunks overlapping the old ∪ new bounds of the changed shapes (grown by 1e-3 ft), the base rects and
  the rebake rects, assigns only chunk strings and shape entries that change (so immer patches, undo and
  network diffs stay per chunk / per shape), creates the heightmap at `DEFAULT_TERRAIN_RESOLUTION` (2) when
  something is written to a level without one, writes the base back into the heightmap and removes
  `terrainEdits` when the last shape goes, and refuses (returns false, writes nothing) a base lattice that
  does not match the level's lattice or an invalid shape (`isValidTerrainShape`: the schema's shape rules
  plus a simple footprint). Shape objects are immutable (geometry caches key on identity).
- Level operations (`resampleTerrain`: the base is resampled, the shapes rebaked sharp at the new resolution,
  `baseChunks` rewritten in the same edit; `cropTerrainToGrid`; `flattenTerrain`: base 0, shapes kept;
  `clearTerrainShapes`: the base becomes the heightmap; `applyShapesEdit` / `applyShapesToBase`: "Apply to
  terrain" on the downward closure `applyShapesClosure(level, ids)`, i.e. the named shapes plus, transitively,
  every shape earlier in bake order whose bounds (grown by 1e-3 ft) overlap one already taken: base :=
  bake(base, closure in bake order) inside its bounds, then the closure is deleted, so the heightmap never
  changes) and the element edits (`translateVertices`, `translateShape`, `rotateShapeQuarter`,
  `dissolveVertices`, `collapseEdge`, `removeInnerEdges`, `loopCut`: null instead of an invalid shape) are pure; every document write of
  terrain goes through the editor store's terrain actions (§7). `hasPaintedBase(level)`: the base is non-zero
  somewhere (reads chunk keys only, by the invariant; nothing is decoded).
- The top graph (loop cuts): `innerPoints` are interior top vertices (x, z strictly inside the footprint);
  top vertex k is `points[k]` for k < n, `innerPoints[k − n]` after (`topVertices`, `topVertexCount`; vertex
  elements index this list). `innerEdges` holds pairs [a, b] of top vertex indices, a < b, ascending,
  never an outline edge. `topGraphValid`: no vertex within 1e-6 ft of another or of an edge it does not
  end, no crossings, edges inside the footprint, every interior point on an edge, and the planar faces
  (`topFaces`: a half-edge walk with the edges around each vertex sorted by angle, keeping the face on the
  left) all simple, covering the footprint exactly once with a single unbounded face, so dangling, spiky
  or detached edges are refused. The top is triangulated face by face, so raised inner edges are crisp
  ridges and a raised crossing a peak. Faces are topology-ordered (each from its lowest vertex, sorted),
  so their indices survive vertex moves; a cut top's faces are face elements n + f (picked by
  `rayHitShape`'s `topFace`, box selected and selected all one by one; "top" stays the element of an uncut
  top). Edge element k < n is outline edge k, n + c is inner edge c
  (`shapeEdgeEnds`, `shapeEdgeCount`; picking, box selection, select all and the element display include
  them, and interior vertex dots). Edits that re-index vertices re-index them (`withVertexMap`,
  `remapInnerEdges`: an edge losing an end, merging its ends or becoming an outline edge is dropped, then
  interior vertices on fewer than two edges go, repeatedly). `loopCutRing(shape, e)`: Blender's edge ring
  through edge element e, walked both ways: each top face (an even number of sides m) is crossed from the
  side it is entered by to the side m/2 further round and on into the next face across that side, until
  the outline; the crossed edges are oriented so one parameter t along every one is a parallel cut; null
  at a face with an odd number of sides or when the ring meets itself. `loopCut(shape, e, ts)`: for each t
  a vertex on every crossed edge (outline edges get them in the footprint, inner edges are split at new
  interior vertices), joined by new inner edges across each face; heights are interpolated along the
  edges, so planar faces keep their form; returns the shape and the new edges' element indices.
- Side and bottom edges are edge elements too, after the top edges (T = n + inner edge count): T + k is the
  vertical edge under footprint vertex k, T + n + k the bottom edge under outline edge k (`shapeEdgePart`,
  `shapeAllEdgeCount`, `shapeEdgeSegment`: null for zero-length ones, a side edge whose top is on the base
  or a bottom edge under a top edge lying on the base, like the prism's drawn edges). They stand for the
  data that exists: a side edge is its corner (moved sideways; Y lifts that corner's top only), a bottom
  edge is its two corners, moved sideways, with Y moving the base, one height for the whole shape
  (`translateVertices` `flat` / `base`; editor `elementMovesByShape`). The advanced mode's gizmo sits at
  the elements' points (`elementsCentroid`: side and bottom edges count their base corners).
- Factories: `blockShape`, `rampShape` (dir 0 = +Z, 1 = +X, 2 = −Z, 3 = −X ascending; low edge y0, high
  edge y0 + height), `cylinderShape` (a 3..64-gon inscribed in the circle), `polygonShape` (a flat top
  over a drawn footprint, stored canonical); base y0, op carve when the height is negative. Factories do not
  validate (`isSimplePolygon`, `isValidTerrainShape`; `isSimplePolyline` checks an open chain that is still
  being drawn). `nextShapeOrder` = max order + 1.

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
  budget), (b) dirty viewer tiles, (c) on-screen lights by coverage, (d) rest. Budget:
  `SHADOW_UPDATES_PER_FRAME` = 4 tiles AND ~2 ms CPU (`shadowUpdateMs`). Invalidation: a tile is dirty when
  its source moved/changed radius, or an `OcclusionWorld.update` dirty region (or a terrain preview's, §4.6)
  intersects its sphere. Occluder proxies follow authoritative door state instantly (only the visual leaf
  animates). Lights beyond the tile budget are **not drawn** (never unshadowed).
- Sun/moon: static cached `DepthTexture` (2048², ortho over the scene bounds), re-rendered on occluder or sun
  change (terrain previews included).
  A second vertical map (1024², looking down) gives sky exposure for the `skyLevel`/`ambientLevel` split. It
  drives the visual fill only outside player fog mode (the player's scene lacks unexplored roofs); in fog mode
  the GPU perception refinement reads it only as an upper bound, which can never remove perception wrongly.

### 4.3 Levels, cutaway, ghosts, draw order

- Each level: a Group of merged visual meshes (per material, with `aSurf`), InstancedMeshes (props, pillars),
  door/window meshes (animated), terrain mesh, token meshes, editor gizmos. Occluder proxies live in a separate
  `occluderScene` built from `OcclusionWorld.primitives` (instanced unit boxes / 16-sided prisms per
  (level, channel mask, 100 ft bucket) + closed heightfield meshes + wall strips merged into one closed,
  outward-wound world-space mesh per (level, channel mask, 100 ft bucket) with a per-vertex `aKey`, named
  `occluders:${level}|${mask}|strip|bx,bz` and rebuilt whole when a member changes (same shader);
  layers LIGHT=1, SIGHT=2), `matrixWorldAutoUpdate=false`.
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
  Held WASD pans either camera along the ground relative to the view, easing in and gliding to a stop.
  The top view never follows the selection: dragging or editing a selected token must not move the camera
  (the ground point under the cursor would shift and the drag would run away).
- Player: orthographic, looking straight down (no tilt, in any view), pan/zoom, rotate by 90°. Only the player and dm-play views
  glide to the selected token's confirmed position (`checkFollow`).
- Camera bounds (`cameras/fit.ts` `sceneBounds`: the grid extent, each level's slab..ceiling over its
  terrain) use the terrain as drawn, terrain previews included, and are refreshed on every terrain change
  and whenever a preview leaves them. The top-down camera stands 30 ft above the bounds' top, so all
  geometry stays in front of its near plane (with bounds stale after a terrain commit, high terrain was
  clipped away).
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

### 4.6 Picking, tool previews and terrain previews

- **Picking** (`render/picking/picker.ts`): `ground` is the active level's terrain where a floor covers the
  hit, else the plane y = elevation. With `PickOptions.terrain` (editor picks, §7) the terrain counts
  wherever it lies inside the grid extent, floors or not (the march stops where the ray leaves the extent;
  the plane remains the fallback outside it and on levels without a heightmap); the floor-object hit is
  unchanged. `PickResult.ray` is the pointer ray from the raycaster (unit direction; orthographic cameras
  give parallel rays with per-pixel origins, so it is never derived from the camera position), present
  whenever the canvas has a size. `Engine.project` maps a world point to canvas CSS px, the frame of
  `ToolPointerEvent.canvasX/Y` and `ToolDeps.project`.
- **Tool previews** (`overlays/previews.ts`): each owns its geometry and materials (`disposePreview`), except
  geometry flagged `userData.shared` / `userData.cached` and materials flagged `userData.shared`; they get
  `renderOrder` 12 only where theirs is 0. A `segment` is drawn as the wall `wallProfile` would build
  (follow on unless `followTerrain === false`, no joint extensions): one closed prism per `pieceKnots`
  interval from its bottom to top(u), plus the base line. An `opening` measures from the ground at its
  centre, or the elevation when its host wall does not follow the terrain (without the host wall's
  `openingFrame` clamps).
- **Terrain overlay** (`overlays/terrainOverlay.ts`; the `TerrainOverlay` tool preview, drawn only while
  the terrain tool is active): the level's shapes as translucent prisms (top = the bake's triangulation at
  the vertex heights, sides down or up to `base`, no base cap), add green, carve orange, hovered lighter,
  selected brighter, an invalid draft red; AA edge lines (top outline, vertical edges, base outline) and
  vertex dots (`materials/aaPointMaterial`: screen-space quads with a `fwidth` edge, viewport / pixel-ratio
  handling copied from `aaLineMaterial`). Faces are drawn twice: depth-tested with a polygon offset and a
  dim x-ray pass without depth test, so buried shapes and carved pits stay visible. A planar top coincides
  with the baked terrain; a non-planar one does not (the bake samples it on the lattice and interpolates
  across each lattice triangle, which rises above a valley crease), so its depth-tested fill uses the top
  lifted by `topLift` = spacing·(√2/2)·R (R: the largest distance of a top triangle's slope from the
  midpoint of the two most different slopes, at most their distance/√3), capped at the top's height range
  (`ShapePrism.liftedTop`; spacing from the preview ground, `buildTerrainOverlay(p, elevation, spacing,
  res)`); the x-ray fill and all edges stay on the true top, planar tops are not lifted. Vertex dots and
  element highlights draw without depth test (they are picked in screen space). Draw order inside the
  overlay: `TERRAIN_OVERLAY_ORDER` (12.1–12.99: x-ray before depth-tested passes, fills before edges,
  elements, brush, gizmo, marquee last).
  - Caching (≤ 1000 shapes / 16000 points per level must stay interactive during drags and live-host
    re-syncs): per-shape prism arrays live in a WeakMap keyed by shape identity (and elevation and lattice
    spacing); shapes are merged into two layers, unselected and selected, whose GPU geometry (`LayerCache`,
    flagged `userData.cached`; lifted faces cached and freed with it) is kept while the layer's list of
    shape identities, the elevation and the spacing are unchanged, so dragging the
    selection re-merges only the selected layer. The shared materials, both layer caches and the
    persistent `decor` (gizmo, label) are `TerrainOverlayResources`, created by the `OverlayManager` with
    the first terrain preview and released when the preview stops being terrain. Hover, draft and element
    highlights are small and rebuilt per overlay. Tools never mutate shapes and keep unchanged shape
    objects identical (the tool also keeps the draft's identity while its snapped value is unchanged).
  - Gizmo: translate arrows (X red, Y green, Z blue; hover / active lighter) drawn in screen space
    (`materials/gizmoMaterial`) from `core/geometry/gizmo` `gizmoHandles(project, at)`, the handles the tool
    hit-tests (`hitGizmo`): shaft from 14 to 70 px along the projected axis, hit radius 7 px, an axis hidden
    when its projected foot is shorter than min(2 px, 0.1 × the longest axis's), e.g. Y in the top-down view, and of two
    visible axes within 8° of each other on screen (`GIZMO_MIN_SEPARATION_COS`; opposite directions do not
    count) the one with the shorter projected foot hidden, so the arrow drawn is the arrow hit (the hidden
    axis stays reachable with X / Y / Z). `OverlayManager.update` re-aims them every frame through
    `OverlayHost.project` (the engine passes `picker.project`; without it no gizmo is drawn), so they keep a
    constant screen size and match the hit test exactly. The rotate ring (green, like the Y arrow it turns
    about) is a horizontal circle through the gizmo centre whose projection reaches 88 px along the longer
    projected horizontal axis (`gizmoRing`: a unit circle mesh scaled per frame; hidden when its ellipse's
    short axis is under 0.2 × its long axis, i.e. seen nearly edge-on), hit within 7 px of its projected
    polyline (`ringDistancePx`, after the arrows; in the vertex and edge modes a vertex or edge nearer the
    cursor than the ring takes the press instead, since the ring runs across the shapes; a click without a
    drag on any gizmo part picks the element under it, like a click there, so the gizmo never hides what lies
    under it; edge picking ranks side and bottom edges 2 px behind top edges). The value label ("+7.5 ft · Add") keeps a constant
    pixel size (placement: §7). The brush ring is the brush preview's. The select sub-tool's marquee
    (`TerrainOverlay.marquee`, canvas CSS px, the frame the tool tests vertices and shapes in) is a
    screen-space rect drawn by its own small shader over everything else.
- **Terrain previews** (`Engine.previewTerrain(levelId, heights, dirty)`, the brush and every terrain-shape
  gesture): the level's ground reads the dense lattice `heights` until the preview is cleared (`null`) or a
  committed terrain change replaces it (`updateScene` drops it, so a tool must not clear after a commit that
  changed the heightmap: the old terrain would flash). Contract: between calls the lattice changes only
  inside `dirty`; the engine keeps the union of every `dirty` since the preview began (`previewDirty`, null =
  everywhere). The terrain mesh (indexed: the top shares its vertices within each grid cell, whose tint is
  its own) moves in place (`builders/floors.ts` `updateTerrainGeometry`): a per lattice-row vertex table
  built with the mesh (`MergedBuild.terrainRows`: the vertices by sample row, each row in ascending x)
  limits the work to the rows and samples around `dirty`, heights are read straight from the lattice, the
  tops' smooth normals are recomputed, each attribute gets ONE upload range per call (first to last touched vertex, merged
  with any range not uploaded yet: several updates can run before a render; per-row `bufferSubData` calls
  into a buffer of tens of MB cost a whole-buffer copy each on some drivers) and the bounds grow by union;
  the floors bucket is rebuilt only when the level has no terrain mesh yet or it was built on another
  lattice spacing. The draped grid overlay follows the same way (`GridOverlay.refreshHeights`: the rows
  around `dirty`, one upload range per call from the first row's start to the last row's end, merged with
  pending ones, bounds grown by union). The preview's height range (scanned once, then grown by each dirty
  rect) feeds the camera bounds (§4.5).
  - Throttled work (`render/engine/previewThrottle.ts` `PreviewThrottle`, per level): the first update runs
    at once; later ones accumulate their dirty rects and run only once max(interval, `PREVIEW_COST_FACTOR`
    (8) × the last run's cost) has passed since that run ENDED (so a slow run takes at most ~1/9 of the main
    thread), plus a trailing run from the frame loop after the last update.
  - Walls: when `dirty` reaches a follow-terrain wall of the level (its bounds grown by the wall's
    thickness, within one lattice spacing), the level's whole walls and doors buckets are rebuilt on the
    preview (throttled, `WALL_PREVIEW_INTERVAL_MS` = 100 ms); the overlays (`sceneChanged`) are rebuilt
    only when outlines hang on that level's walls, doors or windows (selected, hovered or hidden).
    Clearing the preview rebuilds them from the document.
  - Lighting: `LightingSystem.previewTerrain(levelId, ground, dirty)` (throttled, `LIGHT_PREVIEW_INTERVAL_MS`
    = 100 ms; `dirty` = the union since the last call) keeps the level's LIGHT / SIGHT occluder proxies on
    the preview (`render/occluders` `OccluderProxies.previewTerrain`): heightfield chunk meshes holding a
    changed sample (`dirty` grown by one spacing) are rewritten in place (`heightfieldChunkTriangles` into
    an `ArrayTriangleSink`; a chunk's triangle order depends only on the lattice size and solid mask), and
    a flat level's floor boxes (no heightmap yet) are left out of their instance groups and replaced by
    stand-in heightfields on the preview's lattice (`standInHeightfield`, core/occlusion's floor rule).
    Heightfields rebuilt by `update()` meanwhile get the preview again. The level's light origins and viewer
    eyes stand on the preview ground too, except on stairs / ramp runs (`previewGround`; `resolveLights(…,
    preview)` → `lightOrigin`, attached lights by their carrier's level and position; `viewerEye(…, ground)`
    → core/vision `eyeAtGround`, which keeps the ceiling clamp and blocker push-out), re-resolved on each
    call. Tiles whose sphere meets the old ∪ new bounds, and those of sources that moved, are recaptured,
    the sun and sky maps re-render, and the lighting bounds are recomputed when the preview leaves them.
    `ground` null (a cleared preview) restores the document proxies, lights and eyes, invalidated the same
    way (bounds recomputed); a committed terrain change ends it in `applyChange` (each level of
    `change.terrain`, passed to `proxies.update(world, change.terrain)`; the engine drops the pending
    throttled call) and `setScene` (`proxies.rebuild`) ends every preview.
  - Commits and cleared previews move in place: `updateScene` takes, per level of `ch.terrain`, U = the
    changed chunks' rect (`heightmapDiffRect`) ∪ `previewDirty`, passes U to `world.updateTerrain` and moves
    the terrain mesh and the grid (`OverlayManager.terrainChanged(levelId, U)`: `refreshHeights`, else a grid
    rebuild) back onto the document over U. Then walls and doors are rebuilt only when a wall of the level
    stands near U (any wall: follow-off bottoms follow the lowest ground too); connectors, pillars, props and
    fixtures always (`diff.ts` `invalidateTerrain(inv, scene, levelId, kinds)`, which also marks the
    connectors climbing to the level and the tokens). Every bucket is rebuilt as before when the mesh cannot
    move (no terrain mesh, another lattice spacing, no heightmap any more) or changed objects rebuild the
    floors anyway. Clearing a preview moves the mesh and grid back over `previewDirty` the same way (the
    floors bucket is rebuilt only when that fails).
  - The heightfield occluder proxies move in place on commit too (`OccluderProxies.update`,
    `moveHeightfield`): a heightfield whose heights changed on the same lattice (origin, spacing, size,
    solid mask, thickness, channels, level) rewrites only the 16-cell chunk meshes holding a sample that
    differs from what the proxy shows (a level whose preview ends with this commit: the previewed heights,
    so a drag release whose commit equals its last preview rewrites nothing), and its dirty regions are
    those chunks' old ∪ new bounds, one per run of adjacent chunks in a chunk row. Any other change, or a
    level still under preview, rebuilds the heightfield; a settle pass restores ended previews the commit
    left unchanged.
  - Cached floor outline edges (`overlays/highlight.ts`, per mesh geometry and object: hovered, selected or
    a hidden floor's helper outline) follow the mesh: `moveTerrain` records the moved rect grown by one
    spacing (`moveCachedEdges`; the rects of several commits add up), and the next use recomputes only the
    edges whose midpoint lies within a lattice diagonal of it, from the object's triangles near it
    (`patchRangeEdges`), keeping the rest. `updateScene` always rebuilds the overlays; clearing a preview
    rebuilds them (`sceneChanged`) when a floor of the level is outlined, or a wall, door or window when
    the preview had rebuilt them (`outlinedOn`).
  - Follow-off wall bottoms, props, pillars, fixture and token meshes and floor outlines update on commit
    (or clear) only; light origins and viewer eyes follow the preview (Lighting, above).

---

## 5. Simulation (authoritative, CPU, `core/`)

### 5.1 Occlusion world (`core/occlusion`)

`buildOcclusionWorld(scene: SceneLike)` emits primitives per the blocking table and Terrain rule:
walls split around openings (window sill + lintel pieces; closed-door leaves per style; each piece a box, or a
`WallStrip` under a sloping top line, §2 Walls on terrain), wall ends extended at
joints, floors as boxes (flat levels) or one `Heightfield` per floor (levels with a heightmap), stepped boxes
under stairs/ramps, pillars (box/cylinder), prop parts (box/cylinder, scaled, rotated). A 2D uniform grid
(5 ft) over XZ accelerates queries (DDA + mailboxing). `update(scene, changedIds)` and
`updateTerrain(scene, levelId, rect)` rebuild incrementally (a wall brings its openings and the neighbours
whose joints change, an opening its host wall only if its span changed, a connector the floors it cuts) and
return dirty regions only for primitives whose value changed; a change of levels/grid rebuilds everything.
The engine and the host runner pass `updateTerrain` the rect of the heightmap chunks that differ, grown by
one lattice spacing (`heightmapDiffRect`, `core/occlusion/terrain.ts`), not the whole grid; the engine adds
the area its terrain preview of the level drew (§4.6). Wall frames
(`WallFrame`: length, direction, yaw, joint extensions, `profile`) are cached per build context; an
opening's primitives need only its host wall's profile over [0, len], which does not depend on the joint
extensions, so a door toggle builds no joint index.

- `raycast` reports the nearest entry; exact ties (coplanar faces entered at the same t) go to the smallest
  primitive key, so the reported primitive does not depend on grid registration order (edit history).
- Conventions shared with the GPU proxies (`render/occluders`): `OrientedBox.yaw` (and `WallStrip.yaw`) is
  three.js `rotation.y` (`Matrix4.makeRotationY`): local +X maps to world `(cos yaw, 0, −sin yaw)`.
  Heightfield arrays are row-major by z then x: `heights[sz·samplesX + sx]` (world Y),
  `solid[cz·(samplesX−1) + cx]`, same triangle split as `core/scene/heightmap`.
- Primitive keys (stable across rebuilds, whether a wall piece is a box or a strip; `sourceType` in
  brackets): walls `${wallId}` (first full-height piece),
  `${wallId}#after:${openingId}`, `${wallId}#lintel:${openingId}`, `${wallId}#sill:${openingId}` [wall]; closed door
  leaf `${doorId}` [door]; window movement box `${windowId}` [window]; flat-level floor boxes `${floorId}`,
  `${floorId}#k` [floor]; heightmap-level floor heightfield `${floorId}` [terrain]; stairs/ramp rows
  `${connectorId}` / `${connectorId}#k` (row k from the bottom edge) [connector]; pillar `${pillarId}`; prop parts
  `${propId}`, `${propId}#i` [prop]. On heightmap levels a lattice cell is solid when its centre lies in an
  effective floor rect (exact for grid-aligned floors).
- **`WallStrip`** (`shape: "strip"`, `core/occlusion/types.ts`): a wall piece whose top follows a
  piecewise-linear profile. Footprint = the rect `center` ± `halfExtents` (x along the wall) rotated by
  `yaw` exactly like an `OrientedBox`; solid = `bottom` ≤ y ≤ top(lx), lx the local x, top linear between
  `knots` (local x, strictly increasing by ≥ 1e-6 ft, from −halfExtents.x to +halfExtents.x) with world-Y
  `top` values (≥ bottom). It is the union of one convex solid per knot interval (grazing along a knot has
  the heightfields' caveat). Entry test (`stripEntry`): clip the segment to the local box, binary-search the
  knot range it spans, visit those intervals in ray order with an early exit, each tested with
  `core/geometry` `lineConvex`; "contains the start" comes from the same per-interval classification, and
  entries are reported for t ∈ (0, 1) like boxes, so a strip with a constant profile answers exactly as the
  equivalent box. `primitiveTopAt` / `stripTopAt` / `stripMaxTop` binary-search the knots; bounds,
  containment, footprints, `footprintPolygon` and `pushOutOfPrimitive` (nearest of the four sides, the local
  top, the bottom) handle strips like boxes. The world registers a strip only in the cells its footprint
  overlaps, each with the Y range [bottom, highest top over the part of the strip that cell spans]
  (`registerStrip`), and `primitivesEqual` compares knots and tops, so a terrain update marks only strips
  whose values changed. Movement (§5.3): a strip's vertical extent for a swept disc is [bottom, highest top
  over the sweep's local-x span ± the disc radius], so a low wall on a slope is judged by its height where
  it is crossed; the start-overlap exemption uses the span under the start disc only (a rising wall cannot
  be walked through). Rotated strips count as off-grid architecture like rotated boxes. Viewer eyes and
  light origins are pushed out of strips through a side or above the local top, and top probes (§5.2) use
  the local top.

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
stair top) whose vertical extent (a wall strip's: under the sweep, §5.1) overlaps [ground + 0.5 ft step-up,
ground + body height]. A disc, not the
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

**Gridless moves and jumps** (`core/movement/free.ts`). While the DM lets players off the grid
(`GameState.freeMovement`, the host's "Snap players to the grid" switch off; `PlayerView.flags.freeMovement`),
a `move` may carry `end`, the token's exact final point: once the whole path is legal, `checkEnd` requires
`end` to anchor to the last step's cell, have ground, and be reached from that cell's centre (the token's own
position for a path of just its start: a nudge within its cell) by a clear sweep; otherwise the token stops
on the path as usual and the (masked) reason is reported. A `move` with `end` while players are forced to the
grid is refused (`invalid`). Speed counts the grid path (the end is within half a cell of it). A `jump`
(`{tokenId, levelId, x, z}`: offered when no path is found) puts the token there without walking:
ownership and locks as for moves, the point snapped to an anchor unless free movement is on, an enforced
speed limit on the straight grid distance, then `checkJump` (footprint on the grid and grounded, the token's
disc overlapping no movement blocker, with no "already overlapping" exemption); world reasons are masked as
for moves. `smoothPath` string-pulls a path into the polyline a gridless move is drawn and animated along
(display only; pulled segments stay on one level, clear of blockers in the steps' vertical window, grounded
throughout and away from connectors).

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
| `session:{sid}:view:{uid}`   | DM, broadcast                          | that player (active) + DM | HostToClient (incl. `tiles` chunk announcements, §9, and pings, §6.5) |
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
    `${id}@${x},${z}`; openings re-parented (`wallId` = piece, `offset` rebased). Pieces keep the wall's
    `height` and `followTerrain` (memory written before v2 has none: true). A follow-terrain piece on a
    heightmap level also carries `terrainProfile`: the host's base line (world Y) at the piece's
    `wallBaseKnots` (the host `wallProfile` of the remembered wall on the live host terrain, read at
    t0 + u; cached per (heightmap, remembered wall) and shared by all players, and per piece span, so an
    idle refresh sends no patch). The client's `wallProfile` uses it in place of its clipped terrain (§2),
    so its tops and opening heights (door heads, sills, lintels) equal the host's even where it lacks the
    terrain; bottoms may differ (appendix, Known gaps). `src/integration/crossModule.test.ts` runs vision →
    knowledge → filter → `viewToScene` on a bumpy slope and checks that the renderer and occlusion stand
    the player's clipped pieces on the host's tops, door head, sill and lintel (and that without the
    profile they would not). It reveals only the ground along the piece's centreline, which the piece's
    own top already shows. A profile longer than `MAX_TERRAIN_PROFILE`
    (4096 entries: tiny cells and walls far past the grid) is left out, and the client stands that piece
    on its own clipped terrain. Nothing is rebased, and a buried (follow-off) piece is sent like any other.
    Connectors, pillars, props: whole or nothing. Secret doors are omitted unless `revealed[uid]`
    contains them (auto-revealed when observed open, or by `reveal-object`) and then sent as style "wood";
    the host wall renders solid without them.
    Props never carry `blocksMovement` (DM-only); `viewToScene` assumes the `PROP_LIBRARY` default, so a
    client path preview can differ from the host's validation for props whose flag the DM changed.
  - **lights**: static lights from memory with `emitting = (in illuminatingLightIds)`; attached lights only while
    their carrier token is in the view (resolved position, `emitting = on`). Never `attachedTokenId`.
  - **tokens**: controlled + vision tokens always; others only while in `visibleTokenIds`; never hidden. Other
    players' tokens get `label` only; `name/eyeHeight/vision/speed` only for controlled/vision tokens.
    `model` (a `free:<id>` reference, §3) and `imageUrl` (its portrait, e.g. a Token Maker image, §11) are sent
    with every token sent: they are what the token looks like.
    Health (§6.5): exact `hp` only for controlled/vision tokens, others at most their band as `health`
    (none while `hideWounds`); `conditions` with every token sent.
  - **levels**: known levels (any explored cell) + stubs (`known:false`, `name:null`) for levels referenced by a
    sent connector or own token, copied field by field (`playerLevel`), so `terrainEdits` never reaches a
    player (tests check that the serialised view contains neither `terrainEdits` nor `baseChunks`, and that
    a shape edit in a live session reaches players as heightmap chunk diffs only).
    **terrain**: the baked heightmap's chunks overlapping explored cells, samples touching no explored cell
    zeroed. **masks**: perception (current), explored (persistent), sunlit (current ∧ perceived).
  - **table**: chat log and combat as the player may see them (§6.5 "Filter").
  - Wire schema (`playerViewSchema.ts`): walls' `followTerrain` defaults to true (views and saved games from
    before v2), `terrainProfile` is optional, ≤ 4096 finite numbers; remembered walls (`memoryObjectSchema`)
    never hold a profile. `viewToScene` copies both (missing `followTerrain` → true).
- Vision worker contract (`VisionClient`, `net/host/types.ts`): `setScene` / `update(scene, change, stateSeq)`
  advance the worker's revision; `compute(viewerTokenIds, stateSeq)` answers for that revision;
  `probe(scene, change, viewerSets)` evaluates each viewer set on the current revision with `change` taken
  from `scene` (a moving token at an intermediate step) without adopting it, and reports the `stateSeq` it
  was applied to; `pendingProbes` counts queued ones. Two lanes: probes wait until no setScene / update /
  compute is outstanding and run one at a time, so a foreground call waits for at most one probe and a
  flush never queues behind a long path's steps (§5.2 Moves).
- Request rules: ≤ 8 req/s per player (burst 16), one in-flight move (or jump) per token, paths ≤ 256 steps,
  free points (`move.end`, `jump`) finite and within ±20 000 ft.
  Hellos have their own budget (1/s, burst 4; over-budget hellos are dropped and the client retries with
  backoff) and are coalesced, so at most one is queued per player (the latest nonce wins). A request refused
  by the limiter gets a `rate-limited` reply only within 2/s (burst 4); beyond that it is dropped silently, so
  a flood cannot turn the DM's shared 25 msg/s send bucket into replies.
  Door requests: the door must be in the player's current view, a controlled token on its level must be within
  one cell of the door segment, movement not locked; failures reply `"cannot"`; `"locked"` only after the
  adjacency check passes. Players can never unlock.
  Token image requests (`token-image`, §11): ownership first (`not-owner`, as for moves), then the URL must be
  an image in the player's own folder of the token image store (`HostRunnerOptions.tokenImageBase`,
  `core/session/tokenImages.ts`), else `"invalid"`; `null` clears the image. Movement locks do not apply.
- DM edits during a live session: the editor applies immer patches to `GameState.scene`
  (`apply-scene-patches`); play actions (token moves, door/light toggles) are DmCommands and never enter undo.
  Grid resizes remap explored masks; deleting a level drops its masks/memory.
  `levels/<id>/terrainEdits/**` patches are DM-only bookkeeping with no visual effect (the baked result
  arrives as heightmap patches): `deltaFromPatches`, `editor/sceneChange` and `play/host.ts`
  `sceneChangeBetween` ignore them (another level field changed → structure; else the heightmap → terrain;
  else nothing), and an edit made only of them (`onlyTerrainEdits`: a shape renamed, painting under a
  shape) marks no player dirty, does not bump `knowledgeRev` and asks for no early save; nor does it make
  the host drop a move's in-flight step results (`applyKnowledge` compares levels with `sameVisionLevels`,
  which ignores `terrainEdits`). The vision worker never receives `terrainEdits`
  (`net/host/visionProtocol.ts` `visionLevels`).
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
  reads the catalog once per app run; local mode has none. The Token Maker's free parts (`token-bg.png`,
  `token-frame.png` in `token/`) are plain files, not catalog rows (§11).
- Bucket `token-images` (PUBLIC, PNG / WebP ≤ 4 MiB; migration `*_token_maker.sql`): finished tokens at
  `{userId}/{sha256 prefix}.{png|webp}`, so every client at a table loads a token's portrait by URL. Clients
  insert into their own folder only (`private.can_insert_token_image`: well-formed name, ≤ 300 objects /
  200 MB per owner), list and delete their own objects, and never update (content-addressed names).
- `private.image_tool_usage(user_id, day, calls)` — no client access; spent by
  `consume_image_tool_quota(user, anonymous)` (service_role only), which the Edge Function `remove-background`
  calls before every model call: ≤ 10 calls per guest and ≤ 30 per permanent account per UTC day, ≤ 300 per
  day for the whole project (`quota_exceeded`), rows older than a week dropped on the way.

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
  objects;
- `token-images`: ≤ 300 objects and ≤ 200 MB per owner (4 MiB per object);
- image tools (paid model calls): ≤ 10 per guest / 30 per account / 300 in total per day (above).
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

### 6.5 The table: chat, dice, combat, health, pings (`core/dice`, `core/session/table.ts`, `tokenStatus.ts`)

What a group needs around the map, built on the same rules as everything else: the DM's tab is
authoritative, and a player receives only what filter.ts lets through.

- **Dice** (`core/dice`): notation `NdM`, `d%`, keep / drop (`kh`, `kl`, `dh`, `dl`, `k`), exploding `!`
  (≤ 50 extra dice per roll), `adv` / `dis` (2d20kh1 / 2d20kl1), constants and signs, then an optional label
  ("1d20+5 to hit"). Limits (`DICE_LIMITS`): 100 dice, 1000 sides, 12 terms, constants ≤ 10 000. Rolls are
  made **by the host** with `cryptoDiceRng` (crypto.getRandomValues, rejection sampling: unbiased): a player
  sends a formula, never a result, so nobody can pick their own numbers. A `RollResult` keeps every die, the
  dropped ones and the total; `naturalD20` finds the kept die of single-d20 rolls (natural 20 / 1).
- **State**: `GameState.table = {log, combat}` (optional: games saved before it load without one). The log
  keeps the newest `TABLE_LIMITS.maxLog` (200) messages `{id, at, kind: chat | roll | system, from, name,
  color, to, text, roll?}`: `from` is the sender's user id (null: the DM or a system notice), `name` / `color`
  are copied when sent, `at` is the host's wall clock made strictly increasing along the log. `to` is the
  **audience**: `"all"`, or the players besides the sender who may read it (`[]`: the DM only). Players talk
  to everyone or whisper to the DM; the DM also whispers to chosen players or keeps a secret note / roll.
  `combat = {round, activeId, entries}`, entries `{id, tokenId | null (a custom entry: a lair action…), name,
  initiative, modifier, hidden}` in turn order (`sortCombat`: initiative high → low, unrolled last, then
  bonus, then as added). `load-scene` ends combat; `rebind-player` (guest merge) moves a player's messages
  and whispers to the new id; `parseGameState` drops entries whose token is gone.
- **Requests** (`ClientToHost`, strict zod, the sender is the topic's `{uid}`): `say {text ≤ 1000 UTF-16
  units, to: all | dm}`, `roll {formula ≤ 200, to}`, `initiative {tokenId, bonus}` (an integer within ±20;
  only for a token the player owns whose entry is visible and has no initiative yet: the host rolls
  `1d20 + bonus`, a formula it writes itself, stores the bonus as the entry's tie-break modifier and posts a
  public "Initiative" roll, so the bonus is on show like at a real table; a second roll is refused until the
  DM clears the value), `end-turn {entryId}` (only while that entry acts and is a token the player owns, so a
  late or repeated click cannot end the next turn; advances like the DM's Next turn). Reduced by
  `reduceTableRequest` with a `TableContext` (`now`, `newId`, `rng`) from the host. Refusals: `bad-formula`,
  `cannot`, `not-owner`, `invalid`. `say` / `roll` have their own rate on top of the request rate
  (`TABLE_RATE` 2/s, burst 6), so one player cannot flush the shared log at once.
- **DM commands**: `table-post` (the host builds the message: `dmSayCommand`, `dmRollCommand` roll on the
  DM's tab, which is the host), `table-clear-log`, `combat-start` / `-end` (with a `TableStamp` for their
  notices), `-add` (tokens already in are skipped), `-remove` (`removeEntries`: if the acting entry leaves,
  the next one acts, wrapping into a new round with its notice like Next turn), `-update` (initiative,
  bonus, hidden, a custom name; re-sorted), `-turn` (±1; wrapping posts "Round N"), `-set-active`. A map
  edit that deletes tokens removes their entries too (`pruneCombat`, in `apply-scene-patches`; a round it
  starts posts no notice, since reducers make no ids). A hidden token joins as an ordinary entry: the filter
  never sends a token a player cannot see, so its entry appears for them once it is revealed and in view;
  the entry's own `hidden` flag is the DM's way to keep a visible creature out of the order.
  `npcInitiativeCommand` rolls 1d20 + bonus for every unrolled entry no player controls. Table commands mark
  players dirty but never the vision (empty delta).
- **Filter** (`filterForPlayer` → `playerTable`, THE path): `PlayerView.table = {log, combat}`, absent
  when there is nothing to show. Log: the newest `maxViewLog` (60) messages the player may read (`canRead`:
  their own, public ones, whispers to them), keyed by id, each built field by field: `{id, at, kind, name,
  color, mine, dm, whisper, text, roll?}` (the roll copied term by term): **no user id** of anyone. Wire
  objects are cached per (message, reader), so an idle flush compares by identity. Combat: an entry is sent
  only when the DM has not hidden it and it is a custom entry or its token is in this view (controlled,
  seen through, or visible now; never a hidden token), named like the view's tokens (the DM name only for
  tokens the player controls or sees through, else the label); `activeId` only when the acting entry is one
  of those, else null (someone unseen acts). The order therefore never reveals a creature the player cannot
  see. Diff granularity: `table/log/{id}` and `table/combat` (a new message is one op). Views with the table
  still pass the strict `playerViewSchema`; `sceneChangeFromOps` treats table ops as "no scene change".
- **Health and conditions** (`Token.hp`, `Token.conditions`, §3; `core/scene/tokenStatus.ts`,
  `core/session/tokenStatus.ts`): damage spends temporary hit points first and stops at 0; healing stops at
  max; the coarse **band** is `down` (0), `bloodied` (at most half), `wounded` (below max) or `unhurt`
  (temporary hit points do not count). The DM's `set-token-status {tokenId, hp?: TokenHp | null (stop
  tracking), conditions?}` is clamped and normalized (`clampHp`, `normalizeConditions`), a play action like a
  move: empty delta, every player dirty, `origin.dirty` untouched (the map-save prompt does not nag about
  it). Changes made in play are **relative** (`HpChange`: damage, heal, temp (the higher value is kept),
  and for the DM max and `set` (a typed value: only the fields given change); `ConditionChange`: conditions to
  add and remove), applied to the token as the host holds it when they arrive (`applyHpChange`,
  `applyConditionChange`), so a change made meanwhile (the DM's damage while a player adds temporary hit
  points, two quick ticks before the first result is back) is never overwritten. The DM's UI sends
  `change-token-status {tokenId, hp?: HpChange, conditions?: ConditionChange}` (`HostActions.
  changeTokenStatus`; the reducer applies it; hit points only when tracked); only starting / stopping
  tracking uses `set-token-status`. The live "Edit map" inspector does the same through the editor's play
  sink (`store.changeTokenStatus` / `setTokenHp`): play actions with no undo entry, since undoing would
  write a stale value over players' changes; the standalone editor edits them like any field. A player's
  request `token-status {tokenId, hp?: {kind: damage | heal | temp, amount: 1 … 99 999},
  conditions?: {add?, remove?}}` (strict zod: at least one change) is accepted only for a token they own
  (`not-owner`) that players can see (`unknown-token`), and hit points only while the DM tracks them
  (`cannot`); `max` is the DM's alone (the player cannot send it). `GameState.hideWounds` (saved with the
  game; `set-hide-wounds`) turns the bands off.
  **Filter** (`playerToken`): exact `hp` only for tokens the player controls or sees through with shared
  vision (the same "full" set that gets a token's name and senses); every other sent token gets at most its
  band as `health` (none while wounds are hidden); conditions go with every token the player is sent, since
  they show on the token. A hidden or unseen token is never sent, so neither is its health.
  **UI**: health bars under tokens (exact, or the band's colour) and condition icons at their top-right on
  both maps (`TokenBadges`, placed like the turn marker); the hit point editor (damage / heal / temporary,
  Enter damages and Shift + Enter heals; the DM also sets max and starts or stops tracking) and condition
  chips on the DM's token card and on the player's character card; a Conditions submenu in the DM's token
  menu; health bars in the turn strip and the Combat tab; "Show wounds to players" in the Table tab; the
  editor's token inspector sets max, current and temporary hit points and conditions.
- **Pings** (ephemeral, never stored): a player's `ping {levelId, x, z}` (1/s, burst 3, never answered) is
  dropped unless the level is known in the view last sent to them (so pings cannot probe for levels), then
  fanned out as `HostToClient {t: "ping", epoch, ping}` outside the seq order to every other linked player
  for whom `pingForPlayer` (filter.ts) allows it: only on levels they know. The sender's name and colour come
  from `GameState.players`, never the payload. `HostRunner.ping(levelId, point, {focus})` sends the DM's
  (`focus`: clients centre their cameras on it) and `onPing` reports every ping to the DM's UI. Clients
  accept pings of the current wire epoch only, validated by `playerPingSchema`; their own ping is drawn at once.
- **UI** (`components/play/table`): the chat & dice dock (both roles; Enter opens it; `/r`, `/gr` private
  roll, `/w` whisper, `/dm`, bare formulas like `2d6+3`; quick dice; the audience is remembered), the turn
  strip at the top (DM: previous / next; players: roll initiative with a remembered bonus, End turn), the
  host's Combat tab and token menu entries, a turning ring on the acting token (`Engine.tokenDrawnAt` follows
  it mid-walk) and ping rings, placed with `Engine.project` every frame. Pings: hold the left button still
  for `LONG_PRESS_MS` (450 ms) on the map, not on a token you can drag (`PlayController`); the DM's Shift +
  hold is a "look here" ping.

### 6.6 Areas of effect (spell templates: `core/area`, `core/session/templates.ts`, `play/template*.ts`)

The DM and players place spheres, cylinders, cones, lines and cubes on the map and everyone sees who they
catch. What an area reaches comes from the same 3D geometry as vision, so walls, closed doors and floors
stop it: a fireball in the courtyard reaches the edge of the balcony above it, never the room behind the
balcony's wall or the cellar under the paving.

- **Geometry** (`core/area/types.ts`, `shape.ts`): `AreaGeometry {shape, levelId, x, z, elevation, angle,
  size, width, height}`. The point of origin is `(x, ground + elevation, z)` on the level (ground: floors,
  terrain, stairs). Volumes: sphere (radius `size`); cylinder (a disc of radius `size`, up `height` from the
  origin); cone (along `angle`, `size` long, at distance d along its axis d wide, the 5e rule, round about
  its axis); line (`size` × `width`, `width` high, centred on the origin's height); cube (edge `size`, the
  origin at the middle of its near side's bottom edge). Ground-hugging shapes (cylinder, cube) reach down to
  the ground wherever it is below their base (a slope's downhill side). `angle` is radians in XZ: the
  direction `(cos, sin)` in `(x, z)`; round shapes store 0. `normalizeArea` clamps to `AREA_LIMITS` (sizes
  1–120 ft, width ≤ 60, height ≤ 200, elevation ≤ 100) and rounds to 1/1000 ft (angles stay within [−π, π]). `areaOutline` is the
  top-down outline the renderer draws (a cone seen from above is a triangle).
- **Reach** (`core/area/effect.ts` `computeAreaEffect(scene, world, geometry, {tokens, noCells})`): a point
  is in the area when it lies in the volume and the segment from the origin to it is not blocked on the
  **light** channel (what casts shadows: walls, closed doors whose style blocks light, window sills and
  lintels but not the glass, pillars, slabs and terrain, stairs, solid props: the obstructions that give
  total cover). Segments start at the origin pushed out of any light blocker it lies in
  (`resolveLightOrigin`, so an origin on a floor or inside a wall behaves like a light there).
  - **Cells**: on every level, each cell with ground there (`hasGroundAt`) is sampled along its standing
    column, 0.25–5 ft above its ground and 0.25 ft below the ceiling: the column's point nearest the
    origin's height, then its foot, middle and top. Covered when one of them is in the area (the 5e grid
    rule, "a square is affected when the area covers its centre", in 3D).
  - **Tokens**: the columns at the centres of the squares a token occupies (its own centre when it stands
    off the grid and covers none), up to its height. Caught when a point of one is in the area: a halfling
    behind a low wall is spared where a giant is not. `areaAroundToken` centres a carried area on its token
    (round shapes measured from the edge of its space); the play layer leaves the carrier out of what its
    aura catches (the 5e emanation rule).
  - Cost: a 20 ft sphere on the Crooked Lantern ≈ 3 ms, a 150 ft one ≈ 14 ms; on a 120 × 120 grid with three
    full levels a 150 ft sphere took ≈ 115 ms (most rays to the other levels are blocked, so every sample of
    their columns is tried), hence the 120 ft limit and the cache below. A column's heights are tried once
    each, nearest the origin first.
- **State** (`GameState.templates?: AreaTemplate[]`, oldest first): `AreaGeometry & {id, owner (user id |
  null = the DM), label, color, tokenId (carried by that token: position and level follow it), hidden (the
  DM's alone)}`. Each player keeps `TEMPLATE_LIMITS.perPlayer` (6): another one replaces their oldest; the
  game keeps `max` (64). A map edit drops templates on deleted levels or carried by deleted tokens
  (`pruneTemplates`), `load-scene` drops them all, `remove-player` drops the player's, `rebind-player` moves
  them. Saved with the game (`persist.ts`: each template parsed strictly on its own; one that does not parse,
  or of a player who left, or on a missing level, is dropped on load, never the game).
- **Requests**: `template {template: AreaTemplateInput, id?}` places one, or with `id` moves / changes one of
  the sender's own; `template-remove {id}` removes one of theirs (anything else, and a template the DM hid,
  even their own: `cannot`, so a hidden template can be neither brought back nor probed for). A carried
  template needs a token the sender owns (checked before any lookup: `not-owner`) that players can see; a
  standing one a level the sender's last view shows as **known** (like pings, so templates cannot probe for
  levels) and a point within the scene ± `coordMargin` (else `invalid`). The host normalises the geometry,
  cleans the label, keeps a valid colour (else the player's colour) and ignores the payload's position for
  carried ones. `template` shares the table's rate (`TABLE_RATE`) on top of the request rate. **DM commands**:
  `template-set {template}` (add or replace by id, `cleanTemplate`: bounded like a stored one) and
  `template-delete {ids | null}`. Template changes mark every player dirty, never the vision (empty delta).
- **Filter** (`playerTemplates`): a template is sent when the DM has not hidden it and it stands on a level
  the view shows as known, or its carrier is one of the view's tokens (then at that token's position and
  level). Built field by field: `PlayerTemplate = AreaGeometry & {id, label, color, name (the placer's
  display name, "DM"), mine, dm, tokenId}`, never a user id. Diff granularity `templates/{id}`;
  `sceneChangeFromOps` treats them as "no scene change". What an area reaches is **never sent**: each
  viewer computes it from the scene it has (the DM on the whole scene with the host runner's occlusion
  world, `HostRunnerImpl.occlusion()`; a player on the scene built from their view with the planner's
  world), so a player's result uses only geometry they have seen, names only creatures in their view, and
  the host sends nothing more than the template itself.
- **Play** (`play/templateTool.ts` `TemplateTool`, the controller's `"template"` tool, key T): the picker
  (`TemplatePicker`: spell presets from `AREA_PRESETS` (SRD), shape, size, width / height, origin height
  ("auto": aimed shapes 2.5 ft, or half the height of the token they leave from; round ones 0), colour,
  label, "carried by a token") sets the `TemplateSpec`. Hovering shows the area at the pointer. Round
  shapes: press, drag to adjust, release; the centre snaps to grid intersections (Alt: free), a press on a
  token centres it there. Aimed shapes: press at the origin (half-cell lattice; on a token: the edge of its
  space facing the pointer), drag to aim (Shift: 15° steps), release. Auras: a click on a token the user may
  select (or anywhere, for the selected one). Placing returns to the Move tool; Esc leaves the tool.
  `editTemplate(id, spec, angle)` moves an existing one (the draft replaces it until placed).
  `play/templateAreas.ts` `TemplateAreas` lists the templates (`hostTemplateItems` / `playerTemplateItems`)
  with what they reach, memoised: cells per geometry, world and levels, kept when the objects that changed
  (their old and new XZ bounds, `objectBounds`; lights never block) all lie outside the area's bounds, so a
  door toggled across the map recomputes nothing; creatures also per token revision. It builds the engine
  overlays with stable identities. The page computes after layout effects (the planner's world has taken
  the scene by then), and a draft following the pointer at most once per frame.
- **Render** (`OverlayState.templates: TemplateOverlay[]`, `render/overlays/templates.ts`): per template the
  covered squares of every level the plan draws solid, as a translucent fill with a line around the covered
  region (depth-tested with a polygon offset, so tokens, walls and props stand over them), the shape's
  outline draped over its level's ground and a dot at its origin (both drawn through geometry, so the shape
  always reads). Only templates whose overlay object changed are rebuilt; materials are shared per colour.
- **UI** (`components/play/table/TemplateLayer.tsx`, `TemplatePanels.tsx`): chips at each origin (title and
  number of creatures caught; carried ones follow their token as it walks; chips that would overlap stack
  upwards) select a template; rings mark the creatures the selected template, or the one being placed,
  catches. The card lists them (a player's list only ever names creatures in their view) and offers Move and
  Remove to the owner and the DM, and to the DM "Hide from players" and **Roll damage**: one public roll
  ("8d6 Fireball", the host's dice) dealt as `change-token-status` damage to every creature caught whose hit
  points are tracked, halved (rounded down) for those marked as having saved. The template's label is the
  roll's label after a `#` (`damageInput`), so a player's label never extends the formula.
  The host's Table tab counts the areas on the map and clears them all (`template-delete` with `null`).

---

## 7. Editor

- Zustand store `editor/store.ts`: working `Scene` (or, during a live session, a proxy onto `GameState.scene`),
  selection, terrain selection, active level, tool, snap mode, view options. Mutations:
  `editor.apply(recipe, label)` → `produceWithPatches`; `core/history` records `{patches, inversePatches, label}`, supports transactions
  (`begin`/`commit` squash to net patches), caps depth (200).
- Tools implement `editor/tools/types.ts` `Tool`. The canvas builds `ToolPointerEvent`s (engine pick on the active
  level + snapping via core/grid; Alt = free placement) and draws `tool.preview()` via engine overlays.
  Editor picks (the editor viewport and the host's live editor) pass `terrain: true`, the **editor ground
  cast**: wall nodes, shapes and hover markers land where the cursor ray meets the heightmap, floors or not
  (§4.6). Events also carry the pick's `ray`, the canvas-relative position (`canvasX/Y`) and the DOM
  `buttons`; `controller.setProjector` gives tools `ToolDeps.project` (null until an engine exists) from
  `engine.project` with `visible` = `inFront` (in front of the camera, off-canvas points included, so an
  edge with one end off screen stays pickable; `Engine.project`'s own `visible` also requires the canvas,
  for HTML markers; the overlay's gizmo uses the same tools' projection, `Picker.projectForTools`), and the canvas cursor and the options-bar hint come from the active tool when it provides them
  (`Tool.cursor()` / `Tool.hint()`, read through `controller.toolCursor()` / `toolHint()`).
- **Terrain tools** (ToolId `"terrain"`, "Terrain", key T; `editor/tools/terrain.ts` routes to the sub-tools
  in `editor/tools/terrain/` by `toolSettings.terrain.sub`: `select` | `brush` (default) | `block` | `ramp` |
  `cylinder`; pure hit-test / snapping helpers in `editor/terrainMath.ts`). The renderer shows the BAKED
  document terrain; the tool's preview is always a `TerrainOverlay` of the active level's shapes (§4.6), so
  shapes are visible and selectable only in this mode (they are not scene objects: no `selection`, no
  object pick). In this mode the controller shows no object selection or hover, and keys acting on the
  object selection (copy, cut, paste, duplicate, delete, select all, nudge, rotate, Escape) never reach
  `runShortcut`: the tool applies them to its shapes or they do nothing (Escape then returns false, so the
  host can leave edit mode).
  - Gestures are local until release / confirm: the overlay shows the draft or moved shapes, and
    `previewTerrain` gets the lattice re-baked over the previous ∪ current footprint grown by one sample
    spacing, only when the gesture's quantised state changes and not while the footprint touches no floor
    (hint "No floor here: terrain is drawn only under floors"; a null footprint, "nothing changed" as in a
    shape dragged back to its start, only restores what was shown and is not off the floor,
    `ShapePreview.offFloor()`). Each gesture commits ONE `store.applyTerrainEdit` (a `writeTerrain` delta
    built from the current document). After a commit that
    changed the heightmap the preview is left for `updateScene` to replace; a refused or empty commit and a
    cancel clear it. Drags never use `pick.ground` (the preview holds the moving shape): they intersect
    `pick.ray` with the horizontal plane at the grab height (creation: the baked ground under the first
    corner), and events without a ray are ignored. While `buttons & 6` (camera orbit / pan) the height phase
    freezes and re-anchors afterwards. Alt (read from the store's `altHeld`, so a press or release without
    a move counts), snap-mode and terrain-setting changes recompute the gesture from the last event; a click
    that confirms uses that press's Alt.
  - Gesture invalidation: a store subscription cancels a gesture when the active level, the tool or
    sub-tool, `readOnly`, the grid, or the gesture level's `heightmap` / `terrainEdits` / `elevation`
    identity changes (not on other scene changes: the live host re-syncs on every player step). Undo / redo
    during a gesture only cancel it. Read-only: shapes can be selected, nothing else.
  - Brush: paints the BASE (`baseLattice`); the preview shows the baked result of each dirty rect (the bake is
    skipped on levels without shapes); pointerup commits `{base: {lattice, rects: [dirty]}}`. Flatten
    targets the baked height under the stroke start. Strength (`editor/settings` `BRUSH_STRENGTH`): 0.001–0.1 ft
    per dab for raise / lower, 0.001–0.02 blend per dab for smooth / flatten, default 0.01 (dabs every
    quarter radius, so a stroke applies many). Hint: "The brush paints the ground under shapes; use
    Apply to terrain to sculpt a shape".
  - Block / ramp / cylinder (Blender-style creation): press and drag the base on the plane through y0, the
    baked ground under the snapped first corner (block / ramp corners snap like floor edges, the cylinder's
    centre with the snap mode and its radius to half cells, min 0.25 ft; Alt = free; a click makes a
    one-cell base or a half-cell radius; rects are clamped to the extent, cylinders kept inside the extent
    ± 50 ft). Release starts the height phase: the height follows the cursor relatively, 0 at the release
    (`core/geometry/gizmo` `heightFromPointer`: h = h_ref + dot(c − c_ref, u)/k with u the on-screen
    direction of world up at the anchor and k = max(|up axis|, 0.25 × px per foot sideways) px per foot,
    re-anchored when zoom, pan or orbit change the projection; with `screenUpWhenFloored`, used by creation,
    u is screen up whenever k is at that 0.25 floor, since world up then projects short and, in a
    straight-down perspective view, radially from the screen centre), snapped to `heightStep` (default
    0.5 ft; Alt or free snapping: 0.01) with a label ("+7.5 ft · Add" / "−3 ft · Carve") at the draft's
    corner, or, while the floor is active (`HeightFollowState.upPx` < k: the corner lags the cursor), on the
    last pointer ray at the draft's height (redrawn on every move there, sideways too). A left click or
    Enter confirms (the sign picks add / carve; 0 cancels), right-click or Escape cancel. A ramp rises along
    the dominant drag axis (with hysteresis), fixed at the release; R / Shift+R turn it ±90° during the
    height phase.
    Cylinders have `cylinderSides` (6..64, default 24). The new shape (order = max + 1) is selected and the
    sub-tool stays.
  - Polygon: the base phase is a points phase. Each click places a corner (snapped like block corners, Alt =
    free) on the plane through the ground under the first one; a corner whose edge would cross the chain is
    refused with a notice, Backspace / Delete removes the last corner (the last one ends the gesture).
    Right-click, Enter, a double-click or a click on the first corner (same snapped point or within 10 px)
    finish when there are ≥ 3 corners and the closed outline is simple, and the height phase follows,
    anchored at the corner nearest the pointer. The overlay's `outline` draws the chain and the pending
    corner with dots, the closing edge dimmed (red while it would cross), a zero-height fill once the outline
    closes, and the pending edge's length. Idle, a dot shows where the first corner lands. Its keys float
    next to the cursor (`Tool.cursorKeys` → `EditorController.toolCursorKeys` →
    `components/editor/CursorKeys`, mounted in the editor and host viewports: rows of mouse input and keymap
    commands shown with their current keys, placed by writing a transform on pointer moves, flipped left
    near the right edge, hidden off the canvas).
  - Loop cut (`terrain/loopcut.ts`, Shift+C): hovering a shape picks an edge (over the top: the edge, outline
    or inner, of the top face under the pointer nearest to it, preferring edges a ring runs through; over a
    side face: that side; else an edge near the pointer on screen) and previews the cut along its ring, so a
    second cut crosses the first (left to right, then top to bottom) (`TerrainOverlay.cuts`, element
    colour, red with a reason in the hint where there is no loop, too many vertices or the cut would leave
    the shape) with a label ("5 | 15 ft", or "3 cuts"). One cut follows the pointer along the side, snapped
    to eighths (Alt / free snapping: free); `loopCuts` (options bar "Cuts", 1..16; [ / ] step it while the
    loop cut is active, the `brush-size` action) spaces several evenly. A click commits ("Loop cut terrain
    shape", one undo step) and leaves the new inner edges selected in the advanced edge mode (shown in the
    loop cut too), ready to raise with Select. Delete on selected inner edges removes them ("Remove terrain
    loop cuts"). Keys float next to the cursor while a cut is possible.
  - Select, object mode: click selects (Shift / Ctrl toggles; shapes are hit by ray, nearest first), a
    click on nothing clears, a drag on nothing marquee-selects in screen space, a press on a shape selects
    and drags it. A press without Shift / Ctrl on an already selected shape keeps it when it is, in this
    order, the front candidate under the cursor, a pit whose floor is under the cursor (`ShapeHit.onGround`:
    a carve hit within 0.5 ft of the terrain pick, though the top of the shape it carves is hit first), level
    with the front candidate (same side of the terrain, same ray parameter: coplanar tops, which the hit
    order only breaks by id) or the one the click cycle reached at that spot (`heldCandidate`, `terrainMath`
    `cycleCurrent`; a buried one cycled to, never a selected one merely somewhere under a visible
    unselected shape, which the press takes), so a press-drag moves the selection; only a click (released
    without a drag) cycles on to the next overlapping shape at that spot (which also narrows a
    multi-selection), and a drag starts a new cycle. Hover shows what a press would take (that held
    candidate, else the nearest). The selection moves on the plane at the grab
    height, snapped by an anchor (the grabbed shape's first vertex, edge snapping; a grabbed cylinder's
    centre (mean of its points) with the plain snap mode, as at creation; Alt free); offset components
    below 1e-9 ft are 0, so a drag that stays in (or returns to) the anchor's cell commits nothing. The
    gizmo (hit first) and X / Y / Z (toggled during a drag) constrain to an axis; Y moves tops and base
    together, snapped to the height step, following the cursor like the height phase (`heightFromPointer`
    from the press): on the drawn Y handle u is the handle's direction, toggled by key it is screen up
    while k is at the floor. A drag on the rotate ring turns the selection about the vertical axis through
    the gizmo centre (`terrainShapes` `rotateShape`) by the pointer's angle on the ring's plane since the
    press (`ringAngle`, +Z towards +X, the sense of R's quarter turns), in 15° steps (Alt or the free snap
    mode: free; quarter turns exact), labelled "+45°"; X / Y / Z do nothing while rotating; one undo step
    ("Rotate terrain shape(s)"). In advanced mode it turns the selected elements' vertices about their
    centroid (refused when the footprint would fold). Delete; Mod+D duplicates
    one cell away (new orders); Mod+A selects the level's shapes; arrows nudge one cell (Shift: 1 ft),
    coalesced in history like object nudges; R / Shift+R rotate ±90° about the selection's `boundsPivot`
    (the `rotationPivot` rule; a lone cylinder about its own centre).
  - Select, advanced (edit) mode (`toolSettings.terrain.advanced`; effective, `editMode` in
    `tools/terrain/context.ts`, only in the select sub-tool with shapes of the active level selected, so in
    the other sub-tools delete, nudge, rotate, duplicate, select all and Escape act on whole shapes; Tab
    toggles the effective mode, and from another sub-tool always switches to Select in advanced mode; 1 / 2 /
    3 pick vertex / edge / face, switching to the select sub-tool; a Tab key without a shape selection is left
    to the browser's focus navigation, while the options bar's Advanced switch then shows a hint): the
    selected shapes show their elements; vertices and edges are hit in screen space within 8 px
    (`ToolDeps.project`), faces by ray; Shift toggles; a press keeps a selected element and a click cycles,
    by the same rule as shapes (level: coincident vertices / edges at the same distance); another shape
    counts only as the front shape under the cursor (`otherShapeInFront`; a pit whose floor is under the
    cursor is in front of the shape it carves, and none counts when an edited shape is level with it or is
    such a pit): Shift / Ctrl+click on it adds it to the edit session (the element selection
    stays), a plain click selects it alone, while a plain click on an edited shape away from its elements
    clears the element selection even with another shape under it (hover shows no shape there); a marquee
    selects elements and Mod+A all of the current kind; a drag on a selected element moves the selection
    (one vertex: absolute edge snapping; else by anchor), Y moves top heights only (bottom edges: the base); a move that would make a
    shape invalid (not simple, flipped) is refused and the drag keeps its last valid state. Delete dissolves
    vertices or collapses edges (a shape keeps ≥ 3 vertices; selected inner edges are removed instead,
    bottom edges collapse the top edge above them, side edges dissolve their corner); face
    mode deletes nothing (hint). The gizmo
    appears only with elements selected (at their centroid) and never when read-only.
  - Escape order in Select: gesture → elements → advanced mode → shape selection → false. In the other
    sub-tools one Escape (after the gesture) clears the shape selection, and with it the advanced flag.
  - Store: `terrainSelection: {levelId, shapeIds, elements} | null` lives beside `selection`. Missing ids are
    dropped on every commit and `syncScene` (never cleared wholesale; identity kept when nothing is missing);
    it is cleared on an active-level change, a new / loaded / restored document and when the terrain tool
    is left, and `toolSettings.terrain.advanced` resets when it empties. Terrain actions, each one undo
    step, false when refused (read-only, unknown level, `writeTerrain`, `validateEdit`) or when nothing
    changed: `applyTerrainEdit(levelId, edit, label, {coalesceKey?})`, `enableTerrain`, `clearTerrain`
    (heightmap null, `terrainEdits` removed), `flattenTerrain` (base 0 over the extent, shapes kept; false
    when `hasPaintedBase` is false, even where shapes raise the terrain), `clearTerrainShapes`,
    `setTerrainResolution` (`resampleTerrain`, written key by key), `applyTerrainShapes` ("Apply to
    terrain": `applyShapesEdit`, so the older shapes under the selection are applied too; the undo label
    counts every applied shape, "Apply 2 shapes to terrain"). `updateGrid` crops with `cropTerrainToGrid`
    only when the width or depth changes, key by key (a shape left beyond the new extent ± 50 ft makes the
    guard refuse the edit). `LevelUpdate`
    excludes `heightmap` and `terrainEdits` (`updateLevel` also strips them at runtime), so every terrain
    write goes through these actions and `writeTerrain`.
  - UI: the options bar holds the sub-tool picker, the brush settings, the height step and cylinder sides, and
    in the select sub-tool the Advanced switch and element picker (both run the same actions as Tab and 1 / 2
    / 3), plus the tool's phase-aware hint. The Levels panel enables / removes terrain, sets the resolution,
    flattens the painted ground (shapes stay; enabled only when `hasPaintedBase`, else the tooltip, on a
    span around the disabled button, says it is already flat; the height-range hint adds "(shapes only)"
    when only shapes raise the terrain) and deletes a level's shapes, all through the store actions. In
    the terrain mode the Inspector shows the shape selection (`panels/TerrainInspector`: name, add / carve,
    top (moves every top vertex), base, bake order (bring forward / send backward), vertex count, a warning
    for shapes with fewer than 4 lattice samples inside, the selected-elements hint ("2 vertices selected:
    drag them in the viewport; Delete dissolves vertices") only while the advanced mode is effective
    (`terrainMode.ts` `editedTerrainElements`, the tool's `editMode` test), Apply to terrain, Delete; several
    shapes: count, add / carve, Apply, Delete; Apply names the older shapes it also bakes, before as a hint
    and after as a toast, `terrainInspect.ts` `alsoAppliedShapes`), each edit one `applyTerrainEdit`
    (`applyInspectorTerrainEdit`: its own "Can't …" toast only when an upserted shape is invalid; an edit that
    changes nothing, like a rename to the same name, is silent), and "the selection" of menus, page handlers
    and the status bar is the shape selection (`components/editor/lib/terrainMode.ts`): Edit-menu commands and
    Delete run through `controller.keyDown` (the tool's key path), focusing frames the selected shapes, and
    cut / copy / paste are off (shapes are not on the clipboard).
- Walls on terrain (§2): `toolSettings.wall.followTerrain` (default true; the wall tool's "Follow terrain"
  switch) sets new walls' `followTerrain`; the Inspector has the switch per wall and for a selection of
  walls, and warns (`components/editor/lib/terrainInspect.ts` `wallTerrainWarning`) when a follow-off wall
  is buried where the terrain rises above its base, or the terrain lifts a follow wall's top through the
  level above: max top − max(top of that level's floor (`above.elevation`), elevation + height) ≥ 0.05 ft
  (a storey-high wall on flat ground does not warn; for a wall no taller than the storey, lowering it by the
  reported amount clears the warning). The segment preview draws the conforming wall and the opening
  preview uses its host wall's option; the wall tool's hover marker sits on the picked ground. The light
  tool mounts a light `presetHeight` above the wall's base line at the mount point (`wallMountHeight`), at
  least 0.5 ft above that base and the ground there and 0.5 ft below the top.
- Integrity (`core/scene/integrity.ts`): `deleteWithDependents`, `copySelection` / `pasteClipboard` (fresh ids via
  idMap, remap level by relative order (`AtlasClipboard.levelOffsets`), drop orphan openings or re-host them on
  the wall under the pointer (`opts.hostWallId`, placed via `openingCenters`), connector target = level above,
  detach lights whose token wasn't copied), `reprojectOpenings`, `splitWall(draft, wallId, distance)` (for a future wall-splitting tool; no editor tool calls it yet),
  `validateReferences`. `deleteWithDependents` allows deleting the last level; `removeLevel` in the store keeps
  at least one.
- Document guard (`editor/validate.ts`): `apply()` validates what each edit's patches touched (touched objects /
  tokens plus their host walls, openings and carriers, all levels with their terrain only where touched;
  everything after a grid change) with the strict schema and `validateReferences`, and refuses the edit
  (`[]` / `false`, reason in `lastRejected`) if the document would no longer load: e.g. content dragged, nudged or pasted beyond the extent
  ± 50 ft, a grid shrunk under objects or terrain shapes, out-of-range numbers or strings. Terrain is
  checked where the patches touched it: touched heightmap chunks (NaN / range guard; every chunk when the
  heightmap or the level is replaced wholesale), touched shapes and base chunks with the level's shape /
  point counts (every one when `terrainEdits`, the level, the root or the grid is replaced; every base
  chunk when the heightmap is replaced, since base chunks use its resolution); untouched terrain is left
  out of the probe. The paste probe (`editor/clipboard.ts`) likewise drops terrain.
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
  dialogs or menus. Navigation keys stay with a focused widget (`editorMayHandleKey`; Tab too, so the
  terrain tool's Tab never steals focus navigation from a focused control, and the tool also leaves Tab
  to the browser when no shape is selected). The default is prevented only
  when the handler used the key. Propagation is never stopped. `useEditorHotkeys` (editor
  page and the host's live editor) hands the matched action to `controller.keyDown(e, action)`: the
  active tool sees the key first, with the action as `ToolKeyEvent.action` (tools match actions, so
  remapped keys work), then `runShortcut`. Tool-only actions (`confirm`, `terrain-advanced`,
  `terrain-element`, `axis`) do nothing in `runShortcut`, so an unused key keeps its browser default.
  Commands may declare `repeat: false` (fire once per press). The "Terrain" group: Q select, Shift+B brush (B toggles dark vision), Shift+C loop cut,
  E block → ramp → cylinder → polygon (from another tool it re-enters the last creation sub-tool), Tab advanced mode,
  1 / 2 / 3 element kind, X / Y / Z axis constraint (all but Q and Shift+B without auto-repeat); Enter confirms a
  shape's height (`confirm`). Alt for free placement comes from the library's key-state tracker. Map views turn off the theme provider's "D" hotkey
  (`useSuppressThemeHotkey`), because D pans the camera there. W A S D are the cameras' own held-key pan
  input in every map view (the editor keeps arrows for nudges), so the dialog refuses them for editor commands
  and saved editor remaps drop them. Menus, tooltips and hints show the
  current keys (`useCommandLabel`, `CommandKbd`).

---

## 8. Play mode

- Player: select a controlled token; drag shows a path (A* over legal steps, core/movement) with ruler (feet,
  diagonal rule); release sends `move`. RTS-style move commands do the same for the selected token without
  grabbing it: hold the right button to preview the move to the pointer, release to commit, left-click or
  Esc meanwhile to cancel (players' right-drag camera pan then needs no token selected, or the middle
  button; the DM's right-click on a token still opens its menu). With Alt held, moves go off the grid: the
  DM's drops land exactly under the pointer, and players' moves (only while the DM allows free movement,
  §5.3) end exactly there along a string-pulled route. A move with no path is drawn in the error colour and,
  released, is **stranded**: its line and ghost stay and a card at the target (`components/play/StrandedMove`)
  offers "Jump there" (a `jump` request, §5.3), or explains that something the player knows of stands there.
  The pending path is an overlay only; the token moves when the patch arrives, then **walks** there
  (`render/engine/tokenMotion.ts`: constant speed with eased ends, ≤ 2.4 s, following the ground) along the
  route from `Engine.setTokenRouter`: `play/routes.ts` `tokenRouter` uses the route this client sent the move
  along (`SentRoutes`, up to where the host stopped it), else reconstructs one with the client's own planner
  (`MovePlanner.route`: A* on what this client knows; nothing about the real path is sent). Without a route a
  token glides straight up to 40 ft on one level, else jumps. Only the token's figure walks: vision, fog and
  the lights a token carries take its new position at once. Tokens a player sees move (other players', the
  DM's) and every move on the DM's screen are routed the same way. Move paths are drawn as bold lines on a
  dark casing, draped over the ground (`drapeRoute`), with an arrowhead and dots at the grid steps
  (`RulerOverlay.kind` "path" / "blocked"; the Measure tools keep the slim "measure" ruler). Drags target the token's view level (`tokenViewLevelId`, §2), and a drag aimed at the cell just
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
- The table (§6.5): Enter opens the chat & dice dock; holding the left button still on the map (move tool,
  not on a token you can drag) pings the spot, and the DM's Shift + hold makes every player look there.
- Areas of effect (§6.6): the Area tool (T; players and DM) places spell templates from a picker of presets
  and shapes; chips on the map open a template's card (the creatures it catches, Move / Remove; the DM also
  hides it and rolls its damage).
- Play keys: `usePlayKeys` registers `PLAY_COMMANDS` (host-only commands, level switching and vision preview,
  only for the DM). WASD / arrow panning is the top-down camera's own held-key input and is not remappable, so
  the dialog refuses those keys for play commands.
- DM play controls: lock/unlock movement (global and per player), shared vision toggle, enforce speed, snap
  players to the grid (`set-free-movement`: off lets players move off the grid with Alt, §5.3), door and
  light toggles, sun/moon on/off (scene patch), move any token, hide/reveal tokens, reveal secret doors, assign
  tokens to players, preview any token's vision, kick players, and run combat (§6.5: the Combat tab, the
  turn strip, "Add to combat" in the token menus).
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

## 11. Token Maker

A tool of its own at `/tokens` (the header's "Token maker" tab; lazy route, no three.js): layer a
background, character art and a frame, mask them into a round token whose character can break out of the
frame, remove a picture's background with an image model, download a PNG, or put the token on a character
of a game that is open in another tab. Everyone can use it: players for their characters, DMs for NPCs and
monsters, anyone for fun. The play space stays untouched: the host console's "Token maker" button and the
player HUD's (session chip, character card) open it in a NEW browser tab (`openTokenMaker`,
`?session=<id>&token=<id>`), so the game keeps running.

**Designs** (`core/tokenMaker`, pure, tested). A `TokenDesign` is `{version: 1, radius, layers}` in canvas
units: the output square is [0, 1]², y down; the token disc is centred with radius `radius` (the frame's
opening). A layer has a source (an image by id with its pixel size, or a solid fill), a transform (centre,
displayed width `scale`, clockwise rotation, horizontal flip), opacity, visibility and a mask:
`shape` (`none` = whole canvas, `disc` = the disc grown by `grow`), `popOut` (disc layers: everything above
the disc's centre line, as wide as the disc, shows too) and painted strokes (round brush, `reveal` adds,
`hide` removes, applied in order). Edits are immutable functions (`addLayer`, `moveLayer`, `setTransform`,
`setMask`, `addStroke`, `zoomLayerAt`, `pickLayer`…) with budgets (`TOKEN_LIMITS`: 12 layers, 500 strokes /
40k stroke coordinates per layer, brush and scale ranges); `parseTokenDesign` validates a saved design
strictly. `detectFrameOpening(rgba)` measures a ring's hole: the median over 72 rays from the centre of the
distance to the first ≥ 50% opaque pixel (studs and gaps do not skew it); null without an opening or a ring.
`radiusForFrame` turns it into the disc radius when the frame is centred.

**Compositing** (`src/tokenMaker/render.ts`, Canvas 2D, the same code for the stage, downloads and game
images). Per layer, bottom to top: its content on a scratch canvas, cut by its mask. A disc layer that
breaks out (pop-out or reveal strokes) is split: what lies outside its disc, in its pop-out region or under
a reveal stroke is drawn in a second pass above every layer, the rest in place. So the default stack
(backdrop, character, frame) keeps the character inside the ring and under its inner shadow, while a head
breaking out of the ring, or a revealed shield, lies over it in one piece.

**Editor** (`src/tokenMaker/store.ts`, zustand; `components/tokenMaker`, `routes/TokenMakerPage.tsx`).
Undo keeps design snapshots (≤ 100; commits sharing a key within 800 ms, a drag or a slider, are one step).
Images are imported at ≤ 2048 px (`images.ts`), kept as blobs beside the design and decoded once
(`ImageCache`; alpha maps for click-through picking: clicks pass the ring's transparent hole). The stage is a
clipped viewport (`tokenMaker/view.ts`: zoom 0.25–8× about the pointer with the wheel, the zoom
buttons or `=` / `-` / `0`; pan with Space+drag or a middle-button drag), so a layer's outline can reach past
the token without covering the page. Drag moves the selected layer, Ctrl/⌘+wheel (or a pinch) scales it
about the pointer (or sizes the mask brush while painting), Shift+wheel rotates it. A floating toolbar above the token holds Move and the Mask group: Reveal / Hide paint
the selected layer's mask (with a faint ghost of its hidden parts), and the brush size follows the editor
keymap's `brush.smaller` / `brush.larger` (`[` / `]`, remaps included), like the terrain brush. New layers go by role: backgrounds at
the bottom (disc grown 0.02 to reach under the ring), frames on top (unmasked; the disc is fitted to their
opening), character art under the topmost frame (disc). The design and its images autosave to IndexedDB
(`draft.ts`, key `token-maker:current`) and come back on reload; a fresh page starts from the free parts.
Free parts: `token/token-bg.png` and `token/token-frame.png` in the public `free-assets` bucket
(`FREE_TOKEN_PARTS`, `FreeAssetsRepo.tokenParts()`; not catalog rows: they are not loaded into games).
Downloads are PNGs at 256–2048 px.

**Background removal** (model-agnostic). The client (`net/imageTools.ts`) only sends the image and its
size and gets a transparent PNG back; which provider and model run is server configuration.
`supabase/functions/_shared/imageModels.ts` (runtime-agnostic: fetch, FormData, Blob) defines
`BackgroundRemovalModel` and the providers (`IMAGE_MODEL_PROVIDER`, default `openai`: OpenAI's Images edit
endpoint with `OPENAI_IMAGE_MODEL` = `gpt-image-2.5-sunburst`, `background: "transparent"`,
`output_format: "png"`, quality `high`, an output size with the input's aspect ratio, and a one-line
prompt). It runs in the Edge Function `remove-background` (Cloud: the caller's JWT, then
`consume_image_tool_quota`, then the model) and, under `npm run dev`, in the dev server's
`POST /api/image-tools/remove-background` (`dev/imageToolsApi.ts`, key from `.env.local`, no quota). The dev
client tries the dev endpoint first and falls through to the Edge Function when it is not configured.
Provider keys are server secrets only, never `VITE_` variables. The result replaces the layer's image in
place (same centre and width, one undo step) and turns the layer's pop-out on.

**Games** (`net/tokenMakerLink.ts`). The Token Maker never joins a session. Game tabs of the same browser
(the host console, a player's table: `components/play/useTokenMakerLink.ts`) announce themselves on the
BroadcastChannel `atlas-vtt:token-maker:v1` with the tokens their user may re-skin (DM: all; player: the
controlled ones) and whether they can apply now; they re-announce every 10 s and say "gone" on close, and
the Token Maker forgets tabs silent for 25 s. Every message is zod-validated. Applying: the Token Maker
renders the token at 512 px (WebP, PNG fallback), stores it in `token-images` (`net/tokenImages.ts`,
content-addressed, so re-applying stores nothing new) and asks the chosen tab to put the public URL on the
token: the DM's tab checks that the URL is the DM's own token image and makes the scene edit
(`setTokenImagePatches`, like a model change; marks the map dirty); a player's tab sends the `token-image`
request (§6.2), whose verdict it relays. The host authorises every player request itself; the link grants
nothing. The token's `imageUrl` is the portrait the renderer draws on the token (`render/engine/portraits`,
circle-cropped) and every avatar shows. Local mode has no token image store: download only.

---

## Appendix: Implementation status (2026-09-23)

Everything above is implemented, except for the known gaps and deliberate limits listed at the end of
this appendix. Final verification of the tree after the wave-4 fixes (before the terrain tools and walls on
terrain, whose note follows the review-fix lists): `tsc -b --force` (0 errors),
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

**Token Maker (2026-09-24).** `tsc -b`, `npx vitest run` and `npx eslint .` pass. Chromium (Playwright) against
the Vite dev server in local mode with a mock of OpenAI's Images edit endpoint (`OPENAI_BASE_URL`): adding a
frame fits the disc to its opening, character art lands under the frame, background removal sends
`gpt-image-2.5-sunburst` / `background: transparent` / `output_format: png` / a matching size and replaces
the layer's image with pop-out on, zooming and dragging break the head out over the ring in one piece, a
reveal stroke brings a shield over the ring, undo / redo, reload restores the draft, the PNG download, no
console errors, no horizontal scroll at 390 px. Not run from the development container (no network access
to them): the SQL tests `supabase/tests/token_maker_test.sql`, the Edge Function `remove-background`, the
real OpenAI endpoint, and applying a token to a Cloud game (the request path is covered by
`net/player/hostIntegration.test.ts` over the local transport, the tab link by `net/tokenMakerLink.test.ts`).

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
  terrain (since replaced by the host's `terrainProfile`, §6.2); `groundIndex` for per-point ground queries (§2).
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

**Terrain tools and walls on terrain (2026-09-24)**. The terrain brush became the terrain editing mode with
block, ramp and cylinder shapes created Blender-style, a select sub-tool with an advanced vertex / edge /
face mode and a translate gizmo; shapes are editing data baked into the heightmap (scene schema v3, §3
"Terrain edits", §4.6, §7). Walls got `followTerrain` and a shared base-line profile that replaces the
midpoint rule (§2 "Walls on terrain"), with the `WallStrip` primitive for sloped pieces (§5.1); the filter's
piece rebase became the host's `terrainProfile` (§6.2); the editor casts the pointer onto the terrain; the
top-down camera no longer clips high terrain (§4.5). What the implementation reports state was verified:
the unit tests of each area (the pure `core` modules with property tests of the bake invariant against a
from-scratch rebuild, profile tops against `levelGround` + H, strip entries against boxes and brute-force
marches, host → player tops and openings on bumpy terrain, a v1/v2 → v3 migration from a JSON literal, the
serialised player view free of terrain edits); the occlusion and vision perf variants with terrain and
follow walls (PERFORMANCE §11 and "Measurement"); a render check against a dev server in headless Chromium
(walls following ridges, valleys and slopes, a wall chain with one continuous top, doors seated on the
ground, the top-down black trapezoid gone); and the terrain overlay's shaders compiling without console
errors in the editor's post pipeline. `src/integration/crossModule.test.ts` gained the walls-on-terrain
oracle, a terrain-walls fixture, the host → player profile check and a live terrain-shape edit, and
`e2e/editor-smoke.mjs` steps for a block drawn Blender-style, shapes baked outside the tool, the
Inspector, Tab and a wall's Follow terrain switch. Three review rounds (code by area, a real-browser pass,
each finding verified independently) found and fixed 35 issues, among them the in-place terrain commit
path, preview lighting and the Apply-to-terrain closure. Final verification of the merged tree
(2026-09-24): `tsc -b` 0 errors, `eslint .` clean, `npx vitest run` 142 files / 1819 tests pass (the 4
live Supabase files skipped); on a Vite dev server in headless Chromium (NVIDIA through WSL d3d12):
`editor-smoke` 55/55, `keybindings` 30/30, `host-save-map` 12/12, `multiplayer-local` 54/54 on the
Crooked Lantern, on a freshly built v3 Vineyard and on a v1 Vineyard export (migrated on load),
`vineyard-build` 23/23; a walls-on-terrain script (follow walls 10.000 ft above the ground at every
drawn vertex; a wall aimed on floorless terrain from a low camera lands where aimed); a real-mouse pass
of block, ramp and cylinder creation, move, vertex editing with the gizmo and baking outside the tool,
without console errors. The perf-script table above was not re-run for this feature.

**The table: chat, dice, combat and pings (2026-09-24)** (§6.5). Chat with whispers, host-rolled dice,
an initiative tracker and pings for the DM and players, filtered like everything else. Unit tests: the
dice grammar, limits, keep / drop / explode and the crypto RNG's uniformity (chi-square); the table
reducers (audiences, bounded log with increasing times, turn order and rounds, initiative and end-turn
authorisation, DM builders); the filter (no user id in any view, whispers only to their readers, hidden
and unseen combatants never sent, the acting entry masked); strict view and saved-game schemas; one diff op
per message; host runner integration over LocalTransport (readers, the chat rate, pings only to players
who know the level and never back to the sender, combat through requests, the table across a host
restart); the player client (requests, result kinds, pings in and out); long-press pings in
`PlayController`; the chat model (slash commands, whispers by name). The same-browser lock test now uses an
in-memory Web Locks fake where the runtime lacks `navigator.locks` (Node 22), so it passes on every
supported Node. Final verification (2026-09-24): `tsc -b` 0 errors, `eslint .` clean, `npx vitest run`
148 files / 1921 tests pass (4 live Supabase files skipped); on a Vite dev server in headless Chromium with
SwiftShader (`ATLAS_CHROMIUM` + `ATLAS_GPU=swiftshader`): `table-local` 27/27 (new), `multiplayer-local`
54/54, `keybindings` 33/33, `host-save-map` 12/12. `editor-smoke` fails the same three wall / door steps
on this branch and on `master` there (SwiftShader only; not a regression). The Supabase scripts and the
GPU runs were not repeated.

**Token health and conditions (2026-09-24)** (§3, §6.5). Hit points, temporary hit points and conditions
on tokens (scene v6: v5 on its branch, renumbered at the merge after the loop cuts' v5), editable by the DM
(token card, token menu, editor) and by players for their own characters, with bands for everyone else. Unit tests: damage / healing / max changes / bands and condition
normalization; the v5 → v6 migration; the filter (exact numbers only for controlled and shared tokens,
bands otherwise, none when wounds are hidden, conditions for whoever sees the token, strict view schema);
the DM command (clamping, a play action) and the player request (own tokens only, hit points only when
tracked, max stays the DM's), wire and saved-game schemas; the token menu's Conditions submenu. A review
found that player changes carried absolute values built from the player's last view, so two quick changes,
or a player's change racing the DM's, lost one of them; changes are now relative and applied on the host
(regression tests: two stale condition ticks both count, the DM's damage survives a player's temporary hit
points, two quick damage entries both land; the client's wire shape). A second review found the same loss
through the live "Edit map" inspector, whose health fields were undoable edits of whole values: they are now
play actions (`change-token-status` through the play sink; test: the store sends commands and records no
undo step in a live session, and edits with undo standalone). Final
verification (2026-09-24, after both reviews' fixes): `tsc -b` 0 errors, `eslint .` clean, `npx vitest run`
1943 tests pass (4 live Supabase files skipped); `table-local` 35/35 on SwiftShader, with a step where the DM tracks a character's
hit points from the token card, the player takes damage and goes prone from the character card, players see
only a creature's band (and none once wounds are hidden), and the leak scan also looks for that creature's
hit points in every frame and stored view.

**Areas of effect (2026-09-25)** (§6.6). Spell templates for the whole table: five shapes and SRD spell
presets, what each area reaches computed in 3D by every viewer from the geometry it has (walls, closed doors
and floors stop it), covered squares on every level, the creatures caught, auras carried by tokens, and
the DM's damage roll from a template's card. Unit tests: the shapes' volumes and outlines, covered squares
(the 52-square 20 ft sphere, walls, low walls against small and tall creatures, closed and open doors,
cones and lines, the cellar under a fireball, a balcony over a courtyard, a sphere in the air), large
creatures by the squares they occupy; the requests (known levels only, carried by one's own tokens, one's
own templates only, the per-player limit), the DM commands, pruning after map edits and player changes,
the filter (known levels, carriers in view, never a hidden template or a user id, strict view schema),
diffs, persistence and the wire; the renderer's overlay (cells on shown levels, region boundary,
rebuilding only what changed); the Template tool (snapping, aiming from a token's edge, auras, moving,
Escape) and the area cache (recomputed only when something within reach changes). A review found that an
aim due west was rounded past π and made the saved game unloadable, that a player could move a template
the DM had hidden back into view, that a template's label could extend the DM's damage formula, and that
a large area was recomputed on every door toggle anywhere; each is fixed with a regression test (angles
stay within [−π, π] and a template that does not parse is dropped rather than failing the load; hidden
templates are `cannot` for their owner; the label follows a `#`; cells are kept while objects change out
of reach, and the largest area is 120 ft). Final verification (2026-09-25, after the review's fixes):
`tsc -b` 0 errors, `eslint .` clean, `npx vitest run` 2084 tests pass (4 live Supabase files skipped); on
SwiftShader `templates-local` 30/30 (new), `table-local` 35/35 and `keybindings` 33/33.

**Terrain review fixes (2026-09-23)**, each with a regression test that fails on the previous code:
- Document: "Apply to terrain" bakes the downward closure, so the terrain no longer changes (§3, §7);
  footprints with a vertex on an ear's diagonal are triangulated whole (§3); follow walls no longer sink
  just inside the lattice's low edge (§2).
- Editor: press-drag keeps a selected shape or element and only clicks cycle; the advanced mode is effective
  only in Select; Tab without a selection is left to focus navigation; cylinders snap and turn about their
  centre; height follows screen up where world up is foreshortened, with the label at the cursor; a gesture
  follows Alt pressed or released without a move; the hint comes back after a commit; a drag back to its start
  no longer says "No floor here" (§7). Flatten is gated on the painted base, the "pokes through" warning
  ignores storey-high walls on flat ground, and the Inspector's "Can't …" toast fires only for invalid shapes
  (§7).
- Rendering (§4.6, PERFORMANCE §11): one upload range per attribute and call; terrain commits and
  cleared previews move the mesh and grid in place; preview wall rebuilds wait by their own cost; terrain
  previews reach the occluder proxies (shadows, sky, GPU sight); overlapping gizmo arrows are hidden;
  non-planar top fills are lifted above the baked terrain.
- Second round: a press keeps a selected shape or element only when it is in front or cycled to, and an
  advanced-mode click takes another shape only when it is in front; the height label on the pointer ray
  follows sideways moves; a drag inside a cylinder's cell commits nothing; the "pokes through" warning
  measures from the top of the floor above; the disabled Flatten button shows its tooltip; the Inspector's
  element hint shows only where elements are edited (§7). Terrain commits move the heightfield occluder
  proxies in place (`applyChange` per resolution-4 nudge: ≈ 0.1–0.3 s before, 2–7 ms now, PERFORMANCE
  §11); cached floor outlines follow commits and cleared previews; lights and viewer eyes stand on a
  terrain preview (§4.6).

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
- On heightmap levels a clipped follow-terrain wall piece takes its base line from the host's
  `terrainProfile`, so its top, door heads, sills and lintels match the host (§6.2), but its below-ground
  bottom can differ: the host's depends on the terrain under the whole wall, which the player is not sent.
  Nothing above ground is affected. A piece whose profile would exceed 4096 entries (0.5 ft cells, walls
  reaching far past the grid) is sent without one and stands on the client's clipped terrain.
- `terrainProfile` is sent even where the client's clipped ground would reproduce it (173–475 bytes per
  view, about 2%, on the Crooked Lantern); leaving redundant profiles out is a possible optimisation.

**The table (chat, dice, combat, pings)**

- The log keeps the newest 200 messages (the DM's) and a player's view the newest 60 they may read; older
  ones are dropped for good. Message times are the DM's clock.
- A combatant a player cannot see right now is left out of their order entirely (no "unknown" placeholder,
  which would itself reveal it). They can still notice that time passes while nobody they see acts.
- Pings are best-effort: a player whose link is down while one is sent never gets it. They are not
  stored, so a reload shows none.
- "Roll for NPCs" writes the values into the tracker without log messages. Table actions are not part of
  the editor's undo history.
- The log and combat belong to the game (`session_state`), not the map: "Save map to library" does not
  keep them, and a new game starts with neither.

**Areas of effect**

- What an area reaches is computed by each viewer from the scene it has. A player's result uses only the
  geometry they have seen, so an area reaching into unexplored parts is drawn there as if nothing stood in
  its way (over black fog), and a creature the player cannot see is never listed. The DM's result, on the
  whole scene, is the one damage is dealt by.
- Lines of effect are straight: effects that spread around corners (5e Fireball's rules text) are not
  modelled; the DM can place a second template. Squares are judged by their centre column (the 5e grid rule);
  an area covering only part of a square does not cover it.
- "Roll damage" deals one roll to creatures whose hit points are tracked; saving throws are the DM's to
  mark (no rolled saves, resistances or immunities). Templates are game state: "Save map to library" does
  not keep them, and they are not part of the editor's undo history.
- Chips stack when they would overlap each other, not other HUD elements.

**Terrain editing and walls on terrain**

- The ground outside the lattice (x < 0 or z < 0) is the elevation, so a follow wall crossing the
  lattice's low edge ramps instead of stepping; the ramp lies wholly outside the map, from the wall's
  outside end to the edge crossing, and the knot on the edge always samples the terrain (§2).
  `rangeOverPolygon` can still miss the lattice-side minimum where a footprint edge crosses x = 0 or z = 0
  (a crossing rounded to −ε reads the elevation), which only affects wall bottoms there; the two terrain
  samplers (`core/occlusion/terrain.ts`, `render/builders/ground.ts`) do not treat −ε as inside.
- A follow wall can rise through the slab of the level above where the terrain climbs, and a follow-off
  wall is buried where the terrain rises above its base; both are allowed (the DM chooses per wall) and
  only flagged by the Inspector's warnings, not prevented.
- The brush paints the base, i.e. the ground under shapes: under a shape a stroke shows only where the
  painted ground passes the shape's top (above an add, below a carve); "Apply to terrain" makes a shape
  paintable (the hint says so). The optional dimmed brush ring where the baked terrain differs from the
  base is not drawn.
- Terrain is drawn only under floors, so a shape over no floor changes nothing visible (the tool's hint
  says so). A shape with fewer than ~2×2 lattice samples inside bakes to a spike or to nothing (the
  Inspector warns; raising the level's resolution helps).
- The schema checks shapes for shape and range, not simplicity, and not the bake invariant (§3): a
  hand-edited document can hold a non-simple footprint, whose triangulation is conservative and may leave
  holes (spikes, pinches and slits are tested not to cover outside area; other non-simple input is not
  proven), and a broken invariant shows only as a jump when an affected chunk is next written.
- A grid shrink that would leave a shape beyond the extent ± 50 ft is refused (like objects), not
  clipped, and every resize fully rebakes each level with terrain (about 35 ms for a 200×200-cell level at
  resolution 4 with 400 shapes).
- During a terrain preview only the terrain, the draped grid, follow-terrain walls and doors and the level's
  occluder proxies, light origins and viewer eyes (shadows, sky exposure, GPU line of sight; throttled)
  follow it; follow-off wall bottoms, props, pillars, fixture and token meshes and floor outlines update on
  commit. Previewed origins and eyes are still pushed out of the document's blockers, so over a preview
  carve deeper than a light's height the origin can sit up to the slab thickness + 0.3 ft below its
  preview position. Each throttled wall run rebuilds the level's whole walls and doors buckets (the
  builders work per bucket); spatial wall buckets, like the occluder strip buckets, would limit it to the
  walls touched. The segment preview's buried part draws through the terrain, like other
  previews, and the opening preview does not apply the host wall's `openingFrame` clamps.
- The terrain overlay re-merges the unselected layer on any selection change (cost ∝ the level's total
  points: 5–13 ms with 1000 shapes); hover hit-tests every shape on each coalesced move (bounds
  prefilter); while the gizmo shows, `picker.project` reads the canvas rect 4 times per frame; the GPU and
  `picker.project` projections differ by less than a pixel. The lifted top fill (§4.6) leaves the
  footprint-border lattice cells, where the fill meets the surrounding terrain, as before, and its bound
  assumes the path from a point to its lattice corners stays inside the footprint (fuzzed on convex
  footprints only; a deeply notched one could exceed it).
- Vertex, edge and gizmo picking need the engine's projector (`controller.setProjector`); without it only
  shapes and faces can be picked (by ray). The terrain tool's store subscription is never removed (tools
  have no dispose).
- An autosave draft that cannot be opened (invalid or too new) is only logged to the console and kept.

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
  only. Repro: `dev/render.html?sample=crooked-lantern&mode=dm-play&at=66,89.5&zoom=3&lights=floating&moon=0&camera=orbit&orbit=0,55`
  (only the orbit camera sees these faces now that the top-down camera looks straight down).
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
  addresses. Portraits are not copied into Storage, and there is no CSP `img-src` restriction. Token Maker
  images live in Atlas's own public `token-images` bucket; players can only set those (their own folder).
- Token Maker images (§11) are public: anyone with a URL can load it. The names are 128-bit content hashes,
  and a URL reaches only players who see the token. A guest who merges into an account (§6.4) leaves their
  token images in the guest's folder: the URLs keep working, but they count against no quota and nothing
  lists or deletes them.
- Background removal spends money at the model provider. Its allowance (§6.4) is per account and guests are
  free to create, so the project-wide daily cap (300) is the real bound; lower it (or allow permanent
  accounts only) for a public deployment.
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
- `tsconfig.node.json` (which covers `vite.config.ts`, `dev/imageToolsApi.ts` and the shared image model
  module they import) does not set `strict`, unlike `tsconfig.app.json`. The Edge Functions themselves
  (Deno) are not type-checked by `tsc -b`; `supabase/functions/_shared/imageModels.ts` is covered through
  the dev endpoint and its vitest tests.

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
