/**
 * Test harness of the terrain tool (vitest only, no WebGL): a store with a 20×20-cell scene, the tool
 * wired to a synthetic camera's projector and a recorder of Engine.previewTerrain calls, and pointer
 * builders that aim the camera's rays at world points (the ground pick marches the level's baked terrain).
 */
import { heightFollowParams } from "@/core/geometry/gizmo"
import { createScene } from "@/core/scene/factory"
import { levelGround } from "@/core/scene/queries"
import type { Id, Rect, Scene, TerrainShape, Vec3 } from "@/core/scene/types"
import type { TerrainOverlay } from "@/render/contracts"

import type { TerrainSubTool } from "../../settings"
import { makeStore, orthoCamera, screenPointer, worldPointer, type ScreenPointerInit, type TestCamera } from "../../test-utils"
import { createTerrainTool } from "../terrain"
import type { ToolPointerEvent } from "../types"

export interface PreviewCall {
  levelId: Id
  heights: Float32Array | null
  dirty: Rect | null
}

export function terrainHarness(opts: { scene?: Scene; camera?: TestCamera; sub?: TerrainSubTool; project?: boolean } = {}) {
  const scene = opts.scene ?? createScene({ width: 20, depth: 20 })
  const store = makeStore(scene)
  const levelId = store.getState().activeLevelId
  store.getState().setTool("terrain")
  store.getState().setToolSettings("terrain", { sub: opts.sub ?? "select" })
  const camera = opts.camera ?? orthoCamera({ tilt: 15 })
  const previews: PreviewCall[] = []
  let invalidations = 0
  const tool = createTerrainTool({
    store,
    invalidate: () => invalidations++,
    previewTerrain: (l, heights, dirty) => previews.push({ levelId: l, heights, dirty }),
    project: opts.project === false ? undefined : camera.project,
  })
  const ground = (x: number, z: number) => levelGround(store.getState().scene, store.getState().activeLevelId, x, z)

  /** Pointer over world point (x, y, z); the pick's ground is the level's baked terrain along the ray. */
  const at = (x: number, y: number, z: number, init: ScreenPointerInit = {}): ToolPointerEvent =>
    worldPointer(camera, { x, y, z }, { groundY: ground, ...init })
  /** Pointer at canvas pixel (x, y). */
  const px = (x: number, y: number, init: ScreenPointerInit = {}): ToolPointerEvent => screenPointer(camera, x, y, { groundY: ground, ...init })

  return {
    store,
    levelId,
    tool,
    camera,
    previews,
    invalidations: () => invalidations,
    at,
    px,
    /**
     * The cursor that asks the creation height phase for height `h` above `anchor` (the base's release
     * corner, world), from the release event: c = c₀ + u·k·h (core/geometry/gizmo heightFollowParams, with
     * the creation's screen-up fallback).
     */
    heightAt(anchor: Vec3, release: ToolPointerEvent, h: number, init: ScreenPointerInit = {}): ToolPointerEvent {
      const params = heightFollowParams(camera.project, anchor, release.pick.ray!.direction, { screenUpWhenFloored: true })!
      return px(release.canvasX! + params.u.x * params.k * h, release.canvasY! + params.u.y * params.k * h, init)
    },
    overlay(): TerrainOverlay {
      const o = tool.preview()
      if (o?.kind !== "terrain") throw new Error("expected a terrain overlay")
      return o
    },
    shapes(): TerrainShape[] {
      return Object.values(store.getState().scene.levels[levelId].terrainEdits?.shapes ?? {})
    },
    shape(id: Id): TerrainShape {
      return store.getState().scene.levels[levelId].terrainEdits!.shapes[id]
    },
    /** Commit a shape directly (one undo step). */
    add(shape: TerrainShape): Id {
      if (!store.getState().applyTerrainEdit(levelId, { upsert: [shape] }, "Add shape")) throw new Error("shape refused")
      return shape.id
    },
    /** Baked terrain height (relative to the elevation) of the document at (x, z). */
    height(x: number, z: number): number {
      return ground(x, z) - store.getState().scene.levels[levelId].elevation
    },
    /** A preview lattice's height at world (x, z) (lattice samples every 2.5 ft on a res-2, 5-ft-cell level). */
    previewHeight(call: PreviewCall, x: number, z: number): number {
      const res = store.getState().scene.levels[levelId].heightmap?.resolution ?? 2
      const spacing = store.getState().scene.grid.cellSize / res
      const samplesX = store.getState().scene.grid.width * res + 1
      return call.heights![Math.round(z / spacing) * samplesX + Math.round(x / spacing)]
    },
  }
}

export type TerrainHarness = ReturnType<typeof terrainHarness>
