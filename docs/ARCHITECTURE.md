# Atlas VTT — Architecture

Atlas is a browser VTT where the DM builds multi-level 3D scenes and players experience them
in a 2.5D top-down view whose lighting, shadows and line of sight come from the real 3D geometry.

This document is the contract between modules. When code and this document disagree, fix one of them.

---

## 1. Module map

```
src/
  core/                 Pure TypeScript. No DOM, no three.js. Runs in the main thread, a Worker, or tests.
    scene/              Scene document types, zod schema, versioned migrations, factories, queries
    grid/               Cell math, snapping, distance rules, line rasterisation
    geometry/           Small vector / box / segment / ray math shared by occlusion & movement
    occlusion/          CPU occluder model (oriented boxes, cylinders, heightfields) + ray queries
    vision/             Authoritative per-token visibility (LOS from eye height + lighting rules), cell masks
    movement/           Move validation (walls/doors/windows/props), level transitions, ruler measurement
    history/            Generic undo/redo over immer patches
    session/            Game state, protocol messages, host authority reducer, player-view filter, diffs
  render/               three.js (WebGL2). Knows nothing about React or the network.
    engine/             Renderer, frame loop, resize, adaptive quality, stats
    builders/           Scene doc → meshes per level (visual + occluder proxies)
    lighting/           Light manager: slot assignment, culling, flicker, shadow-atlas scheduling
    shadows/            Octahedral distance atlas (point-light shadows AND token vision maps)
    materials/          World material (custom GLSL: lighting + vision + fog in one pass)
    fog/                Explored-mask textures, vision uniforms, token visibility
    cameras/            Editor orbit camera, player 2.5D camera
    overlays/           Grid, selection, tool previews, ruler, ghost levels, gizmos
    picking/            Ground/object picking for tools and tokens
  editor/               DM editor state (zustand) + tools (pure-ish controllers driven by pointer events)
  play/                 Player/DM play-mode state: token selection, drag-to-move, ruler, level switching
  net/                  Supabase client, auth, scene persistence, realtime transports, host runner, player client
  components/           React + shadcn UI (app shell, editor panels, play HUD, lobby)
  routes/               Page-level components (home, editor, host, play)
supabase/migrations/    SQL migrations (schema, RLS, RPCs, realtime policies)
docs/                   ARCHITECTURE.md (this), PERFORMANCE.md
```

Dependency rule: `core` imports nothing outside `core`. `render` imports `core`. `editor`/`play`/`net`
import `core` (and `render` only through `render/contracts.ts`). `components`/`routes` import everything.

UI rule: every UI element is composed from the shadcn components in `src/components/ui`
(preset `b5UKukPFuS` → style `base-mira`, Base UI primitives, zinc/emerald, Outfit + Roboto Slab, lucide icons).
Only write a bespoke element when no shadcn component fits, and then build it with the same tokens
(`bg-card`, `text-muted-foreground`, `border`, `rounded-md`…). The app defaults to dark theme.

---

## 2. World conventions

- 1 world unit = **1 foot**. **Y is up**. The grid is on the XZ plane. Default cell = 5 ft.
- Cell `(i, j)` covers `x ∈ [5i, 5i+5)`, `z ∈ [5j, 5j+5)`; its centre is `(5i+2.5, 5j+2.5)`.
- A scene has an extent `grid.width × grid.depth` cells starting at the origin.
- Levels are ordered by `elevation`. A level's ground is `level.elevation + heightmap(x,z)`.
  Objects on a level store Y **relative to that ground**, so changing a level's elevation moves everything on it.
- Levels do not own ceilings: the "ceiling" of level N is whatever floors level N+1 has.
  A roof is just a level whose floors cover the building.
- Walls are segments `a→b` with `height` and `thickness`, centred on the segment line.
  Doors/windows are openings **hosted by a wall** (`wallId`, `offset` along the wall, `width`).
  Deleting a wall deletes its openings. Moving a wall moves its openings.
- Connectors (stairs/ladder/ramp) have a rectangular footprint on the lower level and an ascending
  direction. A token standing on any footprint cell may switch between `levelId` and `toLevelId`.
  The token's ground height is interpolated along the run for rendering and eye height.

### Blocking semantics (single source of truth: `core/occlusion`)

