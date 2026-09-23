/**
 * Planar polygon helpers on the XZ plane shared by the scene schema and core/scene/terrainShapes
 * (kept in their own module so the schema does not depend on the terrain-shape machinery).
 */

/**
 * Signed area Σ(x_k·z_{k+1} − x_{k+1}·z_k)/2 of a closed polygon (the last point connects back to the
 * first). Terrain shape footprints are stored with a positive value (their canonical orientation);
 * collinear or repeated points contribute nothing. 0 for fewer than 3 points.
 */
export function signedArea(points: readonly { x: number; z: number }[]): number {
  const n = points.length
  if (n < 3) return 0
  let sum = 0
  for (let k = 0; k < n; k++) {
    const a = points[k]
    const b = points[k + 1 === n ? 0 : k + 1]
    sum += a.x * b.z - b.x * a.z
  }
  return sum / 2
}
