/**
 * The play-mode Template tool (ARCHITECTURE §6.6, §8), shared by players and the DM: place an area of
 * effect with the shape, size and colour chosen in the HUD (TemplateSpec).
 *
 *  - Hover shows a draft at the pointer (spheres and cylinders centred there, aimed shapes starting
 *    there, pointing where the last one did).
 *  - Round shapes: press, drag to adjust, release to place. The centre snaps to grid intersections (the
 *    5e rule for spheres); pressing a token centres the area on it.
 *  - Aimed shapes (cone, line, cube): press at the point of origin, drag to aim, release to place. The
 *    origin snaps to the half-cell lattice; pressing a token starts the area on the edge of its space,
 *    at half its height (where a breath or a spell leaves the caster), facing the pointer. Shift snaps
 *    the aim to 15° steps.
 *  - Auras (TemplateSpec.aura): a click on a token the user may select (or anywhere, for the selected
 *    one) places a round area carried by it.
 *  - Alt: no snapping.
 */
import {
  AIMED_SHAPES,
  normalizeArea,
  type AreaGeometry,
  type AreaShape,
} from "@/core/area"
import { snapPoint } from "@/core/grid/grid"
import { SIZE_FOOTPRINT } from "@/core/scene/defaults"
import type { Id, SceneLike, Token, Vec2 } from "@/core/scene/types"

/** Origin height of aimed shapes placed away from a token (a caster's chest, feet). */
export const AIMED_ELEVATION = 2.5
/** Shift snaps the aim to steps of this many degrees. */
export const AIM_SNAP_DEG = 15

/** What the next template will be (the HUD's picker). */
export interface TemplateSpec {
  shape: AreaShape
  size: number
  width: number
  height: number
  color: string
  label: string
  /** Origin height above the ground; null = automatic (aimed: 2.5 ft or half the token's height; round: 0). */
  elevation: number | null
  /** Carried by a token (round shapes only). */
  aura: boolean
}

/** A template being placed, or placed (TemplatePlacer.onTemplate). */
export interface TemplateDraft {
  geometry: AreaGeometry
  /** The token carrying it (auras), or null. */
  tokenId: Id | null
  /** The template being moved (null: a new one). */
  editing: Id | null
}

export interface TemplatePointer {
  /** Ground point on the active level under the pointer. */
  ground: Vec2 | null
  /** Token under the pointer (any token in the scene). */
  tokenId: Id | null
  shift: boolean
  alt: boolean
}

const isAimed = (shape: AreaShape) => AIMED_SHAPES.has(shape)

/** The point where a ray from the token's centre along `dir` leaves its footprint square. */
export function tokenEdgePoint(
  token: Pick<Token, "position" | "size">,
  cellSize: number,
  angle: number
): Vec2 {
  const half = (SIZE_FOOTPRINT[token.size] * cellSize) / 2
  const dx = Math.cos(angle)
  const dz = Math.sin(angle)
  const t = half / Math.max(Math.abs(dx), Math.abs(dz), 1e-9)
  return { x: token.position.x + dx * t, z: token.position.z + dz * t }
}

/** Snap an aim angle to AIM_SNAP_DEG steps. */
export function snapAngle(angle: number): number {
  const step = (AIM_SNAP_DEG * Math.PI) / 180
  return Math.round(angle / step) * step
}

export class TemplateTool {
  private spec: TemplateSpec
  private draft: TemplateDraft | null = null
  private editing: Id | null = null
  private angle = 0
  /** A press in progress: the aimed origin, or the token it started on. */
  private press: { origin: Vec2; token: Token | null; levelId: Id } | null =
    null

  constructor(spec: TemplateSpec) {
    this.spec = spec
  }

  getSpec(): TemplateSpec {
    return this.spec
  }

  /** Change what is being placed (the draft follows at the next pointer event). */
  setSpec(spec: TemplateSpec): void {
    this.spec = spec
    if (this.draft)
      this.draft = {
        ...this.draft,
        geometry: this.geometryFrom(this.draft.geometry, null),
      }
  }

  /** Move an existing template: the next placement replaces it (and starts from its aim). */
  setEditing(id: Id | null, angle = this.angle): void {
    this.editing = id
    this.angle = angle
  }

  getEditing(): Id | null {
    return this.editing
  }

  getDraft(): TemplateDraft | null {
    return this.draft
  }

  get pressed(): boolean {
    return this.press !== null
  }

  clear(): void {
    this.draft = null
    this.press = null
  }

  /** Geometry of the spec at an origin and aim (`token`: the one it leaves from, for the automatic height). */
  private geometryFrom(
    g: Pick<AreaGeometry, "levelId" | "x" | "z" | "angle">,
    token: Pick<Token, "height"> | null
  ): AreaGeometry {
    const s = this.spec
    const aimed = isAimed(s.shape)
    const auto = aimed
      ? token
        ? Math.max(0.5, token.height / 2)
        : AIMED_ELEVATION
      : 0
    return normalizeArea({
      shape: s.shape,
      levelId: g.levelId,
      x: g.x,
      z: g.z,
      elevation: s.elevation ?? auto,
      angle: g.angle,
      size: s.size,
      width: s.width,
      height: s.height,
    })
  }

