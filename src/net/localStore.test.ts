import { describe, expect, it } from "vitest"

import { createMemoryStore, deleteDraft, listDrafts, loadDraft, openLocalStore, saveDraft, type LocalStore } from "./localStore"

describe("openLocalStore", () => {
  it("falls back to memory when IndexedDB is unavailable (Node/Vitest)", async () => {
    expect(typeof globalThis.indexedDB).toBe("undefined")
    const store = await openLocalStore()
    expect(store.backend).toBe("memory")
  })

  it("falls back to memory when IndexedDB is disabled explicitly", async () => {
    expect((await openLocalStore({ indexedDB: null })).backend).toBe("memory")
  })

  it("falls back to memory when opening IndexedDB fails", async () => {
    const broken = {
      open() {
        const req: Record<string, unknown> = { error: new Error("SecurityError") }
        setTimeout(() => (req.onerror as (() => void) | undefined)?.(), 0)
        return req
      },
    } as unknown as IDBFactory
    expect((await openLocalStore({ indexedDB: broken })).backend).toBe("memory")
  })
})

describe("memory store", () => {
  const fresh = (): LocalStore => createMemoryStore()

  it("gets, puts and deletes per object store", async () => {
    const s = fresh()
    await s.put("scenes", "a", { n: 1 })
    await s.put("drafts", "a", { n: 2 })
    expect(await s.get("scenes", "a")).toEqual({ n: 1 })
    expect(await s.get("drafts", "a")).toEqual({ n: 2 })
    await s.delete("scenes", "a")
    expect(await s.get("scenes", "a")).toBeUndefined()
    expect(await s.get("drafts", "a")).toEqual({ n: 2 })
  })

  it("never aliases stored values (structured clone in and out)", async () => {
    const s = fresh()
    const value = { list: [1, 2] }
    await s.put("scenes", "k", value)
    value.list.push(3)
    const read = await s.get<{ list: number[] }>("scenes", "k")
    expect(read).toEqual({ list: [1, 2] })
    read?.list.push(4)
    expect(await s.get("scenes", "k")).toEqual({ list: [1, 2] })
  })

  it("lists keys and entries in ascending order, filtered by prefix", async () => {
    const s = fresh()
    for (const k of ["b:2", "a:1", "b:10", "b:1", "c"]) await s.put("sceneVersions", k, k)
    expect(await s.keys("sceneVersions")).toEqual(["a:1", "b:1", "b:10", "b:2", "c"])
    expect(await s.keys("sceneVersions", "b:")).toEqual(["b:1", "b:10", "b:2"])
    expect(await s.entries("sceneVersions", "b:1")).toEqual([
      ["b:1", "b:1"],
      ["b:10", "b:10"],
    ])
  })

  it("deletes by prefix", async () => {
    const s = fresh()
    for (const k of ["x:1", "x:2", "y:1"]) await s.put("sessions", k, 1)
    expect(await s.deletePrefix("sessions", "x:")).toBe(2)
    expect(await s.keys("sessions")).toEqual(["y:1"])
  })
})

describe("autosave drafts", () => {
  it("saves, loads, lists (newest first) and deletes drafts", async () => {
    const s = createMemoryStore()
    await saveDraft(s, "scene-1", { name: "first" })
    await new Promise((r) => setTimeout(r, 2))
    const second = await saveDraft(s, "scene-2", { name: "second" })
    expect(await loadDraft(s, "scene-2")).toEqual(second)
    expect((await listDrafts(s)).map((d) => d.key)).toEqual(["scene-2", "scene-1"])
    await deleteDraft(s, "scene-1")
    expect(await loadDraft(s, "scene-1")).toBeUndefined()
  })
})
