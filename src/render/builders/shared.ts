/**
 * Cache of shared unit geometries (instanced props, pillars, tokens, fixture flames). They live for
 * the whole session and are never disposed when a level is rebuilt (`userData.shared = true`).
 */
import * as THREE from "three"

import { trackShared } from "../engine/sharedResources"
import { MeshWriter } from "./writer"

const unitCache = new Map<string, THREE.BufferGeometry>()

/** Cached unit geometry built once by `build`. */
export function sharedGeometry(key: string, build: (w: MeshWriter) => void): THREE.BufferGeometry {
  let g = unitCache.get(key)
  if (!g) {
    const w = new MeshWriter()
    build(w)
    g = w.build() ?? new THREE.BufferGeometry()
    g.userData.shared = true
    g.name = key
    unitCache.set(key, g)
    // Outlives engines: released (GPU side only) when an engine is disposed.
    trackShared(g)
  }
  return g
}

/** True for geometries owned by the shared cache. */
export const isSharedGeometry = (g: THREE.BufferGeometry): boolean => g.userData.shared === true