  private snap(scene: SceneLike, p: Vec2, alt: boolean): Vec2 {
    if (alt) return { x: p.x, z: p.z }
    return snapPoint(
      scene.grid,
      p,
      isAimed(this.spec.shape) ? "half" : "vertex"
    )
  }

  private tokenOf(scene: SceneLike, id: Id | null): Token | null {
    return id && Object.hasOwn(scene.tokens, id) ? scene.tokens[id] : null
  }

  /** The draft for an origin (token or point) aimed at `angle`. */
  private aimedDraft(
    scene: SceneLike,
    levelId: Id,
    origin: Vec2,
    token: Token | null
  ): TemplateDraft {
    const o = token
      ? tokenEdgePoint(token, scene.grid.cellSize, this.angle)
      : origin
    return {
      geometry: this.geometryFrom(
        {
          levelId: token?.levelId ?? levelId,
          x: o.x,
          z: o.z,
          angle: this.angle,
        },
        token
      ),
      tokenId: null,
      editing: this.editing,
    }
  }

  private roundDraft(
    levelId: Id,
    at: Vec2,
    token: Token | null,
    carried: boolean
  ): TemplateDraft {
    const p = token ? token.position : at
    return {
      geometry: this.geometryFrom(
        { levelId: token?.levelId ?? levelId, x: p.x, z: p.z, angle: 0 },
        token
      ),
      tokenId: carried && token ? token.id : null,
      editing: this.editing,
    }
  }

  /** Pointer moved with no button held: the draft follows it. Returns whether the draft changed. */
  hover(scene: SceneLike, levelId: Id, e: TemplatePointer): boolean {
    if (this.press) return false
    if (!e.ground) {
      const had = this.draft !== null
      this.draft = null
      return had
    }
    const at = this.snap(scene, e.ground, e.alt)
    const token = this.tokenOf(scene, e.tokenId)
    const next = isAimed(this.spec.shape)
      ? this.aimedDraft(scene, levelId, at, null)
      : this.roundDraft(levelId, at, this.spec.aura ? token : null, true)
    const changed = !sameDraft(this.draft, next)
    this.draft = next
    return changed
  }

  /**
   * Left press on the map. `carrier`: the token an aura goes on when the press is not on one the user
   * may select (their selected token), or null. Returns the draft to place at once (auras), else null.
   */
  down(
    scene: SceneLike,
    levelId: Id,
    e: TemplatePointer,
    canCarry: (tokenId: Id) => boolean,
    carrier: Id | null
  ): TemplateDraft | null {
    const token = this.tokenOf(scene, e.tokenId)
    if (this.spec.aura && !isAimed(this.spec.shape)) {
      const on =
        token && canCarry(token.id) ? token : this.tokenOf(scene, carrier)
      if (!on) return null
      this.draft = this.roundDraft(levelId, on.position, on, true)
      const placed = this.draft
      this.draft = null
      return placed
    }
    if (!e.ground && !token) return null
    const at = token
      ? token.position
      : this.snap(scene, e.ground ?? { x: 0, z: 0 }, e.alt)
    this.press = { origin: at, token, levelId: token?.levelId ?? levelId }
    this.draft = isAimed(this.spec.shape)
      ? this.aimedDraft(scene, levelId, at, token)
      : this.roundDraft(levelId, at, token, false)
    return null
  }

  /** Pointer moved with the button held: aim (aimed shapes) or move (round ones). */
  drag(scene: SceneLike, e: TemplatePointer): boolean {
    const p = this.press
    if (!p || !e.ground) return false
    let next: TemplateDraft
    if (isAimed(this.spec.shape)) {
      const from = p.token ? p.token.position : p.origin
      const dx = e.ground.x - from.x
      const dz = e.ground.z - from.z
      if (Math.hypot(dx, dz) > 0.5) {
        const a = Math.atan2(dz, dx)
        this.angle = e.shift ? snapAngle(a) : a
      }
      next = this.aimedDraft(scene, p.levelId, p.origin, p.token)
    } else {
      if (p.token) return false
      next = this.roundDraft(
        p.levelId,
        this.snap(scene, e.ground, e.alt),
        null,
        false
      )
    }
    const changed = !sameDraft(this.draft, next)
    this.draft = next
    return changed
  }

  /** Release: the draft to place (null when there is none). */
  up(): TemplateDraft | null {
    if (!this.press) return null
    this.press = null
    const placed = this.draft
    this.draft = null
    return placed
  }
}

function sameDraft(a: TemplateDraft | null, b: TemplateDraft | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const g = a.geometry
  const h = b.geometry
  return (
    a.tokenId === b.tokenId &&
    a.editing === b.editing &&
    g.shape === h.shape &&
    g.levelId === h.levelId &&
    g.x === h.x &&
    g.z === h.z &&
    g.angle === h.angle &&
    g.size === h.size &&
    g.width === h.width &&
    g.height === h.height &&
    g.elevation === h.elevation
  )
}
