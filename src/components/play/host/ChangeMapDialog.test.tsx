// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { ServicesContext, type AppServices } from "@/app/services"
import { createScene, createToken } from "@/core/scene/factory"
import { sortedLevels } from "@/core/scene/queries"
import type { Scene } from "@/core/scene/types"
import { createGameState } from "@/core/session/state"
import type { GameState } from "@/core/session/types"
import type { SceneSummary } from "@/net/scenesRepo"

import { ChangeMapDialog, type ChangeMapDialogProps } from "./ChangeMapDialog"
import type { ChangeMapOutcome, ChangeMapRequest } from "./changeMapModel"
import type { SaveMap } from "./useSaveMap"

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  // jsdom has no Web Animations (Base UI's scroll area and dialog ask for running animations).
  Element.prototype.getAnimations ??= () => []
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  document.body.innerHTML = ""
})

function summary(id: string, name: string): SceneSummary {
  return {
    id,
    name,
    visibility: "private",
    shareSlug: null,
    latestVersion: 3,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  }
}

/** The live game: a PC, a player's pony and a wolf on "The Crooked Lantern". */
function liveGame(): { state: GameState; ids: Record<string, string> } {
  const scene = createScene({ name: "The Crooked Lantern" })
  const levelId = sortedLevels(scene)[0].id
  const add = (name: string, kind: "pc" | "npc" | "monster", x: number) => {
    const t = createToken(levelId, { x, z: 2.5 }, { name, kind })
    scene.tokens[t.id] = t
    return t.id
  }
  const ids = {
    mira: add("Mira", "pc", 2.5),
    pony: add("Pony", "npc", 7.5),
    wolf: add("Wolf", "monster", 12.5),
  }
  const state = createGameState({ sessionId: "s", roomCode: "ABCDEFGH", scene })
  state.players = {
    u1: {
      userId: "u1",
      displayName: "Ana",
      color: "#ff0000",
      movementLocked: false,
    },
  }
  state.owners = { [ids.pony]: ["u1"] }
  return { state, ids }
}

function fakeServices(target: Scene): AppServices {
  const rows = [
    summary("row-1", "The Crooked Lantern"),
    summary("row-2", "The Sunken Crypt"),
  ]
  return {
    mode: "local",
    identity: { userId: "dm" },
    scenes: {
      list: async () => rows,
      get: async (id: string) => rows.find((r) => r.id === id) ?? null,
      load: async (id: string) => {
        const row = rows.find((r) => r.id === id)!
        const scene = id === "row-2" ? target : createScene({ name: row.name })
        return {
          summary: row,
          version: 3,
          schemaVersion: scene.schemaVersion,
          parsed: { ok: true, scene, migratedFrom: null },
        }
      },
    },
    assets: { getImage: async () => null },
  } as unknown as AppServices
}

const linked: SaveMap["library"] = {
  status: "linked",
  sceneId: "row-1",
  name: "The Crooked Lantern",
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })
}

function buttons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll("button")]
}

function button(name: string): HTMLButtonElement {
  const b = buttons().find(
    (el) =>
      el.getAttribute("aria-label") === name || el.textContent?.trim() === name
  )
  if (!b)
    throw new Error(
      `no button “${name}”: ${buttons()
        .map((el) => el.getAttribute("aria-label") ?? el.textContent)
        .join(" | ")}`
    )
  return b
}

async function click(el: HTMLElement) {
  await act(async () => el.click())
  await flush()
}

async function mount(
  props: Partial<ChangeMapDialogProps> & {
    onChange: ChangeMapDialogProps["onChange"]
  }
) {
  const { state, ids } = liveGame()
  const target = createScene({ name: "The Sunken Crypt" })
  const onOpenChange = vi.fn()
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ServicesContext.Provider value={fakeServices(target)}>
        <ChangeMapDialog
          open
          onOpenChange={onOpenChange}
          state={state}
          currentSceneId="row-1"
          saveMap={{ library: linked, dirty: false, saving: false }}
          {...props}
        />
      </ServicesContext.Provider>
    )
  })
  await flush()
  return { state, ids, target, onOpenChange }
}

