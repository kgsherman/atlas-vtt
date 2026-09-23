import { produce } from "immer"
import { describe, expect, it, vi } from "vitest"

import {
  add,
  addLevel,
  at,
  flatScene,
  tokenAt,
} from "@/core/movement/test-utils"
import { createConnector, createDoor, createWall } from "@/core/scene/factory"
import type { Id, Scene } from "@/core/scene/types"
import type { VisibilityResult } from "@/core/vision/types"
import {
  createCellMask,
  createGradeMask,
  decodeGrades,
  decodeMask,
  raiseGrade,
} from "@/core/vision"
import type { PickResult } from "@/render/contracts"

import { climbOptions, stairsUnder } from "./connectors"
import {
  PlayController,
  type CommittedMove,
  type PlayControllerHost,
  type PlayPointerEvent,
} from "./controller"
import { doorAt, tokensInReach } from "./doors"
import {
  anchorForPoint,
  formatFeet,
  legCells,
  measureDistance,
  pathPoints,
  pathRuler,
} from "./geometry"
import {
  isEmptyChange,
  previewDimmedTokens,
  previewHostMasks,
  previewSeenTokens,
  sceneChangeBetween,
  setDirectionalPatches,
  setTokensHiddenPatches,
} from "./host"
import { resolvePlayKey } from "./keys"
import { MeasureTool } from "./measure"
import { MovePlanner } from "./planner"
import {
  cycleToken,
  describeSenses,
  resolveSelection,
  tokenDisplayName,
  tokenInitials,
} from "./tokens"

const pick = (
  ground: { x: number; z: number } | null,
  extra: Partial<PickResult> = {}
): PickResult => ({
  ground: ground ? { x: ground.x, y: 0, z: ground.z } : null,
  objectId: null,
  tokenId: null,
  hitPoint: null,
  ...extra,
})

const ev = (
  clientX: number,
  clientY: number,
  p: PickResult,
  extra: Partial<PlayPointerEvent> = {}
): PlayPointerEvent => ({
  clientX,
  clientY,
  button: 0,
  shift: false,
  pick: p,
  ...extra,
})

describe("geometry", () => {
  it("formats feet", () => {
    expect(formatFeet(35)).toBe("35 ft")
    expect(formatFeet(7.071)).toBe("7.1 ft")
    expect(formatFeet(Number.NaN)).toBe("—")
  })

  it("anchors tokens under a point by size", () => {
    const grid = { cellSize: 5 }
    expect(anchorForPoint(grid, "medium", { x: 12, z: 7 })).toEqual({
      i: 2,
      j: 1,
    })
    // Large tokens centre on cell corners: the nearest 2×2 footprint.
    expect(anchorForPoint(grid, "large", { x: 10.4, z: 9.8 })).toEqual({
      i: 1,
      j: 1,
    })
  })

  it("measures king-move routes with the diagonal rule", () => {
    expect(legCells({ i: 0, j: 0 }, { i: 2, j: 1 })).toEqual([
      { i: 1, j: 1 },
      { i: 2, j: 1 },
    ])
    const grid = {
      cellSize: 5,
      width: 20,
      depth: 20,
      diagonalRule: "5-10-5" as const,
    }
    // Two diagonals (5 + 10) and one straight step.
    expect(
      measureDistance(grid, [
        { x: 2.5, z: 2.5 },
        { x: 17.5, z: 12.5 },
      ])
    ).toBe(20)
    expect(
      measureDistance({ ...grid, diagonalRule: "5-5-5" }, [
        { x: 2.5, z: 2.5 },
        { x: 17.5, z: 12.5 },
      ])
    ).toBe(15)
  })

  it("builds rulers along token paths, collapsing in-place level switches", () => {
    const { scene, levelId } = flatScene()
    const upper = addLevel(scene, { elevation: 10 })
    const path = [at(1, 1, levelId), at(2, 2, levelId), at(2, 2, upper.id)]
    const pts = pathPoints(scene, "medium", path)
    expect(pts).toHaveLength(2)
    expect(pts[1].y).toBeGreaterThan(9)
    const ruler = pathRuler(scene, "medium", path, "note")
    expect(ruler?.label).toBe("5 ft · note")
    expect(ruler?.levelId).toBe(upper.id)
  })
})

