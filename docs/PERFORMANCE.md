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
The canvas caps physical pixels (~2.1 MP medium/high, ~1.3 MP low) instead of trusting devicePixelRatio, so a
high-DPI laptop does not shade 2–4× the fragments. Adaptive quality steps down (pixel budget → PCF taps →
GPU vision refinement → light atlas resolution) when the p95 frame time exceeds 18 ms for 2 s, and back up after
5 s under 12 ms.

### 8. Vision: authoritative on CPU, off the render thread
The host's visibility runs in a **Web Worker** with two caches: a viewer-independent **light field** (light level
per sample; a moving torch recomputes only its old/new sphere) and per-viewer **line-of-sight bitsets** keyed by
eye position and occlusion version (only the token that moved recasts rays; LOS is only tested where perception
could succeed). Ray queries use a 5 ft uniform grid with DDA traversal and mailboxing.
Players' GPUs only refine line-of-sight edges inside host-perceived cells using the viewer atlas (≤ 8 viewers),
updated only when a viewer moves.

### 9. Network
Per-player patches are coalesced (≤ 10 Hz), only non-empty diffs are sent, heightmaps travel in 8×8-cell chunks,
and big snapshots go through the database instead of the realtime socket (256 KB broadcast limit, ~100 msg/s on
the free tier).

## Measurement
`FrameStats` (engine) exposes fps, p95 frame time, draw calls, triangles, active lights, shadow tiles updated and
`shadowUpdateMs`. A dev overlay shows them (toggle with `F3`). A stress scene (`core/scene/samples` → "Stress test":
20 lights, 15 tokens, 3 levels) is used for benchmarking; vitest benchmarks cover the vision worker budgets:
full LOS recompute for one viewer ≤ 50 ms, light-field update for one light ≤ 5 ms.
