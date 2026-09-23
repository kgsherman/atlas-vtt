/**
 * Builds the free token models (category "token-models", docs/ARCHITECTURE.md §4.3) from miniature
 * STL sculpts: one GLB per model with three levels of detail plus a PNG thumbnail.
 *
 *   node scripts/free-assets/build-token-models.mjs --in "<folder with the .stl files>" --out <folder>
 *
 * Per model (MODELS below): weld the triangle soup, turn it Z-up → Y-up with the figure facing +Z,
 * cut away a sculpted base (the token draws its own), move the volume centroid to x = z = 0 and the
 * lowest point to y = 0, and scale so 1 unit = one footprint side (a 25.4 mm base = one cell by default).
 * The GLB holds three meshes named lod0 / lod1 / lod2 (LOD_TRIANGLES, most detailed first), quantized
 * and meshopt-compressed (EXT_meshopt_compression, KHR_mesh_quantization), with smooth normals and no
 * materials. `catalog.json` in the output folder lists the metadata for the `free_assets` table.
 *
 * Upload the output folder to the public `free-assets` bucket under `token-models/` and upsert the
 * catalog rows (a secret key bypasses the bucket's "no client writes" rule), e.g.
 *
 *   SUPABASE_URL=… SUPABASE_SECRET_KEY=… node scripts/free-assets/upload.mjs --dir <folder>
 */
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

import { Document, NodeIO } from "@gltf-transform/core"
import {
  EXTMeshoptCompression,
  KHRMeshQuantization,
} from "@gltf-transform/extensions"
import { meshopt } from "@gltf-transform/functions"
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer"

/**
 * `front`: the STL axis the figure faces (it ends up facing +Z, toward the default player camera).
 * `baseCutZ`: STL height below which a sculpted base is removed. `mmPerSide`: model millimetres per
 * footprint side (default 25.4, a 1" base).
 */
const MODELS = [
  {
    id: "elf-archer",
    name: "Elf archer",
    file: "ElfArcher.stl",
    front: "+x",
    baseCutZ: 0.3,
    mmPerSide: 30,
  },
  {
    id: "halfling-thief",
    name: "Halfling thief",
    file: "Halfling Thief.stl",
    front: "-y",
    size: "small",
  },
  {
    id: "kenku-rogue",
    name: "Kenku rogue",
    file: "KenkuRogue.stl",
    front: "+x",
  },
  {
    id: "warforged-fighter",
    name: "Warforged fighter",
    file: "WarforgedFighter.stl",
    front: "+y",
  },
]

const LOD_TRIANGLES = [24_000, 6_000, 1_500]
const THUMB_PX = 256

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1])
const inDir = args.get("in")
const outDir = args.get("out")
if (!inDir || !outDir) {
  console.error(
    'usage: node scripts/free-assets/build-token-models.mjs --in "<stl folder>" --out <folder>'
  )
  process.exit(1)
}

await MeshoptSimplifier.ready
await MeshoptEncoder.ready
fs.mkdirSync(outDir, { recursive: true })

const catalog = []
for (const [order, m] of MODELS.entries()) {
  const t0 = Date.now()
  const soup = readStl(path.join(inDir, m.file))
  let mesh = weld(soup)
  if (m.baseCutZ !== undefined) mesh = cutBelow(mesh, m.baseCutZ)
  orient(mesh, m.front)
  normalize(mesh, m.mmPerSide ?? 25.4)
  const lods = LOD_TRIANGLES.map((target) => simplify(mesh, target))
  const glb = await writeGlb(lods, m)
  fs.writeFileSync(path.join(outDir, `${m.id}.glb`), glb)
  fs.writeFileSync(path.join(outDir, `${m.id}.png`), thumbnail(lods[0]))
  const box = bounds(lods[0].positions)
  catalog.push({
    id: m.id,
    category: "token-models",
    name: m.name,
    path: `token-models/${m.id}.glb`,
    thumbnailPath: `token-models/${m.id}.png`,
    bytes: glb.byteLength,
    sortOrder: order,
    metadata: {
      lods: lods.map((l) => l.indices.length / 3),
      height: round(box.max[1]),
      radius: round(Math.max(-box.min[0], box.max[0], -box.min[2], box.max[2])),
      ...(m.size ? { size: m.size } : {}),
    },
  })
  console.log(
    `${m.id}: ${soup.length / 9} → ${lods.map((l) => l.indices.length / 3).join(" / ")} triangles, ${(glb.byteLength / 1024).toFixed(0)} KiB, ${Date.now() - t0} ms`
  )
}
fs.writeFileSync(
  path.join(outDir, "catalog.json"),
  JSON.stringify(catalog, null, 2) + "\n"
)