describe("MovePlanner", () => {
  it("paths around walls and reports distances", () => {
    const { scene, levelId } = flatScene(10, 10)
    add(scene, createWall(levelId, { x: 25, z: 0 }, { x: 25, z: 40 }))
    const t = tokenAt(scene, levelId, { i: 2, j: 2 })
    const planner = new MovePlanner()
    planner.setScene(scene)
    const plan = planner.plan(t.id, { i: 7, j: 2 }, levelId)
    expect(plan?.path).not.toBeNull()
    expect(plan!.path![0]).toEqual(at(2, 2, levelId))
    expect(plan!.path![plan!.path!.length - 1]).toEqual(at(7, 2, levelId))
    expect(plan!.distance).toBeGreaterThan(25)
    // Cached until the scene changes.
    expect(planner.plan(t.id, { i: 7, j: 2 }, levelId)).toBe(plan)
  })

  it("reports unreachable and floorless targets", () => {
    const { scene, levelId } = flatScene(10, 10)
    // Box the token in.
    for (const [a, b] of [
      [
        { x: 5, z: 5 },
        { x: 15, z: 5 },
      ],
      [
        { x: 15, z: 5 },
        { x: 15, z: 15 },
      ],
      [
        { x: 15, z: 15 },
        { x: 5, z: 15 },
      ],
      [
        { x: 5, z: 15 },
        { x: 5, z: 5 },
      ],
    ])
      add(scene, createWall(levelId, a, b))
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const planner = new MovePlanner({ nodeLimit: 2000 })
    planner.setScene(scene)
    expect(planner.plan(t.id, { i: 8, j: 8 }, levelId)?.reason).toBe(
      "unreachable"
    )
    expect(planner.plan(t.id, { i: 1, j: 1 }, levelId)?.reason).toBe(
      "same-cell"
    )
    const noFloor = flatScene(4, 4)
    const floorId = Object.keys(noFloor.scene.objects)[0]
    delete noFloor.scene.objects[floorId]
    const t2 = tokenAt(noFloor.scene, noFloor.levelId, { i: 0, j: 0 })
    const p2 = new MovePlanner()
    p2.setScene(noFloor.scene)
    expect(p2.plan(t2.id, { i: 2, j: 2 }, noFloor.levelId)?.reason).toBe(
      "no-ground"
    )
  })

  it("falls back to another level with ground at the target (ladder climbs)", () => {
    const { scene, levelId } = flatScene(10, 10)
    const upper = addLevel(scene, { elevation: 10 }, false)
    // Upper floor only over x ≥ 25 plus a ladder at (4,4) leading up.
    add(scene, {
      ...createConnector(
        levelId,
        upper.id,
        { x: 20, z: 20, w: 5, d: 5 },
        0,
        "ladder"
      ),
    })
    const s = scene.grid.cellSize
    scene.objects["upper-floor"] = {
      id: "upper-floor",
      type: "floor",
      levelId: upper.id,
      rect: { x: 20, z: 0, w: 30, d: 10 * s },
      material: "wood",
    }
    const t = tokenAt(scene, levelId, { i: 4, j: 4 })
    const planner = new MovePlanner()
    planner.setScene(scene)
    // Target (8, 4) has ground on both levels: the preferred (upper) level wins.
    const plan = planner.plan(t.id, { i: 8, j: 4 }, upper.id)
    expect(plan?.target.levelId).toBe(upper.id)
    expect(plan?.path?.some((st) => st.levelId === upper.id)).toBe(true)
    // Validate an explicit ladder climb.
    expect(
      planner.validate(t.id, [at(4, 4, levelId), at(4, 4, upper.id)]).ok
    ).toBe(true)
  })

  describe("stairs top edge", () => {
    // Stairs at cells i = 2, j = 1..4 ascending +Z to a full upper floor; the lower level has floor
    // everywhere, including the cell just beyond the top edge (2,5) (the usual in-room layout).
    const setup = () => {
      const { scene, levelId } = flatScene(10, 10)
      const upper = addLevel(scene, { elevation: 10 })
      add(
        scene,
        createConnector(levelId, upper.id, { x: 10, z: 5, w: 5, d: 20 }, 0)
      )
      return { scene, levelId, upper }
    }

    it("goes up when the drop is just beyond the top edge", () => {
      const { scene, levelId, upper } = setup()
      const t = tokenAt(scene, levelId, { i: 2, j: 0 })
      const planner = new MovePlanner()
      planner.setScene(scene)
      const plan = planner.plan(t.id, { i: 2, j: 5 }, levelId)
      expect(plan?.target.levelId).toBe(upper.id)
      expect(plan?.path?.slice(-2)).toEqual([
        at(2, 4, levelId),
        at(2, 5, upper.id),
      ])
    })

    it("goes up from the top step too", () => {
      const { scene, levelId, upper } = setup()
      const t = tokenAt(scene, levelId, { i: 2, j: 4 })
      const planner = new MovePlanner()
      planner.setScene(scene)
      const plan = planner.plan(t.id, { i: 2, j: 5 }, levelId)
      expect(plan?.target.levelId).toBe(upper.id)
      expect(plan?.path).toEqual([at(2, 4, levelId), at(2, 5, upper.id)])
    })

    it("stays on the lower level elsewhere", () => {
      const { scene, levelId } = setup()
      const t = tokenAt(scene, levelId, { i: 2, j: 0 })
      const planner = new MovePlanner()
      planner.setScene(scene)
      const plan = planner.plan(t.id, { i: 2, j: 7 }, levelId)
      expect(plan?.target.levelId).toBe(levelId)
      expect(plan?.path?.every((st) => st.levelId === levelId)).toBe(true)
    })

    it("falls back to the lower level when the landing is walled off", () => {
      const { scene, levelId, upper } = setup()
      add(scene, createWall(upper.id, { x: 0, z: 25 }, { x: 50, z: 25 }))
      const t = tokenAt(scene, levelId, { i: 2, j: 0 })
      const planner = new MovePlanner()
      planner.setScene(scene)
      const plan = planner.plan(t.id, { i: 2, j: 5 }, levelId)
      expect(plan?.path).not.toBeNull()
      expect(plan?.target.levelId).toBe(levelId)
      expect(plan?.path?.every((st) => st.levelId === levelId)).toBe(true)
    })
  })

  it("updates the occlusion world incrementally and rebuilds on structure changes", () => {
    const { scene, levelId } = flatScene(10, 10)
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const planner = new MovePlanner()
    planner.setScene(scene)
    expect(planner.plan(t.id, { i: 6, j: 1 }, levelId)?.distance).toBe(25)
    const wall = createWall(levelId, { x: 20, z: 0 }, { x: 20, z: 50 })
    const next = produce(scene, (d) => {
      d.objects[wall.id] = wall
    })
    planner.setScene(next, { objects: [wall.id] })
    expect(planner.plan(t.id, { i: 6, j: 1 }, levelId)?.reason).toBe(
      "unreachable"
    )
    planner.setScene(scene, { structure: true })
    expect(planner.plan(t.id, { i: 6, j: 1 }, levelId)?.distance).toBe(25)
  })
})

