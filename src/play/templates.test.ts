import { describe, expect, it, vi } from "vitest"

import { buildOcclusionWorld } from "@/core/occlusion"
import { flatScene, tokenAt } from "@/core/movement/test-utils"
import { createWall } from "@/core/scene/factory"
import type { Id, Scene } from "@/core/scene/types"
import type { PickResult } from "@/render/contracts"

import {
  DEFAULT_TEMPLATE_SPEC,
  PlayController,
  type PlayControllerHost,
  type PlayPointerEvent,
} from "./controller"
import {
  DRAFT_ID,
  hostTemplateItems,
  playerTemplateItems,
  specOf,
  TemplateAreas,
  templateInput,
  templateTitle,
  type TemplateItem,
} from "./templateAreas"
import {
  AIMED_ELEVATION,
  snapAngle,
  tokenEdgePoint,
  type TemplateDraft,
  type TemplateSpec,
} from "./templateTool"

const pick = (
  ground: { x: number; z: number } | null,
  tokenId: Id | null = null
): PickResult => ({
  ground: ground ? { x: ground.x, y: 0, z: ground.z } : null,
  objectId: null,
  tokenId,
  hitPoint: null,
})

const ev = (
  p: PickResult,
  extra: Partial<PlayPointerEvent> = {}
): PlayPointerEvent => ({
  clientX: 0,
  clientY: 0,
  button: 0,
  shift: false,
  pick: p,
  ...extra,
})

function fixture(role: "player" | "dm" = "player") {
  const { scene, levelId } = flatScene(20, 20)
  const placed: TemplateDraft[] = []
  const hints: string[] = []
  const camera = vi.fn()
  const host: PlayControllerHost = {
    role,
    scene: () => scene,
    activeLevelId: () => levelId,
    canSelect: () => true,
    canDrag: () => true,
    movementLocked: () => false,
    freeMovement: () => false,
    speedLimit: () => null,
    groundAt: () => null,
    planner: null,
    onSelect: () => {},
    onMove: () => {},
    onDoor: () => {},
    onHint: (m) => hints.push(m),
    setCameraControls: camera,
    onTemplate: (d) => placed.push(d),
  }
  const c = new PlayController(host)
  return { scene, levelId, c, placed, hints, camera }
}

const spec = (partial: Partial<TemplateSpec> = {}): TemplateSpec => ({
  ...DEFAULT_TEMPLATE_SPEC,
  ...partial,
})

describe("template tool helpers", () => {
  it("finds where a ray from a token's centre leaves its space", () => {
    const t = { position: { x: 12.5, z: 12.5 }, size: "medium" as const }
    expect(tokenEdgePoint(t, 5, 0)).toEqual({ x: 15, z: 12.5 })
    const diag = tokenEdgePoint(t, 5, Math.PI / 4)
    expect(diag.x).toBeCloseTo(15)
    expect(diag.z).toBeCloseTo(15)
    const large = tokenEdgePoint(
      { position: { x: 10, z: 10 }, size: "large" },
      5,
      Math.PI
    )
    expect(large.x).toBeCloseTo(5)
  })

  it("snaps aims to 15° steps", () => {
    expect(snapAngle((44 * Math.PI) / 180)).toBeCloseTo((45 * Math.PI) / 180)
    expect(snapAngle((7 * Math.PI) / 180)).toBeCloseTo(0)
  })
})

