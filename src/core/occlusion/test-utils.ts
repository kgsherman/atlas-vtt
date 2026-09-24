/**
 * Scene builders shared by the occlusion tests.
 */
import { createHeightmap, sampleCounts, writeHeights } from "../scene/heightmap"
import { createLevel, createScene } from "../scene/factory"
import type { Id, Level, Scene, SceneObject, TerrainResolution } from "../scene/types"

export function flatScene(width = 20, depth = 20): { scene: Scene; levelId: Id } {
  const scene = createScene({ width, depth })
  return { scene, levelId: Object.keys(scene.levels)[0] }
}

export function add<T extends SceneObject>(scene: Scene, o: T): T {
  scene.objects[o.id] = o
  return o
}

export function addLevel(scene: Scene, partial: Partial<Level>): Level {
  const level = createLevel(partial)
  scene.levels[level.id] = level
  return level
}

/** Give a level a heightmap whose relative height at lattice point (x, z) is f(x, z). */
export function paintHeightmap(scene: Scene, levelId: Id, f: (x: number, z: number) => number, resolution: TerrainResolution = 2): void {
  const level = scene.levels[levelId]
  const hm = level.heightmap ?? createHeightmap(resolution)
  const { samplesX, samplesZ } = sampleCounts(scene.grid, hm.resolution)
  const s = scene.grid.cellSize / hm.resolution
  const dense = new Float32Array(samplesX * samplesZ)
  for (let j = 0; j < samplesZ; j++) for (let i = 0; i < samplesX; i++) dense[j * samplesX + i] = f(i * s, j * s)
  scene.levels[levelId] = { ...level, heightmap: writeHeights(hm, scene.grid, dense) }
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
