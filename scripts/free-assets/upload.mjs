/**
 * Publishes built free assets (e.g. the output of build-token-models.mjs): uploads every file the
 * folder's catalog.json names to the public `free-assets` bucket (overwriting) and upserts the rows
 * of public.free_assets.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=sb_secret_… \
 *     node scripts/free-assets/upload.mjs --dir <folder> [--no-catalog]
 *
 * The bucket and the table have no client write policies, so this needs a secret key (it bypasses
 * RLS). SUPABASE_API_KEY + SUPABASE_ACCESS_TOKEN (a user's JWT) can be given instead when a policy
 * lets that user write; `--no-catalog` then skips the table (update it with SQL).
 */
import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const dirIndex = args.indexOf("--dir")
const dir = dirIndex >= 0 ? args[dirIndex + 1] : null
const withCatalog = !args.includes("--no-catalog")
const url = process.env.SUPABASE_URL?.replace(/\/+$/, "")
const apiKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_API_KEY
const bearer =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_ACCESS_TOKEN
if (!dir || !url || !apiKey || !bearer) {
  console.error(
    "usage: SUPABASE_URL=… SUPABASE_SECRET_KEY=… node scripts/free-assets/upload.mjs --dir <folder> [--no-catalog]"
  )
  process.exit(1)
}

const MIME = {
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".webp": "image/webp",
}
const headers = { apikey: apiKey, Authorization: `Bearer ${bearer}` }
const catalog = JSON.parse(
  fs.readFileSync(path.join(dir, "catalog.json"), "utf8")
)

for (const row of catalog) {
  for (const objectPath of [row.path, row.thumbnailPath].filter(Boolean)) {
    const file = path.join(dir, path.basename(objectPath))
    const type = MIME[path.extname(file)]
    if (!type) throw new Error(`${file}: unsupported file type`)
    const res = await fetch(
      `${url}/storage/v1/object/free-assets/${objectPath}`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": type,
          "x-upsert": "true",
          "Cache-Control": "max-age=3600",
        },
        body: fs.readFileSync(file),
      }
    )
    if (!res.ok)
      throw new Error(`upload ${objectPath}: ${res.status} ${await res.text()}`)
    console.log(`uploaded ${objectPath}`)
  }
}

if (withCatalog) {
  const rows = catalog.map((r) => ({
    id: r.id,
    category: r.category,
    name: r.name,
    description: r.description ?? "",
    path: r.path,
    thumbnail_path: r.thumbnailPath ?? null,
    bytes: r.bytes,
    metadata: r.metadata ?? {},
    attribution: r.attribution ?? null,
    sort_order: r.sortOrder ?? 0,
  }))
  const res = await fetch(`${url}/rest/v1/free_assets?on_conflict=id`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  })
  if (!res.ok)
    throw new Error(`catalog upsert: ${res.status} ${await res.text()}`)
  console.log(`upserted ${rows.length} catalog rows`)
}
