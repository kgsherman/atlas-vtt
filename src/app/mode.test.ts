import { describe, expect, it } from "vitest"

import { FORCE_LOCAL_KEY, modeSwitchUrl, resolveAppMode, withModeParam, type KeyValueStorage } from "./mode"

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

describe("resolveAppMode", () => {
  it("uses Supabase when configured and nothing is forced", () => {
    expect(resolveAppMode("", true, memoryStorage())).toEqual({ mode: "supabase", forcedLocal: false, cloudAvailable: true })
  })

  it("falls back to local mode without configuration", () => {
    expect(resolveAppMode("", false, memoryStorage())).toEqual({ mode: "local", forcedLocal: false, cloudAvailable: false })
    // ?local=1 without configuration is not "forced": there is nothing else.
    expect(resolveAppMode("?local=1", false, memoryStorage()).forcedLocal).toBe(false)
  })

  it("forces local mode with ?local=1 and persists it", () => {
    const storage = memoryStorage()
    expect(resolveAppMode("?local=1", true, storage)).toEqual({ mode: "local", forcedLocal: true, cloudAvailable: true })
    expect(storage.data.get(FORCE_LOCAL_KEY)).toBe("1")
    // Later navigations without the parameter keep it.
    expect(resolveAppMode("", true, storage).mode).toBe("local")
  })

  it("accepts ?local, ?local=true and clears with ?local=0", () => {
    const storage = memoryStorage()
    expect(resolveAppMode("?local", true, storage).mode).toBe("local")
    expect(resolveAppMode("?foo=1&local=true", true, storage).mode).toBe("local")
    expect(resolveAppMode("?local=0", true, storage).mode).toBe("supabase")
    expect(storage.data.has(FORCE_LOCAL_KEY)).toBe(false)
    expect(resolveAppMode("", true, storage).mode).toBe("supabase")
  })

  it("survives throwing or missing storage", () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
      removeItem: () => {
        throw new Error("denied")
      },
    }
    expect(resolveAppMode("?local=1", true, throwing).mode).toBe("local")
    expect(resolveAppMode("", true, throwing).mode).toBe("supabase")
    expect(resolveAppMode("?local=1", true, null).mode).toBe("local")
  })
})

describe("mode URLs", () => {
  it("builds switch URLs", () => {
    expect(modeSwitchUrl("local", "https://atlas.test/join/ABCD?x=1")).toBe("https://atlas.test/join/ABCD?x=1&local=1")
    expect(modeSwitchUrl("supabase", "https://atlas.test/?local=1")).toBe("https://atlas.test/?local=0")
  })

  it("appends ?local=1 only in forced local mode", () => {
    expect(withModeParam("/join/ABCD1234", { mode: "local", forcedLocal: true, cloudAvailable: true })).toBe("/join/ABCD1234?local=1")
    expect(withModeParam("/play/x?a=1", { mode: "local", forcedLocal: true, cloudAvailable: true })).toBe("/play/x?a=1&local=1")
    expect(withModeParam("/join/ABCD1234", { mode: "local", forcedLocal: false, cloudAvailable: false })).toBe("/join/ABCD1234")
    expect(withModeParam("/join/ABCD1234", { mode: "supabase", forcedLocal: false, cloudAvailable: true })).toBe("/join/ABCD1234")
  })
})
