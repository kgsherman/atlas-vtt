/**
 * Shared geometric tolerance. Vector math in core/occlusion uses the scalar-argument helpers in
 * ./ray; the scene's Vec2 (x, z ground plane) and Vec3 types are plain objects.
 */

/** Default geometric tolerance in feet (world coordinates stay within ~1000 ft). */
export const EPS = 1e-6

/**
 * cos / sin of a yaw with round-off below 1e-12 snapped to 0, so quarter turns are exact (cos(π/2) is
 * 6e-17 in floating point). Axis-aligned boxes that share a face (a wall piece and the door leaf in its
 * opening) then share it exactly, and a ray along that face hits them instead of slipping between.
 */
export function yawCos(yaw: number): number {
  const c = Math.cos(yaw)
  return Math.abs(c) < 1e-12 ? 0 : c
}

export function yawSin(yaw: number): number {
  const s = Math.sin(yaw)
  return Math.abs(s) < 1e-12 ? 0 : s
}
