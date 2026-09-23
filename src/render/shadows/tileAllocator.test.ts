import { describe, expect, it } from "vitest"

import { TileAllocator } from "./tileAllocator"

describe("TileAllocator", () => {
  it("lays tiles out in a grid covering the atlas", () => {
    const a = new TileAllocator<number>(4096, 2048, 512)
    expect(a.capacity).toBe(32)
    const low = new TileAllocator<number>(2048, 1024, 256)
    expect(low.capacity).toBe(32)
    const viewers = new TileAllocator<number>(4096, 2048, 1024)
    expect(viewers.capacity).toBe(8)
    const seen = new Set<string>()
    for (let k = 0; k < 32; k++) {
      const t = a.acquire(`o${k}`, 1)!
      expect(t.x + t.size).toBeLessThanOrEqual(4096)
      expect(t.y + t.size).toBeLessThanOrEqual(2048)
      seen.add(`${t.x},${t.y}`)
    }
    expect(seen.size).toBe(32)
  })

  it("keeps an owner's tile and its state across frames", () => {
    const a = new TileAllocator<string>(1024, 512, 512)
    const t = a.acquire("light:a", 1)!
    t.state = "captured"
    const again = a.acquire("light:a", 2)!
    expect(again).toBe(t)
    expect(again.state).toBe("captured")
    expect(again.lastUsed).toBe(2)
  })

  it("evicts the least recently used tile that is not in use this frame", () => {
    const a = new TileAllocator<string>(1024, 512, 512) // 2 tiles
    a.acquire("a", 1)!.state = "A"
    a.acquire("b", 2)!.state = "B"
    // Frame 3: "b" is in use; "c" must take "a"'s slot.
    a.touch("b", 3)
    const c = a.acquire("c", 3)!
    expect(c.state).toBeNull()
    expect(a.get("a")).toBeUndefined()
    expect(a.get("b")?.state).toBe("B")
    // Both slots are used in frame 3: a fourth owner gets nothing.
    expect(a.acquire("d", 3)).toBeUndefined()
    // Next frame the older of the two is evicted.
    a.touch("c", 4)
    const d = a.acquire("d", 4)!
    expect(d).toBeDefined()
    expect(a.get("b")).toBeUndefined()
  })

  it("prefers free slots and supports release/clear", () => {
    const a = new TileAllocator<number>(1024, 512, 512)
    a.acquire("a", 1)
    a.release("a")
    expect(a.get("a")).toBeUndefined()
    const b = a.acquire("b", 1)!
    expect(b.owner).toBe("b")
    a.clear()
    expect(a.owned()).toHaveLength(0)
    expect(a.acquire("c", 1)).toBeDefined()
  })
})
