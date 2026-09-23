/**
 * Static checks on the GLSL strings (no WebGL in vitest): every declared uniform is provided by the
 * material and vice versa, varyings match between stages, preprocessor blocks balance, and the world
 * shader never uses discard / gl_FragDepth.
 */
import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { DARKVISION_MAX_GAIN } from "../lighting/lightModel"
import { DIRECTIONAL_BIAS_FT } from "../lighting/system"
import { createSharedUniforms } from "../lighting/uniforms"
import { CAP_EPSILON, CAP_INSET, DISTANCE_EPSILON } from "../shadows/octahedral"
import { COMMON_FUNCTIONS_GLSL, SHARED_UNIFORMS_GLSL } from "./glsl/common"
import { createOccluderDepthMaterial, createOccluderDistanceMaterial, createReencodeMaterial } from "./occluderMaterials"
import { createOverlayMaterial, GLASS_OPACITY } from "./overlayMaterial"
import { precompileScene } from "./util"
import { createTokenMaterial } from "./tokenMaterial"
import { createWorldMaterial } from "./worldMaterial"
import { createBackdropUniforms, setBackdropUniforms } from "./backdrop"
import { DETAIL_GLSL } from "./glsl/detail"
import { doorSurface, MAT, SURFACE_TABLE, SURFACE_TABLE_ROWS, surfaceOf, surfaceTableUniform } from "./surface"
import { TIER_DEFINE, TierRegistry } from "./util"

/** Uniforms three.js declares or feeds itself. */
const BUILTIN_UNIFORMS = new Set(["modelMatrix", "modelViewMatrix", "projectionMatrix", "viewMatrix", "normalMatrix", "cameraPosition", "isOrthographic"])
/** Identifiers three.js defines in the ShaderMaterial prefix (must not be redefined). */
const PREFIX_IDENTIFIERS = ["luminance", "toneMapping", "linearToOutputTexel", "saturate", "sRGBTransferOETF", "LinearTransferOETF", "pc_fragColor"]

function uniformsDeclared(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of src.matchAll(/^\s*uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w+)\s+(\w+)\s*(\[[^\]]+\])?\s*;/gm)) out.set(m[2], m[1])
  return out
}

function varyings(src: string, dir: "in" | "out"): Map<string, string> {
  const out = new Map<string, string>()
  const re = new RegExp(`^\\s*(flat\\s+)?${dir}\\s+(?:highp\\s+)?(\\w+)\\s+(\\w+)\\s*;`, "gm")
  for (const m of src.matchAll(re)) out.set(m[3], `${m[1] ? "flat " : ""}${m[2]}`)
  return out
}

