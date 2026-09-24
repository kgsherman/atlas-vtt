import { produce } from "immer"
import { describe, expect, it, vi } from "vitest"

import {
  add,
  addLevel,
  at,
  check,
  flatScene,
  paintHeightmap,
  tokenAt,
} from "@/core/movement/test-utils"
import {
  createConnector,
  createDoor,
  createProp,
  createWall,
} from "@/core/scene/factory"
import type { Id, Scene, TerrainShape } from "@/core/scene/types"
import type { VisibilityResult } from "@/core/vision/types"
import {
  createCellMask,
  createGradeMask,
  decodeGrades,
  decodeMask,
  encodeGrades,
  encodeMask,
  raiseGrade,
  setCell,
} from "@/core/vision"
import type { PickResult } from "@/render/contracts"

import { climbOptions } from "./connectors"
import {
  LONG_PRESS_MS,
  PlayController,
  type CommittedMove,
  type PlayControllerHost,
  type PlayPointerEvent,
} from "./controller"
import { doorAt, tokensInReach } from "./doors"
import {
  anchorForPoint,
  drapeRoute,
  formatFeet,
  pathPoints,
  pathRuler,
  straightRuler,
} from "./geometry"
import {
  isEmptyChange,
  previewDimmedTokens,
  previewHostMasks,
  previewSeenTokens,
  sceneChangeBetween,
  setDirectionalPatches,
  setTokenModelPatches,
  setTokensHiddenPatches,
} from "./host"
import { MeasureTool } from "./measure"
import { SentRoutes, tokenRouter } from "./routes"
import {
  blindLandingOk,
  MovePlanner,
  runsBelowTop,
  unexploredIn,
} from "./planner"
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

  it("labels straight rulers with the grid distance (core rulerDistance)", () => {
    const { scene, levelId } = flatScene()
    const from = { x: 2.5, z: 2.5 }
    const to = { x: 17.5, z: 12.5 }
    const withRule = (diagonalRule: Scene["grid"]["diagonalRule"]) => ({
      ...scene,
      grid: { ...scene.grid, diagonalRule },
    })
    // Two diagonals (5 + 10 under 5-10-5) and one straight step.
    expect(straightRuler(withRule("5-10-5"), levelId, from, to).label).toBe(
      "20 ft"
    )
    expect(straightRuler(withRule("5-5-5"), levelId, from, to).label).toBe(
      "15 ft"
    )
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

describe("move routes", () => {
  it("drapes lines over the ground and switches level halfway across a level change", () => {
    const { scene, levelId } = flatScene()
    paintHeightmap(scene, levelId, (x) => (x > 10 ? 2 : 0))
    const pts = drapeRoute(scene, [
      { levelId, position: { x: 2.5, z: 2.5 } },
      { levelId, position: { x: 17.5, z: 2.5 } },
    ])
    expect(pts.length).toBeGreaterThan(20)
    expect(pts[0].y).toBeCloseTo(0.15)
    expect(pts[pts.length - 1].y).toBeCloseTo(2.15)
    const upper = addLevel(scene, { elevation: 10 })
    const up = drapeRoute(scene, [
      { levelId, position: { x: 2.5, z: 2.5 } },
      { levelId: upper.id, position: { x: 2.5, z: 7.5 } },
    ])
    expect(up[1].y).toBeLessThan(5)
    expect(up[up.length - 1].y).toBeGreaterThan(9)
  })

  it("reuses the route a move was sent along, up to where the host stopped it, once", () => {
    let now = 0
    const sent = new SentRoutes(() => now)
    const L = "L"
    const p = (x: number) => ({ levelId: L, position: { x, z: 2.5 } })
    sent.remember("t", [p(2.5), p(7.5), p(12.5), p(17.5)])
    expect(sent.take("t", p(3), p(12.5))).toEqual([p(3), p(7.5), p(12.5)])
    expect(sent.take("t", p(3), p(12.5))).toBeNull()
    sent.remember("t", [p(2.5), p(7.5)])
    expect(sent.take("t", p(2.5), p(30))).toBeNull()
    now = 60_000
    expect(sent.take("t", p(2.5), p(7.5))).toBeNull()
  })

  it("reconstructs routes of moves this client did not send (the planner, around walls)", () => {
    const { scene, levelId } = flatScene(10, 10)
    add(scene, createWall(levelId, { x: 10, z: 0 }, { x: 10, z: 30 }))
    const t = tokenAt(scene, levelId, { i: 3, j: 0 })
    const planner = new MovePlanner()
    planner.setScene(scene)
    const route = tokenRouter(planner)(
      t.id,
      { levelId, position: { x: 2.5, z: 2.5 } },
      { levelId, position: { x: 17.5, z: 2.5 } }
    )
    expect(route).not.toBeNull()
    expect(route!.length).toBeGreaterThan(3)
    expect(route![0].position).toEqual({ x: 2.5, z: 2.5 })
    expect(route![route!.length - 1].position).toEqual({ x: 17.5, z: 2.5 })
    // Off the grid: pulled, ending exactly there.
    const free = planner.route(t.id, { levelId, position: { x: 17, z: 40 } }, { levelId, position: { x: 31.2, z: 44.4 } })
    expect(free).toEqual([
      { levelId, position: { x: 17, z: 40 } },
      { levelId, position: { x: 31.2, z: 44.4 } },
    ])
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

    it("goes up from the top step when the view has switched to the upper level", () => {
      const { scene, levelId, upper } = setup()
      const t = tokenAt(scene, levelId, { i: 2, j: 4 })
      const planner = new MovePlanner()
      planner.setScene(scene)
      const plan = planner.plan(t.id, { i: 2, j: 5 }, upper.id)
      expect(plan?.path).toEqual([at(2, 4, levelId), at(2, 5, upper.id)])
      expect(runsBelowTop(scene, [upper.id], { i: 2, j: 5 }, 1)).toEqual([])
      expect(
        runsBelowTop(scene, [upper.id, levelId], { i: 2, j: 5 }, 1).map(
          (r) => r.lower
        )
      ).toEqual([{ i: 2, j: 4 }])
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

  describe("blind landings (upper storey the player has not explored)", () => {
    // The player's scene: the upper level is a stub without floor (nothing explored up there).
    const setup = (lowerBeyond = true) => {
      const { scene, levelId } = flatScene(10, 10)
      if (!lowerBeyond) {
        // A stairwell against a wall: no lower floor beyond the top edge (z ≥ 25).
        const floorId = Object.keys(scene.objects)[0]
        const f = scene.objects[floorId]
        if (f.type === "floor") f.rect = { ...f.rect, d: 25 }
      }
      const upper = addLevel(scene, { elevation: 10 }, false)
      add(
        scene,
        createConnector(levelId, upper.id, { x: 10, z: 5, w: 5, d: 20 }, 0)
      )
      return { scene, levelId, upper }
    }
    const nothingUpstairs =
      (upperId: Id) =>
      (levelId: Id): boolean =>
        levelId === upperId

    it("plans up the run and across the top edge; the host validates the landing", () => {
      const { scene, levelId, upper } = setup()
      const t = tokenAt(scene, levelId, { i: 2, j: 0 })
      const planner = new MovePlanner({
        unexplored: nothingUpstairs(upper.id),
      })
      planner.setScene(scene)
      const plan = planner.plan(t.id, { i: 2, j: 5 }, levelId)
      expect(plan?.target).toEqual(at(2, 5, upper.id))
      expect(plan?.path?.[0]).toEqual(at(2, 0, levelId))
      expect(plan?.path?.slice(-2)).toEqual([
        at(2, 4, levelId),
        at(2, 5, upper.id),
      ])
      expect(plan?.distance).toBe(25)
      // From the top step: just the crossing.
      const top = tokenAt(scene, levelId, { i: 2, j: 4 })
      expect(planner.plan(top.id, { i: 2, j: 5 }, levelId)?.path).toEqual([
        at(2, 4, levelId),
        at(2, 5, upper.id),
      ])
    })

    it("climbs even without lower floor beyond the top edge", () => {
      const { scene, levelId, upper } = setup(false)
      const t = tokenAt(scene, levelId, { i: 2, j: 0 })
      const blind = new MovePlanner({ unexplored: nothingUpstairs(upper.id) })
      blind.setScene(scene)
      expect(blind.plan(t.id, { i: 2, j: 5 }, levelId)?.target.levelId).toBe(
        upper.id
      )
      // Without blind landings (the DM's complete scene) there is no floor there.
      const dm = new MovePlanner()
      dm.setScene(scene)
      expect(dm.plan(t.id, { i: 2, j: 5 }, levelId)?.reason).toBe("no-ground")
    })

    it("stays on known ground when the landing was explored, or blind landings are off", () => {
      const { scene, levelId } = setup()
      const t = tokenAt(scene, levelId, { i: 2, j: 0 })
      for (const planner of [
        new MovePlanner(),
        new MovePlanner({ unexplored: () => false }),
      ]) {
        planner.setScene(scene)
        const plan = planner.plan(t.id, { i: 2, j: 5 }, levelId)
        expect(plan?.target.levelId).toBe(levelId)
        expect(plan?.path?.every((st) => st.levelId === levelId)).toBe(true)
      }
    })

    it("does not cross a known wall on the landing", () => {
      const { scene, levelId, upper } = setup()
      add(scene, createWall(upper.id, { x: 0, z: 25 }, { x: 50, z: 25 }))
      const t = tokenAt(scene, levelId, { i: 2, j: 0 })
      const planner = new MovePlanner({
        unexplored: nothingUpstairs(upper.id),
      })
      planner.setScene(scene)
      const plan = planner.plan(t.id, { i: 2, j: 5 }, levelId)
      expect(plan?.target.levelId).toBe(levelId)
      expect(plan?.path?.every((st) => st.levelId === levelId)).toBe(true)
    })

    it("accepts only a missing landing floor as a client-side fault (climb buttons)", () => {
      const { scene, levelId, upper } = setup()
      const t = tokenAt(scene, levelId, { i: 2, j: 4 })
      const [up] = climbOptions(scene, t)
      expect(up.direction).toBe("up")
      const v = check(scene, t, up.path)
      expect(v).toMatchObject({ ok: false, reason: "no-ground", failedAt: 1 })
      expect(blindLandingOk(v, up.path, 1, nothingUpstairs(upper.id))).toBe(
        true
      )
      expect(blindLandingOk(v, up.path, 1, () => false)).toBe(false)
      expect(blindLandingOk(v, up.path, 1)).toBe(false)
      // A same-level step onto missing floor is never blind.
      const flat = [at(2, 4, levelId), at(3, 4, levelId)]
      expect(
        blindLandingOk(
          {
            ok: false,
            reason: "no-ground",
            failedAt: 1,
            legalSteps: 0,
            distance: 0,
          },
          flat,
          1,
          () => true
        )
      ).toBe(false)
    })

    it("reads the player's explored masks", () => {
      const { levelId } = flatScene(4, 4)
      const explored = createCellMask(4, 4)
      setCell(explored, 1 * 4 + 2)
      const view = {
        masks: {
          [levelId]: {
            perception: encodeGrades(createGradeMask(4, 4)),
            explored: encodeMask(explored),
            sunlit: encodeMask(createCellMask(4, 4)),
          },
        },
      }
      expect(unexploredIn(view, levelId, { i: 2, j: 1 })).toBe(false)
      expect(unexploredIn(view, levelId, { i: 1, j: 1 })).toBe(true)
      expect(unexploredIn(view, "other", { i: 2, j: 1 })).toBe(true)
      expect(unexploredIn(null, levelId, { i: 2, j: 1 })).toBe(true)
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
    // Terrain edits are DM-only editing data: alone they change nothing; with
    // the baked heightmap they are a terrain change.
    const shape: TerrainShape = {
      id: "s1",
      kind: "block",
      op: "add",
      order: 0,
      base: 0,
      points: [
        { x: 0, y: 2, z: 0 },
        { x: 5, y: 2, z: 0 },
        { x: 5, y: 2, z: 5 },
      ],
    }
    const edited = produce(renamed, (d) => {
      d.levels[levelId].terrainEdits = { shapes: { s1: shape }, baseChunks: {} }
    })
    expect(sceneChangeBetween(renamed, edited)).toEqual({})
    const baked = produce(edited, (d) => {
      d.levels[levelId].terrainEdits!.shapes.s1.name = "Mound"
      d.levels[levelId].heightmap = { resolution: 2, chunks: {} }
    })
    expect(sceneChangeBetween(edited, baked)).toEqual({ terrain: [levelId] })
    const cleared = produce(baked, (d) => {
      delete d.levels[levelId].terrainEdits
      d.levels[levelId].elevation = 1
    })
    expect(sceneChangeBetween(baked, cleared)).toEqual({ structure: true })
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
    const model = setTokenModelPatches(scene, [t.id, "missing"], "free:elf-archer")
    expect(model).toEqual([
      { op: "add", path: ["tokens", t.id, "model"], value: "free:elf-archer" },
    ])
    const withModel = {
      ...scene,
      tokens: { ...scene.tokens, [t.id]: { ...t, model: "free:elf-archer" } },
    }
    expect(setTokenModelPatches(withModel, [t.id], null)).toEqual([
      { op: "remove", path: ["tokens", t.id, "model"] },
    ])
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
  opts: { locked?: boolean; speed?: number | null; free?: boolean } = {}
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
    freeMovement: () => opts.free ?? false,
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
    planner,
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

  it("runs right-button move commands: preview while held, commit on release", () => {
    const { scene, levelId } = flatScene(10, 10)
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const f = controllerFixture("player", scene, levelId)
    const c = f.controller
    // Nothing selected: the right button is left to the page (camera pan).
    expect(c.pointerDown(ev(0, 0, pick({ x: 22.5, z: 7.5 }), { button: 2 }))).toBe(false)
    c.setSelected(t.id)
    expect(c.pointerDown(ev(0, 0, pick({ x: 22.5, z: 7.5 }), { button: 2 }))).toBe(true)
    expect(c.commanding).toBe(true)
    expect(f.camera).toHaveBeenLastCalledWith(false)
    expect(c.overlays().ruler).toMatchObject({ label: "15 ft", kind: "path" })
    c.pointerMove(ev(10, 0, pick({ x: 27.5, z: 7.5 })))
    expect(c.overlays().dragGhosts[t.id]?.position).toEqual({ x: 27.5, z: 7.5 })
    expect(c.pointerUp(ev(10, 0, pick({ x: 27.5, z: 7.5 }), { button: 2 }))).toBe(true)
    expect(f.moves).toHaveLength(1)
    const m = f.moves[0]
    expect(m.kind === "path" && m.path[m.path.length - 1]).toEqual(at(5, 1, levelId))
    expect(m.kind === "path" && m.route[m.route.length - 1].position).toEqual({ x: 27.5, z: 7.5 })
    expect(c.commanding).toBe(false)
    expect(f.camera).toHaveBeenLastCalledWith(true)
  })

  it("cancels a move command on a left click (which does nothing else) or Esc", () => {
    const { scene, levelId } = flatScene(10, 10)
    const wall = add(scene, createWall(levelId, { x: 0, z: 25 }, { x: 50, z: 25 }))
    add(scene, createDoor(wall, 22.5, { width: 5 }))
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const f = controllerFixture("player", scene, levelId)
    const c = f.controller
    c.setSelected(t.id)
    c.pointerDown(ev(0, 0, pick({ x: 22.5, z: 7.5 }), { button: 2 }))
    // A left press on a door while the right button is held: cancels, no door toggle.
    expect(c.pointerDown(ev(0, 0, pick({ x: 22.5, z: 25.5 })))).toBe(true)
    expect(c.overlays().ruler).toBeNull()
    c.pointerUp(ev(0, 0, pick({ x: 22.5, z: 25.5 })))
    expect(c.pointerUp(ev(0, 0, pick({ x: 22.5, z: 7.5 }), { button: 2 }))).toBe(false)
    expect(f.doors).toEqual([])
    expect(f.moves).toEqual([])
    c.pointerDown(ev(0, 0, pick({ x: 22.5, z: 7.5 }), { button: 2 }))
    c.cancel()
    c.pointerUp(ev(0, 0, pick({ x: 22.5, z: 7.5 }), { button: 2 }))
    expect(f.moves).toEqual([])
  })

  it("leaves the DM's right-click on a token to its menu and refuses commands while locked", () => {
    const { scene, levelId } = flatScene(10, 10)
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const other = tokenAt(scene, levelId, { i: 4, j: 4 })
    const dm = controllerFixture("dm", scene, levelId)
    dm.controller.setSelected(t.id)
    expect(dm.controller.pointerDown(ev(225, 225, pick({ x: 22.5, z: 22.5 }, { tokenId: other.id }), { button: 2 }))).toBe(false)
    expect(dm.controller.pointerDown(ev(325, 75, pick(null), { button: 2 }))).toBe(true)
    dm.controller.pointerUp(ev(325, 75, pick(null), { button: 2 }))
    expect(dm.moves).toEqual([{ kind: "place", tokenId: t.id, levelId, position: { x: 32.5, z: 7.5 } }])
    const locked = controllerFixture("player", scene, levelId, { locked: true })
    locked.controller.setSelected(t.id)
    expect(locked.controller.pointerDown(ev(0, 0, pick({ x: 22.5, z: 7.5 }), { button: 2 }))).toBe(false)
    expect(locked.hints).toEqual(["Movement is locked by the DM"])
  })

  it("strands a move with no path: error line, then a jump or a dismissal", () => {
    const { scene, levelId } = flatScene(10, 10)
    // A closed box around cells (6..8, 6..8).
    for (const [a, b] of [
      [{ x: 30, z: 30 }, { x: 45, z: 30 }],
      [{ x: 45, z: 30 }, { x: 45, z: 45 }],
      [{ x: 45, z: 45 }, { x: 30, z: 45 }],
      [{ x: 30, z: 45 }, { x: 30, z: 30 }],
    ])
      add(scene, createWall(levelId, a, b))
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const f = controllerFixture("player", scene, levelId)
    const c = f.controller
    c.setSelected(t.id)
    c.pointerDown(ev(0, 0, pick({ x: 37.5, z: 37.5 }), { button: 2 }))
    expect(c.overlays().ruler).toMatchObject({ kind: "blocked" })
    expect(c.overlays().ruler?.label).toContain("no path")
    c.pointerUp(ev(0, 0, pick({ x: 37.5, z: 37.5 }), { button: 2 }))
    expect(f.moves).toEqual([])
    expect(c.getStranded()).toMatchObject({ tokenId: t.id, levelId, position: { x: 37.5, z: 37.5 }, reason: "unreachable", blocked: false })
    // The line and ghost stay.
    expect(c.overlays().ruler).toMatchObject({ kind: "blocked" })
    expect(c.overlays().dragGhosts[t.id]).toEqual({ levelId, position: { x: 37.5, z: 37.5 } })
    c.jumpStranded()
    expect(f.moves).toEqual([{ kind: "jump", tokenId: t.id, levelId, position: { x: 37.5, z: 37.5 } }])
    expect(c.getStranded()).toBeNull()
    expect(c.overlays().ruler).toBeNull()
    // A left drag strands too; a click elsewhere dismisses it, so does the token moving.
    c.pointerDown(ev(0, 0, pick({ x: 7.5, z: 7.5 }, { tokenId: t.id })))
    c.pointerMove(ev(100, 0, pick({ x: 37.5, z: 37.5 })))
    c.pointerUp(ev(100, 0, pick({ x: 37.5, z: 37.5 })))
    expect(c.getStranded()).not.toBeNull()
    c.pointerDown(ev(0, 0, pick({ x: 12, z: 12 })))
    expect(c.getStranded()).toBeNull()
    c.pointerUp(ev(0, 0, pick({ x: 12, z: 12 })))
    c.pointerDown(ev(0, 0, pick({ x: 37.5, z: 37.5 }), { button: 2 }))
    c.pointerUp(ev(0, 0, pick({ x: 37.5, z: 37.5 }), { button: 2 }))
    expect(c.getStranded()).not.toBeNull()
    t.position = { x: 12.5, z: 7.5 }
    c.sceneChanged()
    expect(c.getStranded()).toBeNull()
    // Onto a crate: no jump is offered.
    add(scene, createProp(levelId, "crate", { x: 7.5, y: 0, z: 37.5 }))
    f.planner.setScene({ ...scene, objects: { ...scene.objects } })
    c.pointerDown(ev(0, 0, pick({ x: 7.5, z: 37.5 }), { button: 2 }))
    c.pointerUp(ev(0, 0, pick({ x: 7.5, z: 37.5 }), { button: 2 }))
    expect(c.getStranded()?.blocked).toBe(true)
    c.jumpStranded()
    expect(f.moves).toHaveLength(1)
  })

  it("moves off the grid with Alt only when allowed (players) and always for the DM", () => {
    const { scene, levelId } = flatScene(10, 10)
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const run = (f: ReturnType<typeof controllerFixture>, alt: boolean) => {
      f.controller.setSelected(t.id)
      f.controller.pointerDown(ev(231, 88, pick({ x: 23.1, z: 8.8 }), { button: 2, alt }))
      f.controller.pointerUp(ev(231, 88, pick({ x: 23.1, z: 8.8 }), { button: 2, alt }))
      return f.moves[f.moves.length - 1]
    }
    const snapped = run(controllerFixture("player", scene, levelId), true)
    expect(snapped).toMatchObject({ kind: "path", end: null })
    const free = run(controllerFixture("player", scene, levelId, { free: true }), true)
    expect(free).toMatchObject({ kind: "path", end: { x: 23.1, z: 8.8 } })
    // A straight line in the open: the route is pulled to its two ends.
    expect(free.kind === "path" && free.route.map((p) => p.position)).toEqual([
      { x: 7.5, z: 7.5 },
      { x: 23.1, z: 8.8 },
    ])
    expect(run(controllerFixture("player", scene, levelId, { free: true }), false)).toMatchObject({ end: null })
    expect(run(controllerFixture("dm", scene, levelId), true)).toEqual({ kind: "place", tokenId: t.id, levelId, position: { x: 23.1, z: 8.8 } })
    expect(run(controllerFixture("dm", scene, levelId), false)).toMatchObject({ position: { x: 22.5, z: 7.5 } })
  })

  it("nudges a token within its own cell off the grid, and follows Alt pressed mid-command", () => {
    const { scene, levelId } = flatScene(10, 10)
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const f = controllerFixture("player", scene, levelId, { free: true })
    const c = f.controller
    c.setSelected(t.id)
    c.pointerDown(ev(0, 0, pick({ x: 8.5, z: 6 }), { button: 2 }))
    expect(c.overlays().ruler).toBeNull()
    c.setAlt(true)
    expect(c.overlays().dragGhosts[t.id]?.position).toEqual({ x: 8.5, z: 6 })
    c.pointerUp(ev(0, 0, pick({ x: 8.5, z: 6 }), { button: 2, alt: true }))
    expect(f.moves).toEqual([
      expect.objectContaining({ kind: "path", path: [at(1, 1, levelId)], end: { x: 8.5, z: 6 } }),
    ])
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

describe("PlayController: long-press pings", () => {
  /** A fixture whose long-press timer the test fires by hand. */
  function pinging(role: "player" | "dm") {
    const { scene, levelId } = flatScene(10, 10)
    const f = controllerFixture(role, scene, levelId)
    const pings: { levelId: Id; point: { x: number; y: number; z: number }; shift: boolean }[] = []
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = []
    const host = (f.controller as unknown as { host: PlayControllerHost }).host
    host.onPing = (lvl, point, shift) => pings.push({ levelId: lvl, point, shift })
    host.setTimer = (fn, ms) => {
      const t = { fn, ms, cancelled: false }
      timers.push(t)
      return () => {
        t.cancelled = true
      }
    }
    const fire = () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn()
    }
    return { ...f, scene, levelId, pings, timers, fire }
  }

  it("a still press on the ground pings it; its release does nothing else", () => {
    const f = pinging("dm")
    const t = tokenAt(f.scene, f.levelId, { i: 1, j: 1 })
    f.controller.setSelected(t.id)
    f.controller.pointerDown(ev(300, 300, pick({ x: 30, z: 30 }), { shift: true }))
    expect(f.timers.map((x) => x.ms)).toEqual([LONG_PRESS_MS])
    f.controller.pointerMove(ev(302, 301, pick({ x: 30.2, z: 30.1 })))
    f.fire()
    expect(f.pings).toEqual([{ levelId: f.levelId, point: { x: 30, y: 0, z: 30 }, shift: true }])
    // The release neither deselects (DM) nor clicks a door.
    expect(f.controller.pointerUp(ev(302, 301, pick({ x: 30.2, z: 30.1 })))).toBe(true)
    expect(f.selections).toEqual([])
    // The next click behaves normally again.
    f.controller.pointerDown(ev(300, 300, pick({ x: 30, z: 30 })))
    f.controller.pointerUp(ev(300, 300, pick({ x: 30, z: 30 })))
    expect(f.selections).toEqual([null])
  })

  it("moving, releasing early, dragging a token or measuring never pings", () => {
    const f = pinging("player")
    // Moved away.
    f.controller.pointerDown(ev(100, 100, pick({ x: 10, z: 10 })))
    f.controller.pointerMove(ev(120, 100, pick({ x: 12, z: 10 })))
    f.fire()
    f.controller.pointerUp(ev(120, 100, pick({ x: 12, z: 10 })))
    // Released first.
    f.controller.pointerDown(ev(100, 100, pick({ x: 10, z: 10 })))
    f.controller.pointerUp(ev(100, 100, pick({ x: 10, z: 10 })))
    f.fire()
    // A press on a token the player can drag.
    const t = tokenAt(f.scene, f.levelId, { i: 1, j: 1 })
    f.controller.pointerDown(ev(75, 75, pick({ x: 7.5, z: 7.5 }, { tokenId: t.id })))
    f.fire()
    f.controller.pointerUp(ev(75, 75, pick({ x: 7.5, z: 7.5 })))
    // Nothing under the pointer.
    f.controller.pointerDown(ev(5, 5, pick(null)))
    f.fire()
    f.controller.pointerUp(ev(5, 5, pick(null)))
    // Measuring.
    f.controller.setTool("measure")
    f.controller.pointerDown(ev(100, 100, pick({ x: 10, z: 10 })))
    f.fire()
    f.controller.pointerUp(ev(100, 100, pick({ x: 10, z: 10 })))
    expect(f.pings).toEqual([])
  })
})
