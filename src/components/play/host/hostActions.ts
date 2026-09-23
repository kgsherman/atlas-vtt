/**
 * The DM's play commands (ARCHITECTURE §8 "DM play controls") as one object shared by the session
 * panel, the context menus and the keyboard: every command goes through HostRunner.dispatch (DmCommand)
 * or applyScenePatches (scene edits such as hiding tokens or switching the sun), and refusals become
 * toasts.
 */
import { toast } from "sonner"

import {
  groundHeightAt,
  levelById,
  lightWorldPosition,
} from "@/core/scene/queries"
import type {
  DoorState,
  Id,
  LightObject,
  Scene,
  Vec2,
} from "@/core/scene/types"
import type { DmCommand, GameState } from "@/core/session/types"
import type { HostRunnerImpl } from "@/net/host"
import {
  setDirectionalPatches,
  setObjectsHiddenPatches,
  setTokensHiddenPatches,
} from "@/play"

export interface HostActions {
  dispatch(cmd: DmCommand, failure?: string): boolean
  moveToken(tokenId: Id, levelId: Id, position: Vec2): void
  moveTokenToLevel(tokenId: Id, levelId: Id): void
  setDoor(doorId: Id, state: DoorState): void
  setLight(lightId: Id, on: boolean): void
  setMovementLocked(locked: boolean, userId?: string): void
  setSharedVision(enabled: boolean): void
  setEnforceSpeed(enabled: boolean): void
  assign(tokenId: Id, userId: string, assigned: boolean): void
  revealDoor(doorId: Id, userId?: string): void
  setTokensHidden(tokenIds: Id[], hidden: boolean): void
  setObjectsHidden(objectIds: Id[], hidden: boolean): void
  setSun(enabled: boolean): void
  resetFog(userId?: string): void
}

export function createHostActions(
  runner: HostRunnerImpl,
  getState: () => GameState | null
): HostActions {
  const scene = (): Scene | null => getState()?.scene ?? null

  const dispatch = (cmd: DmCommand, failure = "That didn't work"): boolean => {
    const r = runner.dispatch(cmd)
    if (!r) {
      toast.error(failure, {
        description: "This tab is not hosting the session right now.",
      })
      return false
    }
    if (r.error) {
      toast.error(failure, { description: r.error })
      return false
    }
    return true
  }

  const patch = (
    patches: ReturnType<typeof setTokensHiddenPatches>,
    failure: string
  ) => {
    if (patches.length === 0) return
    dispatch({ t: "apply-scene-patches", patches }, failure)
  }

  return {
    dispatch,
    moveToken(tokenId, levelId, position) {
      dispatch(
        { t: "move-token", tokenId, levelId, x: position.x, z: position.z },
        "Couldn't move the token"
      )
    },
    moveTokenToLevel(tokenId, levelId) {
      const s = scene()
      const t = s && Object.hasOwn(s.tokens, tokenId) ? s.tokens[tokenId] : null
      if (!s || !t || !levelById(s, levelId)) return
      dispatch(
        { t: "move-token", tokenId, levelId, x: t.position.x, z: t.position.z },
        "Couldn't move the token"
      )
    },
    setDoor(doorId, state) {
      dispatch({ t: "set-door", doorId, state }, "Couldn't change the door")
    },
    setLight(lightId, on) {
      dispatch({ t: "set-light", lightId, on }, "Couldn't switch the light")
    },
    setMovementLocked(locked, userId) {
      dispatch(
        userId === undefined
          ? { t: "set-movement-locked", locked }
          : { t: "set-movement-locked", locked, userId },
        "Couldn't change the movement lock"
      )
    },
    setSharedVision(enabled) {
      dispatch(
        { t: "set-shared-vision", enabled },
        "Couldn't change party vision"
      )
    },
    setEnforceSpeed(enabled) {
      dispatch(
        { t: "set-enforce-speed", enabled },
        "Couldn't change the speed rule"
      )
    },
    assign(tokenId, userId, assigned) {
      dispatch(
        { t: "assign-token", tokenId, userId, assigned },
        assigned ? "Couldn't assign the token" : "Couldn't unassign the token"
      )
    },
    revealDoor(doorId, userId) {
      if (
        dispatch(
          userId === undefined
            ? { t: "reveal-object", objectId: doorId }
            : { t: "reveal-object", objectId: doorId, userId },
          "Couldn't reveal the door"
        )
      ) {
        toast.success(
          userId === undefined
            ? "Secret door revealed to every player"
            : "Secret door revealed"
        )
      }
    },
    setTokensHidden(tokenIds, hidden) {
      const s = scene()
      if (s)
        patch(
          setTokensHiddenPatches(s, tokenIds, hidden),
          hidden ? "Couldn't hide the token" : "Couldn't reveal the token"
        )
    },
    setObjectsHidden(objectIds, hidden) {
      const s = scene()
      if (s)
        patch(
          setObjectsHiddenPatches(s, objectIds, hidden),
          "Couldn't change visibility"
        )
    },
    setSun(enabled) {
      const s = scene()
      if (s) patch(setDirectionalPatches(s, enabled), "Couldn't change the sky")
    },
    resetFog(userId) {
      if (
        dispatch(
          userId === undefined
            ? { t: "reset-fog" }
            : { t: "reset-fog", userId },
          "Couldn't reset the fog"
        )
      ) {
        toast.success(
          userId === undefined
            ? "Fog of war reset for everyone"
            : "Fog of war reset"
        )
      }
    },
  }
}

/** World point of a light (for focusing / menus). */
export function lightPoint(
  scene: Scene,
  light: LightObject
): { x: number; y: number; z: number } {
  return lightWorldPosition(scene, light)
}

/** Ground point of a token (camera focus). */
export function tokenPoint(
  scene: Scene,
  tokenId: Id
): { x: number; y: number; z: number } | null {
  const t = Object.hasOwn(scene.tokens, tokenId) ? scene.tokens[tokenId] : null
  if (!t || !levelById(scene, t.levelId)) return null
  return {
    x: t.position.x,
    y: groundHeightAt(scene, t.levelId, t.position),
    z: t.position.z,
  }
}
