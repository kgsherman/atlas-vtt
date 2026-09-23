# Atlas VTT — Performance design

Target: **60 fps (≤ 16.7 ms) on a mid-range laptop** (Intel Iris Xe / GTX 1650 class) at 1080p-equivalent,
with ~20 lights and ~15 tokens, while the DM's tab also runs the authoritative simulation.

## Frame budget (Iris Xe, 1080p, 20 lights, 3 viewers)

| Stage                                   | Budget  | How it is kept there |
|-----------------------------------------|---------|----------------------|
| Main pass fragment shading              | 6–8 ms  | ~1.3× overdraw (level draw order), per-light `dimRadius` early-out, ≤ 32 culled lights in uniforms |
| Shadow / vision tile updates            | ≤ 2 ms CPU, 1–2 ms GPU | cached tiles, 4 tiles/frame cap + 2 ms CPU cap, priority queue |
| Overlays, tokens, UI                    | < 1 ms  | instancing, one draw per overlay kind |
| JS (engine + React + network)           | < 3 ms  | vision in a Worker, event-driven host, no React re-render per frame |

## Techniques

### 1. One forward pass, no recompiles
All world geometry uses one custom GLSL3 `ShaderMaterial` that does lighting, shadows, perception and fog.
Lights are **uniform arrays** (`vec4 uLights[128]`), not three.js `Light` objects, so turning lights on/off,
adding/removing them or changing their count never recompiles the shader (the loop bound is a uniform).
No `scene.fog`, clipping planes or `renderer.shadowMap`; tone mapping and colour space are fixed; every variant
is pre-compiled with `renderer.compileAsync` at load, and the engine draws nothing until those parallel compiles
have landed (ARCHITECTURE §4.1 start-up hold): the first frame used to force every link synchronously (~2 s of
blocked main thread on the Vineyard, ultra, RTX 5070 Ti through WSL; 1.1 s were still left when only the
material variants were waited for, 0.4 s with the live scene compiled too, none once the capture programs
and the first-use reflection were covered). 
**Compile time on D3D (ANGLE on Windows).** D3D's HLSL compiler is slow on the world shader, and Firefox has no
parallel compile: the ultra start-up took ~15 s there (4 lit world programs at 2.4–4.8 s each, the token
program ~1 s; `?debugShaders=1` logs per-program times). Bisected by timing stubbed variants of the assembled
shader in Firefox on Windows: ~80 % of it was the point-light shadow filters, inlined once per call site. Now:
one `atShadowIn` for both light atlases (filters take an atlas id and fetch through `atTexel`, since GLSL cannot
pick a sampler at runtime), one `atPcf` call per light (`atPcss` returns a fallback code instead of calling it),
and soft-shadow taps on a computed Vogel disc instead of a const-array lookup in the unrolled loops (~0.7 s per
program on its own). The light and viewer loops also take a uniform bound (`min(count, max)`, not the array
size plus `break`), which D3D cannot unroll (~10 %). Result on the same machine (Firefox 156, RTX 5070 Ti,
ultra, Crooked Lantern): 14.6 s → 5.6 s of start-up compile, world programs 1.0–1.4 s, token 0.3 s. GPU frame
time within noise in an alternating A/B (NVIDIA ultra, Crooked Lantern and Stress Test); penumbrae change
slightly with the tap pattern.

