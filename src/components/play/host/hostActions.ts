/**
 * The DM's play commands (ARCHITECTURE §8 "DM play controls") as one object shared by the session
 * panel, the context menus and the keyboard: every command goes through HostRunner.dispatch (DmCommand)
 * or applyScenePatches (scene edits such as hiding tokens or switching the sun), and refusals become
 * toasts. The table (chat, dice, combat) goes through the same dispatch: the DM's tab is the host, so
 * its dice (crypto, unbiased) are the table's dice.
 */
import { toast } from "sonner"

import { cryptoDiceRng } from "@/core/dice/dice"
import { newId } from "@/core/scene/factory"
import { groundHeightAt, levelById } from "@/core/scene/queries"
import type {
  TokenCondition,
  TokenHp,
  TokenStatusChange,
} from "@/core/scene/tokenStatus"
import type { DoorState, Id, Scene, Vec2 } from "@/core/scene/types"
import type { FreeAssetCategory } from "@/core/session/freeAssets"
import {
  dmRollCommand,
  dmSayCommand,
  npcInitiativeCommand,
  tableStamp,
  type TableContext,
} from "@/core/session/table"
import type {
  CombatEntry,
  DmCommand,
  GameState,
  TableAudience,
} from "@/core/session/types"
import type { HostRunnerImpl } from "@/net/host"
import {
  setDirectionalPatches,
  setObjectsHiddenPatches,
  setTokenImagePatches,
  setTokenModelPatches,
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
  setFreeMovement(enabled: boolean): void
  assign(tokenId: Id, userId: string, assigned: boolean): void
  revealDoor(doorId: Id, userId?: string): void
  setTokensHidden(tokenIds: Id[], hidden: boolean): void
  setObjectsHidden(objectIds: Id[], hidden: boolean): void
  setSun(enabled: boolean): void
  resetFog(userId?: string): void
  /** Token.model (`free:<id>`), or null for the default body. A map edit like hiding a token. */
  setTokenModel(tokenIds: Id[], model: string | null): void
  /** Token.imageUrl (a portrait, e.g. from the Token Maker), or null for none. Returns false when refused. */
  setTokenImage(tokenIds: Id[], imageUrl: string | null): boolean
  /** Free asset categories loaded into the game. */
  setFreeAssets(categories: FreeAssetCategory[]): void

  // ---- the table ----------------------------------------------------------------------------------
  /** Say something (`to`: "all", these players, or [] for a note only the DM sees). */
  say(text: string, to: TableAudience): void
  /** Roll "formula [label]"; returns why it can't be read, else null. */
  roll(input: string, to: TableAudience): string | null
  /** Start combat with these tokens (replacing any), nobody acting yet. */
  startCombat(tokenIds: Id[]): void
  endCombat(): void
  /** Add tokens (those already in combat are skipped); starts combat when none runs. */
  addToCombat(tokenIds: Id[]): void
  /** Remove a token's entry (by token id) or any entry (by entry id). */
  removeFromCombat(ids: { tokenId?: Id; entryId?: Id }): void
  addCustomCombatant(name: string, initiative: number | null): void
  updateCombatant(
    entryId: Id,
    patch: Partial<
      Pick<CombatEntry, "initiative" | "modifier" | "hidden" | "name">
    >
  ): void
  /** Next (1) or previous (-1) turn. */
  stepTurn(delta: 1 | -1): void
  setActiveCombatant(entryId: Id | null): void
  /** 1d20 + modifier for every unrolled entry no player controls. */
  rollNpcInitiative(): void
  /** Point at a spot for every player who knows the level (`focus`: centre their cameras on it). */
  ping(levelId: Id, point: Vec2, focus: boolean): void
  /** A token's hit points (null: stop tracking) and/or conditions (a play action, like a move). */
  setTokenStatus(
    tokenId: Id,
    status: { hp?: TokenHp | null; conditions?: TokenCondition[] }
  ): void
  /**
   * Damage, heal, temporary or max hit points (when tracked) and/or conditions to add and remove: the
   * reducer applies it to the token as the host holds it (never a copy an earlier render saw).
   */
  changeTokenStatus(tokenId: Id, change: TokenStatusChange): void
  /** Hide (or show) other creatures' health bands from players. */
  setHideWounds(hidden: boolean): void
}

