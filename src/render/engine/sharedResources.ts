/**
 * Registry of module-level GPU singletons: placeholder textures, the surface noise texture and the shared
 * unit geometries (builders/shared, token caps / quads, glow quads).
 *
 * three.js leaves a "dispose" listener on every texture and geometry a renderer uploads, and that listener
 * captures the renderer. A singleton that outlives its renderer therefore keeps the renderer, and with it
 * the whole WebGL context (drawing buffer, textures, buffers, programs), reachable: every editor / host /
 * play visit leaked a context until Chrome started force-losing the oldest ones.
 *
 * AtlasEngine.dispose() calls releaseSharedGpuResources(): dispose() on each object frees every
 * renderer's GPU copy and drops the listeners. The objects stay cached and valid CPU-side; any renderer
 * that uses one again (another live engine included) re-uploads it lazily, exactly as a fresh renderer
 * does.
 */
import type * as THREE from "three"

interface Disposable {
  dispose(): void
}

const tracked = new Set<Disposable>()

/** Register a module-level GPU object (texture, geometry) for releaseSharedGpuResources(). */
export function trackShared<T extends Disposable>(res: T): T {
  tracked.add(res)
  return res
}

/** Tracked geometries (their cached outline edges must be released too: overlays/highlight). */
export function sharedGpuGeometries(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = []
  for (const r of tracked) if ((r as Partial<THREE.BufferGeometry>).isBufferGeometry === true) out.push(r as THREE.BufferGeometry)
  return out
}

/** Free the GPU copies of every tracked singleton in every renderer (the objects stay usable). */
export function releaseSharedGpuResources(): void {
  for (const r of tracked) r.dispose()
}
