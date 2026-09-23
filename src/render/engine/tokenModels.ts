/**
 * Token models (Token.model, ARCHITECTURE §4.3): 3D figures drawn on a token's base instead of the
 * default body. The engine is given a TokenModelSource (EngineOptions.tokenModels) that turns a
 * reference into a URL; the file is a GLB whose meshes `lod0`, `lod1`, … hold the figure at decreasing
 * detail, in footprint units (1 = the footprint side, feet on y = 0, facing +Z), possibly quantized and
 * meshopt-compressed (scripts/free-assets/build-token-models.mjs). GLTFLoader and the meshopt decoder
 * are imported only when the first model loads.
 *
 * Geometries are cached per URL for the whole page (several engines share them) and registered as
 * shared GPU resources. Loading is asynchronous: `onChange` fires when a model becomes ready, and a
 * token whose model is not (yet) available keeps the default body. Failures are remembered, not retried.
 */
import * as THREE from "three"

import type { TokenModelSource } from "../contracts"
import { trackShared } from "./sharedResources"

export interface TokenModel {
  /** Most detailed first; each indexed, float position + normal. */
  lods: THREE.BufferGeometry[]
  /** Triangles per LOD. */
  triangles: number[]
  /** Figure height in footprint units. */
  height: number
}

/** Model files by URL (page-wide; engines come and go, the parsed geometry stays). */
const byUrl = new Map<string, Promise<TokenModel>>()

interface RefState {
  state: "loading" | "ready" | "error"
  model: TokenModel | null
}

export class TokenModelLibrary {
  onChange: (() => void) | null = null
  private readonly source: TokenModelSource | null
  private readonly loadUrl: (url: string) => Promise<TokenModel>
  private readonly refs = new Map<string, RefState>()
  private disposed = false

  /** `loadUrl`: downloads and parses a model file (tests pass a stand-in). */
  constructor(source: TokenModelSource | null, loadUrl: (url: string) => Promise<TokenModel> = loadTokenModel) {
    this.source = source
    this.loadUrl = loadUrl
  }

  /** The model for a reference once it has loaded, else null (the first call starts loading it). */
  get(ref: string | undefined): TokenModel | null {
    if (!ref || !this.source) return null
    const known = this.refs.get(ref)
    if (known) return known.model
    const entry: RefState = { state: "loading", model: null }
    this.refs.set(ref, entry)
    void this.load(ref, entry)
    return null
  }

  private async load(ref: string, entry: RefState): Promise<void> {
    try {
      const url = await this.source!.resolveUrl(ref)
      if (!url) throw new Error("unknown token model")
      let pending = this.loadUrl === loadTokenModel ? byUrl.get(url) : undefined
      if (!pending) {
        pending = this.loadUrl(url)
        if (this.loadUrl === loadTokenModel) {
          byUrl.set(url, pending)
          // A failed download may succeed on a later page visit (another engine), not in this one.
          pending.catch(() => byUrl.delete(url))
        }
      }
      entry.model = await pending
      entry.state = "ready"
      if (!this.disposed) this.onChange?.()
    } catch (err) {
      entry.state = "error"
      if (!this.disposed) console.warn(`[atlas] token model ${ref} unavailable:`, err)
    }
  }

  dispose(): void {
    this.disposed = true
    this.onChange = null
  }
}

async function loadTokenModel(url: string): Promise<TokenModel> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.arrayBuffer()
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
  ])
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(data, "")
  gltf.scene.updateMatrixWorld(true)
  const meshes: THREE.Mesh[] = []
  for (let k = 0; ; k++) {
    const m = gltf.scene.getObjectByName(`lod${k}`)
    const mesh = m && findMesh(m)
    if (!mesh) break
    meshes.push(mesh)
  }
  // Not an Atlas LOD file: the first mesh is the only level.
  if (meshes.length === 0) {
    const first = findMesh(gltf.scene)
    if (first) meshes.push(first)
  }
  if (meshes.length === 0) throw new Error("the file has no mesh")
  const lods = meshes.map((m, k) => bakeGeometry(m, `token-model:${url}#${k}`))
  lods[0].computeBoundingBox()
  return {
    lods,
    triangles: lods.map((g) => (g.index ? g.index.count : g.getAttribute("position").count) / 3),
    height: Math.max(0.1, lods[0].boundingBox?.max.y ?? 1),
  }
}

function findMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null
  root.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh
  })
  return found
}

/** Float position + normal (quantized attributes dequantized, node transform applied) and the index. */
export function bakeGeometry(mesh: THREE.Mesh, name: string): THREE.BufferGeometry {
  const src = mesh.geometry
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", toFloat(src.getAttribute("position")))
  const normal = src.getAttribute("normal")
  if (normal) g.setAttribute("normal", toFloat(normal))
  if (src.index) g.setIndex(src.index.clone())
  g.applyMatrix4(mesh.matrixWorld)
  if (!normal) g.computeVertexNormals()
  g.computeBoundingSphere()
  g.name = name
  g.userData.shared = true
  return trackShared(g)
}

function toFloat(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const n = attr.count
  const size = attr.itemSize
  const out = new Float32Array(n * size)
  for (let i = 0; i < n; i++) for (let c = 0; c < size; c++) out[i * size + c] = attr.getComponent(i, c)
  return new THREE.BufferAttribute(out, size)
}

/**
 * Which LOD to draw for a figure whose footprint side covers `px` physical pixels: the most detailed
 * one that keeps about `pxPerTriangle` px² per triangle (a figure covers about half its footprint
 * square, and half of its triangles face away), so dense sculpts don't flood small tokens with
 * sub-pixel triangles. With `current`, a switch needs a 10% margin past the threshold, so a zoom that
 * hovers on it does not flicker.
 */
export function chooseLod(triangles: readonly number[], px: number, current?: number, pxPerTriangle = 3): number {
  const pick = (p: number) => {
    const budget = (p * p) / pxPerTriangle
    for (let k = 0; k < triangles.length; k++) if (triangles[k] <= budget) return k
    return triangles.length - 1
  }
  const want = pick(px)
  if (current === undefined || current === want || current >= triangles.length) return want
  // Finer than now only if it still holds 10% further out; coarser only if it holds 10% closer in.
  return want < current ? Math.min(current, pick(px / 1.1)) : Math.max(current, pick(px * 1.1))
}