### 2. Light culling
Every frame the CPU culls lights: off/hidden, dim sphere outside the camera frustum, or on a level hidden by the
cutaway whose sphere does not reach the visible levels. Survivors are sorted by screen contribution and the top 32
go into uniform slots. A per-cell slot mask (a small R32UI texture over XZ with 10 ft cells; bit i set where
slot i's dim disc reaches the cell; rebuilt only when the slot list changes) lets each fragment skip the slots
whose disc misses its cell before fetching their uniforms. Without it the loop ran a distance test (a uniform
fetch and a `length`) for every slotted light: on the AMD iGPU below that dead-slot overhead was ~1.8 ms of a
Crooked Lantern DM frame (15 slots, 1080p). For the remaining slots a light is skipped when
`distance > dimRadius` or `N·L ≤ 0` **before** any shadow sample, so only the ~4–6 lights in range of a
fragment pay for falloff, Lambert and shadow taps.

### 3. Shadow-map budgeting and static caching
Point-light shadows are octahedral distance maps (one 512² tile per light in a 4096×2048 R32F atlas; one texture
binding, one lookup per tap). Tiles are **cached**: re-rendered only when the light moves or changes radius, or when
an occluder change (door toggled, geometry edited) produces a dirty region intersecting the light's sphere.
Flicker modulates intensity only, so flickering torches never re-render. A per-frame budget (4 tiles and 2 ms of
CPU submission) with a priority queue (moved sources → dirty viewer tiles → on-screen lights by coverage) spreads
bursts (e.g. opening a door inside 10 light radii) over a few frames; a stale tile stays valid from its recorded
capture origin until refreshed. Lights beyond the tile budget are dropped, never drawn unshadowed.
The sun/moon uses one static 2048² depth map with hardware PCF, re-rendered only when occluders or the sun change.

### 4. Cheap occluder geometry
Shadow/vision passes render a separate proxy scene built from `core/occlusion` primitives: instanced unit
boxes and prisms (a few draw calls per level per channel) plus closed heightfield meshes — not the detailed visual
meshes. Sloped wall pieces (`WallStrip`, follow-terrain walls on terrain) are not affine images of a cube, so
each (level, channel mask, 100 ft bucket) merges its strips into one closed mesh with per-vertex primitive
keys (one more draw call per bucket, same shader), rebuilt whole when a member changes; walls with a
constant top stay instanced boxes. `matrixWorldAutoUpdate` is off and sorting is disabled during tile updates.
BackSide (second-depth) rendering removes most acne without large biases.

### 5. Overdraw control
In player view, level groups are ordered so the active level draws first and lower storeys are early-Z rejected
under its floors. The world shader never discards or writes depth, so early-Z stays enabled. Levels above the
cutaway are not drawn at all. Tokens are opaque at rest and transparent only while their 150 ms appear / leave
fade runs, so they sort into the opaque queue and draw before the level geometry. When they were always
transparent they drew after it, which cost ~1.7 ms (medium) and ~2.9 ms (high) of GPU time on the Vineyard
player view on the AMD iGPU for a handful of small meshes.

### 6. Draw-call reduction
Static geometry is merged per level per material; props, pillars and tokens are instanced. A typical scene draws
in < 150 calls.

### 7. Pixel budget and adaptive quality
The canvas caps physical pixels (~2.1 MP medium, ~1.3 MP low) instead of trusting devicePixelRatio, so a
high-DPI laptop does not shade 2–4× the fragments; high and ultra render natively up to 2× DPR. The tiers
(ARCHITECTURE §10) bundle pixel budget, MSAA, PCF taps, GPU vision refinement, light-atlas resolution, soft
shadows and post-processing. At start-up `render/engine/autoQuality.ts` picks a tier from the GPU renderer
string plus a ~100–300 ms synthetic benchmark (cached per GPU under `atlas:quality-probe:v2`); `EngineCanvas`
runs it for "Auto" on every route (editor, host console, player) before creating the engine, so a discrete
GPU starts at ultra and an integrated or software GPU never starts at high. At runtime adaptive quality
steps one whole tier down when the p95 frame cost (max of CPU and timer-query GPU time where available)
exceeds 18 ms for 2 s. It steps back up after 5 s under 12 ms only if p95 × the next tier's cost ratio also
fits ~14 ms, never above the user's choice, and a tier whose step up failed is not retried until the
ceiling or the viewport changes. Before that rule the AMD host console oscillated between high and medium
for as long as it ran (the timer query reads ~10.6 ms at medium where a synchronised frame takes ~13.9 ms, so
every "up" looked safe): tier changes at 2.6, 10.5, 13.5, 25.6, 28.6, 50.7 and 53.8 s, 130 frames over 20 ms
and a 333 ms worst frame in 100 s.

A step itself used to be a hitch: the new tier's shaders compiled in the frame that switched (high → ultra
633 ms on the AMD iGPU, 983 ms on NVIDIA; medium → low 250 + 117 ms), and when the light atlas was
re-allocated every shadowed light went dark and came back 4 per frame over 4–6 frames. Now an adaptive step
compiles the next tier's programs in the background (`compileAsync`) and fills its new shadow atlases under
their own tile budget while the old tier keeps rendering, then switches in one frame once both are ready
(at most 1.5 s later), so no light drops out (ARCHITECTURE §4.5). On the WSL / ANGLE / Mesa d3d12 test
machines compiles are not parallel, so the stall is smaller (two frames of ~170–480 ms were measured after
the background compile landed) but not gone; a pixel-budget change (low ↔ medium) also resizes the canvas in
the switching frame. Native drivers with parallel compilation are untested.