/** Pick "The Sunken Crypt", then review. */
async function toConfirm() {
  await click(button("Move the game to The Sunken Crypt"))
  await click(button("Review"))
}

function checked(tokenName: string): boolean {
  const row = [
    ...document.body.querySelectorAll<HTMLElement>("[data-slot=field]"),
  ].find((f) => f.querySelector("label")?.textContent === tokenName)
  const box = row?.querySelector("[role=checkbox]")
  if (!box) throw new Error(`no party row for ${tokenName}`)
  return box.getAttribute("aria-checked") === "true"
}

describe("ChangeMapDialog", () => {
  it("lists the library with the current map marked and not selectable", async () => {
    await mount({ onChange: vi.fn() })
    const current = button("The Crooked Lantern (the current map)")
    expect(current.disabled).toBe(true)
    expect(current.textContent).toContain("Current map")
    expect(button("Move the game to The Sunken Crypt").disabled).toBe(false)
    // Each card is a button (no role of its own) inside an item of the "Your maps" list.
    expect(current.hasAttribute("role")).toBe(false)
    expect(
      current
        .closest("[role=listitem]")
        ?.parentElement?.getAttribute("aria-label")
    ).toBe("Your maps")
  })

  it("brings PCs and the players' tokens by default", async () => {
    await mount({ onChange: vi.fn() })
    await click(button("Move the game to The Sunken Crypt"))
    expect(document.body.textContent).toContain("Who comes along")
    expect(checked("Mira")).toBe(true)
    expect(checked("Pony")).toBe(true)
    expect(checked("Wolf")).toBe(false)
  })

  it("offers to save unsaved edits first and stays open when that fails", async () => {
    const onChange = vi.fn(
      async (_req: ChangeMapRequest): Promise<ChangeMapOutcome> => false
    )
    const { ids, target, onOpenChange } = await mount({
      onChange,
      saveMap: { library: linked, dirty: true, saving: false },
    })
    await toConfirm()
    // Keep playing, change without saving, or save and change.
    expect(button("Keep playing here")).toBeTruthy()
    expect(button("Change without saving").disabled).toBe(false)
    expect(button("Save map & change").disabled).toBe(false)
    expect(document.body.textContent).toContain(
      "Save it to “The Crooked Lantern” in your library first"
    )

    await click(button("Save map & change"))
    expect(onChange).toHaveBeenCalledTimes(1)
    const req = onChange.mock.calls[0][0]
    expect(req.save).toBe(true)
    expect(req.scene).toBe(target)
    expect(req.origin).toEqual({ sceneId: "row-2", version: 3, dirty: false })
    expect(req.name).toBe("The Sunken Crypt")
    expect([...req.tokenIds].sort()).toEqual([ids.mira, ids.pony].sort())
    expect(req.arrival.levelId).toBe(sortedLevels(target)[0].id)
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(button("Save map & change").disabled).toBe(false)
  })

  it("shows a refusal inline and keeps the dialog open", async () => {
    const onChange = vi.fn(
      async (): Promise<ChangeMapOutcome> =>
        "There's no room on that level for Pony."
    )
    const { onOpenChange } = await mount({ onChange })
    await toConfirm()
    await click(button("Change map"))
    expect(document.body.textContent).toContain(
      "There's no room on that level for Pony."
    )
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("changes a clean map in one step and closes", async () => {
    const onChange = vi.fn(async (): Promise<ChangeMapOutcome> => true)
    const { onOpenChange } = await mount({ onChange })
    await toConfirm()
    expect(buttons().some((b) => b.textContent?.includes("Save map"))).toBe(
      false
    )
    await click(button("Change map"))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ save: false })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("holds the save choice while the library scene is looked up, and refuses to change while saving", async () => {
    const onChange = vi.fn(async (): Promise<ChangeMapOutcome> => true)
    await mount({
      onChange,
      saveMap: { library: { status: "loading" }, dirty: true, saving: true },
    })
    await toConfirm()
    expect(button("Save map & change").disabled).toBe(true)
    expect(button("Change without saving").disabled).toBe(true)
    expect(document.body.textContent).toContain(
      "Saving the map to your library"
    )
  })
})
