/**
 * Host-mask textures (ARCHITECTURE §4.4): one RGBA8 layer per scene level in a DataArrayTexture,
 * 4 texels per cell (see ./maskExpand for the channel layout), LINEAR filtered. Only levels whose
 * encoded masks changed are re-expanded and re-uploaded (`addLayerUpdate`); the texture is re-created
 * only when the grid size or the level count changes (texStorage3D is immutable).
 */
import * as THREE from "three"

import { sortedLevels } from "@/core/scene/queries"
import type { Id, SceneLike } from "@/core/scene/types"
import type { FogStyle, HostLevelMasks } from "../contracts"
import type { SharedUniforms } from "../lighting/uniforms"
import { placeholderMaskTexture } from "../materials/placeholders"
import { expandLevelMasks, maskLayerBytes, maskSignature, MASK_TEXELS_PER_CELL } from "./maskExpand"

export class HostMaskTextures {
  private texture: THREE.DataArrayTexture | null = null
  private width = 0
  private depth = 0
  private cellSize = 5
  private layers: Id[] = []
  private style: FogStyle = "smooth"
  private readonly signatures = new Map<Id, string>()
  private readonly levelUniforms = new Map<Id, THREE.IUniform<number>>()
  private readonly shared: SharedUniforms
  /**
   * The texture's storage has not been uploaded yet: the first upload must include every layer, so no
   * per-layer updates may be queued until three reports the upload (texture.onUpdate).
   */
  private fullUploadPending = false

  constructor(shared: SharedUniforms) {
    this.shared = shared
  }

  /** Shared per-level uniform holding the level's layer index (-1 until the level has a layer). */
  levelUniform(levelId: Id): THREE.IUniform<number> {
    let u = this.levelUniforms.get(levelId)
    if (!u) {
      u = { value: this.layers.indexOf(levelId) }
      this.levelUniforms.set(levelId, u)
    }
    return u
  }

  layerOf(levelId: Id): number {
    return this.texture ? this.layers.indexOf(levelId) : -1
  }

  /**
   * Bring the texture in line with the scene's levels and the host masks. Returns true if anything was
   * (re)uploaded.
   */
  sync(scene: Pick<SceneLike, "grid" | "levels">, masks: Record<Id, HostLevelMasks>, style: FogStyle = "smooth"): boolean {
    const levels = sortedLevels(scene).map((l) => l.id)
    const { width, depth, cellSize } = scene.grid
    if (levels.length === 0 || width <= 0 || depth <= 0) {
      this.disposeTexture()
      this.layers = []
      this.updateLevelUniforms()
      return false
    }
    const recreate =
      !this.texture || width !== this.width || depth !== this.depth || levels.length !== this.layers.length
    const relayout = recreate || levels.some((id, k) => this.layers[k] !== id)
    const layerBytes = maskLayerBytes(width, depth)
    if (recreate) {
      this.disposeTexture()
      const texW = width * MASK_TEXELS_PER_CELL
      const texH = depth * MASK_TEXELS_PER_CELL
      const tex = new THREE.DataArrayTexture(new Uint8Array(layerBytes * levels.length), texW, texH, levels.length)
      tex.format = THREE.RGBAFormat
      tex.type = THREE.UnsignedByteType
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.wrapS = THREE.ClampToEdgeWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.generateMipmaps = false
      tex.colorSpace = THREE.NoColorSpace
      tex.name = "atlas-host-masks"
      tex.onUpdate = () => {
        if (this.texture === tex) this.fullUploadPending = false
      }
      this.texture = tex
      this.fullUploadPending = true
      this.width = width
      this.depth = depth
    }
    this.cellSize = cellSize
    if (relayout || style !== this.style) {
      this.layers = levels
      this.signatures.clear()
      this.style = style
    }
    const tex = this.texture!
    const data = tex.image.data as Uint8Array
    const changedLayers: number[] = []
    levels.forEach((id, layer) => {
      const m = Object.hasOwn(masks, id) ? masks[id] : undefined
      const sig = maskSignature(m)
      if (this.signatures.get(id) === sig) return
      this.signatures.set(id, sig)
      expandLevelMasks(m, width, depth, data.subarray(layer * layerBytes, (layer + 1) * layerBytes), style)
      changedLayers.push(layer)
    })
    if (this.fullUploadPending) {
      // Storage not uploaded yet: upload every layer (layerUpdates must be empty).
      tex.clearLayerUpdates()
      tex.needsUpdate = true
    } else if (changedLayers.length > 0) {
      for (const layer of changedLayers) tex.addLayerUpdate(layer)
      tex.needsUpdate = true
    }
    this.updateLevelUniforms()
    return recreate || changedLayers.length > 0
  }

  /** Whether the next upload must include every layer (tests / debugging). */
  get pendingFullUpload(): boolean {
    return this.fullUploadPending
  }

  /** Re-upload everything (WebGL context restored). */
  invalidate(): void {
    if (this.texture) {
      this.fullUploadPending = true
      this.texture.clearLayerUpdates()
      this.texture.needsUpdate = true
    }
  }

  private updateLevelUniforms(): void {
    const s = this.shared
    s.uMasks.value = this.texture ?? placeholderMaskTexture()
    const texW = this.width * MASK_TEXELS_PER_CELL
    const texH = this.depth * MASK_TEXELS_PER_CELL
    if (this.texture) s.uMaskGrid.value.set(1 / (this.width * this.cellSize), 1 / (this.depth * this.cellSize), texW, texH)
    else s.uMaskGrid.value.set(0, 0, 1, 1)
    for (const [id, u] of this.levelUniforms) u.value = this.texture ? this.layers.indexOf(id) : -1
  }

  private disposeTexture(): void {
    this.texture?.dispose()
    this.texture = null
    this.signatures.clear()
  }

  dispose(): void {
    this.disposeTexture()
    this.layers = []
    this.updateLevelUniforms()
  }
}