describe("PlayController: Template tool", () => {
  it("hover shows a sphere centred on the nearest grid intersection; a click places it and returns to Move", () => {
    const f = fixture()
    f.c.setTool("template")
    f.c.pointerMove(ev(pick({ x: 21, z: 29 })))
    expect(f.c.templateDraft()?.geometry).toMatchObject({
      shape: "sphere",
      x: 20,
      z: 30,
      size: 20,
      elevation: 0,
    })
    f.c.pointerDown(ev(pick({ x: 21, z: 29 })))
    expect(f.camera).toHaveBeenLastCalledWith(false)
    f.c.pointerMove(ev(pick({ x: 24, z: 29 })))
    expect(f.c.templateDraft()?.geometry.x).toBe(25)
    f.c.pointerUp(ev(pick({ x: 24, z: 29 })))
    expect(f.placed).toHaveLength(1)
    expect(f.placed[0]).toMatchObject({
      tokenId: null,
      editing: null,
      geometry: { x: 25, z: 30, levelId: f.levelId },
    })
    expect(f.c.getTool()).toBe("move")
    expect(f.c.templateDraft()).toBeNull()
    expect(f.camera).toHaveBeenLastCalledWith(true)
  })

  it("aimed shapes: press sets the origin (half-cell lattice), drag aims (Shift snaps), release places", () => {
    const f = fixture()
    f.c.setTool("template")
    f.c.setTemplateSpec(spec({ shape: "cone", size: 15 }))
    f.c.pointerDown(ev(pick({ x: 11.1, z: 9.2 })))
    f.c.pointerMove(ev(pick({ x: 11.1, z: 30 }), { shift: true }))
    const g = f.c.templateDraft()!.geometry
    expect(g).toMatchObject({ x: 10, z: 10, elevation: AIMED_ELEVATION })
    expect(g.angle).toBeCloseTo(Math.PI / 2)
    f.c.pointerUp(ev(pick({ x: 11.1, z: 30 })))
    expect(f.placed[0].geometry.shape).toBe("cone")
  })

  it("a cone started on a token leaves from the edge of its space at half its height", () => {
    const f = fixture()
    const t = tokenAt(f.scene, f.levelId, { i: 2, j: 2 }, { height: 6 })
    f.c.setTool("template")
    f.c.setTemplateSpec(spec({ shape: "cone", size: 15 }))
    f.c.pointerDown(ev(pick({ x: 12.5, z: 12.5 }, t.id)))
    f.c.pointerMove(ev(pick({ x: 30, z: 12.5 })))
    f.c.pointerUp(ev(pick({ x: 30, z: 12.5 })))
    expect(f.placed[0].geometry).toMatchObject({ x: 15, z: 12.5, elevation: 3 })
    expect(f.placed[0].geometry.angle).toBeCloseTo(0)
  })

  it("auras go on the token clicked (or the selected one) at once", () => {
    const f = fixture()
    const t = tokenAt(f.scene, f.levelId, { i: 3, j: 3 })
    f.c.setTool("template")
    f.c.setTemplateSpec(spec({ size: 15, aura: true }))
    f.c.pointerDown(ev(pick({ x: 50, z: 50 })))
    expect(f.placed).toHaveLength(0)
    expect(f.hints).toEqual(["Click one of your tokens to give it the aura"])
    f.c.pointerDown(ev(pick({ x: 17.5, z: 17.5 }, t.id)))
    expect(f.placed[0]).toMatchObject({
      tokenId: t.id,
      geometry: { x: 17.5, z: 17.5 },
    })
    expect(f.c.getTool()).toBe("move")
    // With a token selected, a click anywhere puts it on that one.
    f.c.setSelected(t.id)
    f.c.setTool("template")
    f.c.pointerDown(ev(pick({ x: 50, z: 50 })))
    expect(f.placed[1].tokenId).toBe(t.id)
  })

  it("moving a template replaces it; Escape leaves the tool without placing", () => {
    const f = fixture()
    f.c.editTemplate("t1", spec({ shape: "line", size: 30 }), Math.PI)
    expect(f.c.getTool()).toBe("template")
    expect(f.c.templateEditing()).toBe("t1")
    f.c.pointerMove(ev(pick({ x: 40, z: 40 })))
    expect(f.c.templateDraft()?.geometry.angle).toBeCloseTo(Math.PI)
    f.c.pointerDown(ev(pick({ x: 40, z: 40 })))
    f.c.pointerUp(ev(pick({ x: 40, z: 40 })))
    expect(f.placed[0].editing).toBe("t1")
    f.c.setTool("template")
    expect(f.c.templateEditing()).toBeNull()
    f.c.pointerMove(ev(pick({ x: 10, z: 10 })))
    f.c.pointerDown(ev(pick({ x: 10, z: 10 })))
    f.c.cancel()
    expect(f.c.getTool()).toBe("move")
    expect(f.c.templateDraft()).toBeNull()
    expect(f.placed).toHaveLength(1)
  })
})