describe("MeasureTool", () => {
  it("measures press-drag rulers and extends them with shift", () => {
    const { scene, levelId } = flatScene(10, 10)
    const m = new MeasureTool()
    m.press(scene.grid, levelId, { x: 1, z: 1 })
    m.move(scene.grid, { x: 21, z: 2 })
    expect(m.ruler(scene)?.label).toBe("20 ft")
    m.release()
    expect(m.active).toBe(false)
    expect(m.ruler(scene)?.points).toHaveLength(2)
    m.press(scene.grid, levelId, { x: 21, z: 2 }, true)
    m.move(scene.grid, { x: 21, z: 22 })
    m.release()
    expect(m.route()).toHaveLength(3)
    expect(m.distance(scene.grid)).toBe(40)
    m.press(scene.grid, levelId, { x: 1, z: 1 })
    expect(m.route()).toHaveLength(1)
    m.clear()
    expect(m.empty).toBe(true)
    expect(m.ruler(scene)).toBeNull()
  })
})

describe("connectors", () => {
  it("offers ladder climbs under the token, up first", () => {
    const { scene, levelId } = flatScene(10, 10)
    const cellar = addLevel(scene, { elevation: -10 })
    const upper = addLevel(scene, { elevation: 10 })
    add(
      scene,
      createConnector(
        levelId,
        upper.id,
        { x: 20, z: 20, w: 5, d: 5 },
        0,
        "ladder"
      )
    )
    add(
      scene,
      createConnector(
        cellar.id,
        levelId,
        { x: 20, z: 20, w: 5, d: 5 },
        0,
        "ladder"
      )
    )
    const t = tokenAt(scene, levelId, { i: 4, j: 4 })
    const opts = climbOptions(scene, t)
    expect(opts.map((o) => o.direction)).toEqual(["up", "down"])
    expect(opts[0].path).toEqual([at(4, 4, levelId), at(4, 4, upper.id)])
    const away = tokenAt(scene, levelId, { i: 0, j: 0 })
    expect(climbOptions(scene, away)).toEqual([])
  })

  describe("stairs and ramps", () => {
    const setup = () => {
      const { scene, levelId } = flatScene(10, 10)
      const upper = addLevel(scene, { elevation: 10 })
      const stairs = add(
        scene,
        createConnector(levelId, upper.id, { x: 10, z: 5, w: 5, d: 20 }, 0)
      )
      return { scene, levelId, upper, stairs }
    }

    it("offers going up from the top step", () => {
      const { scene, levelId, upper, stairs } = setup()
      const opts = climbOptions(scene, tokenAt(scene, levelId, { i: 2, j: 4 }))
      expect(opts).toHaveLength(1)
      expect(opts[0]).toMatchObject({
        direction: "up",
        style: stairs.style,
        connectorId: stairs.id,
        toLevelId: upper.id,
      })
      expect(opts[0].path).toEqual([at(2, 4, levelId), at(2, 5, upper.id)])
    })

    it("offers nothing lower on the run", () => {
      const { scene, levelId } = setup()
      expect(
        climbOptions(scene, tokenAt(scene, levelId, { i: 2, j: 2 }))
      ).toEqual([])
    })

    it("offers going down from the cell beyond the top edge", () => {
      const { scene, levelId, upper } = setup()
      const opts = climbOptions(scene, tokenAt(scene, upper.id, { i: 2, j: 5 }))
      expect(opts).toHaveLength(1)
      expect(opts[0].direction).toBe("down")
      expect(opts[0].toLevelId).toBe(levelId)
      expect(opts[0].path).toEqual([at(2, 5, upper.id), at(2, 4, levelId)])
    })

    it("labels ladders as ladders", () => {
      const { scene, levelId } = flatScene(10, 10)
      const upper = addLevel(scene, { elevation: 10 })
      add(
        scene,
        createConnector(
          levelId,
          upper.id,
          { x: 20, z: 20, w: 5, d: 5 },
          0,
          "ladder"
        )
      )
      const opts = climbOptions(scene, tokenAt(scene, levelId, { i: 4, j: 4 }))
      expect(opts.map((o) => o.style)).toEqual(["ladder"])
    })
  })

  it("finds stairs under a token", () => {
    const { scene, levelId } = flatScene(10, 10)
    const upper = addLevel(scene, { elevation: 10 })
    add(
      scene,
      createConnector(
        levelId,
        upper.id,
        { x: 10, z: 10, w: 10, d: 5 },
        1,
        "stairs"
      )
    )
    expect(
      stairsUnder(scene, tokenAt(scene, levelId, { i: 3, j: 2 }))
    ).toHaveLength(1)
    expect(
      stairsUnder(scene, tokenAt(scene, levelId, { i: 5, j: 5 }))
    ).toHaveLength(0)
  })
})

