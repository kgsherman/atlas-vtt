import { beforeEach, describe, expect, it, vi } from "vitest"

import { createScene } from "@/core/scene/factory"
import type { Scene } from "@/core/scene/types"

import { createMemoryStore } from "./localStore"
import {
  createLocalScenesRepo,
  createScenesRepo,
  exportSceneFile,
  importSceneFile,
  MAX_SCENE_VERSIONS,
  normalizeSceneName,
  sceneFileName,
  type ScenesRepo,
} from "./scenesRepo"
import { isNetError } from "./supabase"

// core/scene parseScene is owned (and tested) by the core-scene module; here it is a stand-in so these
// tests exercise only the repository: migrate/validate is modelled as "schemaVersion 1 → ok,
// higher → too-new, anything else → invalid".
vi.mock("@/core/scene/schema", () => ({
  parseScene: vi.fn((json: unknown) => {
    const doc = json as { schemaVersion?: unknown } | null
    if (doc && typeof doc === "object" && doc.schemaVersion === 1) return { ok: true, scene: structuredClone(doc), migratedFrom: null }
    if (doc && typeof doc === "object" && typeof doc.schemaVersion === "number" && doc.schemaVersion > 1) {
      return { ok: false, error: "too-new", issues: ["newer schema"] }
    }
    return { ok: false, error: "invalid", issues: ["not a scene"] }
  }),
  serializeScene: (scene: unknown) => JSON.stringify(scene),
}))

async function expectNetError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(isNetError(err), `expected NetError(${code}), got ${String(err)}`).toBe(true)
  expect((err as { code: string }).code).toBe(code)
}