// ---------------------------------------------------------------------------
// Mesh steps
// ---------------------------------------------------------------------------

/** Binary STL → triangle soup (9 floats per triangle). */
function readStl(file) {
  const b = fs.readFileSync(file)
  const n = b.readUInt32LE(80)
  if (84 + n * 50 !== b.length) throw new Error(`${file}: not a binary STL`)
  const out = new Float32Array(n * 9)
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 9; k++)
      out[i * 9 + k] = b.readFloatLE(84 + i * 50 + 12 + k * 4)
  return out
}

/** Merge bit-identical corners into shared vertices and drop degenerate triangles. */
function weld(soup) {
  const remap = MeshoptSimplifier.generatePositionRemap(soup, 3)
  const tri = []
  for (let i = 0; i < remap.length; i += 3) {
    const a = remap[i]
    const b = remap[i + 1]
    const c = remap[i + 2]
    if (a !== b && b !== c && a !== c) tri.push(a, b, c)
  }
  return compact(soup, Uint32Array.from(tri))
}

/** Keep only the vertices the indices use. */
function compact(positions, indices) {
  const map = new Int32Array(positions.length / 3).fill(-1)
  const out = []
  const idx = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]
    if (map[v] < 0) {
      map[v] = out.length / 3
      out.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2])
    }
    idx[i] = map[v]
  }
  return { positions: Float32Array.from(out), indices: idx }
}

/**
 * Remove every triangle whose centroid lies below `z` (STL axes, Z up), then the small islands the cut
 * leaves of a textured base top (components under 0.5% of the triangles and under 3 mm across).
 */
function cutBelow(mesh, z) {
  const { positions: p, indices } = mesh
  const kept = []
  for (let i = 0; i < indices.length; i += 3) {
    const cz =
      (p[indices[i] * 3 + 2] +
        p[indices[i + 1] * 3 + 2] +
        p[indices[i + 2] * 3 + 2]) /
      3
    if (cz >= z) kept.push(indices[i], indices[i + 1], indices[i + 2])
  }
  const tri = Uint32Array.from(kept)
  // Union-find over shared vertices.
  const parent = new Int32Array(p.length / 3).map((_, i) => i)
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]]
    return a
  }
  for (let i = 0; i < tri.length; i += 3) {
    const a = find(tri[i])
    parent[find(tri[i + 1])] = a
    parent[find(tri[i + 2])] = a
  }
  const comps = new Map()
  for (let i = 0; i < tri.length; i += 3) {
    const r = find(tri[i])
    let c = comps.get(r)
    if (!c)
      comps.set(
        r,
        (c = {
          count: 0,
          min: [Infinity, Infinity, Infinity],
          max: [-Infinity, -Infinity, -Infinity],
        })
      )
    c.count++
    for (let k = 0; k < 3; k++)
      for (let a = 0; a < 3; a++) {
        const v = p[tri[i + k] * 3 + a]
        if (v < c.min[a]) c.min[a] = v
        if (v > c.max[a]) c.max[a] = v
      }
  }
  const total = tri.length / 3
  const out = []
  for (let i = 0; i < tri.length; i += 3) {
    const c = comps.get(find(tri[i]))
    const span = Math.hypot(
      c.max[0] - c.min[0],
      c.max[1] - c.min[1],
      c.max[2] - c.min[2]
    )
    if (c.count >= total * 0.005 || span >= 3)
      out.push(tri[i], tri[i + 1], tri[i + 2])
  }
  return compact(p, Uint32Array.from(out))
}

/** STL Z-up → Y-up (x, z, −y), then turn about +Y so the figure's front faces +Z. */
function orient(mesh, front) {
  // After (x, y, z) → (x, z, −y) the STL −Y axis points along +Z.
  const angle = {
    "-y": 0,
    "+x": -Math.PI / 2,
    "+y": Math.PI,
    "-x": Math.PI / 2,
  }[front]
  if (angle === undefined) throw new Error(`unknown front axis ${front}`)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const p = mesh.positions
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]
    const y = p[i + 2]
    const z = -p[i + 1]
    p[i] = x * c + z * s
    p[i + 1] = y
    p[i + 2] = -x * s + z * c
  }
}