describe("template areas", () => {
  function items(levelId: Id): TemplateItem[] {
    return [
      {
        id: "t1",
        source: {
          shape: "sphere",
          levelId,
          x: 50,
          z: 50,
          elevation: 0,
          angle: 0,
          size: 10,
          width: 5,
          height: 40,
          tokenId: null,
        },
        color: "#f97316",
        label: "",
        name: "DM",
        mine: true,
        dm: true,
        hidden: false,
        canEdit: true,
      },
    ]
  }

  it("computes cells and affected tokens, and reuses them until something relevant changes", () => {
    const { scene, levelId } = flatScene(20, 20)
    const t = tokenAt(scene, levelId, { i: 10, j: 10 })
    const world = buildOcclusionWorld(scene)
    const areas = new TemplateAreas()
    const list = items(levelId)
    const [a] = areas.compute(scene, world, list, null)
    expect(a.tokenIds).toEqual([t.id])
    expect(a.cells[levelId].length).toBeGreaterThan(0)
    const [b] = areas.compute(scene, world, list, null)
    expect(b.cells).toBe(a.cells)
    expect(b.tokenIds).toBe(a.tokenIds)
    // A token moves away: tokens recomputed, cells kept.
    const moved: Scene = {
      ...scene,
      tokens: {
        ...scene.tokens,
        [t.id]: { ...t, position: { x: 92.5, z: 92.5 } },
      },
    }
    const [c] = areas.compute(moved, world, list, null)
    expect(c.cells).toBe(a.cells)
    expect(c.tokenIds).toEqual([])
    // A wall across the area: cells recomputed.
    const walled: Scene = { ...scene, objects: { ...scene.objects } }
    const w = createWall(levelId, { x: 52.6, z: 0 }, { x: 52.6, z: 100 })
    walled.objects[w.id] = w
    const [d] = areas.compute(walled, buildOcclusionWorld(walled), list, null)
    expect(d.cells).not.toBe(a.cells)
    expect(d.cells[levelId].length).toBeLessThan(a.cells[levelId].length)
  })

  it("adds the draft, and a moved template's draft replaces it", () => {
    const { scene, levelId } = flatScene(20, 20)
    const world = buildOcclusionWorld(scene)
    const areas = new TemplateAreas()
    const list = items(levelId)
    const geometry = { ...list[0].source, x: 20, z: 20 }
    const s = spec({ color: "#22d3ee" })
    const fresh = areas.compute(scene, world, list, {
      draft: { geometry, tokenId: null, editing: null },
      spec: s,
    })
    expect(fresh.map((v) => [v.id, v.draft])).toEqual([
      ["t1", false],
      [DRAFT_ID, true],
    ])
    expect(fresh[1].color).toBe("#22d3ee")
    const moving = areas.compute(scene, world, list, {
      draft: { geometry, tokenId: null, editing: "t1" },
      spec: s,
    })
    expect(moving.map((v) => [v.id, v.draft, v.geometry.x])).toEqual([
      ["t1", true, 20],
    ])
    const overlays = areas.overlaysOf(moving, null)
    expect(overlays[0].state).toBe("draft")
    expect(areas.overlaysOf(moving, null)[0]).toBe(overlays[0])
    expect(areas.overlaysOf(fresh, "t1")[0].state).toBe("selected")
  })

  it("lists the host's and a player's templates, and builds inputs and specs", () => {
    const state = {
      players: {
        u1: {
          userId: "u1",
          displayName: "Alice",
          color: "#123456",
          movementLocked: false,
        },
      },
      templates: [
        {
          id: "a",
          shape: "cone" as const,
          levelId: "L",
          x: 1,
          z: 2,
          elevation: 3,
          angle: 1,
          size: 15,
          width: 5,
          height: 40,
          owner: "u1",
          label: "Burning Hands",
          color: "#f97316",
          tokenId: null,
          hidden: true,
        },
      ],
    }
    const [h] = hostTemplateItems(state)
    expect(h).toMatchObject({
      name: "Alice",
      mine: false,
      hidden: true,
      canEdit: true,
    })
    expect(templateTitle(h)).toBe("Burning Hands")
    expect(templateTitle({ ...h, label: "" })).toBe("15 ft cone")
    expect(specOf(h)).toMatchObject({
      shape: "cone",
      size: 15,
      elevation: 3,
      aura: false,
    })
    expect(playerTemplateItems(null)).toEqual([])
    const input = templateInput(
      {
        geometry: state.templates[0],
        tokenId: null,
        editing: null,
      },
      { label: "x", color: "#000000" }
    )
    expect(input).toMatchObject({
      label: "x",
      color: "#000000",
      tokenId: null,
      shape: "cone",
    })
  })
})