describe("doors", () => {
  it("resolves clicks near a door segment and checks reach like the host", () => {
    const { scene, levelId } = flatScene(10, 10)
    const wall = add(
      scene,
      createWall(levelId, { x: 0, z: 25 }, { x: 50, z: 25 })
    )
    const door = add(scene, createDoor(wall, 22.5, { width: 5 }))
    expect(doorAt(scene, levelId, null, { x: 22, z: 25.8 })?.door.id).toBe(
      door.id
    )
    expect(doorAt(scene, levelId, null, { x: 22, z: 30 })).toBeNull()
    expect(doorAt(scene, levelId, door.id, null)?.door.id).toBe(door.id)
    const hit = doorAt(scene, levelId, door.id, null)!
    const near = tokenAt(scene, levelId, { i: 4, j: 5 })
    const far = tokenAt(scene, levelId, { i: 4, j: 8 })
    expect(tokensInReach(scene, hit, [near.id, far.id])).toEqual([near.id])
  })
})

describe("tokens & keys", () => {
  it("names, initials and senses", () => {
    expect(tokenDisplayName({ name: "  ", label: "Guard" })).toBe("Guard")
    expect(tokenInitials({ name: "Mira Stone Fist", label: null })).toBe("MF")
    expect(tokenInitials({ name: "Ox", label: null })).toBe("OX")
    expect(
      describeSenses({ darkvision: 60, blindsight: 10, blind: false }).map(
        (s) => s.label
      )
    ).toEqual(["Darkvision 60 ft", "Blindsight 10 ft"])
    expect(
      describeSenses({ darkvision: 60, blindsight: 0, blind: true }).map(
        (s) => s.kind
      )
    ).toEqual(["blind"])
    expect(describeSenses(undefined)[0].kind).toBe("normal")
  })

  it("resolves and cycles selections", () => {
    expect(resolveSelection("b", ["a", "b"])).toBe("b")
    expect(resolveSelection("c", ["a", "b"])).toBe("a")
    expect(resolveSelection(null, [])).toBeNull()
    expect(cycleToken("b", ["a", "b"], 1)).toBe("a")
    expect(cycleToken("a", ["a", "b"], -1)).toBe("b")
    expect(cycleToken(null, ["a", "b"], -1)).toBe("b")
  })

  it("maps play keys", () => {
    const k = (
      key: string,
      extra: Partial<{ shift: boolean; ctrl: boolean; alt: boolean }> = {}
    ) =>
      resolvePlayKey({ key, shift: false, ctrl: false, alt: false, ...extra })
    expect(k("q")).toEqual({ type: "rotate", quarterTurns: -1 })
    expect(k("E")).toEqual({ type: "rotate", quarterTurns: 1 })
    expect(k("=")).toEqual({ type: "zoom", direction: 1 })
    expect(k("-")).toEqual({ type: "zoom", direction: -1 })
    expect(k("Tab", { shift: true })).toEqual({ type: "cycle-token", dir: -1 })
    expect(k("m")).toEqual({ type: "toggle-measure" })
    expect(k("w")).toBeNull()
    expect(k("q", { ctrl: true })).toBeNull()
  })
})