/** Centre the volume centroid on x = z = 0, rest the lowest point on y = 0, 1 unit = `mmPerSide`. */
function normalize(mesh, mmPerSide) {
  const { positions: p, indices } = mesh
  let vol = 0
  let cx = 0
  let cz = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3
    const b = indices[i + 1] * 3
    const c = indices[i + 2] * 3
    // Signed volume of the tetrahedron (origin, a, b, c).
    const v =
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6
    vol += v
    cx += (v * (p[a] + p[b] + p[c])) / 4
    cz += (v * (p[a + 2] + p[b + 2] + p[c + 2])) / 4
  }
  const box = bounds(p)
  // Open meshes can make the volume meaningless: fall back to the bounding box centre.
  const ok =
    Math.abs(vol) >
    1e-6 *
      (box.max[0] - box.min[0]) *
      (box.max[1] - box.min[1]) *
      (box.max[2] - box.min[2])
  const ox = ok ? cx / vol : (box.min[0] + box.max[0]) / 2
  const oz = ok ? cz / vol : (box.min[2] + box.max[2]) / 2
  const s = 1 / mmPerSide
  for (let i = 0; i < p.length; i += 3) {
    p[i] = (p[i] - ox) * s
    p[i + 1] = (p[i + 1] - box.min[1]) * s
    p[i + 2] = (p[i + 2] - oz) * s
  }
}

/** Simplified copy with about `target` triangles, compacted, with smooth normals. */
function simplify(mesh, target) {
  let indices = mesh.indices
  if (indices.length / 3 > target) {
    ;[indices] = MeshoptSimplifier.simplify(
      mesh.indices,
      mesh.positions,
      3,
      target * 3,
      0.05,
      ["Prune"]
    )
    if (indices.length / 3 > target * 1.25)
      [indices] = MeshoptSimplifier.simplifySloppy(
        mesh.indices,
        mesh.positions,
        3,
        null,
        target * 3,
        0.05
      )
  }
  const out = compact(mesh.positions, indices)
  out.normals = smoothNormals(out)
  return out
}

/** Area-weighted vertex normals. */
function smoothNormals({ positions: p, indices }) {
  const n = new Float32Array(p.length)
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3
    const b = indices[i + 1] * 3
    const c = indices[i + 2] * 3
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]]
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]
    const x = e1[1] * e2[2] - e1[2] * e2[1]
    const y = e1[2] * e2[0] - e1[0] * e2[2]
    const z = e1[0] * e2[1] - e1[1] * e2[0]
    for (const v of [a, b, c]) {
      n[v] += x
      n[v + 1] += y
      n[v + 2] += z
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1
    n[i] /= l
    n[i + 1] /= l
    n[i + 2] /= l
  }
  return n
}

function bounds(p) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3)
    for (let a = 0; a < 3; a++) {
      if (p[i + a] < min[a]) min[a] = p[i + a]
      if (p[i + a] > max[a]) max[a] = p[i + a]
    }
  return { min, max }
}

function round(v) {
  return Math.round(v * 1000) / 1000
}

// ---------------------------------------------------------------------------
// GLB
// ---------------------------------------------------------------------------

async function writeGlb(lods, m) {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const scene = doc.createScene(m.id)
  doc.getRoot().setDefaultScene(scene)
  lods.forEach((lod, k) => {
    const prim = doc
      .createPrimitive()
      .setAttribute(
        "POSITION",
        doc
          .createAccessor()
          .setType("VEC3")
          .setArray(lod.positions)
          .setBuffer(buffer)
      )
      .setAttribute(
        "NORMAL",
        doc
          .createAccessor()
          .setType("VEC3")
          .setArray(lod.normals)
          .setBuffer(buffer)
      )
      .setIndices(
        doc
          .createAccessor()
          .setType("SCALAR")
          .setArray(
            lod.positions.length / 3 > 65535
              ? lod.indices
              : Uint16Array.from(lod.indices)
          )
          .setBuffer(buffer)
      )
    const mesh = doc.createMesh(`lod${k}`).addPrimitive(prim)
    scene.addChild(doc.createNode(`lod${k}`).setMesh(mesh))
  })
  doc.getRoot().getAsset().extras = {
    atlas: {
      kind: "token-model",
      id: m.id,
      lods: lods.map((l) => l.indices.length / 3),
    },
  }
  // meshopt() reorders, quantizes (KHR_mesh_quantization) and compresses (EXT_meshopt_compression).
  await doc.transform(
    meshopt({
      encoder: MeshoptEncoder,
      level: "high",
      quantizePosition: 14,
      quantizeNormal: 10,
    })
  )
  const io = new NodeIO()
    .registerExtensions([KHRMeshQuantization, EXTMeshoptCompression])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder })
  return Buffer.from(await io.writeBinary(doc))
}

// ---------------------------------------------------------------------------
// Thumbnail: software render of the finest LOD (¾ view from the front right, above), RGBA PNG
// ---------------------------------------------------------------------------