The WebGL context has no MSAA on any tier; medium and above get MSAA from the post pipeline's scene target
(medium: a lite post pass with a 2× MSAA scene target, resolve + Reinhard composite, no bloom or AO; 2×
because 4× cost ~0.3 ms more on the AMD iGPU). Context MSAA was fixed when
the context was created: an engine started at high kept it after dropping to low (Crooked Lantern DM view,
AMD iGPU, 1080p: low 7.6 ms with the inherited context MSAA vs 6.3 ms without), an engine started at low had
no MSAA on medium, and on high / ultra the canvas' MSAA buffers (~66 MB at 1080p) only served the overlays.
Overlays now use analytic antialiasing. Measured after the change with `e2e/perf.mjs` (Crooked Lantern,
AMD iGPU, 1080p, GPU frame median / p95): DM view low 7.4 / 8.3–8.4 ms, medium 12.9–13.0 / 13.4–13.5 ms
(13.4 / 14.1 ms before, with context MSAA), high 20.9 / 21.7 ms; player view low 3.2–3.3 / 3.6–4.2 ms,
medium 7.9–8.1 / 8.7–9.1 ms, high 11.1 / 12.0 ms.

### 8. Vision: authoritative on CPU, off the render thread
The host's visibility runs in a **Web Worker** with two caches: a viewer-independent **light field** (light level
per sample; a moving torch recomputes only its old/new sphere) and per-viewer **line-of-sight bitsets** keyed by
eye position and occlusion version (only the token that moved recasts rays; LOS is only tested where perception
could succeed). Ray queries use a 5 ft uniform grid with DDA traversal and mailboxing.
Players' GPUs only refine line-of-sight edges inside host-perceived cells using the viewer atlas (≤ 8 viewers),
updated only when a viewer moves.
A move's result waits only for the vision compute of its final position; the intermediate steps (which OR
into explored, so walked-past corridors are explored) run afterwards as low-priority probes whose exploration
follows in the next patch (ARCHITECTURE §5.2). Before, every step queued a full compute ahead of the result:
a 14-step move on a 120×120 daylit field took over 5 s and timed out as "DM not responding". Now
(`e2e/multiplayer-latency.mjs`, same field, five runs on 2026-09-23): a 20-step move is answered in
309–616 ms and another player's concurrent 1-step move in 547–617 ms; before the change both timed out
after 5 s.

