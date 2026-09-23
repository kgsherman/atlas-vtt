/**
 * Dev-only map-image helpers for the render harness: decoding battlemap images (huge JPEGs decode only
 * through createImageBitmap with a resize), a floor mask traced from an image's alpha (a quick stand-in
 * for core/scene/imageTrace), and the `vineyard-test` sample: the Forgotten Adventures vineyard maps in
 * test_maps/ (27 × 47 cells, 140 px per cell) as three levels with backdrops, lights and tokens.
 */
import { bytesToBase64 } from "@/core/scene/heightmap"
import { createFloor, createLevel, createLight, createScene, createToken } from "@/core/scene/factory"
import type { FloorMask, Id, LightObject, LightPreset, Rect, Scene, Token } from "@/core/scene/types"

/** Pixels per cell the harness normalises oversized images to (ARCHITECTURE §9 import rule). */
export const MAP_PX_PER_CELL = 140
const MAX_SIDE = 8192

export interface DecodedMap {
  bitmap: ImageBitmap
  ms: number
}

/**
 * Decode an image URL to a premultiplied ImageBitmap of `pxPerCell` × the grid (≤ 8192 px per side),
 * resizing while decoding: plain Image.decode fails on 100+ MP battlemaps, and FA maps are drawn at
 * 140 px per cell anyway.
 */
export async function decodeMapImage(url: string, grid: { width: number; depth: number }, pxPerCell = MAP_PX_PER_CELL): Promise<DecodedMap> {
  const t0 = performance.now()
  const blob = await (await fetch(url)).blob()
  const k = Math.min(1, MAX_SIDE / (Math.max(grid.width, grid.depth) * pxPerCell))
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: "premultiply",
    resizeWidth: Math.round(grid.width * pxPerCell * k),
    resizeHeight: Math.round(grid.depth * pxPerCell * k),
    resizeQuality: "high",
  })
  return { bitmap, ms: performance.now() - t0 }
}

/**
 * Floor mask covering the opaque part of an image placed over `rect` (alpha ≥ threshold), at `spacing`
 * feet per mask cell. Returns null when nothing is opaque.
 */
export async function floorMaskFromImage(image: ImageBitmap, rect: Rect, spacing: number, threshold = 128): Promise<FloorMask | null> {
  const cols = Math.max(1, Math.round(rect.w / spacing))
  const rows = Math.max(1, Math.round(rect.d / spacing))
  const small = await createImageBitmap(image, { resizeWidth: cols, resizeHeight: rows, resizeQuality: "medium", premultiplyAlpha: "none" })
  const canvas = new OffscreenCanvas(cols, rows)
  const ctx = canvas.getContext("2d")!
  ctx.drawImage(small, 0, 0)
  small.close()
  const data = ctx.getImageData(0, 0, cols, rows).data
  const bits = new Uint8Array(Math.ceil((cols * rows) / 8))
  let any = false
  for (let k = 0; k < cols * rows; k++) {
    if (data[k * 4 + 3] >= threshold) {
      bits[k >> 3] |= 1 << (k & 7)
      any = true
    }
  }
  return any ? { spacing, cols, rows, b64: bytesToBase64(bits) } : null
}

export const VINEYARD_MAPS = {
  basement: "/test_maps/181-FA-Vineyard-Interior-27x47-NoGrid-Basement-Night.png",
  ground: "/test_maps/181-FA-Vineyard-Interiors-27x47-NoGrid-FirstFloor-Night.jpg",
  upper: "/test_maps/181-FA-Vineyard-Interior-27x47-NoGrid-SecondFloor-Night.png",
} as const

export interface VineyardScene {
  scene: Scene
  /** Level id → decoded image. */
  images: Map<Id, ImageBitmap>
  rect: Rect
  ms: number
}

type LightSpec = [preset: LightPreset, cellX: number, cellZ: number, partial?: Partial<LightObject>]

/**
 * A quick 27 × 47 scene: basement (−12 ft) and second floor (10 ft) floors traced from their images'
 * alpha, a full ground floor, the three maps as backdrops, lights where the maps draw lamps and fires,
 * a moonlit night and a small party on the plaza.
 */