function thumbnail(lod) {
  const S = THUMB_PX * 2 // 2× supersampled
  const yaw = Math.PI / 6
  const pitch = -0.35
  const { positions: p, normals: nrm, indices } = lod
  const view = (x, y, z) => {
    // Rotate about Y (yaw), then about X (pitch).
    const x1 = x * Math.cos(yaw) - z * Math.sin(yaw)
    const z1 = x * Math.sin(yaw) + z * Math.cos(yaw)
    const y2 = y * Math.cos(pitch) - z1 * Math.sin(pitch)
    const z2 = y * Math.sin(pitch) + z1 * Math.cos(pitch)
    return [x1, y2, z2]
  }
  const vp = []
  const vn = []
  for (let i = 0; i < p.length; i += 3) {
    vp.push(view(p[i], p[i + 1], p[i + 2]))
    vn.push(view(nrm[i], nrm[i + 1], nrm[i + 2]))
  }
  const min = [Infinity, Infinity]
  const max = [-Infinity, -Infinity]
  for (const v of vp)
    for (let a = 0; a < 2; a++) {
      min[a] = Math.min(min[a], v[a])
      max[a] = Math.max(max[a], v[a])
    }
  const span = Math.max(max[0] - min[0], max[1] - min[1]) * 1.08
  const cx = (min[0] + max[0]) / 2
  const cy = (min[1] + max[1]) / 2
  const sx = (v) => ((v[0] - cx) / span + 0.5) * S
  const sy = (v) => (0.5 - (v[1] - cy) / span) * S
  const zb = new Float32Array(S * S).fill(-Infinity)
  const nb = new Float32Array(S * S * 3)
  for (let i = 0; i < indices.length; i += 3) {
    const t = [indices[i], indices[i + 1], indices[i + 2]]
    const X = t.map((k) => sx(vp[k]))
    const Y = t.map((k) => sy(vp[k]))
    const Z = t.map((k) => vp[k][2])
    const d = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0])
    if (Math.abs(d) < 1e-12) continue
    const x0 = Math.max(0, Math.floor(Math.min(...X)))
    const x1 = Math.min(S - 1, Math.ceil(Math.max(...X)))
    const y0 = Math.max(0, Math.floor(Math.min(...Y)))
    const y1 = Math.min(S - 1, Math.ceil(Math.max(...Y)))
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5
        const py = y + 0.5
        const w1 =
          ((px - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (py - Y[0])) / d
        const w2 =
          ((X[1] - X[0]) * (py - Y[0]) - (px - X[0]) * (Y[1] - Y[0])) / d
        const w0 = 1 - w1 - w2
        if (w0 < 0 || w1 < 0 || w2 < 0) continue
        const z = w0 * Z[0] + w1 * Z[1] + w2 * Z[2]
        const o = y * S + x
        if (z <= zb[o]) continue
        zb[o] = z
        for (let a = 0; a < 3; a++)
          nb[o * 3 + a] = w0 * vn[t[0]][a] + w1 * vn[t[1]][a] + w2 * vn[t[2]][a]
      }
  }
  // Shade: warm key from the upper left, cool fill, rim; resin-like albedo.
  const key = unit([-0.5, 0.8, 0.6])
  const fill = unit([0.7, 0.2, 0.5])
  const albedo = [0.86, 0.83, 0.78]
  const W = THUMB_PX
  const rgba = Buffer.alloc(W * W * 4)
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0, 0]
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) {
          const o = (y * 2 + j) * S + (x * 2 + i)
          if (zb[o] === -Infinity) continue
          const n = unit([nb[o * 3], nb[o * 3 + 1], nb[o * 3 + 2]])
          const k = Math.max(0, dot(n, key))
          const f = Math.max(0, dot(n, fill))
          const rim = Math.pow(1 - Math.max(0, n[2]), 3)
          const light = [
            0.18 + 0.85 * k + 0.25 * f * 0.8 + 0.35 * rim,
            0.18 + 0.82 * k + 0.25 * f * 0.9 + 0.35 * rim,
            0.2 + 0.75 * k + 0.25 * f * 1.1 + 0.4 * rim,
          ]
          for (let a = 0; a < 3; a++)
            acc[a] += Math.min(1, albedo[a] * light[a])
          acc[3] += 1
        }
      const o = (y * W + x) * 4
      if (acc[3] === 0) continue
      for (let a = 0; a < 3; a++)
        rgba[o + a] = Math.round(Math.pow(acc[a] / acc[3], 1 / 1.2) * 255)
      rgba[o + 3] = Math.round((acc[3] / 4) * 255)
    }
  return png(W, W, rgba)
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function unit(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++)
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const crc = (buf) => {
    let x = 0xffffffff
    for (const b of buf) x = table[(x ^ b) & 255] ^ (x >>> 8)
    return (x ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
