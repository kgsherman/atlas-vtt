/**
 * Scene library (ARCHITECTURE §3): `scenes` rows + immutable `scene_versions` in Supabase, or the
 * same model in IndexedDB (localStore) in local-only mode. Every document read back goes through
 * core/scene parseScene (migrate → strict validate → reference check); `too-new` documents are
 * returned as such so the editor can open them read-only.
 *
 * Library ids (`SceneSummary.id`) are storage ids (UUIDs). They are unrelated to the document's own
 * `Scene.id` and are never capabilities: remote access is owner-only by RLS, and link shares are read
 * exclusively through get_shared_scene(slug).
 */
import { newId } from "@/core/scene/factory"
import { parseScene, serializeScene, type ParseSceneResult } from "@/core/scene/schema"
import type { Scene } from "@/core/scene/types"

import type { Json } from "./database.types"
import { getLocalStore, type LocalStore } from "./localStore"
import { getSupabaseOrNull, NetError, toNetError, unwrap, type AtlasClient } from "./supabase"

export type SceneVisibility = "private" | "link"

export interface SceneSummary {
  id: string
  name: string
  visibility: SceneVisibility
  /** Present only while visibility is "link". */
  shareSlug: string | null
  latestVersion: number
  createdAt: string
  updatedAt: string
}

export interface SceneVersionInfo {
  version: number
  schemaVersion: number
  createdAt: string
}

export interface LoadedScene {
  summary: SceneSummary
  version: number
  schemaVersion: number
  /** ok → the scene (its name follows the library row); too-new → open read-only; invalid → error. */
  parsed: ParseSceneResult
}

export interface SharedScene {
  name: string
  version: number
  schemaVersion: number
  parsed: ParseSceneResult
}

export interface SaveOptions {
  /** Fail with NetError("version_conflict") unless the latest version is still this one. */
  baseVersion?: number
  /** Also rename the library entry (defaults to the document's name). */
  name?: string
}

export interface ScenesRepo {
  readonly storage: "remote" | "local"
  /** My scenes, most recently updated first. */
  list(): Promise<SceneSummary[]>
  get(id: string): Promise<SceneSummary | null>
  /** New library entry with the scene as version 1. */
  create(scene: Scene): Promise<SceneSummary>
  /** Append an immutable version; returns the new version number. */
  saveVersion(id: string, scene: Scene, opts?: SaveOptions): Promise<number>
  /** Latest version by default. */
  load(id: string, version?: number): Promise<LoadedScene>
  listVersions(id: string): Promise<SceneVersionInfo[]>
  rename(id: string, name: string): Promise<SceneSummary>
  remove(id: string): Promise<void>
  /** Returns the share slug (null when private). Online only. `rotate` issues a new link. */
  setVisibility(id: string, visibility: SceneVisibility, opts?: { rotate?: boolean }): Promise<string | null>
  /** Read a link-shared scene (the FULL DM document). Online only. */
  getShared(slug: string): Promise<SharedScene>
}

/** Versions kept per scene (the server prunes older ones the same way). */
export const MAX_SCENE_VERSIONS = 50
export const SCENE_NAME_MAX = 200
export const SHARE_SLUG_RE = /^[A-Za-z0-9_-]{24}$/

/** Mirrors private.normalize_scene_name(). */
export function normalizeSceneName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const collapsed = name.replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim()
  const capped = [...collapsed].slice(0, SCENE_NAME_MAX).join("").trim()
  return capped || "Untitled Scene"
}

function asVisibility(value: string): SceneVisibility {
  return value === "link" ? "link" : "private"
}

