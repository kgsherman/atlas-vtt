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
    cameras/            Editor orbit camera, player 2.5D camera
    overlays/           Grid, selection, tool previews, ruler, pending paths, ghost levels, gizmos
    picking/            Ground/object/token picking
  editor/               DM editor state (zustand) + tools
  play/                 Play-mode controllers (token selection, drag-to-move, ruler, level switching)
  net/                  Supabase client, auth, repositories, transports, host runner (+ vision worker), player client
  components/           React + shadcn UI (app shell, editor panels, play HUD, lobby)
  routes/               Page-level components
supabase/migrations/    SQL: schema, RLS, RPCs, realtime policies
```

Dependency rule: `core` imports nothing outside `core` (immer types allowed). `render` imports `core`.
`editor`/`play`/`net` import `core` and `render/contracts.ts`. `components`/`routes` import everything.

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
  (the "Terrain rule"):
  - Floor slab: top = ground surface (displaced by the heightmap), bottom = top − thickness.
  - Wall: base = ground at the wall midpoint; wall top, opening heights, sills and lintels measure from
    that base. The box bottom extends down to the minimum ground along its footprint − 0.05 ft.
  - Pillars/props resting on the ground (`y = 0`): top = ground(centre) + y + height; bottom = min ground
    over the footprint. Lights follow the ground under their x,z.
- **Walls** are segments centred on a→b; at shared endpoints (within 1e-3 ft) both ends extend by
  thickness/2 so corners have no notch (in both render and occlusion).
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
- `core/scene/schema.ts`: zod **strict** schemas for the current version with bounds (grid ≤ 200×200,
  ≤ 20k objects, strings ≤ 2k, `dimRadius ≥ brightRadius`, wall thickness > 0, heightmap resolution ∈
  {1,2,4}, chunk keys `^\d+,\d+$`, chunk byte length exact, coordinates within extent ± margin).
- `core/scene/migrations.ts`: migrations operate on unknown JSON with frozen per-version schemas.
  `parseScene(json)` → `{ok:true, scene}` | `{ok:false, error:'too-new'|'invalid', issues}`; `too-new` opens read-only.
  `parseScene` also runs `validateReferences` (integrity).
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
   - caps (tops of walls, doors, pillars, props with n.y > 0.7): test point `p − n·0.1 + horiz(eye − p)·0.1`,
     and the host-mask lookup uses `p.xz + horiz(eye − p)·0.6` (the cell on the viewer's side);
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
  viewport + scissor (`scissorTest`), autoClear off. Cube pass: 256² R32F faces with depth, cleared to 1e6.
- Encoding axis −Y (seams go to the upward hemisphere, hidden by cutaway); the re-encode pass fills a 1-texel
  guard ring with the octahedral wrap, and takes the MIN of 4 cube taps per texel (conservative).
- Occluder proxies are rendered **BackSide** (second-depth) as closed volumes; camera near 0.05 ft.
  Compare `|q − src| ≤ stored(q) + 0.05` with receiver normal offset `q = p + n·k·d`,
  `k = 1.5·sqrt(4π)/(tileTexels − 2)`. Source-containing primitives are excluded via a per-instance key.
- Each tile stores its **capture origin**; the shader measures from it (a moving source lags until refreshed).
- Update priority: (a) sources that moved (the locally controlled/selected token's tile always, even over
  budget), (b) dirty viewer tiles, (c) on-screen lights by coverage, (d) rest. Budget: `SHADOW_UPDATES_PER_FRAME`
  = 4 tiles AND ~2 ms CPU (`shadowUpdateMs`). Invalidation: a tile is dirty when its source moved/changed radius,
  or an `OcclusionWorld.update` dirty region intersects its sphere. Occluder proxies follow authoritative door
  state instantly (only the visual leaf animates). Lights beyond the tile budget are **not drawn** (never unshadowed).
- Sun/moon: static cached `DepthTexture` (2048², ortho over the scene bounds), re-rendered on occluder or sun change.

### 4.3 Levels, cutaway, ghosts, draw order

- Each level: a Group of merged visual meshes (per material, with `aSurf`), InstancedMeshes (props, pillars),
  door/window meshes (animated), terrain mesh, token meshes, editor gizmos. Occluder proxies live in a separate
  `occluderScene` built from `OcclusionWorld.primitives` (instanced unit boxes / 16-sided prisms per
  (level, channel mask) + closed heightfield meshes; layers LIGHT=1, SIGHT=2), `matrixWorldAutoUpdate=false`.
- **DM modes** use the full scene. **Player mode** has only the scene rebuilt from its PlayerView
  (`viewToScene`); unexplored geometry is absent, which is why fog and sun are clamped by host masks.
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
- Pixel budget: cap physical pixels at ~2.1 MP (medium/high) / ~1.3 MP (low) instead of raw DPR. MSAA on
  medium/high. Adaptive quality steps down when p95 frame time > 18 ms for 2 s, up when < 12 ms for 5 s.

---

## 5. Simulation (authoritative, CPU, `core/`)

### 5.1 Occlusion world (`core/occlusion`)

`buildOcclusionWorld(scene: SceneLike)` emits primitives per the blocking table and Terrain rule:
walls split around openings (window sill + lintel pieces; closed-door leaves per style), wall ends extended at
joints, floors as boxes (flat levels) or one `Heightfield` per floor (levels with a heightmap), stepped boxes
under stairs/ramps, pillars (box/cylinder), prop parts (box/cylinder, scaled, rotated). A 2D uniform grid
(5 ft) over XZ accelerates queries (DDA + mailboxing). `update(scene, changedIds)` and
`updateTerrain(scene, levelId, rect)` rebuild incrementally and return dirty regions.

### 5.2 Vision (`core/vision`)

**Viewer eye** (`resolveViewerEye`): nominal eye `ground + eyeHeight`, clamped to `ceiling − 0.25` (ceiling from
an upward sight raycast), then pushed out of any containing sight blocker it did not start in.

**Samples**: per cell, centre + 4 points inset `VISION_SAMPLE_INSET` (0.75 ft) from the cell edges, at
`groundHeightAt + 0.25`. A (level, cell) is **sampleable** only if an effective floor / heightfield / connector
footprint covers the sample on that level. Samples inside a sight blocker P count as seen via a side probe (the
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
footprint square, shrunk by a 0.35 ft clearance (so a medium token fits a 4 ft door), is swept along the step
against movement blockers on the relevant level; diagonals may not cut corners. Every target footprint needs
ground (`hasGroundAt`). The host applies the **legal prefix** ("bump into a wall") and replies
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
  which bumps `sessions.host_epoch`. Each host start also creates a random `epoch` string used on the wire.
  A host that sees a higher epoch (broadcast or failed fenced write) stops and offers "Take over".
- Transport interface `net/transport.ts`: `SupabaseTransport` (private channels only, via one helper that
  hard-codes `config.private = true`; view channels with `broadcast.ack = true`; never sends while not joined;
  token bucket ≈ 25 msg/s; size guard 200 KB) and `LocalTransport` (BroadcastChannel; dev/testing only, NOT secure).

| Topic                        | INSERT (send)                          | SELECT (receive)          | Carries |
|------------------------------|----------------------------------------|---------------------------|---------|
| `session:{sid}:req:{uid}`    | that player (active member), broadcast | DM                        | ClientToHost |
| `session:{sid}:view:{uid}`   | DM, broadcast                          | that player (active) + DM | HostToClient |
| `session:{sid}:host`         | DM, broadcast + presence               | active members + DM       | HostBroadcast; DM presence = host online |
| `session:{sid}:lobby`        | active members, presence only          | active members + DM       | who's online (display only) |

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
- Join order (client): subscribe `view:{uid}` → SUBSCRIBED → subscribe `req:{uid}` → send hello. Host: on every
  `req:{uid}` SUBSCRIBED (boot, reconnect, new member) push a snapshot/snapshot_ready. Host sends `sync` on idle
  (~10 s) so a lost final patch is detected.
- Host liveness = DM presence on `session:{sid}:host`. On leave: the client loads its `player_views` row, shows
  "Waiting for DM", disables moves. Pending optimistic moves are overlays only; they clear when their result is
  applied, on snapshot/epoch change, or after 5 s ("DM not responding").
- Channel supervisor: CHANNEL_ERROR/TIMED_OUT → `realtime.setAuth()` then built-in rejoin; unexpected CLOSED →
  remove and recreate with backoff.
- Persistence (fenced by epoch RPCs): `save_session_state(sid, epoch, state)` throttled ~5 s + immediately after
  DM commands that reduce what players may see (hide token, remove token, reset fog, scene edits) + best-effort on
  `visibilitychange→hidden`; `upsert_player_view(sid, uid, epoch, seq, view)` throttled ≤ 5 s and awaited before
  `snapshot_ready`.

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
`is_active_member(sid)`. RPCs (`security definer`, `search_path=''`, execute granted to authenticated only; return
ids/booleans, never whole rows): `create_session(scene_id)` (owner check, copies the scene into session_state,
generates an 8-char Crockford room code), `join_session(room_code, display_name)`, `session_info(sid)`,
`list_session_members(sid)` (DM), `set_member_status(sid, uid, status)` (DM), `claim_host(sid)`,
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
  idMap, remap level, drop orphan openings or snap to the wall under the pointer, connector target = level above,
  detach lights whose token wasn't copied), `reprojectOpenings`, `validateReferences`.
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