| Object            | Blocks movement | Blocks sight | Blocks light (casts shadow) |
|-------------------|-----------------|--------------|------------------------------|
| Wall              | yes             | yes          | yes                          |
| Door closed/locked| yes             | yes          | yes                          |
| Door open         | no              | no           | no (leaf swung aside, still rendered) |
| Window            | yes             | no           | no                           |
| Pillar            | yes             | yes          | yes                          |
| Floor slab        | n/a (vertical)  | yes          | yes                          |
| Terrain (heightmap)| slope only (no)| yes          | yes                          |
| Prop              | `blocksMovement`| `blocksSight`| `castsShadows`               |
| Token             | no              | no           | no (blob shadow only)        |

Hidden (`hidden: true`) objects still block for the DM's simulation; they are just never sent to players.
(A hidden wall is a DM-only wall that players bump into but cannot see until explored… see §6.3.)

---

## 3. Scene document & versioning

- Types: `src/core/scene/types.ts`. Presets/dimensions: `src/core/scene/defaults.ts`.
- `schemaVersion` is an integer. `src/core/scene/schema.ts` holds zod schemas for the **current** version.
  `src/core/scene/migrations.ts` holds `migrations[n]: (doc_vn) => doc_vn+1`. `parseScene(unknown)` runs
  migrations up to `SCENE_SCHEMA_VERSION` then validates with zod and returns a `Scene` or a typed error.
- Scenes are stored as JSON in Supabase (`scene_versions.data`), exported/imported as `.atlas.json`
  files, and cached locally (IndexedDB) for offline editing.
- Each save creates a new immutable `scene_versions` row (`version` increments). The `scenes` row points
  at the latest. Sharing: `scenes.visibility = 'private' | 'link' | 'public'` + `share_slug`.

---

## 4. Rendering (three.js, WebGL2)

### 4.1 One world material for everything

All static world geometry uses a single custom `ShaderMaterial` (GLSL 3) — `render/materials/worldMaterial.ts`.
It computes in one forward pass:

1. **Lighting**: ambient + directional (sun/moon, with its own shadow map) + up to `MAX_LIGHTS` (64)
   point lights read from a float **light data texture** (not three.js lights). Each light: position,
   colour×intensity×flicker, bright & dim radius, shadow-atlas tile. Per fragment, lights are skipped
   when `distance > dimRadius` (cheap branch) before any shadow sample.
   Light count changes never trigger shader recompiles (the loop bound is a uniform).
2. **Shadows**: point-light shadows come from the **octahedral distance atlas** (§4.2), 4-tap PCF.
3. **Vision** (player mode, or DM "preview token vision"): up to `MAX_VIEWERS` (16) vision sources from a
   viewer data texture (eye position, range, vision type, atlas tile). A fragment is *seen* by a viewer if
   it is within range and not occluded in the viewer's distance map, and the light rules allow it:
   - normal: needs light level ≥ dim (bright/dim from lights, sun, or ambientLevel)
   - darkvision: within range, darkness renders as dim → **greyscale**; beyond range as normal
   - blindsight: within range, seen regardless of light (rendered desaturated with an outline tint)
   - blind: sees nothing beyond its own cell
