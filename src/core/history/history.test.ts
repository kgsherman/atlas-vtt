import { applyPatches, produceWithPatches, type Draft } from "immer"
import { describe, expect, it } from "vitest"

import { createHistory, squashPatches, type History } from "./index"

interface Doc {
  items: Record<string, { x: number; name: string }>
  title: string
}

const base = (): Doc => ({ items: { a: { x: 0, name: "A" } }, title: "t" })

/** Minimal document holder wired to a History, mirroring what the editor store does. */
function harness(h: History = createHistory()) {
  let doc = base()
  return {
    h,
    get doc() {
      return doc
    },
    edit(label: string, recipe: (d: Draft<Doc>) => void, coalesceKey?: string) {
      const [next, patches, inversePatches] = produceWithPatches(doc, recipe)
      doc = next
      h.push({ label, patches, inversePatches }, { coalesceKey })
      return patches
    },
    undo() {
      const step = h.undo()
      if (step) doc = applyPatches(doc, step.patches)
      return step
    },
    redo() {
      const step = h.redo()
      if (step) doc = applyPatches(doc, step.patches)
      return step
    },
    begin(label: string) {
      return h.begin(label, doc)
    },
    cancel() {
      doc = applyPatches(doc, h.cancel())
    },
  }
}

describe("History: push / undo / redo", () => {
  it("undoes and redoes in order and reports labels", () => {
    const t = harness()
    t.edit("move", (d) => {
      d.items.a.x = 5
    })
    t.edit("rename", (d) => {
      d.title = "u"
    })
    expect(t.h.state()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: "rename", undoDepth: 2 })

    expect(t.undo()?.label).toBe("rename")
    expect(t.doc.title).toBe("t")
    expect(t.h.state()).toMatchObject({ undoLabel: "move", redoLabel: "rename" })
    expect(t.undo()?.label).toBe("move")
    expect(t.doc).toEqual(base())
    expect(t.undo()).toBeNull()

    t.redo()
    t.redo()
    expect(t.doc.items.a.x).toBe(5)
    expect(t.doc.title).toBe("u")
    expect(t.redo()).toBeNull()
  })

  it("clears the redo stack on a new push", () => {
    const t = harness()
    t.edit("a", (d) => {
      d.items.a.x = 1
    })
    t.undo()
    expect(t.h.state().canRedo).toBe(true)
    t.edit("b", (d) => {
      d.items.a.x = 2
    })
    expect(t.h.state().canRedo).toBe(false)
  })

  it("ignores empty entries", () => {
    const h = createHistory()
    h.push({ label: "noop", patches: [], inversePatches: [] })
    expect(h.state().canUndo).toBe(false)
  })

  it("caps the depth and drops the oldest steps", () => {
    const t = harness(createHistory({ limit: 3 }))
    for (let k = 1; k <= 5; k++) {
      t.edit(`step ${k}`, (d) => {
        d.items.a.x = k
      })
    }
    expect(t.h.state().undoDepth).toBe(3)
    while (t.undo());
    // Steps 1 and 2 were dropped: undo bottoms out at x = 2.
    expect(t.doc.items.a.x).toBe(2)
  })

  it("the default cap is 200", () => {
    const t = harness()
    for (let k = 0; k < 250; k++) {
      t.edit("n", (d) => {
        d.items.a.x = k + 1
      })
    }
    expect(t.h.state().undoDepth).toBe(200)
  })

  it("coalesces pushes with the same key inside the window", () => {
    let clock = 0
    const t = harness(createHistory({ now: () => clock, coalesceMs: 1000 }))
    t.edit("nudge", (d) => void (d.items.a.x += 1), "nudge")
    clock = 500
    t.edit("nudge", (d) => void (d.items.a.x += 1), "nudge")
    clock = 900
    t.edit("nudge", (d) => void (d.items.a.x += 1), "nudge")
    expect(t.h.state().undoDepth).toBe(1)
    clock = 5000
    t.edit("nudge", (d) => void (d.items.a.x += 1), "nudge")
    expect(t.h.state().undoDepth).toBe(2)
    t.undo()
    expect(t.doc.items.a.x).toBe(3)
    t.undo()
    expect(t.doc.items.a.x).toBe(0)
  })

  it("does not coalesce different keys or after an undo", () => {
    const t = harness(createHistory({ now: () => 0 }))
    t.edit("a", (d) => void (d.items.a.x = 1), "k1")
    t.edit("b", (d) => void (d.items.a.x = 2), "k2")
    expect(t.h.state().undoDepth).toBe(2)
    t.undo()
    t.edit("c", (d) => void (d.items.a.x = 3), "k1")
    // The top entry has key k1, but the redo stack is not empty at push time: a new step is recorded.
    expect(t.h.state().undoDepth).toBe(2)
  })

  it("changes head with every step and restores it on undo (dirty tracking)", () => {
    const t = harness()
    const h0 = t.h.state().head
    t.edit("a", (d) => void (d.items.a.x = 1))
    const h1 = t.h.state().head
    expect(h1).not.toBe(h0)
    t.undo()
    expect(t.h.state().head).toBe(h0)
    t.redo()
    expect(t.h.state().head).toBe(h1)
    t.h.clear()
    expect(t.h.state().head).not.toBe(h0)
  })

  it("discards the top of a stack", () => {
    const t = harness()
    t.edit("a", (d) => void (d.items.a.x = 1))
    t.undo()
    t.h.discard("redo")
    expect(t.h.state().canRedo).toBe(false)
  })

  it("notifies listeners and stops after unsubscribe", () => {
    const t = harness()
    const seen: number[] = []
    const off = t.h.subscribe((s) => seen.push(s.undoDepth))
    t.edit("a", (d) => void (d.items.a.x = 1))
    t.undo()
    off()
    t.redo()
    expect(seen).toEqual([1, 0])
  })
})