/** parseScene, with the library row's name taking precedence over the stored document's. */
function parseStored(data: unknown, name: string): ParseSceneResult {
  const parsed = parseScene(data)
  if (parsed.ok) parsed.scene.name = name
  return parsed
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

const SUMMARY_COLUMNS = "id, name, visibility, share_slug, latest_version, created_at, updated_at"

interface SceneRow {
  id: string
  name: string
  visibility: string
  share_slug: string | null
  latest_version: number
  created_at: string
  updated_at: string
}

function fromRow(row: SceneRow): SceneSummary {
  return {
    id: row.id,
    name: row.name,
    visibility: asVisibility(row.visibility),
    shareSlug: row.share_slug,
    latestVersion: row.latest_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createRemoteScenesRepo(client: AtlasClient): ScenesRepo {
  const get = async (id: string): Promise<SceneSummary | null> => {
    const row = unwrap(await client.from("scenes").select(SUMMARY_COLUMNS).eq("id", id).maybeSingle())
    return row ? fromRow(row) : null
  }
  const mustGet = async (id: string): Promise<SceneSummary> => {
    const summary = await get(id)
    if (!summary) throw new NetError("not_found", "scene not found")
    return summary
  }

  return {
    storage: "remote",
    async list() {
      const rows = unwrap(await client.from("scenes").select(SUMMARY_COLUMNS).order("updated_at", { ascending: false }))
      return (rows ?? []).map(fromRow)
    },
    get,
    async create(scene) {
      const id = unwrap(
        await client.rpc("create_scene", { p_name: normalizeSceneName(scene.name), p_schema_version: scene.schemaVersion, p_data: scene as unknown as Json })
      )
      if (typeof id !== "string") throw new NetError("unknown", "create_scene returned no id")
      return mustGet(id)
    },
    async saveVersion(id, scene, opts = {}) {
      const version = unwrap(
        await client.rpc("save_scene_version", {
          p_scene_id: id,
          p_schema_version: scene.schemaVersion,
          p_data: scene as unknown as Json,
          ...(opts.baseVersion !== undefined ? { p_base_version: opts.baseVersion } : {}),
          p_name: normalizeSceneName(opts.name ?? scene.name),
        })
      )
      if (typeof version !== "number") throw new NetError("unknown", "save_scene_version returned no version")
      return version
    },
    async load(id, version) {
      const summary = await mustGet(id)
      const wanted = version ?? summary.latestVersion
      const row = unwrap(
        await client.from("scene_versions").select("version, schema_version, data").eq("scene_id", id).eq("version", wanted).maybeSingle()
      )
      if (!row) throw new NetError("not_found", `version ${wanted} not found`)
      return { summary, version: row.version, schemaVersion: row.schema_version, parsed: parseStored(row.data, summary.name) }
    },
    async listVersions(id) {
      const rows = unwrap(await client.from("scene_versions").select("version, schema_version, created_at").eq("scene_id", id).order("version", { ascending: false }))
      return (rows ?? []).map((r) => ({ version: r.version, schemaVersion: r.schema_version, createdAt: r.created_at }))
    },
    async rename(id, name) {
      const row = unwrap(await client.from("scenes").update({ name: normalizeSceneName(name) }).eq("id", id).select(SUMMARY_COLUMNS).maybeSingle())
      if (!row) throw new NetError("not_found", "scene not found")
      return fromRow(row)
    },
    async remove(id) {
      const rows = unwrap(await client.from("scenes").delete().eq("id", id).select("id"))
      if (!rows || rows.length === 0) throw new NetError("not_found", "scene not found")
    },
    async setVisibility(id, visibility, opts = {}) {
      const { data, error } = await client.rpc("set_scene_visibility", { p_scene_id: id, p_visibility: visibility, p_rotate: opts.rotate ?? false })
      if (error) throw toNetError(error)
      // Generated types say `string`, but SQL returns NULL when the scene goes private.
      return (data as string | null) ?? null
    },
    async getShared(slug) {
      if (!SHARE_SLUG_RE.test(slug)) throw new NetError("not_found", "invalid share link")
      const rows = unwrap(await client.rpc("get_shared_scene", { p_slug: slug }))
      const row = rows?.[0]
      if (!row) throw new NetError("not_found", "shared scene not found")
      return { name: row.name, version: row.version, schemaVersion: row.schema_version, parsed: parseStored(row.data, row.name) }
    },
  }
}

// ---------------------------------------------------------------------------
// Local (IndexedDB) — same model, no sharing
// ---------------------------------------------------------------------------

interface LocalSceneRecord {
  id: string
  name: string
  latestVersion: number
  createdAt: string
  updatedAt: string
}

interface LocalVersionRecord {
  version: number
  schemaVersion: number
  createdAt: string
  data: unknown
}

const versionKey = (id: string, version: number) => `${id}:${String(version).padStart(9, "0")}`

function localSummary(r: LocalSceneRecord): SceneSummary {
  return { id: r.id, name: r.name, visibility: "private", shareSlug: null, latestVersion: r.latestVersion, createdAt: r.createdAt, updatedAt: r.updatedAt }
}

/** Store a plain JSON copy (drops undefined, like the database would). */
function toStoredJson(scene: Scene): unknown {
  return JSON.parse(serializeScene(scene))
}

/** Monotonic ISO timestamps so "most recently updated" ordering is stable within one millisecond. */
let lastStamp = 0
function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return new Date(lastStamp).toISOString()
}

export function createLocalScenesRepo(storeOrPromise: LocalStore | Promise<LocalStore>): ScenesRepo {
  const store = () => Promise.resolve(storeOrPromise)
  const record = async (id: string) => {
    const r = await (await store()).get<LocalSceneRecord>("scenes", id)
    if (!r) throw new NetError("not_found", "scene not found")
    return r
  }
  const offline = () => new NetError("unsupported_offline", "sharing needs an online (Supabase) library")

  return {
    storage: "local",
    async list() {
      const all = await (await store()).entries<LocalSceneRecord>("scenes")
      return all.map(([, r]) => localSummary(r)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },
    async get(id) {
      const r = await (await store()).get<LocalSceneRecord>("scenes", id)
      return r ? localSummary(r) : null
    },
    async create(scene) {
      const s = await store()
      const now = stamp()
      const r: LocalSceneRecord = { id: crypto.randomUUID(), name: normalizeSceneName(scene.name), latestVersion: 1, createdAt: now, updatedAt: now }
      await s.put<LocalVersionRecord>("sceneVersions", versionKey(r.id, 1), { version: 1, schemaVersion: scene.schemaVersion, createdAt: now, data: toStoredJson(scene) })
      await s.put("scenes", r.id, r)
      return localSummary(r)
    },
    async saveVersion(id, scene, opts = {}) {
      const s = await store()
      const r = await record(id)
      if (opts.baseVersion !== undefined && opts.baseVersion !== r.latestVersion) {
        throw new NetError("version_conflict", `latest version is ${r.latestVersion}`)
      }
      const version = r.latestVersion + 1
      const now = stamp()
      await s.put<LocalVersionRecord>("sceneVersions", versionKey(id, version), { version, schemaVersion: scene.schemaVersion, createdAt: now, data: toStoredJson(scene) })
      await s.put<LocalSceneRecord>("scenes", id, { ...r, name: normalizeSceneName(opts.name ?? scene.name), latestVersion: version, updatedAt: now })
      // Prune like the server: keep the newest MAX_SCENE_VERSIONS.
      const oldest = version - MAX_SCENE_VERSIONS
      if (oldest >= 1) {
        for (const key of await s.keys("sceneVersions", `${id}:`)) {
          if (Number(key.slice(id.length + 1)) <= oldest) await s.delete("sceneVersions", key)
        }
      }
      return version
    },
    async load(id, version) {
      const r = await record(id)
      const wanted = version ?? r.latestVersion
      const v = await (await store()).get<LocalVersionRecord>("sceneVersions", versionKey(id, wanted))
      if (!v) throw new NetError("not_found", `version ${wanted} not found`)
      return { summary: localSummary(r), version: v.version, schemaVersion: v.schemaVersion, parsed: parseStored(v.data, r.name) }
    },
    async listVersions(id) {
      await record(id)
      const all = await (await store()).entries<LocalVersionRecord>("sceneVersions", `${id}:`)
      return all.map(([, v]) => ({ version: v.version, schemaVersion: v.schemaVersion, createdAt: v.createdAt })).sort((a, b) => b.version - a.version)
    },
    async rename(id, name) {
      const r = await record(id)
      const next = { ...r, name: normalizeSceneName(name), updatedAt: stamp() }
      await (await store()).put("scenes", id, next)
      return localSummary(next)
    },
    async remove(id) {
      const s = await store()
      await record(id)
      await s.deletePrefix("sceneVersions", `${id}:`)
      await s.delete("scenes", id)
    },
    async setVisibility() {
      throw offline()
    },
    async getShared() {
      throw offline()
    },
  }
}

export interface ScenesRepoOptions {
  /** null forces local mode. Default: the app client when Supabase is configured. */
  client?: AtlasClient | null
  store?: LocalStore | Promise<LocalStore>
}

/** Remote library when Supabase is configured, IndexedDB otherwise. */
export function createScenesRepo(opts: ScenesRepoOptions = {}): ScenesRepo {
  const client = opts.client === undefined ? getSupabaseOrNull() : opts.client
  return client ? createRemoteScenesRepo(client) : createLocalScenesRepo(opts.store ?? getLocalStore())
}

// ---------------------------------------------------------------------------
// .atlas.json files
// ---------------------------------------------------------------------------

export const SCENE_FILE_EXTENSION = ".atlas.json"
export const SCENE_FILE_MIME = "application/json"
/** Refuse absurdly large files before parsing (the schema bounds the document anyway). */
export const MAX_SCENE_FILE_BYTES = 64 * 1024 * 1024

export function sceneFileName(name: string): string {
  const base =
    normalizeSceneName(name)
      .toLowerCase()
      .normalize("NFKD")
      // drop combining marks so "â" becomes "a" rather than a separator
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "scene"
  return `${base}${SCENE_FILE_EXTENSION}`
}

/** Serialise a scene for download as `<name>.atlas.json` (the document itself is the file format). */
export function exportSceneFile(scene: Scene): { fileName: string; mimeType: string; text: string } {
  return { fileName: sceneFileName(scene.name), mimeType: SCENE_FILE_MIME, text: serializeScene(scene) }
}

/**
 * Parse an imported `.atlas.json`. On success the scene gets a fresh `Scene.id` (imports never
 * collide with, or impersonate, the document they were exported from).
 */
export function importSceneFile(text: string): ParseSceneResult {
  if (text.length > MAX_SCENE_FILE_BYTES) return { ok: false, error: "invalid", issues: [`file is larger than ${MAX_SCENE_FILE_BYTES} bytes`] }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: "invalid", issues: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }
  const parsed = parseScene(json)
  if (parsed.ok) parsed.scene.id = newId()
  return parsed
}