describe("host helpers", () => {
  it("diffs scene revisions by identity", () => {
    const { scene, levelId } = flatScene(6, 6)
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const moved = produce(scene, (d) => {
      d.tokens[t.id].position = { x: 12.5, z: 12.5 }
    })
    expect(sceneChangeBetween(scene, moved)).toEqual({ tokens: [t.id] })
    expect(isEmptyChange(sceneChangeBetween(scene, scene)!)).toBe(true)
    const lit = produce(moved, (d) => {
      d.environment.directional.enabled = !d.environment.directional.enabled
    })
    expect(sceneChangeBetween(moved, lit)).toEqual({ structure: true })
    const terrain = produce(lit, (d) => {
      d.levels[levelId].heightmap = { resolution: 1, chunks: {} }
    })
    expect(sceneChangeBetween(lit, terrain)).toEqual({ terrain: [levelId] })
    const renamed = produce(terrain, (d) => {
      d.levels[levelId].name = "Other"
    })
    expect(sceneChangeBetween(terrain, renamed)).toEqual({ structure: true })
    expect(
      sceneChangeBetween(scene, { ...scene, id: "other" } as Scene)
    ).toBeNull()
    expect(sceneChangeBetween(null, scene)).toBeNull()
  })

  it("builds preview masks and dimmed tokens", () => {
    const { scene, levelId } = flatScene(4, 4)
    const a = tokenAt(scene, levelId, { i: 0, j: 0 })
    const b = tokenAt(scene, levelId, { i: 2, j: 2 })
    const c = tokenAt(scene, levelId, { i: 3, j: 3 })
    const grades = createGradeMask(4, 4)
    raiseGrade(grades, 5, 3)
    const result: VisibilityResult = {
      perception: { [levelId]: grades },
      sunlit: { [levelId]: createCellMask(4, 4) },
      visibleTokenIds: new Set([b.id]),
      observedObjectIds: new Set(),
      illuminatingLightIds: new Set(),
    }
    const masks = previewHostMasks(scene, result)
    expect(decodeGrades(masks[levelId].perception).grades[5]).toBe(3)
    const explored = decodeMask(masks[levelId].explored)
    expect(explored.bits[0] & (1 << 5)).toBeTruthy()
    expect(previewDimmedTokens(scene, [a.id], result)).toEqual([c.id])
    expect(previewSeenTokens(scene, [a.id], result)).toEqual([b.id])
    // A hidden token in plain sight: players never receive it, so it is dimmed and not counted.
    scene.tokens[b.id] = { ...b, hidden: true }
    expect(previewDimmedTokens(scene, [a.id], result)).toEqual(
      [b.id, c.id].sort()
    )
    expect(previewSeenTokens(scene, [a.id], result)).toEqual([])
  })

  it("makes scene patches for play-view edits", () => {
    const { scene, levelId } = flatScene(4, 4)
    const t = tokenAt(scene, levelId, { i: 0, j: 0 })
    const hide = setTokensHiddenPatches(scene, [t.id, "missing"], true)
    expect(hide).toEqual([
      { op: "replace", path: ["tokens", t.id, "hidden"], value: true },
    ])
    expect(setTokensHiddenPatches(scene, [t.id], false)).toEqual([])
    const sun = setDirectionalPatches(
      scene,
      !scene.environment.directional.enabled
    )
    expect(sun[0].path).toEqual(["environment", "directional", "enabled"])
  })
})

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

