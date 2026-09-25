/**
 * Scene document migrations (docs/ARCHITECTURE.md §3).
 *
 * Migrations operate on UNKNOWN JSON, never on the current TypeScript types: a migration written
 * for v1→v2 must keep working after the types move on to v3. When bumping SCENE_SCHEMA_VERSION:
 *  1. freeze the old shape — copy the current zod schema into a versioned module (e.g. `schemaV1`)
 *     if a migration needs to read the old shape reliably;
 *  2. add `MIGRATIONS[N] = (doc) => …` converting a vN document into vN+1;
 *  3. update schema.ts to the new shape.
 * The framework stamps `schemaVersion` after each step, so a migration only reshapes data.
 */
import { SCENE_SCHEMA_VERSION } from "./types"

/** Converts a document of version N (the key) into version N+1. Input is a private deep copy; mutate or rebuild freely. */
export type Migration = (doc: unknown) => unknown

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * v2 → v3 (terrain shapes, follow-terrain walls): every wall gains `followTerrain: true`. A v2 wall stood on
 * the ground at its midpoint; on terrain a conforming base is the closest v3 equivalent (off would bury
 * walls on hills), and on flat levels both settings are identical. Levels are untouched (terrainEdits is
 * optional). Duck-typed and idempotent: anything that is not a wall record is left for the schema to report,
 * and a boolean `followTerrain` is kept.
 */
function wallsFollowTerrain(doc: unknown): unknown {
  if (!isRecord(doc) || !isRecord(doc.objects)) return doc
  for (const o of Object.values(doc.objects)) {
    if (isRecord(o) && o.type === "wall" && typeof o.followTerrain !== "boolean") o.followTerrain = true
  }
  return doc
}

/** v7 → v8: the scene's author and description were removed; only `meta.tags` remains. */
function dropMetaAuthorDescription(doc: unknown): unknown {
  if (isRecord(doc) && isRecord(doc.meta)) {
    delete doc.meta.author
    delete doc.meta.description
  }
  return doc
}

/** vN → vN+1 migrations keyed by N. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({
  // v2 added the optional Token.model; v1 documents are valid v2 documents.
  1: (doc: unknown) => doc,
  2: wallsFollowTerrain,
  // v4 added heightmap resolutions 8 and 16 and the "polygon" terrain shape kind; v3 documents are valid v4 documents.
  3: (doc: unknown) => doc,
  // v5 added the optional TerrainShape.innerEdges (loop cuts); v4 documents are valid v5 documents.
  4: (doc: unknown) => doc,
  // v6 added the optional Token.hp and Token.conditions; v5 documents are valid v6 documents.
  5: (doc: unknown) => doc,
  // v7 added the optional TerrainShape.innerPoints (where loop cuts cross); v6 documents are valid v7 documents.
  6: (doc: unknown) => doc,
  7: dropMetaAuthorDescription,
})

export type MigrateResult =
  | { ok: true; doc: unknown; from: number }
  | { ok: false; error: "too-new" | "invalid"; issues: string[] }

export interface MigrateOptions {
  /** Override the migration table (tests). */
  migrations?: Readonly<Record<number, Migration>>
  /** Override the current version (tests). */
  currentVersion?: number
}

/** The document's schemaVersion if it is a positive integer, else null. */
export function readSchemaVersion(json: unknown): number | null {
  if (!isRecord(json)) return null
  const v = json.schemaVersion
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null
}

/**
 * Bring a parsed JSON document up to the current schema version. Does not validate the result
 * (schema.ts parseScene does). Documents from a NEWER app version fail with "too-new" so the UI can
 * open them read-only instead of corrupting them. The input is never mutated.
 */
export function migrateToCurrent(json: unknown, opts: MigrateOptions = {}): MigrateResult {
  const migrations = opts.migrations ?? MIGRATIONS
  const current = opts.currentVersion ?? SCENE_SCHEMA_VERSION
  if (!isRecord(json)) return { ok: false, error: "invalid", issues: ["document is not a JSON object"] }
  const from = readSchemaVersion(json)
  if (from === null) return { ok: false, error: "invalid", issues: ["schemaVersion: expected a positive integer"] }
  if (from > current) {
    return { ok: false, error: "too-new", issues: [`schemaVersion ${from} is newer than this app supports (${current})`] }
  }
  if (from === current) return { ok: true, doc: json, from }

  let doc: unknown
  try {
    doc = structuredClone(json)
  } catch {
    return { ok: false, error: "invalid", issues: ["document is not plain JSON"] }
  }
  for (let v = from; v < current; v++) {
    const step = Object.hasOwn(migrations, v) ? migrations[v] : undefined
    if (!step) return { ok: false, error: "invalid", issues: [`no migration from schemaVersion ${v} to ${v + 1}`] }
    try {
      doc = step(doc)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: "invalid", issues: [`migration ${v}→${v + 1} failed: ${msg}`] }
    }
    if (!isRecord(doc)) return { ok: false, error: "invalid", issues: [`migration ${v}→${v + 1} did not return an object`] }
    doc.schemaVersion = v + 1
  }
  return { ok: true, doc, from }
}
