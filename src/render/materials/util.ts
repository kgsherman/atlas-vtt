/** Small helpers shared by the material factories. */
import * as THREE from "three"

/**
 * Default values for vertex attributes a geometry does not provide (three applies them with
 * gl.vertexAttrib*fv). @types/three narrows `defaultAttributeValues` to color/uv/uv1, hence the cast.
 */
export function setDefaultAttributes(material: THREE.ShaderMaterial, values: Record<string, number[]>): void {
  const m = material as unknown as { defaultAttributeValues: Record<string, number[]> }
  m.defaultAttributeValues = { ...m.defaultAttributeValues, ...values }
}

/**
 * ShaderMaterial.clone() deep-copies uniform values (and nulls render-target textures), which would cut
 * a clone off from the shared lighting uniforms. Clones are made through the factory instead, copying
 * only the base Material state (blending, colorWrite, depth state, side, …).
 */
export function keepSharedOnClone(material: THREE.ShaderMaterial, create: () => THREE.ShaderMaterial): void {
  material.clone = function (this: THREE.ShaderMaterial) {
    const copy = create()
    THREE.Material.prototype.copy.call(copy, this)
    return copy
  } as typeof material.clone
}

/**
 * Compile a scene's programs ahead of use (§4.1: no hitches later): in parallel through compileAsync
 * when KHR_parallel_shader_compile is available, otherwise synchronously (compileAsync without it only
 * adds a console warning). Best effort: the promise never rejects, and partial renderer mocks are fine.
 */
export function precompileScene(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera, targetScene: THREE.Scene | null = null): Promise<void> {
  const r = renderer as Partial<THREE.WebGLRenderer>
  try {
    if (r.extensions?.has?.("KHR_parallel_shader_compile") === true && typeof r.compileAsync === "function") {
      return r.compileAsync.call(renderer, scene, camera, targetScene).then(
        () => undefined,
        () => undefined
      )
    }
    if (typeof r.compile === "function") r.compile.call(renderer, scene, camera, targetScene)
  } catch {
    // Compilation errors surface again (with three's diagnostics) when the material is first drawn.
  }
  return Promise.resolve()
}
