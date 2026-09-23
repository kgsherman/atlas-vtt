/**
 * Grid overlay on the active level: a mesh over the grid extent (flat plane, or a lattice draped on
 * the level's terrain) with a shader that draws anti-aliased cell lines from world XZ, fades them out
 * with distance from the view centre and when cells get too small on screen.
 */
import * as THREE from "three"

import type { GridSettings } from "@/core/scene/types"

import type { GroundSampler } from "../builders/ground"

const VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const FRAGMENT = /* glsl */ `
uniform float uCell;
uniform vec3 uColor;
uniform float uOpacity;
uniform vec2 uFadeCenter;
uniform float uFadeRadius;
uniform vec4 uExtent;
varying vec3 vWorld;
void main() {
  vec2 coord = vWorld.xz / uCell;
  vec2 fw = max(fwidth(coord), vec2(1e-5));
  vec2 g = abs(fract(coord - 0.5) - 0.5) / fw;
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  // Too dense on screen (cells under ~6 px): fade out instead of moiré.
  float density = 1.0 - smoothstep(0.12, 0.3, max(fw.x, fw.y));
  float d = length(vWorld.xz - uFadeCenter);
  float fade = 1.0 - smoothstep(uFadeRadius * 0.55, uFadeRadius, d);
  // The outer border of the grid extent is drawn a bit stronger.
  vec2 lo = (vWorld.xz - uExtent.xy) / (uCell * fw);
  vec2 hi = (uExtent.zw - vWorld.xz) / (uCell * fw);
  float border = 1.0 - min(min(min(abs(lo.x), abs(lo.y)), min(abs(hi.x), abs(hi.y))) * 0.5, 1.0);
  float a = max(line * density * fade, border * 0.9) * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`

export class GridOverlay {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  private key = ""

  constructor() {
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uCell: { value: 5 },
        uColor: { value: new THREE.Color(0.85, 0.87, 0.9) },
        uOpacity: { value: 0.2 },
        uFadeCenter: { value: new THREE.Vector2() },
        uFadeRadius: { value: 100 },
        uExtent: { value: new THREE.Vector4(0, 0, 100, 100) },
      },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
    this.mesh.name = "grid"
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 0
    this.mesh.raycast = () => {}
  }

  /**
   * Rebuild the grid surface for a level when its identity, the grid, or the terrain changed
   * (`version` is bumped by the engine on terrain edits and previews).
   */
  setLevel(grid: GridSettings, ground: GroundSampler | null, levelId: string | null, version: number): void {
    const key = `${levelId}|${grid.width}|${grid.depth}|${grid.cellSize}|${ground?.elevation}|${version}`
    if (key === this.key) return
    this.key = key
    const u = this.mesh.material.uniforms
    u.uCell.value = grid.cellSize
    const W = grid.width * grid.cellSize
    const D = grid.depth * grid.cellSize
    ;(u.uExtent.value as THREE.Vector4).set(0, 0, W, D)
    this.mesh.geometry.dispose()
    this.mesh.geometry = gridGeometry(W, D, ground)
    this.mesh.visible = levelId !== null
  }

  /**
   * Refresh vertex heights in place (terrain brush preview) inside `dirty` (whole grid when null).
   * Returns false when the current geometry is not a lattice with the sampler's spacing.
   */
  refreshHeights(ground: GroundSampler, dirty: { x: number; z: number; w: number; d: number } | null): boolean {
    const lattice = this.mesh.geometry.userData.lattice as { nx: number; nz: number; W: number; D: number } | undefined
    const pos = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined
    if (!lattice || !pos || ground.flat || Math.abs(lattice.W / lattice.nx - ground.spacing) > 1e-9) return false
    const { nx, nz, W, D } = lattice
    const sx = W / nx
    const sz = D / nz
    const i0 = dirty ? Math.max(0, Math.floor(dirty.x / sx) - 1) : 0
    const i1 = dirty ? Math.min(nx, Math.ceil((dirty.x + dirty.w) / sx) + 1) : nx
    const j0 = dirty ? Math.max(0, Math.floor(dirty.z / sz) - 1) : 0
    const j1 = dirty ? Math.min(nz, Math.ceil((dirty.z + dirty.d) / sz) + 1) : nz
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * (nx + 1) + i
        pos.setY(k, ground.heightAt(pos.getX(k), pos.getZ(k)) + LIFT)
      }
    }
    pos.needsUpdate = true
    this.mesh.geometry.computeBoundingSphere()
    return true
  }

  setFade(centerX: number, centerZ: number, radius: number): void {
    const u = this.mesh.material.uniforms
    ;(u.uFadeCenter.value as THREE.Vector2).set(centerX, centerZ)
    u.uFadeRadius.value = radius
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}

const LIFT = 0.04

/** Plane (flat level) or terrain-draped lattice over [0, W] × [0, D]. */
export function gridGeometry(W: number, D: number, ground: GroundSampler | null): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  if (!ground || ground.flat) {
    const y = (ground?.elevation ?? 0) + LIFT
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, y, 0, W, y, 0, W, y, D, 0, y, 0, W, y, D, 0, y, D]), 3))
    return g
  }
  const s = ground.spacing
  const nx = Math.max(1, Math.round(W / s))
  const nz = Math.max(1, Math.round(D / s))
  const positions = new Float32Array((nx + 1) * (nz + 1) * 3)
  let k = 0
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = (i * W) / nx
      const z = (j * D) / nz
      positions[k++] = x
      positions[k++] = ground.heightAt(x, z) + LIFT
      positions[k++] = z
    }
  }
  // Same diagonal split as the heightmap: (i, j) → (i+1, j+1).
  const index: number[] = []
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i
      const b = a + 1
      const c = a + nx + 1
      const d = c + 1
      index.push(a, d, b, a, c, d)
    }
  }
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  g.setIndex(index)
  g.userData.lattice = { nx, nz, W, D }
  return g
}
