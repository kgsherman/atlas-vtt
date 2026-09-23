import { describe, expect, it } from "vitest"

import { MIGRATIONS, migrateToCurrent, readSchemaVersion, type Migration } from "./migrations"
import { SCENE_SCHEMA_VERSION } from "./types"

describe("migrateToCurrent", () => {
  it("has no migrations while the schema is at v1", () => {
    expect(SCENE_SCHEMA_VERSION).toBe(1)
    expect(Object.keys(MIGRATIONS)).toEqual([])
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