export async function buildVineyardScene(): Promise<VineyardScene> {
  const t0 = performance.now()
  const width = 27
  const depth = 47
  const scene = createScene({ name: "Vineyard (test maps)", width, depth })
  const cs = scene.grid.cellSize
  const rect: Rect = { x: 0, z: 0, w: width * cs, d: depth * cs }
  const ground = Object.values(scene.levels)[0]
  ground.name = "Ground Floor"
  ground.height = 10
  const basement = createLevel({ name: "Basement", elevation: -12, height: 11 })
  const upper = createLevel({ name: "Second Floor", elevation: 10, height: 9 })
  scene.levels[basement.id] = basement
  scene.levels[upper.id] = upper

  scene.environment = {
    ...scene.environment,
    skyLevel: "dim",
    ambientLevel: "dark",
    ambientColor: "#7f8fb8",
    // Night battlemaps already carry their own (painted) darkness: a brighter fill keeps them readable.
    ambientIntensity: 0.32,
    backgroundColor: "#07090d",
    directional: { ...scene.environment.directional, enabled: true, kind: "moon", azimuth: Math.PI * 0.25, elevation: Math.PI * 0.32, color: "#a9bcff", intensity: 0.45, grants: "dim" },
  }

  const [bBase, bGround, bUpper] = await Promise.all([
    decodeMapImage(VINEYARD_MAPS.basement, scene.grid),
    decodeMapImage(VINEYARD_MAPS.ground, scene.grid),
    decodeMapImage(VINEYARD_MAPS.upper, scene.grid),
  ])
  const images = new Map<Id, ImageBitmap>([
    [basement.id, bBase.bitmap],
    [ground.id, bGround.bitmap],
    [upper.id, bUpper.bitmap],
  ])

  scene.assets = {}
  for (const [level, img, name] of [
    [basement, bBase.bitmap, "basement"],
    [ground, bGround.bitmap, "ground"],
    [upper, bUpper.bitmap, "upper"],
  ] as const) {
    const assetId = `map-${name}`
    scene.assets[assetId] = { id: assetId, kind: "image", name, mime: "image/webp", width: img.width, height: img.height, bytes: 0 }
    level.backdrop = { assetId, rect: { ...rect }, opacity: 1, tintWalls: true }
  }

  // Ground floor: the default full floor; basement and upper storey follow their images' opaque area.
  for (const o of Object.values(scene.objects)) if (o.type === "floor") scene.objects[o.id] = { ...o, material: "dirt" }
  for (const [level, img, material] of [
    [basement, bBase.bitmap, "stone"],
    [upper, bUpper.bitmap, "wood"],
  ] as const) {
    const mask = await floorMaskFromImage(img, rect, cs / 4)
    if (!mask) continue
    const floor = { ...createFloor(level.id, { ...rect }, material), mask }
    scene.objects[floor.id] = floor
  }

  const lights: [Id, LightSpec[]][] = [
    [
      ground.id,
      [
        ["lantern", 6.3, 3.6],
        ["candle", 2.1, 9.7, { dimRadius: 15, brightRadius: 7 }],
        ["brazier", 5.0, 10.2],
        ["lantern", 18.6, 8.6],
        ["candle", 22.0, 10.5, { dimRadius: 15, brightRadius: 7 }],
        ["torch", 18.3, 12.4],
        ["lantern", 11.2, 12.2],
        ["torch", 21.6, 19.6],
        ["brazier", 4.1, 39.4],
      ],
    ],
    [
      basement.id,
      [
        ["torch", 4.0, 10.5],
        ["torch", 3.7, 16.5],
        ["brazier", 20.0, 6.3],
        ["torch", 8.7, 26.2],
        ["torch", 4.3, 38.5],
        ["candle", 7.0, 38.7, { dimRadius: 15, brightRadius: 7 }],
      ],
    ],
    [
      upper.id,
      [
        ["candle", 6.5, 3.2, { dimRadius: 20, brightRadius: 10 }],
        ["lantern", 4.0, 10.5],
        ["candle", 1.6, 9.3, { dimRadius: 15, brightRadius: 7 }],
      ],
    ],
  ]
  for (const [levelId, specs] of lights) {
    specs.forEach(([preset, cx, cz, partial], k) => {
      const l = createLight(levelId, preset, { x: cx * cs, z: cz * cs }, { name: `${preset} ${k + 1}`, ...partial })
      scene.objects[l.id] = l
    })
  }

  const tokens: [Id, string, number, number, string, Partial<Token>][] = [
    [ground.id, "Aria", 13.5, 19.5, "#38bdf8", { kind: "pc", vision: { darkvision: 60, blindsight: 0, blind: false } }],
    [ground.id, "Borin", 15.5, 19.5, "#f59e0b", { kind: "pc", vision: { darkvision: 60, blindsight: 0, blind: false } }],
    [ground.id, "Cassia", 14.5, 21.5, "#a78bfa", { kind: "pc" }],
    [ground.id, "Vintner", 18.5, 10.5, "#e5e7eb", { kind: "npc" }],
    [basement.id, "Smuggler", 18.5, 8.5, "#ef4444", { kind: "monster" }],
    [upper.id, "Sleeper", 4.5, 8.5, "#10b981", { kind: "npc" }],
  ]
  for (const [levelId, name, cx, cz, color, partial] of tokens) {
    const t = createToken(levelId, { x: cx * cs, z: cz * cs }, { name, color, label: name, ...partial })
    scene.tokens[t.id] = t
  }

  return { scene, images, rect, ms: performance.now() - t0 }
}