describe("local scenes repo", () => {
  let repo: ScenesRepo
  let scene: Scene

  beforeEach(() => {
    repo = createLocalScenesRepo(createMemoryStore())
    scene = createScene({ name: "Crypt", width: 10, depth: 8 })
  })

  it("is chosen when no Supabase client is available", () => {
    expect(createScenesRepo({ client: null, store: createMemoryStore() }).storage).toBe("local")
  })

  it("creates a scene as version 1 and loads it back through parseScene", async () => {
    const summary = await repo.create(scene)
    expect(summary).toMatchObject({ name: "Crypt", latestVersion: 1, visibility: "private", shareSlug: null })
    expect(summary.id).toMatch(/^[0-9a-f-]{36}$/)
    const loaded = await repo.load(summary.id)
    expect(loaded.version).toBe(1)
    expect(loaded.parsed).toMatchObject({ ok: true })
    if (loaded.parsed.ok) expect(loaded.parsed.scene).toEqual(scene)
  })

  it("stores immutable versions and bumps latest_version", async () => {
    const { id } = await repo.create(scene)
    scene.name = "Crypt (lit)"
    expect(await repo.saveVersion(id, scene)).toBe(2)
    scene.meta.description = "third"
    expect(await repo.saveVersion(id, scene)).toBe(3)
    expect((await repo.get(id))?.latestVersion).toBe(3)
    expect((await repo.listVersions(id)).map((v) => v.version)).toEqual([3, 2, 1])
    const v1 = await repo.load(id, 1)
    expect(v1.parsed.ok && v1.parsed.scene.meta.description).toBe("")
    // A version never changes after it was written, even when the caller mutates its object.
    scene.meta.description = "mutated after save"
    const v3 = await repo.load(id, 3)
    expect(v3.parsed.ok && v3.parsed.scene.meta.description).toBe("third")
  })

  it("rejects a save based on a stale version", async () => {
    const { id } = await repo.create(scene)
    await repo.saveVersion(id, scene, { baseVersion: 1 })
    await expectNetError(repo.saveVersion(id, scene, { baseVersion: 1 }), "version_conflict")
  })

  it("prunes versions beyond the retention limit", async () => {
    const { id } = await repo.create(scene)
    for (let i = 0; i < MAX_SCENE_VERSIONS + 5; i++) await repo.saveVersion(id, scene)
    const versions = await repo.listVersions(id)
    expect(versions).toHaveLength(MAX_SCENE_VERSIONS)
    expect(versions[0].version).toBe(MAX_SCENE_VERSIONS + 6)
    await expectNetError(repo.load(id, 1), "not_found")
  })

  it("lists most recently updated first, renames and deletes", async () => {
    const a = await repo.create(createScene({ name: "A" }))
    const b = await repo.create(createScene({ name: "B" }))
    expect((await repo.list()).map((s) => s.name)).toEqual(["B", "A"])
    const renamed = await repo.rename(a.id, "  A   renamed ")
    expect(renamed.name).toBe("A renamed")
    expect((await repo.list()).map((s) => s.name)).toEqual(["A renamed", "B"])
    // The library row's name wins over the stored document's.
    const loaded = await repo.load(a.id)
    expect(loaded.parsed.ok && loaded.parsed.scene.name).toBe("A renamed")
    await repo.remove(b.id)
    expect((await repo.list()).map((s) => s.id)).toEqual([a.id])
    await expectNetError(repo.load(b.id), "not_found")
    await expectNetError(repo.remove(b.id), "not_found")
  })

  it("reports too-new documents instead of failing (opened read-only)", async () => {
    const { id } = await repo.create({ ...scene, schemaVersion: 2 as 1 })
    const loaded = await repo.load(id)
    expect(loaded.parsed).toEqual({ ok: false, error: "too-new", issues: ["newer schema"] })
  })

  it("names the image folders only this scene uses (not shared ones, not an active session's)", async () => {
    const store = createMemoryStore()
    const local = createLocalScenesRepo(store)
    const a = await local.create(scene)
    // Another library entry with the same document (a copy that kept Scene.id) shares its images.
    const copy = await local.create(scene)
    const other = createScene({ name: "Other" })
    await local.saveVersion(a.id, other)
    expect((await local.imageFoldersToFree(a.id)).sort()).toEqual([other.id])
    await local.remove(copy.id)
    expect((await local.imageFoldersToFree(a.id)).sort()).toEqual([scene.id, other.id].sort())
    // A running session on `other` keeps its folder.
    await store.put("sessions", "s:sess1", { id: "sess1", status: "active" })
    await store.put("sessions", "state:sess1", { epoch: 0, state: { kind: "seed", scene: { id: other.id } } })
    expect(await local.imageFoldersToFree(a.id)).toEqual([scene.id])
  })

  it("does not support sharing offline", async () => {
    const { id } = await repo.create(scene)
    await expectNetError(repo.setVisibility(id, "link"), "unsupported_offline")
    await expectNetError(repo.getShared("A".repeat(24)), "unsupported_offline")
  })
})

describe(".atlas.json export / import", () => {
  it("round-trips a scene and regenerates its id", () => {
    const scene = createScene({ name: "Tower of Doom!" })
    const file = exportSceneFile(scene)
    expect(file.fileName).toBe("tower-of-doom.atlas.json")
    expect(file.mimeType).toBe("application/json")
    const imported = importSceneFile(file.text)
    expect(imported.ok).toBe(true)
    if (imported.ok) {
      expect(imported.scene.id).not.toBe(scene.id)
      expect({ ...imported.scene, id: scene.id }).toEqual(scene)
    }
  })

  it("reports malformed files", () => {
    expect(importSceneFile("{not json")).toMatchObject({ ok: false, error: "invalid" })
    expect(importSceneFile('{"hello": 1}')).toMatchObject({ ok: false, error: "invalid" })
  })

  it("names files safely", () => {
    expect(sceneFileName("   ")).toBe("untitled-scene.atlas.json")
    expect(sceneFileName("../../etc/passwd")).toBe("etc-passwd.atlas.json")
    expect(sceneFileName("Château d'If")).toBe("chateau-d-if.atlas.json")
  })
})

describe("normalizeSceneName", () => {
  it("mirrors the SQL normaliser", () => {
    expect(normalizeSceneName("  a \n\t b  ")).toBe("a b")
    expect(normalizeSceneName("")).toBe("Untitled Scene")
    expect([...normalizeSceneName("é".repeat(300))]).toHaveLength(200)
  })
})
