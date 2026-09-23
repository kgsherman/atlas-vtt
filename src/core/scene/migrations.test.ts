/* eslint-disable @typescript-eslint/no-explicit-any -- these tests poke at raw, untyped JSON documents */
import { describe, expect, it } from "vitest"

import { MIGRATIONS, migrateToCurrent, readSchemaVersion, type Migration } from "./migrations"
import { parseScene } from "./schema"
import { SCENE_SCHEMA_VERSION } from "./types"

/**
 * A v1 document written by hand (never by the factory, which emits the current version): a terrain level
 * (one all-zero res-1 chunk) and a flat upper level, each with a wall.
 */
function v1Doc(): Record<string, any> {
  return {
    schemaVersion: 1,
    id: "scene1",
    name: "Old keep",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    grid: { cellSize: 5, width: 8, depth: 8, diagonalRule: "5-10-5" },
    environment: {
      skyLevel: "dark",
      ambientLevel: "dark",
      ambientColor: "#8090b0",
      ambientIntensity: 0.12,
      directional: { enabled: false, kind: "moon", azimuth: 2.35, elevation: 0.94, color: "#9fb4ff", intensity: 0.35, grants: "dim" },
      backgroundColor: "#0b0d10",
    },
    levels: {
      ground: {
        id: "ground",
        name: "Ground",
        elevation: 0,
        height: 10,
        floorThickness: 0.5,
        heightmap: { resolution: 1, chunks: { "0,0": "A".repeat(342) + "==" } },
      },
      upper: { id: "upper", name: "Upper", elevation: 10, height: 10, floorThickness: 0.5, heightmap: null },
    },
    objects: {
      floorG: { id: "floorG", type: "floor", levelId: "ground", rect: { x: 0, z: 0, w: 40, d: 40 }, material: "grass" },
      wallG: { id: "wallG", type: "wall", levelId: "ground", a: { x: 5, z: 5 }, b: { x: 30, z: 5 }, height: 10, thickness: 0.5, material: "stone" },
      doorG: {
        id: "doorG",
        type: "door",
        levelId: "ground",
        wallId: "wallG",
        offset: 10,
        width: 5,
        height: 7,
        state: "closed",
        style: "wood",
        leaves: "single",
        hinge: "start",
        swing: 1,
      },
      wallU: {
        id: "wallU",
        type: "wall",
        levelId: "upper",
        a: { x: 5, z: 20 },
        b: { x: 5, z: 35 },
        height: 8,
        thickness: 1,
        material: "wood",
        name: "Upper wall",
      },
    },
    tokens: {},
    meta: { description: "", author: "", tags: [] },
  }
}