4. **Fog of war**: `visible` → lit colour; else `explored` (from the per-level explored mask texture) →
   dimmed desaturated "memory" colour; else black. Tokens use a token material that **discards** when not
   visible (they are also not present in the player's data unless visible — §6).

The DM sees everything (`uVisionMode = 0`), optionally with a "preview token" overlay that darkens what
that token cannot see (`uVisionMode = 2`).

### 4.2 Octahedral distance atlas (shadows + line of sight share one mechanism)

A point light's shadow and a token's field of view are the same query: "what is the nearest occluder from
point P in direction D?" Both are stored as **octahedral-encoded linear-distance maps** in one
`R32F` atlas texture (default 4096² with 512² tiles = 64 tiles; low tier 2048²/256² tiles).

- Update = render the occluder proxy scene into a 6-face cube render target from P (linear distance
  output), then one full-screen pass re-encodes the cube into the atlas tile (octahedral mapping).
- Lights use the **light-occluder layer**; viewers use the **sight-occluder layer**
  (differences: windows and `blocksSight:false` props; see the table in §2).
- Sampling = 1 octahedral lookup per tap; tiles have a 1-texel guard band.
- Tiles are **cached**: re-rendered only when the source moves, its radius changes, or an occluder whose
  bounds intersect its radius changes (door toggled, geometry edited). Flicker never re-renders.
- A per-frame budget (`SHADOW_UPDATES_PER_FRAME`, default 4) with a priority queue (on-screen, near camera,
  viewer tiles first) spreads updates over frames; stale tiles stay valid until refreshed.

### 4.3 Levels, cutaway, ghosts

Each level is a `THREE.Group` holding: merged visual meshes (per material), instanced props/pillars,
connector meshes, door/window meshes (separate so they can animate), and light gizmos (editor only).
Occluder proxies live in a separate `occluderScene` (never drawn to screen) with layers `LIGHT=1`, `SIGHT=2`.

- **Player view**: render levels with `elevation <= currentLevel.elevation`; levels above are not drawn
  (but remain in the occluder scene, so upper floors still cast shadows and block sight).
- **Editor**: per-level visibility toggles; the active level is opaque; adjacent levels can be shown as
  "ghosts" (transparent, desaturated, no depth write).

### 4.4 Cameras

- Editor: perspective orbit camera (orbit/pan/zoom, focus on selection), plus an optional top ortho view.
- Player: orthographic camera looking down with a configurable tilt (0–35°), pan/zoom/rotate by 90°,
  follows the selected token. "Preview player view" in the editor switches to this camera + fog on a
  chosen token.

---

## 5. Simulation (authoritative, CPU, `core/`)

### 5.1 Occlusion world (`core/occlusion`)

`buildOcclusionWorld(scene)` converts the scene into primitives:
oriented boxes (walls split around openings, closed doors, window frames, floor slabs, square pillars, props),
vertical cylinders (round pillars, trees), and heightfields (per-level terrain, only where floor exists).
Each primitive carries `blocks: { movement, sight, light }` flags, `levelId`, `sourceId`.
A 2D uniform grid (cell = 5 ft) over XZ accelerates ray queries (DDA traversal + mailboxing).
`world.update(scene, changedIds)` supports incremental rebuilds (door toggles must be cheap).

### 5.2 Vision (`core/vision`)

For each viewer token: eye = `(x, groundY + eyeHeight, z)`. For every candidate cell on every level within
range, test sample points (cell centre + 4 inset points, at ground + 0.25 ft): a sample is **seen** if the
segment eye→sample is unobstructed for sight AND the vision rules (§4.1 step 3) pass given the sample's
light level. Light level at a point = max over lights of (bright if within brightRadius, dim if within
dimRadius) where the light→point segment is unobstructed for light; the directional light grants its level
where a ray toward it escapes the scene; else `environment.ambientLevel`.
A cell is visible if any sample is seen. Tokens are visible if any of (feet, mid, head) is seen, or if the
token stands in a visible cell. Results are cached per viewer keyed by (position, level, vision, occlusion
version, lighting version).

Output: per-level cell bitsets (`CellMask`, base64 on the wire) for `visible`; the host ORs them into each
player's persistent `explored` masks.

The GPU (§4) renders the same rules per pixel for smooth edges; the CPU result is authoritative for
**what data is sent**. The CPU test is deliberately slightly generous (5 samples) so GPU-visible pixels
always have their data.

### 5.3 Movement (`core/movement`)

A move request is a path of steps `{ cell, levelId }`. Each step must be to an 8-neighbour cell on the same
level (diagonals may not cut wall corners), or a level switch in place on a connector footprint cell.
The segment between consecutive cell centres must not cross any movement-blocking primitive on that level
(tested in 2D against footprints inflated by a small epsilon). Validation returns the longest legal prefix
and a reason. Distances use `grid.diagonalRule` (5-5-5 default). Speed is enforced only when the DM enables it.

---

## 6. Multiplayer (DM-authoritative)

### 6.1 Roles & transport

- The DM's browser tab is the **host**. It owns the full `GameState` (scene working copy + session data),
  validates player requests, computes visibility, and sends each player **only their filtered view**.
- Transport interface (`net/transport.ts`) with two implementations:
  - `SupabaseTransport` — Realtime **private** broadcast channels, authorised by RLS on `realtime.messages`.
  - `LocalTransport` — `BroadcastChannel` between tabs for offline dev/testing (explicitly NOT secure).

Topics (Supabase):

| Topic                          | Who can send (INSERT)        | Who can receive (SELECT) | Carries |
|--------------------------------|------------------------------|--------------------------|---------|
| `session:{sid}:req:{uid}`      | that player only             | the DM only              | player → host requests |
| `session:{sid}:view:{uid}`     | the DM only                  | that player (and the DM) | host → player view patches |
| `session:{sid}:lobby`          | DM (broadcast), members (presence) | members            | presence, non-secret session status |

Broadcast payloads are not authenticated, so the host **never trusts identity fields in a payload**:
a request's sender is the `{uid}` in the topic it arrived on, which RLS guarantees only that user can
write to. The host subscribes to one `req` topic per session member.

### 6.2 State flow

```
player UI ──request──▶ host topic ──▶ host: validate → apply to GameState → recompute visibility
                                         │
                   for each player: view' = filterForPlayer(state, player) ; ops = diff(view, view')
                                         │
player client ◀── patch{seq, ops} ── player topic        (+ debounced upsert of view' into player_views)
```

- `filterForPlayer` (`core/session/filter.ts`) is the ONLY path by which data reaches a player. It builds
  a `PlayerView` from scratch from the authoritative state, so nothing leaks by accident:
  - levels: only levels with explored cells (heightmap samples outside explored cells zeroed)
  - objects: only those intersecting the player's explored cells (dilated by 1 cell); `hidden` objects
    dropped; `dmNotes` stripped; `locked` doors reported as `closed`. Objects outside current visibility
    keep their **last seen** state (per-player memory), so a door closed out of sight still looks open.
  - lights: only lights that currently illuminate a visible cell or sit in an explored cell (last-seen state)
  - tokens: the player's own tokens (+ party tokens when shared vision is on) always; other tokens only
    while currently visible; never `hidden` tokens; `dmNotes` stripped
  - masks: the player's `visible` and `explored` cell masks per level
  - session flags: movement lock, shared vision, the player's controlled token ids
- Deltas are JSON-patch-like ops keyed by path produced by `diffViews(prev, next)`. Every patch carries
  `seq` and `baseSeq`. A client that sees a gap asks for a resync.

### 6.3 Reconnection

- Every player view is also upserted (debounced ~500 ms) into `player_views` (RLS: player reads only their row).
- Supabase Realtime reconnects the socket automatically; on every (re)subscribe the player sends
  `hello{lastSeq}`. The host replies with `patch` from `lastSeq` if it still has the history ring buffer
  (last 64 views), else `snapshot_ready{seq}` and the client reloads its row from `player_views`.
- If the host is offline the client loads its `player_views` row directly and shows "Waiting for DM".
- The DM's full `GameState` is saved (debounced ~2 s and on unload) to `session_state` (DM-only RLS),
  so the DM can close the tab and resume.

### 6.4 Database (see `supabase/migrations`)

`profiles`, `scenes`, `scene_versions`, `sessions` (room_code unique, dm_id, scene_id, status),
`session_members` (session_id, user_id, display_name, role, token ids), `session_state` (DM only),
`player_views` (session_id, user_id, seq, view jsonb). RPCs: `create_session(scene_id)`,
`join_session(room_code, display_name)`, `is_session_dm(sid)`, `is_session_member(sid)`.
Auth: Supabase anonymous sign-in (players need no account); DMs may link an email later.

---

## 7. Editor

- Zustand store `editor/store.ts` holds the working `Scene`, selection, active level, tool, view options.
  All document mutations go through `editor.apply(recipe, label)` → `immer.produceWithPatches`; the
  history module stores `{patches, inversePatches, label}` and supports transactions
  (`beginTransaction`/`commit` so a drag is one undo step).
- Tools implement `{ onPointerDown, onPointerMove, onPointerUp, onKeyDown, preview(): ToolPreview }` and
  receive picks from `render/picking` (ground point on the active level, snapped; hovered object id).
- Snapping: cell centre / cell corner (vertex) / half cell / free (hold Alt to toggle free placement).
- Copy/paste: selection serialised as `{ objects, tokens }` JSON (system clipboard + in-memory fallback),
  pasted with fresh ids at the pointer, openings re-parented to pasted walls when both are copied.
- Multi-select: click, shift-click, marquee on the active level.

---

## 8. Play mode

- Player sees their controlled token(s); clicking a token selects it; dragging shows a path preview + ruler
  (feet, using the diagonal rule); release sends a `move` request. The client shows the move optimistically
  as "pending" until the host confirms or rejects.
- Connectors: when a token stands on a connector footprint the HUD offers "Go up/down"; dragging onto the
  footprint and choosing the other level in the path is also allowed.
- DM play controls: lock/unlock movement (global and per player), shared party vision toggle, toggle doors and
  lights, move any token, preview any token's vision, reveal/hide tokens.
