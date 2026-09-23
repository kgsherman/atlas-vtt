/**
 * Test helpers: plain materials standing in for the lighting system's world/token materials, so level
 * views and token layers can be exercised in Node without WebGL.
 */
import * as THREE from "three"

import type { LevelMaterials, SharedMaterials } from "./levels"

const mat = (name: string) => new THREE.ShaderMaterial({ name })

export function testMaterials(): { level: LevelMaterials; shared: SharedMaterials } {
  return {
    level: {
      opaque: mat("opaque"),
      opaqueInstanced: mat("opaque:instanced"),
      ghost: mat("ghost"),
      ghostInstanced: mat("ghost:instanced"),
      ghostDepth: mat("ghost-depth"),
      ghostDepthInstanced: mat("ghost-depth:instanced"),
    },
    shared: { token: mat("token"), glass: new THREE.MeshBasicMaterial(), flame: new THREE.MeshBasicMaterial() },
  }
}
