/**
 * Screen-sized text labels (ruler distance): a canvas texture on a sprite whose world scale is
 * refreshed every frame from the camera's world-per-pixel so the label keeps a constant pixel size.
 */
import * as THREE from "three"

const FONT_PX = 28
const PAD_PX = 10

export class TextLabel {
  readonly sprite: THREE.Sprite
  private readonly canvas: HTMLCanvasElement
  private readonly texture: THREE.CanvasTexture
  private text = ""
  private aspect = 1
  /** Height of the label on screen, CSS pixels. */
  pixelHeight = 22

  constructor() {
    this.canvas = document.createElement("canvas")
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.minFilter = THREE.LinearFilter
    this.texture.generateMipmaps = false
    const material = new THREE.SpriteMaterial({ map: this.texture, depthTest: false, depthWrite: false, transparent: true, toneMapped: false })
    this.sprite = new THREE.Sprite(material)
    this.sprite.center.set(0.5, -0.35)
    this.sprite.renderOrder = 20
  }

  setText(text: string): void {
    if (text === this.text) return
    const ctx = this.canvas.getContext("2d")
    // No context: do not record the text as drawn (a later call retries).
    if (!ctx) return
    this.text = text
    const font = `600 ${FONT_PX}px system-ui, -apple-system, "Segoe UI", sans-serif`
    ctx.font = font
    const w = Math.ceil(ctx.measureText(text).width) + PAD_PX * 2
    const h = FONT_PX + PAD_PX * 2
    const resized = w !== this.canvas.width || h !== this.canvas.height
    // Assigning the size also clears the canvas and resets the context state.
    this.canvas.width = w
    this.canvas.height = h
    ctx.font = font
    ctx.fillStyle = "rgba(9, 9, 11, 0.82)"
    const r = h / 2
    ctx.beginPath()
    ctx.moveTo(r, 0)
    ctx.arcTo(w, 0, w, h, r)
    ctx.arcTo(w, h, 0, h, r)
    ctx.arcTo(0, h, 0, 0, r)
    ctx.arcTo(0, 0, w, 0, r)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = "#f4f4f5"
    ctx.textBaseline = "middle"
    ctx.textAlign = "center"
    ctx.fillText(text, w / 2, h / 2 + 1)
    this.aspect = w / h
    // three allocates immutable storage (texStorage2D) at the first upload's size, so a wider canvas
    // cannot be uploaded into it (GL_INVALID_VALUE, stale text); dispose() frees the GL texture and the
    // next render creates one at the new size. The material keeps this same texture object.
    if (resized) this.texture.dispose()
    this.texture.needsUpdate = true
  }

  /** Keep a constant on-screen size. */
  updateScale(worldPerPixel: number): void {
    const h = this.pixelHeight * worldPerPixel
    this.sprite.scale.set(h * this.aspect, h, 1)
  }

  dispose(): void {
    this.texture.dispose()
    this.sprite.material.dispose()
  }
}
