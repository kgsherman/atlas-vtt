/**
 * Areas of effect (spell templates, docs/ARCHITECTURE.md §6.6): the shapes, their limits and the geometry
 * a template is placed with. Pure data; the maths lives in shape.ts and effect.ts.
 */
import type { Id } from "../scene/types"

export const AREA_SHAPES = ["sphere", "cylinder", "cone", "line", "cube"] as const
export type AreaShape = (typeof AREA_SHAPES)[number]

/** Shapes aimed in a direction (the others are round and ignore `angle`). */
export const AIMED_SHAPES: ReadonlySet<AreaShape> = new Set(["cone", "line", "cube"])

export const AREA_LIMITS = {
  /** Radius (sphere, cylinder), length (cone, line) or edge (cube), feet. */
  minSize: 1,
  maxSize: 150,
  /** Line width, feet. */
  minWidth: 1,
  maxWidth: 60,
  /** Cylinder height, feet. */
  minHeight: 1,
  maxHeight: 200,
  /** Height of the point of origin above the ground, feet. */
  maxElevation: 100,
  maxLabel: 40,
} as const

export const DEFAULT_LINE_WIDTH = 5
export const DEFAULT_CYLINDER_HEIGHT = 40

/**
 * Where and how big an area is. The point of origin is (x, ground + elevation, z) on the level, the
 * ground being the level's ground under (x, z) (floors, terrain, stairs):
 *  - sphere: every point within `size` of the origin;
 *  - cylinder: a disc of radius `size` around the origin, from the origin up `height` feet;
 *  - cone: from the origin along `angle`, `size` long; at distance d along its axis it is d wide
 *    (5e: the width equals the distance), in every direction around the axis;
 *  - line: from the origin along `angle`, `size` long and `width` wide, `width` high (centred on the origin's height);
 *  - cube: edge `size`, the origin at the centre of its near side's bottom edge, extending along `angle` and up.
 * `angle` is in radians in the XZ plane: the direction (cos angle, sin angle) in (x, z).
 */
export interface AreaGeometry {
  shape: AreaShape
  levelId: Id
  x: number
  z: number
  elevation: number
  angle: number
  size: number
  /** Line width (other shapes keep DEFAULT_LINE_WIDTH). */
  width: number
  /** Cylinder height (other shapes keep DEFAULT_CYLINDER_HEIGHT). */
  height: number
}