export function createHostActions(
  runner: HostRunnerImpl,
  getState: () => GameState | null
): HostActions {
  const scene = (): Scene | null => getState()?.scene ?? null
  const rng = cryptoDiceRng()
  const ctx = (): TableContext => ({ now: Date.now(), newId, rng })
  // A hidden token needs no hidden entry: players are never sent a token they cannot see (filter.ts),
  // so its entry shows up for them once the token is revealed and in view.
  const tokenEntry = (tokenId: Id): CombatEntry => ({
    id: newId(),
    tokenId,
    name: "",
    initiative: null,
    modifier: 0,
    hidden: false,
  })

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
    setFreeMovement(enabled) {
      dispatch(
        { t: "set-free-movement", enabled },
        "Couldn't change the grid rule"
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
    setTokenModel(tokenIds, model) {
      const s = scene()
      if (s)
        patch(
          setTokenModelPatches(s, tokenIds, model),
          "Couldn't change the token's model"
        )
    },
    setTokenImage(tokenIds, imageUrl) {
      const s = scene()
      if (!s) return false
      const patches = setTokenImagePatches(s, tokenIds, imageUrl)
      if (patches.length === 0) return true
      return dispatch(
        { t: "apply-scene-patches", patches },
        "Couldn't change the token's image"
      )
    },
    setFreeAssets(categories) {
      dispatch(
        { t: "set-free-assets", categories },
        "Couldn't change the game's free assets"
      )
    },
    say(text, to) {
      const cmd = dmSayCommand(text, to, ctx())
      if (cmd) dispatch(cmd, "Couldn't send the message")
    },
    roll(input, to) {
      const r = dmRollCommand(input, to, ctx())
      if (!r.ok) return r.error
      dispatch(r.cmd, "Couldn't roll")
      return null
    },
    startCombat(tokenIds) {
      dispatch(
        {
          t: "combat-start",
          entries: tokenIds.map(tokenEntry),
          stamp: tableStamp(ctx()),
        },
        "Couldn't start combat"
      )
    },
    endCombat() {
      dispatch(
        { t: "combat-end", stamp: tableStamp(ctx()) },
        "Couldn't end combat"
      )
    },
    addToCombat(tokenIds) {
      if (!getState()?.table?.combat)
        dispatch(
          {
            t: "combat-start",
            entries: tokenIds.map(tokenEntry),
            stamp: tableStamp(ctx()),
          },
          "Couldn't start combat"
        )
      else
        dispatch(
          { t: "combat-add", entries: tokenIds.map(tokenEntry) },
          "Couldn't add to combat"
        )
    },
    removeFromCombat({ tokenId, entryId }) {
      const c = getState()?.table?.combat
      const e = c?.entries.find((x) =>
        entryId !== undefined ? x.id === entryId : x.tokenId === tokenId
      )
      if (e)
        dispatch(
          { t: "combat-remove", entryId: e.id, stamp: tableStamp(ctx()) },
          "Couldn't remove from combat"
        )
    },
    addCustomCombatant(name, initiative) {
      const entry: CombatEntry = {
        id: newId(),
        tokenId: null,
        name,
        initiative,
        modifier: 0,
        hidden: false,
      }
      if (!getState()?.table?.combat)
        dispatch(
          { t: "combat-start", entries: [entry], stamp: tableStamp(ctx()) },
          "Couldn't start combat"
        )
      else
        dispatch(
          { t: "combat-add", entries: [entry] },
          "Couldn't add to combat"
        )
    },
    updateCombatant(entryId, patch) {
      dispatch(
        { t: "combat-update", updates: [{ entryId, patch }] },
        "Couldn't change the combatant"
      )
    },
    stepTurn(delta) {
      dispatch(
        { t: "combat-turn", delta, stamp: tableStamp(ctx()) },
        "Couldn't change the turn"
      )
    },
    setActiveCombatant(entryId) {
      dispatch({ t: "combat-set-active", entryId }, "Couldn't change the turn")
    },
    rollNpcInitiative() {
      const state = getState()
      const cmd = state ? npcInitiativeCommand(state, null, ctx()) : null
      if (!cmd) {
        toast.info("Everyone the DM runs has initiative already")
        return
      }
      dispatch(cmd, "Couldn't roll initiative")
    },
    ping(levelId, point, focus) {
      runner.ping(levelId, point, { focus })
    },
    setTokenStatus(tokenId, status) {
      dispatch(
        { t: "set-token-status", tokenId, ...status },
        "Couldn't change the token"
      )
    },
    changeTokenStatus(tokenId, change) {
      dispatch(
        { t: "change-token-status", tokenId, ...change },
        "Couldn't change the token"
      )
    },
    setHideWounds(hidden) {
      dispatch(
        { t: "set-hide-wounds", hidden },
        "Couldn't change what players see of wounds"
      )
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