function controllerFixture(
  role: "player" | "dm",
  scene: Scene,
  levelId: Id,
  opts: { locked?: boolean; speed?: number | null } = {}
) {
  const planner = new MovePlanner()
  planner.setScene(scene)
  const moves: CommittedMove[] = []
  const hints: string[] = []
  const doors: Id[] = []
  const selections: (Id | null)[] = []
  const camera = vi.fn()
  const host: PlayControllerHost = {
    role,
    scene: () => scene,
    activeLevelId: () => levelId,
    canSelect: () => true,
    canDrag: () => true,
    movementLocked: () => opts.locked ?? false,
    speedLimit: () => opts.speed ?? null,
    groundAt: (x, y) => ({ x: x / 10, z: y / 10 }),
    planner: role === "player" ? planner : null,
    onSelect: (id) => selections.push(id),
    onMove: (m) => moves.push(m),
    onDoor: (h) => doors.push(h.door.id),
    onHint: (m) => hints.push(m),
    setCameraControls: camera,
  }
  return {
    controller: new PlayController(host),
    moves,
    hints,
    doors,
    selections,
    camera,
  }
}

describe("PlayController", () => {
  it("selects on press and commits a planned path on drag release (player)", () => {
    const { scene, levelId } = flatScene(10, 10)
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const f = controllerFixture("player", scene, levelId)
    const c = f.controller
    c.pointerDown(ev(100, 100, pick({ x: 7.5, z: 7.5 }, { tokenId: t.id })))
    expect(f.selections).toEqual([t.id])
    expect(c.overlays().selectedIds).toEqual([t.id])
    // Below the drag threshold: nothing.
    c.pointerMove(ev(102, 101, pick({ x: 8, z: 8 })))
    expect(c.dragging).toBe(false)
    c.pointerMove(ev(160, 100, pick({ x: 22.5, z: 7.5 })))
    expect(c.dragging).toBe(true)
    const o = c.overlays()
    expect(o.ruler?.label).toBe("15 ft")
    expect(o.dragGhosts[t.id]).toEqual({
      levelId,
      position: { x: 22.5, z: 7.5 },
    })
    c.pointerUp(ev(160, 100, pick({ x: 22.5, z: 7.5 })))
    expect(f.moves).toHaveLength(1)
    const m = f.moves[0]
    expect(m.kind).toBe("path")
    if (m.kind === "path")
      expect(m.path[m.path.length - 1]).toEqual(at(4, 1, levelId))
    expect(c.overlays().ruler).toBeNull()
    expect(f.camera).toHaveBeenLastCalledWith(true)
  })

  it("refuses drags while movement is locked and over the speed limit", () => {
    const { scene, levelId } = flatScene(10, 10)
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const locked = controllerFixture("player", scene, levelId, { locked: true })
    locked.controller.pointerDown(
      ev(0, 0, pick({ x: 7.5, z: 7.5 }, { tokenId: t.id }))
    )
    locked.controller.pointerMove(ev(50, 0, pick({ x: 30, z: 7.5 })))
    locked.controller.pointerUp(ev(50, 0, pick({ x: 30, z: 7.5 })))
    expect(locked.moves).toEqual([])
    expect(locked.hints).toEqual(["Movement is locked by the DM"])

    const slow = controllerFixture("player", scene, levelId, { speed: 10 })
    slow.controller.pointerDown(
      ev(0, 0, pick({ x: 7.5, z: 7.5 }, { tokenId: t.id }))
    )
    slow.controller.pointerMove(ev(50, 0, pick({ x: 32.5, z: 7.5 })))
    expect(slow.controller.overlays().ruler?.label).toContain(
      "over 10 ft speed"
    )
    slow.controller.pointerUp(ev(50, 0, pick({ x: 32.5, z: 7.5 })))
    expect(slow.moves).toEqual([])
    expect(slow.hints[0]).toContain("farther")
  })

  it("places tokens freely for the DM on the token's level", () => {
    const { scene, levelId } = flatScene(10, 10)
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const f = controllerFixture("dm", scene, levelId)
    f.controller.pointerDown(
      ev(75, 75, pick({ x: 7.5, z: 7.5 }, { tokenId: t.id }))
    )
    f.controller.pointerMove(ev(330, 180, pick(null)))
    expect(f.controller.overlays().dragGhosts[t.id]).toEqual({
      levelId,
      position: { x: 32.5, z: 17.5 },
    })
    f.controller.pointerUp(ev(330, 180, pick(null)))
    expect(f.moves).toEqual([
      { kind: "place", tokenId: t.id, levelId, position: { x: 32.5, z: 17.5 } },
    ])
    // Clicking empty ground deselects for the DM.
    f.controller.pointerDown(ev(10, 10, pick({ x: 40, z: 40 })))
    f.controller.pointerUp(ev(10, 10, pick({ x: 40, z: 40 })))
    expect(f.selections[f.selections.length - 1]).toBeNull()
  })

  it("hovers a door wherever a click would toggle it (walls seen edge-on)", () => {
    const { scene, levelId } = flatScene(10, 10)
    // A wall running up/down the screen: from above it is a thin line.
    const wall = add(
      scene,
      createWall(levelId, { x: 25, z: 0 }, { x: 25, z: 50 })
    )
    const door = add(scene, createDoor(wall, 22.5, { width: 5 }))
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const c = controllerFixture("player", scene, levelId).controller
    // The pick hit the wall, 1 ft from the door segment: the door is hovered.
    c.pointerMove(ev(0, 0, pick({ x: 26, z: 22 }, { objectId: wall.id })))
    expect(c.overlays().hoveredId).toBe(door.id)
    // 3 ft away: nothing.
    c.pointerMove(ev(0, 0, pick({ x: 28, z: 22 }, { objectId: wall.id })))
    expect(c.overlays().hoveredId).toBeNull()
    // A token pick wins over a nearby door.
    c.pointerMove(
      ev(0, 0, pick({ x: 26, z: 22 }, { objectId: wall.id, tokenId: t.id }))
    )
    expect(c.overlays().hoveredId).toBe(t.id)
  })

  it("routes door clicks and measures with the measure tool", () => {
    const { scene, levelId } = flatScene(10, 10)
    const wall = add(
      scene,
      createWall(levelId, { x: 0, z: 25 }, { x: 50, z: 25 })
    )
    const door = add(scene, createDoor(wall, 22.5, { width: 5 }))
    const f = controllerFixture("player", scene, levelId)
    f.controller.pointerDown(ev(0, 0, pick({ x: 22.5, z: 25.5 })))
    f.controller.pointerUp(ev(0, 0, pick({ x: 22.5, z: 25.5 })))
    expect(f.doors).toEqual([door.id])

    f.controller.setTool("measure")
    f.controller.pointerDown(ev(0, 0, pick({ x: 2, z: 2 })))
    f.controller.pointerMove(ev(10, 0, pick({ x: 2, z: 32 })))
    expect(f.controller.overlays().ruler?.label).toBe("30 ft")
    f.controller.pointerUp(ev(10, 0, pick({ x: 2, z: 32 })))
    expect(f.controller.measuredFeet()).toBe(30)
    f.controller.cancel()
    expect(f.controller.overlays().ruler).toBeNull()
  })

  it("keeps overlay identity while nothing changes and notifies listeners", () => {
    const { scene, levelId } = flatScene(4, 4)
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const f = controllerFixture("player", scene, levelId)
    const listener = vi.fn()
    f.controller.subscribe(listener)
    const a = f.controller.overlays()
    expect(f.controller.overlays()).toBe(a)
    f.controller.setSelected(t.id)
    expect(listener).toHaveBeenCalled()
    expect(f.controller.overlays()).not.toBe(a)
    f.controller.pointerMove(ev(0, 0, pick({ x: 7, z: 7 }, { tokenId: t.id })))
    expect(f.controller.overlays().hoveredId).toBe(t.id)
  })
})
