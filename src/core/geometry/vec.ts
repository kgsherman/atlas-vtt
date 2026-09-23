/**
 * Shared geometric tolerance. Vector math in core/occlusion uses the scalar-argument helpers in
 * ./ray; the scene's Vec2 (x, z ground plane) and Vec3 types are plain objects.
 */

/** Default geometric tolerance in feet (world coordinates stay within ~1000 ft). */
export const EPS = 1e-6