function checkBalanced(src: string): void {
  let depth = 0
  for (const ch of src) {
    if (ch === "{") depth++
    if (ch === "}") depth--
    expect(depth).toBeGreaterThanOrEqual(0)
  }
  expect(depth).toBe(0)
  const opens = [...src.matchAll(/^\s*#if(n?def)?\b/gm)].length
  const closes = [...src.matchAll(/^\s*#endif\b/gm)].length
  expect(opens).toBe(closes)
  let paren = 0
  for (const ch of src) {
    if (ch === "(") paren++
    if (ch === ")") paren--
  }
  expect(paren).toBe(0)
}

/** GLSL has no forward declarations here: every at* function must be defined before its first call. */
function checkDefinedBeforeUse(glsl: string, label: string): void {
  // Comments blanked to spaces (positions kept).
  const src = glsl.replace(/\/\/[^\n]*/g, (c) => " ".repeat(c.length))
  const defs = new Map<string, number>()
  for (const m of src.matchAll(/\b(?:float|vec2|vec3|vec4|bool|int|uint|void|ivec2)\s+(at\w+)\s*\(/g)) {
    if (!defs.has(m[1])) defs.set(m[1], m.index)
  }
  for (const m of src.matchAll(/\b(at[A-Z]\w*)\s*\(/g)) {
    const def = defs.get(m[1])
    expect(def, `${label}: ${m[1]} is not defined`).toBeDefined()
    expect(def! <= m.index, `${label}: ${m[1]} used before its definition`).toBe(true)
  }
}

function checkMaterial(m: THREE.ShaderMaterial, vertexAttrs: string[]): void {
  checkDefinedBeforeUse(m.vertexShader, `${m.name} vertex`)
  checkDefinedBeforeUse(m.fragmentShader, `${m.name} fragment`)
  expect(m.glslVersion).toBe(THREE.GLSL3)
  const declared = new Map([...uniformsDeclared(m.vertexShader), ...uniformsDeclared(m.fragmentShader)])
  for (const name of declared.keys()) {
    if (BUILTIN_UNIFORMS.has(name)) continue
    expect(m.uniforms, `uniform ${name} of ${m.name}`).toHaveProperty(name)
  }
  for (const name of Object.keys(m.uniforms)) expect(declared.has(name), `unused uniform ${name} on ${m.name}`).toBe(true)
  // Varyings: every fragment input comes from the vertex stage with the same type/qualifier.
  const vsOut = varyings(m.vertexShader, "out")
  const fsIn = varyings(m.fragmentShader, "in")
  for (const [name, type] of fsIn) expect(vsOut.get(name), `varying ${name} of ${m.name}`).toBe(type)
  // Vertex inputs we declare ourselves (three declares position/normal/uv/instance*).
  const vsIn = varyings(m.vertexShader, "in")
  expect([...vsIn.keys()].sort()).toEqual([...vertexAttrs].sort())
  // GLSL3: the fragment output is ours (three omits pc_fragColor with glslVersion GLSL3).
  expect(m.fragmentShader).toMatch(/layout\(location = 0\) out highp vec4 atFragColor;/)
  checkBalanced(m.vertexShader)
  checkBalanced(m.fragmentShader)
  for (const id of PREFIX_IDENTIFIERS) {
    expect(m.fragmentShader).not.toMatch(new RegExp(`\\b(float|vec3|vec4|void)\\s+${id}\\s*\\(`))
    expect(m.fragmentShader).not.toMatch(new RegExp(`#define\\s+${id}\\b`))
  }
}

describe("world / token shaders", () => {
  const shared = createSharedUniforms()
  const levelUniform = { value: 0 }

  it("world material variants declare exactly the uniforms they are given", () => {
    for (const variant of ["opaque", "ghost", "ghost-depth"] as const) {
      const m = createWorldMaterial({ shared, levelUniform: () => levelUniform }, { levelId: "L", variant, instanced: false })
      checkMaterial(m, ["color", "aSurf", "aMat"])
      expect(m.uniforms.uLevelLayer).toBe(levelUniform)
      // Shared by reference.
      expect(m.uniforms.uLights).toBe(shared.uLights)
    }
  })

  it("world shader keeps early-Z (no discard / gl_FragDepth)", () => {
    const m = createWorldMaterial({ shared, levelUniform: () => levelUniform }, { levelId: "L", variant: "opaque", instanced: true })
    expect(m.fragmentShader).not.toMatch(/\bdiscard\b/)
    expect(m.fragmentShader).not.toMatch(/gl_FragDepth/)
    expect(m.transparent).toBe(false)
  })

  it("ghost variants have the right render state", () => {
    const ghost = createWorldMaterial({ shared, levelUniform: () => levelUniform }, { levelId: "L", variant: "ghost", instanced: false })
    expect(ghost.transparent).toBe(true)
    expect(ghost.depthWrite).toBe(false)
    expect(ghost.depthFunc).toBe(THREE.LessEqualDepth)
    expect(ghost.defines.AT_GHOST).toBe("")
    const depth = createWorldMaterial({ shared, levelUniform: () => levelUniform }, { levelId: "L", variant: "ghost-depth", instanced: false })
    expect(depth.colorWrite).toBe(false)
    expect(depth.defines.AT_DEPTH_ONLY).toBe("")
  })

  it("clones stay attached to the shared uniforms", () => {
    const m = createWorldMaterial({ shared, levelUniform: () => levelUniform }, { levelId: "L", variant: "opaque", instanced: false })
    m.colorWrite = false
    const c = m.clone()
    expect(c.uniforms.uLights).toBe(shared.uLights)
    expect(c.uniforms.uLevelLayer).toBe(levelUniform)
    expect(c.colorWrite).toBe(false)
  })

  it("token material declares its uniforms and never discards", () => {
    const m = createTokenMaterial({ shared, isDimmed: () => false, layerOf: () => -1 }, { instanced: true })
    checkMaterial(m, ["color", "aDim", "aFade", "aPortrait"])
    expect(m.fragmentShader).not.toMatch(/\bdiscard\b/)
  })
})

describe("cutaway cap rule", () => {
  it("declares uCutawayY (default: no cutaway) and uses it only for caps", () => {
    expect(SHARED_UNIFORMS_GLSL).toMatch(/uniform float uCutawayY;/)
    expect(createSharedUniforms().uCutawayY.value).toBe(1e9)
    const body = COMMON_FUNCTIONS_GLSL.slice(COMMON_FUNCTIONS_GLSL.indexOf("vec3 atPointLights("))
    const uses = body.split("\n").filter((line) => /\buCutawayY\b/.test(line) && !line.trim().startsWith("//"))
    expect(uses.length).toBeGreaterThan(0)
    // Walkable / vertical surfaces keep light coming down stairwells: the cutaway test is gated on `cap`.
    for (const line of uses) expect(line).toMatch(/\(cap && p\.y > uCutawayY \+ AT_CAP_INSET && l0\.y > uCutawayY\)/)
    // Nothing else in the shared functions reads it.
    expect(COMMON_FUNCTIONS_GLSL.split("\n").filter((line) => /\buCutawayY\b/.test(line) && !line.trim().startsWith("//"))).toEqual(uses)
  })
})

describe("DM dark vision", () => {
  it("declares uDarkVision (default off) and only DM colour reads it", () => {
    expect(SHARED_UNIFORMS_GLSL).toMatch(/uniform vec2 uDarkVision;/)
    expect(createSharedUniforms().uDarkVision.value.x).toBe(0)
    const fns = COMMON_FUNCTIONS_GLSL.split(/\n(?=\S)/)
    const readers = fns.filter((f) => /\buDarkVision\b/.test(f.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")))
    expect(readers.map((f) => f.match(/^\w+\s+(\w+)\(/)?.[1])).toEqual(["atDarkVisionLook", "atDmColour"])
  })
})

describe("perception edges and darkvision (per pixel)", () => {
  const world = createWorldMaterial(
    { shared: createSharedUniforms(), levelUniform: () => ({ value: -1 }) },
    { levelId: "l", variant: "opaque", instanced: false }
  )
  const code = (src: string) =>
    src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")

  it("cuts darkvision / blindsight perception at the range per pixel, only with every viewer in a slot, never on touch", () => {
    const frag = code(world.fragmentShader)
    const cut = frag.split("\n").find((line) => /grade < 2\.5/.test(line) && /perceived \*=/.test(line))
    expect(cut).toBeDefined()
    expect(cut).toMatch(/uViewersAll > 0\.5/)
    expect(cut).toMatch(/!atTouched\(p\)/)
    expect(cut).toMatch(/atSenseWeight\(p, 1, AT_SENSE_EDGE\)/)
    // Sense weights read darkvision from slot 0 (.w of [0]) and blindsight from slot 1 (.w of [1]).
    expect(COMMON_FUNCTIONS_GLSL).toMatch(/float r = uViewers\[v \* 3 \+ slot\]\.w;/)
    expect(COMMON_FUNCTIONS_GLSL).toMatch(/uViewers\[v \* 3 \+ 2\]\.w\) return true;/)
  })

  it("skips light slots the per-cell mask clears, before fetching their uniforms (all bits without a mask)", () => {
    const body = code(COMMON_FUNCTIONS_GLSL)
    const loop = body.slice(body.indexOf("vec3 atPointLights("))
    const skip = loop.indexOf("if (((mask >> uint(i)) & 1u) == 0u) continue;")
    expect(skip).toBeGreaterThan(0)
    expect(skip).toBeLessThan(loop.indexOf("vec4 l0 = uLights[i * 4];"))
    expect(body).toMatch(/if \(uLightMaskGrid\.w < 0\.5\) return 0xFFFFFFFFu;/)
    expect(code(SHARED_UNIFORMS_GLSL)).toMatch(/uniform highp usampler2D uLightMask;/)
    const shared = createSharedUniforms()
    const t = shared.uLightMask.value as THREE.DataTexture
    expect(t.internalFormat).toBe("R32UI")
    expect(t.format).toBe(THREE.RedIntegerFormat)
    expect(Array.from(t.image.data as Uint32Array)).toEqual([0xffffffff])
    expect(shared.uLightMaskGrid.value.w).toBe(0)
  })

  it("raises darkvision colour by a capped gain before any grey, with the TypeScript mirror's constant", () => {
    expect(COMMON_FUNCTIONS_GLSL).toMatch(new RegExp(`#define AT_DV_MAX_GAIN ${DARKVISION_MAX_GAIN.toFixed(1)}\\b`))
    expect(COMMON_FUNCTIONS_GLSL).toMatch(/vec3 atGradeColour\(float grade, vec3 albedo, vec3 light, float dv, vec3 n\)/)
    expect(COMMON_FUNCTIONS_GLSL).toMatch(/c \* min\(target \/ max\(l, 1e-4\), AT_DV_MAX_GAIN\)/)
  })

  it("moves glow sprites toward the camera (bounded) with a hollow core over the flame", () => {
    const glow = createOverlayMaterial({ shared: createSharedUniforms(), layerOf: () => -1 }, { kind: "glow" })
    const vert = code(glow.vertexShader)
    expect(vert).toMatch(/#define AT_GLOW_PUSH 0\.6\b/)
    expect(vert).toMatch(/centre\.xyz \+ toCamera \* min\(0\.5 \* size, AT_GLOW_PUSH\)/)
    // Perception stays at the flame, not at the moved sprite.
    expect(vert).toMatch(/vWorldPos = centre\.xyz;/)
    expect(code(glow.fragmentShader)).toMatch(/g \*= atSmoothstepSafe\(0\.05, 0\.3, r\);/)
  })

  it("averages the fine noise band over two rotated lattices only when magnified", () => {
    const body = code(DETAIL_GLSL)
    expect(body).toMatch(/float mag = atMagnified\(/)
    expect(body).toMatch(/if \(mag > 0\.0\) \{/)
    expect(body).toMatch(/fine = mix\(fine, 0\.5 \+ \(fine \+ fine2 - 1\.0\) \* 0\.7071, mag\);/)
  })
})

describe("GLSL constants mirror the TypeScript side", () => {
  const define = (src: string, name: string) => Number(new RegExp(`#define ${name} ([-0-9.e]+)`).exec(src)?.[1])
  it("keeps epsilons, cap inset and directional bias in sync", () => {
    expect(define(SHARED_UNIFORMS_GLSL, "AT_DIST_EPS")).toBe(DISTANCE_EPSILON)
    expect(define(COMMON_FUNCTIONS_GLSL, "AT_CAP_INSET")).toBe(CAP_INSET)
    expect(define(COMMON_FUNCTIONS_GLSL, "AT_CAP_EPS")).toBe(CAP_EPSILON)
    expect(define(COMMON_FUNCTIONS_GLSL, "AT_DIR_BIAS_FT")).toBe(DIRECTIONAL_BIAS_FT)
  })
})

describe("overlay (glass / flame) shaders", () => {
  const shared = createSharedUniforms()

  it("declare their uniforms, share the globals and never discard", () => {
    for (const kind of ["glass", "flame", "glow"] as const) {
      const m = createOverlayMaterial({ shared, layerOf: () => 0 }, { kind })
      checkMaterial(m, ["color"])
      expect(m.uniforms.uMasks).toBe(shared.uMasks)
      expect(m.fragmentShader).not.toMatch(/\bdiscard\b/)
      // Fog fades them through alpha, so both blend.
      expect(m.transparent).toBe(true)
      expect(m.toneMapped).toBe(false)
    }
  })

  it("glass is a faint double-sided pane without depth writes; flames are flagged for the shader", () => {
    const glass = createOverlayMaterial({ shared, layerOf: () => 0 }, { kind: "glass" })
    expect(glass.uniforms.uOpacity.value).toBe(GLASS_OPACITY)
    expect(glass.depthWrite).toBe(false)
    expect(glass.side).toBe(THREE.DoubleSide)
    expect(glass.defines.AT_FLAME).toBeUndefined()
    const flame = createOverlayMaterial({ shared, layerOf: () => 0 }, { kind: "flame" })
    expect(flame.defines.AT_FLAME).toBe("")
    expect(flame.uniforms.uOpacity.value).toBe(1)
  })

  it("picks the host-mask layer from the drawn object's level", () => {
    const layers: Record<string, number> = { A: 2, B: 5 }
    const m = createOverlayMaterial({ shared, layerOf: (id) => layers[id] ?? -1 }, { kind: "flame" })
    const call = (levelId: unknown) => {
      const o = new THREE.Object3D()
      o.userData.levelId = levelId
      m.onBeforeRender(null as never, null as never, null as never, null as never, o as never, null as never)
      return m.uniforms.uLevelLayer.value as number
    }
    expect(call("A")).toBe(2)
    expect(call("B")).toBe(5)
    expect(call(undefined)).toBe(-1)
  })
})

describe("occluder / re-encode shaders", () => {
  it("declare exactly their uniforms", () => {
    checkMaterial(createOccluderDistanceMaterial(), ["aKey"])
    checkMaterial(createOccluderDepthMaterial(), ["aKey"])
    checkMaterial(createReencodeMaterial(), [])
  })

  it("render back faces without blending", () => {
    for (const m of [createOccluderDistanceMaterial(), createOccluderDepthMaterial()]) {
      expect(m.side).toBe(THREE.BackSide)
      expect(m.blending).toBe(THREE.NoBlending)
    }
    expect(createOccluderDepthMaterial().colorWrite).toBe(false)
  })
})

describe("precompileScene", () => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera()
  it("compiles in parallel only with KHR_parallel_shader_compile, else synchronously, and never rejects", async () => {
    const calls: string[] = []
    const parallel = {
      extensions: { has: (n: string) => n === "KHR_parallel_shader_compile" },
      compileAsync: () => (calls.push("async"), Promise.reject(new Error("lost"))),
      compile: () => calls.push("sync"),
    }
    await expect(precompileScene(parallel as never, scene, camera)).resolves.toBeUndefined()
    const serial = { extensions: { has: () => false }, compileAsync: () => (calls.push("async"), Promise.resolve()), compile: () => calls.push("sync") }
    await precompileScene(serial as never, scene, camera)
    await precompileScene({} as never, scene, camera)
    expect(calls).toEqual(["async", "sync"])
  })
})

describe("procedural surface materials", () => {
  it("mirror MAT ids in the AT_MAT_* defines and size the parameter table to match", () => {
    for (const [name, id] of Object.entries(MAT)) {
      expect(Number(new RegExp(`#define AT_MAT_${name} (\\d+)`).exec(DETAIL_GLSL)?.[1]), name).toBe(id)
    }
    const count = Object.keys(MAT).length
    expect(SURFACE_TABLE).toHaveLength(count)
    for (const rows of SURFACE_TABLE) expect(rows).toHaveLength(SURFACE_TABLE_ROWS)
    expect(DETAIL_GLSL).toContain(`#define AT_MAT_ROWS ${SURFACE_TABLE_ROWS}`)
    expect(DETAIL_GLSL).toContain(`uniform vec4 uMatTable[${count * SURFACE_TABLE_ROWS}];`)
    expect(surfaceTableUniform().value).toHaveLength(count * SURFACE_TABLE_ROWS * 4)
    // Pattern types are 0..3 and cell sizes positive.
    for (const [up, face] of SURFACE_TABLE) {
      for (const p of [up, face]) {
        expect([0, 1, 2, 3]).toContain(p[0])
        expect(p[1]).toBeGreaterThan(0)
        expect(p[2]).toBeGreaterThan(0)
      }
    }
  })

  it("maps scene materials and door styles to surfaces", () => {
    expect(surfaceOf("wood")).toBe(MAT.WOOD)
    expect(surfaceOf("cobble")).toBe(MAT.COBBLE)
    expect(surfaceOf("nonsense")).toBe(MAT.NONE)
    expect(doorSurface("wood", "stone")).toBe(MAT.WOOD)
    expect(doorSurface("iron", "stone")).toBe(MAT.METAL)
    expect(doorSurface("secret", "brick")).toBe(MAT.BRICK)
  })
})

describe("quality tier defines", () => {
  it("stamp AT_TIER on tracked materials and recompile them once per change", () => {
    const tiers = new TierRegistry(TIER_DEFINE.medium)
    const shared = createSharedUniforms()
    const m = createWorldMaterial({ shared, levelUniform: () => ({ value: 0 }), tiers }, { levelId: "L", variant: "opaque", instanced: false })
    expect(m.defines.AT_TIER).toBe("1")
    const v = m.version
    expect(tiers.set(TIER_DEFINE.ultra)).toBe(true)
    expect(m.defines.AT_TIER).toBe("3")
    expect(m.version).toBeGreaterThan(v)
    expect(tiers.set(TIER_DEFINE.ultra)).toBe(false)
    m.dispose()
    expect(tiers.size).toBe(0)
  })

  it("compile the tier-only code paths behind AT_TIER", () => {
    const shared = createSharedUniforms()
    const m = createWorldMaterial({ shared, levelUniform: () => ({ value: 0 }) }, { levelId: "L", variant: "opaque", instanced: false })
    // PCSS and the hi-res atlas exist only on ultra; bump mapping from high up.
    expect(m.fragmentShader).toMatch(/#if AT_TIER >= 3\n\/\/ Rotated Poisson disc/)
    expect(m.fragmentShader).toMatch(/#if AT_TIER >= 2\n {2}nb = atBumpNormal/)
    // Unset tier: defaults to low.
    expect(m.fragmentShader).toMatch(/#ifndef AT_TIER\n#define AT_TIER 0/)
  })
})

describe("level backdrop uniforms", () => {
  it("default to a transparent placeholder and switch without new uniforms", () => {
    const u = createBackdropUniforms()
    expect(u.uBackdropParams.value.x).toBe(0)
    const tex = new THREE.Texture()
    setBackdropUniforms(u, tex, { x: 10, z: 20, w: 100, d: 50 }, 0.8, true)
    expect(u.uBackdrop.value).toBe(tex)
    expect(u.uBackdropRect.value.toArray()).toEqual([10, 20, 0.01, 0.02])
    expect(u.uBackdropParams.value.toArray()).toEqual([0.8, 1, 0, 0])
    setBackdropUniforms(u, null, null, 1, false)
    expect(u.uBackdrop.value).not.toBe(tex)
    expect(u.uBackdropParams.value.x).toBe(0)
  })

  it("are shared by the level's world materials", () => {
    const shared = createSharedUniforms()
    const own = createBackdropUniforms()
    const ctx = { shared, levelUniform: () => ({ value: 0 }), levelBackdrop: () => own }
    const a = createWorldMaterial(ctx, { levelId: "L", variant: "opaque", instanced: false })
    const b = createWorldMaterial(ctx, { levelId: "L", variant: "ghost", instanced: true })
    expect(a.uniforms.uBackdrop).toBe(own.uBackdrop)
    expect(b.uniforms.uBackdropParams).toBe(own.uBackdropParams)
  })
})