### 9. Network
Per-player patches are coalesced (≤ 10 Hz), only non-empty diffs are sent, heightmaps travel in 8×8-cell chunks
(terrain shapes and the painted base never travel; follow-terrain wall pieces carry the host's base line,
`terrainProfile`, one number per base knot of the piece: 173–475 bytes per view, about 2%, on the Crooked Lantern),
and big snapshots go through the database instead of the realtime socket: the transport's size guard is 200 KB
(`MAX_BROADCAST_BYTES`, headroom under Realtime's 256 KB message limit), and each client's sends go through
one token bucket of ≈ 25 msg/s (burst 10), well under the free tier's ~100 msg/s. Per player, requests are
limited to 8/s (burst 16), hellos (each may cost a full snapshot plus a tile table per backdrop level) to
1/s (burst 4, coalesced), and `rate-limited` replies to 2/s, so one client cannot turn the DM's shared send
bucket into replies (ARCHITECTURE §6.2).

### 11. Terrain editing (shapes, previews, walls on terrain)
Terrain shapes must stay interactive at the limits (1000 shapes and 16000 points per level, 200×200 cells at
resolution 4: 801² lattice samples) while the live host re-syncs on every player step. The measured costs
per gesture step and per commit are below; frame times in the browser for a resolution-4 drag or nudge are
not yet part of `e2e/perf.mjs`.
- **Local gestures, per-chunk commits.** A drag or a creation re-bakes only the previous ∪ current footprint
  (grown by one sample spacing) into a local lattice, and only when its snapped state changes; the document
  gets one `writeTerrain` per gesture, which rewrites only the chunks the change reaches, so undo patches and
  network diffs stay per chunk. The bake visits each top triangle's bounding box, never every sample against
  every polygon. Measured once in vitest on a 200×200-cell level at resolution 4 with 400 shapes:

  | Operation | Time |
  |---|---|
  | Move one shape (`writeTerrain`, 3 patches) | ≈ 3 ms |
  | `bakeRegion` over 100×100 ft | ≈ 0.4 ms |
  | `bakeRegion` over the whole level | 13 ms |
  | Rebake "all" (resolution change, grid resize) | 35 ms |
  | First write of all 400 shapes | 97 ms |

  `triangulateFootprint` takes ≈ 51 µs for a 64-gon and ≈ 7.1 µs for a 24-gon (≈ 37 / 5.6 µs before the
  diagonal rule of ARCHITECTURE §3), cached per shape object. "Apply to terrain"'s `applyShapesClosure`
  takes ≈ 1–2 ms in the worst case (1000 shapes overlapping in one chain); the Inspector runs it on each
  render of its action buttons. `hasPaintedBase` (the Levels panel's Flatten) reads chunk keys only.

- **Terrain previews move the mesh in place** (`Engine.previewTerrain`, ARCHITECTURE §4.6). A per lattice-row
  triangle table built with the terrain mesh limits an update to the rows and cells around the dirty rect,
  heights are read straight from the lattice and the bounds grow by union (before: a scan of every terrain
  triangle and a bounding-sphere recompute over the whole mesh per pointer move). Budget ≤ 4 ms per update for
  a 100×100 ft dirty rect on a 200×200-cell resolution-4 level (2.57M triangles): measured ≈ 1.0–1.2 ms steady
  and 4 ms on the first call, against 12–38 ms for the old full scan. The committed test (60×60 cells,
  resolution 4) asserts an 8 ms median and that the result equals a full scan. The first preview rebuilds the
  floors bucket only when the level has no terrain mesh yet. The draped grid overlay likewise updates only the
  rows around the dirty rect and grows its bounds by union (before: the whole position buffer, 641k vertices
  on the largest level, and a bounding-sphere recompute per call).
- **One upload range per attribute and call.** The terrain mesh's positions and normals and the grid's
  positions each upload one range (first to last touched vertex, merged with any range not uploaded yet,
  since several previews can run before a render). With one range per lattice row, each a `bufferSubData`
  into a 23 MB+ buffer the GPU may still be reading, dragging a 40×40 ft block on a 100×100-cell
  resolution-4 level took 1.0–1.4 s per frame in headless Chromium (ANGLE → Mesa d3d12, which appears to
  copy the whole buffer per call; p95 ≈ 1.3 s) and a brush stroke p95 510 ms; collapsing the ranges to
  one per attribute gave p95 ≈ 21 ms for the drag and ≈ 27 ms for the brush. Native drivers may suffer
  less, but one range costs nothing.
- **Throttled preview work** (`PreviewThrottle`). When the dirty rect reaches a follow-terrain wall, the
  level's WHOLE walls and doors buckets are rebuilt (the builders work per bucket, not per wall): the first
  update at once, then only once max(100 ms, 8 × the last rebuild's cost) has passed since that rebuild ended,
  plus a trailing rebuild, so even a slow rebuild takes at most ~1/9 of the main thread (with a fixed 100 ms
  counted from its start, a rebuild of ~100 ms or more ran again on the next move: ~10 fps gestures on large
  levels). The overlays are rebuilt only when outlines hang on that level's walls, doors or windows. A rebuild
  costs ≈ 0.07 ms per wall with a door and a window (node, CPU only: 6–7 ms for 84 walls on 40×40 cells, 15 ms
  for 220 walls on 100×100 cells and 42 ms for 544 walls on 200×200 cells at resolution 4). The lighting
  system's occluder proxies follow the preview under a second throttle (same rule, 100 ms): rewriting the
  touched heightfield chunks for a 100×100 ft dirty rect on a 200×200-cell resolution-4 level (2500 chunks)
  costs ≈ 3.0 ms median and 7.6 ms worst per call, cancelling the preview (`endPreview` restores those
  chunks) 6.7 ms, plus per call one sun and one sky map re-render (2048² + 1024² proxy depth passes) and the
  recapture of the light / viewer tiles near the change and of the lights and viewers whose origin or eye
  the preview moved (the level's lights and viewers are re-resolved on the preview ground each call).
- **Terrain commits move the mesh in place.** Every drag end, creation, nudge, rotate, Inspector edit and
  brush stroke is a commit. It used to rebuild every bucket of the level and the draped grid and re-upload
  the whole terrain: ≈ 0.33 s of CPU per arrow-key nudge on a 100×100-cell resolution-4 level, and in
  headless Chromium on 200×200 with 60 shapes ≈ 9 s per shape move (1.4 s in `updateScene`, then 7.5 s of
  `bufferData` before the next frame).
  Now the mesh and the grid move in place over the changed chunks ∪ what the preview drew, walls and doors
  are rebuilt only when a wall stands near that rect, and the other ground-dependent buckets (cheap)
  always. Measured in vitest (CPU, resolution 4, 150 walls with doors and props):

  | Level | Floors rebuild (before) | Mesh in place | Grid | `GroundSampler.forLevel` | `world.updateTerrain` |
  |---|---|---|---|---|---|
  | 100×100 cells | 408 ms | 4.0 ms | 0.4 ms | 2.4 ms | 12.8 ms |
  | 200×200 cells | 1128 ms | 4.0 ms | 0.3 ms | 3.2 ms | 15.4 ms |

  When rebuilt, walls take 11–14 ms, doors 15–50 ms and props 1–10 ms there (first runs include warm-up).
  The committed engine test (100×100 cells, resolution 4, one-shape nudge, lighting system stubbed)
  asserts that `updateScene` costs less than half of one floors rebuild: measured 35.5 ms against
  344.6 ms. What remains there is mostly `world.updateTerrain` (13–15 ms) and `GroundSampler.forLevel`
  decoding the whole heightmap (2–3 ms).
- **Terrain commits move the occluder proxies in place.** The lighting system's `applyChange` used to
  rebuild a changed floor's heightfield proxy whole (every chunk mesh re-created, then re-uploaded at the
  next capture) and invalidate the light tiles over the whole level. Now `OccluderProxies.update` rewrites
  only the chunk meshes holding a changed sample and dirties only their bounds; a commit that ends a
  preview diffs against the previewed heights, so a drag release whose commit equals its last preview
  rewrites nothing. The sun and sky maps still re-render once per terrain commit. Measured in vitest (CPU,
  resolution 4, one 40 ft block nudged 5 ft; best / median of 3, a range = several runs; the engine row in
  jsdom with a fake WebGL renderer, one level, no walls):

  | Per commit | 100×100 before | 100×100 now | 200×200 before | 200×200 now |
  |---|---|---|---|---|
  | `applyChange`, arrow nudge | 98 / 124 ms | 1.8–3.5 / 3.7–6.5 ms | 290 / 291 ms | 2.5–2.7 / 4.7–5.7 ms |
  | `applyChange`, drag release (after a preview of the same move) | 86 / 89 ms | 0.5–0.6 / 0.6–1.0 ms | 237 / 294 ms | 1.5–1.7 / 1.7–1.9 ms |
  | New proxy geometries | 625 (31 MB) | 0 | 2500 (123 MB) | 0 |
  | Proxy dirty area | whole level (500 ft) | 8 regions ≤ 40 ft | whole level (1000 ft) | 8 regions ≤ 40 ft |
  | `engine.updateScene` with the real lighting system | 315 / 317 ms | 17–20 / 21–22 ms | 1064 / 1116 ms | 27–29 / 29–34 ms |

  The committed test (60×60 cells, resolution 4, a nudge with and without a preview) asserts that every
  chunk equals a fresh rebuild, that no geometry is allocated and that each dirty region is at most 40 ft
  wide.
- **Floor outlines are patched, not recomputed.** A hovered, selected or hidden floor's outline is its
  terrain triangles' feature edges (`THREE.EdgesGeometry`), cached per mesh geometry and object. The first
  outline of a whole-level terrain floor still costs 2.8 s at 100×100 cells and 12.3 s at 200×200
  (resolution 4; e.g. its first hover in the Select tool). A commit or cleared preview only records the
  moved rect (0.07–0.23 ms); the next use recomputes the edges near it from the triangles near it: ≈ 80 ms
  at 100×100 and 112 ms at 200×200 for an 81 ft rect, instead of the full recompute. Outlines do not
  follow a live preview.
- **Terrain overlay caching.** Per-shape prism arrays are cached by shape identity (with the elevation and
  lattice spacing; a non-planar top's lifted fill is one more merged geometry per op, built only when some top
  is lifted) and the unselected shapes are one merged layer that a drag of the selection does not touch, so a
  level of 1000 shapes stays at about 8 draw calls (per-shape meshes would be ~4000). Measured once in vitest
  with 1000 shapes / 19,000 points (above the 16000-point document limit; noisy, other test runs in parallel):
  a rebuild with the same shapes 0.2–1.2 ms, dragging one shape 0.4–1 ms, a selection change 5–13 ms
  (re-merges the unselected layer), dragging all 1000 shapes 23–27 ms per move (mostly re-triangulation).
- **DM-only data stays out of hot paths.** `terrainEdits` is stripped from the vision worker's scene, a
  terrain-edit-only change (a rename, painting under a shape) marks no player dirty, and the editor's
  document guard validates only the touched shapes and base chunks (a full check only when a level, the
  root or the grid is replaced).
- **Wall strips.** Sloped wall pieces binary-search their knots and visit only the intervals a ray's clipped
  span covers, and register per grid cell with the Y range of the part the cell spans. On the same walls
  without a floor, strips cost about 1.2–1.35× boxes. Door toggles build no joint index (an opening needs
  only its host wall's profile): 0.1 ms on the large perf scene, against 3.75 ms while an opening's frame
  still built it. The occlusion and vision perf tests (below) run a terrain + follow-wall variant against
  1.5× the flat ceilings.

### 10. Battlemap backdrops (memory and uploads)
A Forgotten Adventures storey is ~25 MP (the Vineyard's are 3780×6580 px). Three rules keep that affordable:
- **Player canvases grow with exploration.** A player's per-level composite canvas covers only the
  chunk-aligned bounding box of the explored cells and grows geometrically, and its pixel budget follows the
  engine's quality ceiling (`backdropTexelBudget`, the same `BACKDROP_MAX_TEXELS` as DM images). Before,
  every known level got a full-map canvas (~100 MB of CPU memory) and a full-map mipmapped texture
  (~133 MB of GPU memory), and the player's ceiling was always high. Measured on the Vineyard for Wren's
  starting view (the Ground Floor fully explored, the Second Floor for 16 partly explored cells spread over
  a 20 × 37-cell box), composite canvases + backdrop textures (with mips):

  | Quality ceiling | Before | After |
  |---|---|---|
  | high | ~465 MB (2 × 3780×6580) | ~400 MB (3780×6580 + 3360×5600) |
  | medium | ~465 MB (no tier cap for players) | ~200 MB (2673×4653 + 2376×3960) |
  | low | ~465 MB | ~67 MB (1539×2679 + 1368×2280) |

  A bounding box only shrinks memory when exploration is clustered: 16 cells in one room of a storey cost
  a canvas of 8 × 8 cells (~5 MB + ~7 MB of texture at 140 px per cell) instead of the storey's full
  ~233 MB. DM views hold the whole images: ~580 MB of textures on the Vineyard at high, ~315 MB at medium,
  ~120 MB at low (3 levels plus atlases; per-texture numbers include mip chains).
- **Dirty rects per chunk, one mip rebuild per update.** When a move explores new cells, the compositor
  reports one dirty rect per changed 4×4-cell chunk and the engine copies each rect into the texture, then
  regenerates the mipmaps once. Before, the changed cells were merged into one bounding box, often most of
  the map, and each exploring move re-uploaded up to the whole texture: `copyTextureToTexture` took
  157–281 ms on NVIDIA and 37–214 ms on the AMD iGPU, with 185–382 ms long tasks, a visible hitch on almost
  every move into new territory.
- **Sub-cell chunk clipping.** Chunks are clipped to the explored 4×4 sub-cells (a security fix: whole cells
  shipped 13–40% never-perceived art in small rooms). As tokens move, the sub-cells of boundary cells keep
  filling in, so boundary chunks are re-drawn and re-uploaded more often than with whole-cell chunks; the
  uploads are coalesced per chunk (one queued job per chunk, the latest content wins) and announced with a
  content revision. `e2e/multiplayer-supabase.mjs` on the Vineyard (2026-09-23, after the change): 105
  chunk uploads for the first host run (first view of the Ground Floor plus 16 Second Floor cells, one
  short move), 89 re-uploads after the DM's reload, no upload failures and no 429 on the host's uploads;
  the browsers logged 0–7 HTTP 429s per run on Storage requests, all retried. One of two runs hit
  transient Storage 502s and took over 60 s to composite the first view; the other took ~12 s. A run after
  the wave-4 fixes: 105 uploads for the first host run, 74 after the DM's reload, of which 8 got HTTP 429
  and were retried after backing off (all chunks arrived); the first view composited in 6.3 s. The two
  final-verification runs: 105 uploads each for the first host run and 86 / 89 after the reload; the
  first run's reload hit 10 HTTP 429s ("Too many connections issued to the database", retried, all
  chunks arrived), the second none; the first view composited in 5.5 / 5.1 s. In the first run the
  host's end-of-session chunk clean-up failed on the same 429, which is why it now retries (ARCHITECTURE
  §9).

## Measurement
`FrameStats` (engine) exposes fps, p95 frame time, draw calls, triangles, active lights, shadow tiles updated and
`shadowUpdateMs`. The editor's and the host console's status bars show fps / p95 / draw calls and the active tier
(hover for the rest); the host console also shows the vision worker and flush times. A stress scene
(`core/scene/samples` → "Stress Test": 20 lights, 15 tokens, 3 levels) is used for benchmarking.

Vision budgets (vitest, `core/vision/perf.test.ts`, 100×100×3 dungeon, 20 lights, 15 tokens; the tests assert
generous CI ceilings, typical desktop numbers in brackets): full line-of-sight compute for one viewer ≤ 50 ms
target (≈ 14 ms), light-field update for one moved light ≤ 5 ms (≈ 1 ms), a torch bearer's step with 15
per-viewer recomputes ≈ 25 ms, all in the worker. On a 200×200 map with ~7.4k objects: full compute ≈ 19 ms
(a dark map: LOS is only tested where perception could succeed). The same map on rolling terrain with
follow-terrain walls (sloped pieces become `WallStrip`s) must stay within 1.5× the flat ceilings (full
compute 600 ms instead of 400, light move 60 instead of 40); measured once: 22 ms, and 18 ms for the flat
variant. The occlusion benchmark (`core/occlusion/perf.test.ts`, 100k random sight segments over a
300 ft square) has the same terrain variant (145 strips): segments ≤ 60 ft 63 ms against 36 ms flat
(ceiling 1500 ms, 1000 flat), ≤ 425 ft 102 ms against 66 ms (ceiling 3000 ms, 2000 flat). Full-daylight
open maps are the expensive case: every sample is lit, so LOS is tested on every cell and the cost grows with cells × map width. One
viewer's compute on an open daylit field takes ≈ 110 ms at 120×120 and ≈ 490 ms at 200×200 in Node, about
3× that in the browser's vision worker, which is why a move's result no longer waits for per-step passes
(§8 above). Interior maps stay at ~7 ms per compute (Crooked Lantern, Vineyard).
Host flush (filter + diff per player) ≈ 0.2 ms per player on the stress scene.

Frame times are measured end to end by `e2e/perf.mjs` (DM console and a player's view in local mode, 1920×1080,
one renderer at a time): the engine's own FrameStats over 5 s with vsync, plus `engine.benchmark(120)` — frames
rendered back to back, each followed by a 1-pixel `readPixels`, so the time includes the GPU work.

### Measured (2026-09-23, after the wave-4 fixes, `e2e/perf.mjs`, 1920×1080, vsync, local mode)

GPU frame = back-to-back frames each synchronised with a 1-pixel `readPixels` (median / p95), i.e. the
headroom against 16.7 ms. The AMD part is the 2-CU RDNA2 iGPU of a desktop Ryzen 7 9800X3D (renderer string
"AMD Radeon(TM) Graphics"), driven through ANGLE → OpenGL → Mesa d3d12 under WSL2. It is below the Iris Xe /
GTX 1650 reference class of the target, so it is a conservative stand-in for the mid-range laptop rather
than an exact one. NVIDIA is a desktop RTX 5070 Ti, through the same d3d12 path (headless Chromium,
`scripts/pw.mjs`).

| GPU · tier | Scene | DM: fps · GPU median / p95 | Player: fps · GPU median / p95 |
|---|---|---|---|
| AMD iGPU · medium | The Crooked Lantern (4 levels, 15 lights) | 60 · 11.6–11.8 / 12.3–12.7 ms | 60 · 7.7–7.8 / 8.4–8.8 ms |
| AMD iGPU · medium | Stress Test (20 lights, 15 tokens) | 60 · 7.2–7.4 / 8.0–8.3 ms | 60 · 6.8–7.0 / 7.6–8.0 ms |
| AMD iGPU · medium | The Vineyard (3 battlemaps, 17 lights) | 60 · 5.7–6.0 / 6.4–6.5 ms | 60 · 8.8–9.1 / 9.7–10.1 ms |
| NVIDIA RTX · ultra | The Crooked Lantern | 60 · 2.2–2.3 / 2.9 ms | 60 · 1.7–1.8 / 2.2–2.3 ms |
| NVIDIA RTX · ultra | Stress Test | 60 · 2.4–2.5 / 2.9–3.0 ms | 60 · 1.7–1.8 / 2.2–2.3 ms |
| NVIDIA RTX · ultra | The Vineyard | 60 · 2.0–2.1 / 2.4–2.6 ms | 60 · 1.9 / 2.4 ms |

Measured on the tree after the wave-4 fixes (the per-cell light mask of §2, tokens opaque at rest): ranges span
three runs of the full matrix (four for the AMD Crooked Lantern and Vineyard rows), two of them in the final
verification; all 36 checks passed every time. Against the wave-3 tree (same script and machine), the iGPU's Crooked Lantern DM view is
~1.1 ms cheaper (12.9–13.0 / 13.4–13.5 ms before), the Stress Test DM view ~1 ms (8.2–8.4 / 9.0 ms), and the
Vineyard player view 0.5–0.8 ms (9.6 / 10.4 ms), less than the ~1.7 ms the token bisection predicted; the
NVIDIA rows are unchanged within noise. The player's view depends on where their token stands: earlier
runs, with Wren at another spot, measured the Vineyard player view at 11.7–13.3 / 12.8–14.6 ms on the iGPU.
Compared with the earlier medium tier (context MSAA), the lite post pass's resolve and composite made the
iGPU's views other than the Crooked Lantern DM view 0.3–1 ms dearer. On the same iGPU the high tier costs
20.9 / 21.7 ms on the Crooked Lantern DM view (51 fps with vsync; measured after wave 3), so a mid-range
laptop depends on the start-up benchmark (run on every route for "Auto") and adaptive quality settling on
medium; the step-up rule of §7 keeps it there instead of retrying high every few seconds. The Vineyard scene
is built from third-party battlemaps by `e2e/vineyard-build.mjs` and is not part of the repository.

### Where the iGPU's medium frame goes

Interleaved A/B bisection on the AMD iGPU (render harness, 1920×1080, minimum of 5–6 `engine.benchmark` runs
each, 2026-09-23, measured before the lite post pass replaced context MSAA on medium, before the per-cell light
mask of §2 and before tokens became opaque at rest):
- Crooked Lantern DM view, 12.6 ms: point lights 6.4 ms, of which 3.2 ms are shadow taps and 1.8 ms the
  dead-slot loop overhead (15 slots, §2); wide PCF (3×3 for the 8 strongest lights) 0.5 ms; procedural
  surface detail 2.1 ms; 4× context MSAA ~1.7 ms (now a 2× post target, §7); lower storeys 0.2–0.3 ms
  (early-Z works: drawing the cellar first costs 1.1 ms more); tokens and overlays ~0.3 ms; sky, sun and
  ambient ~0.1 ms. Quartering the pixels saves 7.5 ms, so ~10 ms of the frame scales with pixels.
- Vineyard player view, 11.3–13.3 ms: point lights 5.3 ms (2.5 ms shadow taps), GPU line-of-sight refinement
  1.5 ms, always-transparent tokens 1.7–2.1 ms (now opaque at rest, §5), surface detail 0.3 ms (the backdrop
  covers most surfaces).

Of the savings this profile suggested, the per-cell light mask (§2, estimated ~1.5–1.8 ms) and opaque tokens
(§5, ~1.7 ms on the Vineyard player view) are implemented. Not implemented: wide PCF for the 4 strongest
lights instead of 8 (~0.3 ms, at a visible cost on the next 4), two noise taps for detail on medium and none
on caps and faces under ~2 px (≤ 1 ms), and for larger wins a cached per-level shadow-visibility mask for
walkable surfaces so floors skip the PCF taps.

