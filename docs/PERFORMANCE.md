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
is pre-compiled with `renderer.compileAsync` at load.

### 2. Light culling
Every frame the CPU culls lights: off/hidden, dim sphere outside the camera frustum, or on a level hidden by the
cutaway whose sphere does not reach the visible levels. Survivors are sorted by screen contribution and the top 32
go into uniform slots. Per fragment, a light is skipped when `distance > dimRadius` or `N·L ≤ 0` **before** any
shadow sample, so a fragment typically pays for ~4–6 lights, not 20.

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
meshes. `matrixWorldAutoUpdate` is off and sorting is disabled during tile updates. BackSide (second-depth)
rendering removes most acne without large biases.

### 5. Overdraw control
In player view, level groups are ordered so the active level draws first and lower storeys are early-Z rejected
under its floors. The world shader never discards or writes depth, so early-Z stays enabled. Levels above the
cutaway are not drawn at all.

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
(`e2e/multiplayer-latency.mjs`, same field, three runs): a 20-step move is answered in 320–616 ms and
another player's concurrent 1-step move in 550–616 ms; before the change both timed out after 5 s.

### 9. Network
Per-player patches are coalesced (≤ 10 Hz), only non-empty diffs are sent, heightmaps travel in 8×8-cell chunks,
and big snapshots go through the database instead of the realtime socket (256 KB broadcast limit, ~100 msg/s on
the free tier).

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
  transient Storage 502s and took over 60 s to composite the first view; the other took ~12 s.

## Measurement
`FrameStats` (engine) exposes fps, p95 frame time, draw calls, triangles, active lights, shadow tiles updated and
`shadowUpdateMs`. The editor's and the host console's status bars show fps / p95 / draw calls and the active tier
(hover for the rest); the host console also shows the vision worker and flush times. A stress scene
(`core/scene/samples` → "Stress Test": 20 lights, 15 tokens, 3 levels) is used for benchmarking.

Vision budgets (vitest, `core/vision/perf.test.ts`, 100×100×3 dungeon, 20 lights, 15 tokens; the tests assert
generous CI ceilings, typical desktop numbers in brackets): full line-of-sight compute for one viewer ≤ 50 ms
target (≈ 14 ms), light-field update for one moved light ≤ 5 ms (≈ 1 ms), a torch bearer's step with 15
per-viewer recomputes ≈ 25 ms, all in the worker. On a 200×200 map with ~7.4k objects: full compute ≈ 19 ms
(a dark map: LOS is only tested where perception could succeed). Full-daylight open maps are the expensive
case: every sample is lit, so LOS is tested on every cell and the cost grows with cells × map width. One
viewer's compute on an open daylit field takes ≈ 110 ms at 120×120 and ≈ 490 ms at 200×200 in Node, about
3× that in the browser's vision worker, which is why a move's result no longer waits for per-step passes
(§8 above). Interior maps stay at ~7 ms per compute (Crooked Lantern, Vineyard).
Host flush (filter + diff per player) ≈ 0.2 ms per player on the stress scene.

Frame times are measured end to end by `e2e/perf.mjs` (DM console and a player's view in local mode, 1920×1080,
one renderer at a time): the engine's own FrameStats over 5 s with vsync, plus `engine.benchmark(120)` — frames
rendered back to back, each followed by a 1-pixel `readPixels`, so the time includes the GPU work.

### Measured (2026-09-23, final verification, `e2e/perf.mjs`, 1920×1080, vsync, local mode)

GPU frame = back-to-back frames each synchronised with a 1-pixel `readPixels` (median / p95), i.e. the
headroom against 16.7 ms. The AMD part is an integrated Radeon iGPU (the "mid-range laptop" proxy); NVIDIA is
a desktop RTX card. Both were driven through Mesa's d3d12 driver under WSL2 (headless Chromium, `scripts/pw.mjs`).

| GPU · tier | Scene | DM: fps · GPU median / p95 | Player: fps · GPU median / p95 |
|---|---|---|---|
| AMD iGPU · medium | The Crooked Lantern (4 levels, 15 lights) | 60 · 12.9–13.0 / 13.4–13.5 ms | 60 · 7.9–8.0 / 8.7–8.8 ms |
| AMD iGPU · medium | Stress Test (20 lights, 15 tokens) | 60 · 8.2–8.4 / 9.0 ms | 60 · 6.9–7.0 / 7.9–8.0 ms |
| AMD iGPU · medium | The Vineyard (3 battlemaps, 17 lights) | 60 · 5.7 / 6.8 ms | 60 · 9.6 / 10.4 ms |
| NVIDIA RTX · ultra | The Crooked Lantern | 60 · 2.2 / 2.8–2.9 ms | 60 · 1.7–1.8 / 2.2–2.3 ms |
| NVIDIA RTX · ultra | Stress Test | 60 · 2.3–2.4 / 2.8–2.9 ms | 60 · 1.7–1.8 / 2.1–2.2 ms |
| NVIDIA RTX · ultra | The Vineyard | 60 · 2.1 / 2.5–2.6 ms | 60 · 1.8–1.9 / 2.4–2.5 ms |

Ranges are from two runs of the final tree (all 36 checks passed both times). The player's view depends on
where their token stands: earlier runs, with Wren at another spot, measured the Vineyard player view at
11.7–13.3 / 12.8–14.6 ms on the iGPU. Compared with the earlier medium tier (context MSAA), the Crooked Lantern
DM view is ~0.5 ms cheaper and the other iGPU views 0.3–1 ms dearer (the lite post pass's resolve and
composite). On the same iGPU the
high tier costs 20.9 / 21.7 ms on the Crooked Lantern DM view (51 fps with vsync), so a mid-range laptop
depends on the start-up benchmark (run on every route for "Auto") and adaptive quality settling on medium;
the step-up rule of §7 keeps it there instead of retrying high every few seconds. The Vineyard scene is built from third-party battlemaps by
`e2e/vineyard-build.mjs` and is not part of the repository.