describe("migrateToCurrent", () => {
  it("has one migration per version step", () => {
    expect(SCENE_SCHEMA_VERSION).toBe(3)
    expect(Object.keys(MIGRATIONS)).toEqual(["1", "2"])
  })

  it("migrates v1 documents (no token models) to v2 unchanged", () => {
    const doc = { schemaVersion: 1, name: "x", tokens: { t: { id: "t" } } }
    expect(MIGRATIONS[1](structuredClone(doc))).toEqual(doc)
    const res = migrateToCurrent(doc)
    expect(res).toEqual({ ok: true, doc: { schemaVersion: 3, name: "x", tokens: { t: { id: "t" } } }, from: 1 })
    expect(doc.schemaVersion).toBe(1)
  })

  it("passes current documents through untouched", () => {
    const doc = { schemaVersion: SCENE_SCHEMA_VERSION, name: "x" }
    const res = migrateToCurrent(doc)
    expect(res).toEqual({ ok: true, doc, from: SCENE_SCHEMA_VERSION })
  })

  it("rejects documents from a newer app as too-new", () => {
    const res = migrateToCurrent({ schemaVersion: SCENE_SCHEMA_VERSION + 1 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe("too-new")
  })

  it("rejects non-objects and bad versions as invalid", () => {
    for (const bad of [null, 42, "scene", [], {}, { schemaVersion: 0 }, { schemaVersion: 1.5 }, { schemaVersion: "1" }]) {
      const res = migrateToCurrent(bad)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toBe("invalid")
    }
    expect(readSchemaVersion({ schemaVersion: 3 })).toBe(3)
    expect(readSchemaVersion({ schemaVersion: -1 })).toBeNull()
  })

  describe("with injected migrations (simulating v3)", () => {
    // v1 → v2 renames `title` to `name`; v2 → v3 wraps `tags` into `meta`.
    const migrations: Record<number, Migration> = {
      1: (doc) => {
        const d = doc as Record<string, unknown>
        const { title, ...rest } = d
        return { ...rest, name: title }
      },
      2: (doc) => {
        const d = doc as Record<string, unknown>
        d.meta = { tags: d.tags }
        delete d.tags
        return d
      },
    }

    it("chains migrations and stamps each version", () => {
      const input = { schemaVersion: 1, title: "Old", tags: ["a"] }
      const res = migrateToCurrent(input, { migrations, currentVersion: 3 })
      expect(res).toEqual({ ok: true, from: 1, doc: { schemaVersion: 3, name: "Old", meta: { tags: ["a"] } } })
      // The caller's JSON is never mutated.
      expect(input).toEqual({ schemaVersion: 1, title: "Old", tags: ["a"] })
    })

    it("starts from the document's own version", () => {
      const res = migrateToCurrent({ schemaVersion: 2, name: "Mid", tags: [] }, { migrations, currentVersion: 3 })
      expect(res).toEqual({ ok: true, from: 2, doc: { schemaVersion: 3, name: "Mid", meta: { tags: [] } } })
    })

    it("fails cleanly on a missing step, a throwing step or a non-object result", () => {
      const gap = migrateToCurrent({ schemaVersion: 1 }, { migrations: { 2: migrations[2] }, currentVersion: 3 })
      expect(gap).toMatchObject({ ok: false, error: "invalid" })
      const throwing = migrateToCurrent(
        { schemaVersion: 1 },
        {
          migrations: {
            1: () => {
              throw new Error("boom")
            },
          },
          currentVersion: 2,
        }
      )
      expect(throwing).toMatchObject({ ok: false, error: "invalid", issues: ["migration 1→2 failed: boom"] })
      const nonObject = migrateToCurrent({ schemaVersion: 1 }, { migrations: { 1: () => [1, 2] }, currentVersion: 2 })
      expect(nonObject).toMatchObject({ ok: false, error: "invalid" })
    })
  })
})

describe("v2 → v3 (walls follow terrain)", () => {
  it("gives every wall followTerrain: true, on terrain and flat levels, and loads (from v1 and from v2)", () => {
    const v2 = { ...v1Doc(), schemaVersion: 2 }
    const r2 = parseScene(v2)
    expect(r2.ok && r2.migratedFrom === 2 && r2.scene.objects.wallG.type === "wall" && r2.scene.objects.wallG.followTerrain).toBe(true)
    const input = v1Doc()
    const before = structuredClone(input)
    const res = parseScene(input)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.migratedFrom).toBe(1)
    expect(res.scene.schemaVersion).toBe(3)
    expect(res.scene.objects.wallG).toMatchObject({ type: "wall", followTerrain: true })
    expect(res.scene.objects.wallU).toMatchObject({ type: "wall", followTerrain: true, name: "Upper wall" })
    // Nothing else changes: levels keep no terrain edits, other objects are identical.
    expect(res.scene.levels).toEqual(before.levels)
    expect(res.scene.objects.doorG).toEqual(before.objects.doorG)
    expect(res.scene.objects.floorG).toEqual(before.objects.floorG)
    // The caller's JSON is never mutated.
    expect(input).toEqual(before)
  })

  it("is idempotent and keeps boolean values", () => {
    const doc = v1Doc()
    doc.objects.wallU.followTerrain = false
    const once = MIGRATIONS[2](structuredClone(doc)) as Record<string, any>
    expect(once.objects.wallG.followTerrain).toBe(true)
    expect(once.objects.wallU.followTerrain).toBe(false)
    expect(MIGRATIONS[2](structuredClone(once))).toEqual(once)
  })

  it("never throws on garbage: the schema reports the problems", () => {
    const garbage: unknown[] = [
      { schemaVersion: 1 },
      { schemaVersion: 1, objects: "nope" },
      { ...v1Doc(), objects: { a: null, b: [1, 2], c: { type: "wall" }, d: 42 } },
      { ...v1Doc(), objects: { ...v1Doc().objects, wallG: { ...v1Doc().objects.wallG, a: "x" } } },
    ]
    for (const doc of garbage) {
      const res = parseScene(doc)
      expect(res.ok).toBe(false)
      if (res.ok) continue
      expect(res.error).toBe("invalid")
      expect(res.issues.length).toBeGreaterThan(0)
      expect(res.issues.join("\n")).not.toMatch(/migration/)
    }
    // A wall-shaped entry is migrated even when the rest of it is invalid (the schema names what is wrong).
    const res = parseScene({ ...v1Doc(), objects: { ...v1Doc().objects, wallG: { ...v1Doc().objects.wallG, height: -1 } } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.issues.join("\n")).toMatch(/objects\.wallG\.height/)
  })
})