describe("History: transactions", () => {
  it("squashes a drag into one net step", () => {
    const t = harness()
    t.begin("drag")
    for (let k = 1; k <= 50; k++) t.edit("move", (d) => void (d.items.a.x = k))
    expect(t.h.state()).toMatchObject({ canUndo: false, transaction: { label: "drag" } })
    const entry = t.h.commit()
    expect(entry?.label).toBe("drag")
    expect(entry?.patches).toEqual([{ op: "replace", path: ["items", "a", "x"], value: 50 }])
    expect(t.h.state().undoDepth).toBe(1)
    t.undo()
    expect(t.doc.items.a.x).toBe(0)
    t.redo()
    expect(t.doc.items.a.x).toBe(50)
  })

  it("records nothing when a transaction has no net change", () => {
    const t = harness()
    t.begin("temp")
    t.edit("add", (d) => void (d.items.b = { x: 1, name: "B" }))
    t.edit("remove", (d) => void delete d.items.b)
    expect(t.h.commit()).toBeNull()
    expect(t.h.state().canUndo).toBe(false)
  })

  it("an add followed by edits squashes to a single add of the final value", () => {
    const t = harness()
    t.begin("place")
    t.edit("add", (d) => void (d.items.b = { x: 1, name: "B" }))
    t.edit("move", (d) => void (d.items.b.x = 7))
    const entry = t.h.commit()
    expect(entry?.patches).toEqual([{ op: "add", path: ["items", "b"], value: { x: 7, name: "B" } }])
    t.undo()
    expect(t.doc.items.b).toBeUndefined()
  })

  it("nested begin joins the outer transaction", () => {
    const t = harness()
    const id = t.begin("outer")
    expect(t.begin("inner")).toBe(id)
    t.edit("a", (d) => void (d.items.a.x = 1))
    expect(t.h.commit()).toBeNull()
    expect(t.h.inTransaction).toBe(true)
    t.edit("b", (d) => void (d.items.a.name = "Z"))
    expect(t.h.commit()?.label).toBe("outer")
    expect(t.h.state().undoDepth).toBe(1)
    t.undo()
    expect(t.doc).toEqual(base())
  })

  it("cancel returns patches reverting the transaction and records nothing", () => {
    const t = harness()
    t.edit("before", (d) => void (d.title = "before"))
    t.begin("drag")
    t.edit("m1", (d) => void (d.items.a.x = 3))
    t.edit("m2", (d) => void (d.items.b = { x: 1, name: "B" }))
    t.edit("m3", (d) => void (d.items.a.x = 9))
    t.cancel()
    expect(t.doc).toEqual({ ...base(), title: "before" })
    expect(t.h.inTransaction).toBe(false)
    expect(t.h.state().undoDepth).toBe(1)
  })

  it("undo/redo are refused while a transaction is open", () => {
    const t = harness()
    t.edit("a", (d) => void (d.items.a.x = 1))
    t.begin("txn")
    expect(t.h.undo()).toBeNull()
    expect(t.h.state().canUndo).toBe(false)
    t.h.commit()
    expect(t.h.state().canUndo).toBe(true)
  })

  it("without a base the transaction is concatenated (still one step)", () => {
    const t = harness()
    t.h.begin("raw")
    t.edit("a", (d) => void (d.items.a.x = 1))
    t.edit("b", (d) => void (d.items.a.x = 2))
    expect(t.h.commit()?.patches).toHaveLength(2)
    t.undo()
    expect(t.doc.items.a.x).toBe(0)
  })

  it("transaction ids are unique", () => {
    const h = createHistory()
    const a = h.begin("a")
    h.commit()
    const b = h.begin("b")
    expect(b).not.toBe(a)
    expect(h.transactionId).toBe(b)
  })
})

describe("squashPatches", () => {
  it("falls back to the raw sequence when the patches no longer replay onto the base", () => {
    const patches = [{ op: "replace" as const, path: ["missing", "deep"], value: 1 }]
    const inverse = [{ op: "replace" as const, path: ["missing", "deep"], value: 0 }]
    expect(squashPatches(base(), patches, inverse)).toEqual({ patches, inversePatches: inverse })
  })

  it("replays onto the base and returns net patches and inverses", () => {
    const doc = base()
    const [s1, p1, i1] = produceWithPatches(doc, (d) => void (d.items.a.x = 1))
    const [, p2, i2] = produceWithPatches(s1, (d) => void (d.items.a.x = 2))
    const net = squashPatches(doc, [...p1, ...p2], [...i2, ...i1])
    expect(net.patches).toEqual([{ op: "replace", path: ["items", "a", "x"], value: 2 }])
    expect(applyPatches(applyPatches(doc, net.patches), net.inversePatches)).toEqual(doc)
  })
})
