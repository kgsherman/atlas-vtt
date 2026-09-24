// @vitest-environment jsdom
/**
 * Regression: Base UI menu labels throw ("MenuGroupContext is missing") outside a Group, which crashed
 * the whole host console (and sent every player to "Waiting for the DM") on a light right-click or
 * on opening "Controlled by" before anyone had joined. Also: the token's Conditions submenu.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { createLight, createScene, createToken } from "@/core/scene/factory"
import { sortedLevels } from "@/core/scene/queries"
import { createGameState } from "@/core/session/state"
import type { GameState } from "@/core/session/types"

import type { HostActions } from "./hostActions"
import { HostContextMenuContent } from "./HostContextMenu"
import type { MenuTarget } from "./menuTarget"

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
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  document.body.innerHTML = ""
})

function fixture(): { state: GameState; lightId: string; tokenId: string } {
  const scene = createScene()
  const levelId = sortedLevels(scene)[0].id
  const light = createLight(
    levelId,
    "torch",
    { x: 10, z: 10 },
    { name: "Torch" }
  )
  const token = createToken(levelId, { x: 12.5, z: 12.5 }, { name: "Hero" })
  scene.objects[light.id] = light
  scene.tokens[token.id] = token
  const state = createGameState({ sessionId: "s", roomCode: "ABCDEFGH", scene })
  return { state, lightId: light.id, tokenId: token.id }
}

function renderMenu(
  state: GameState,
  target: MenuTarget,
  spies: Partial<HostActions> = {}
) {
  const actions = new Proxy(spies, {
    get: (t, k) => (k in t ? t[k as keyof HostActions] : vi.fn()),
  }) as unknown as HostActions
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <ContextMenu defaultOpen>
        <ContextMenuTrigger>map</ContextMenuTrigger>
        <HostContextMenuContent
          target={target}
          state={state}
          actions={actions}
          onPreview={vi.fn()}
          onSelect={vi.fn()}
        />
      </ContextMenu>
    )
  )
}

describe("HostContextMenuContent", () => {
  it("renders the light menu", () => {
    const { state, lightId } = fixture()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    renderMenu(state, { kind: "light", id: lightId })
    expect(document.body.textContent).toContain("Torch")
    expect(document.body.textContent).toContain("Put out")
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it("renders 'Controlled by' with no players", () => {
    const { state, tokenId } = fixture()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    renderMenu(state, { kind: "token", id: tokenId })
    const sub = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
      el.textContent?.includes("Controlled by")
    ) as HTMLElement | undefined
    expect(sub).toBeTruthy()
    act(() => sub!.click())
    expect(document.body.textContent).toContain("No players have joined yet")
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it("ticks a condition from the Conditions submenu", () => {
    const { state, tokenId } = fixture()
    state.scene.tokens[tokenId].conditions = ["prone"]
    const setTokenStatus = vi.fn()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    renderMenu(state, { kind: "token", id: tokenId }, { setTokenStatus })
    const item = (role: string, text: string) =>
      [...document.querySelectorAll(`[role="${role}"]`)].find((el) =>
        el.textContent?.includes(text)
      ) as HTMLElement | undefined
    act(() => item("menuitem", "Conditions")!.click())
    expect(
      item("menuitemcheckbox", "Prone")?.getAttribute("aria-checked")
    ).toBe("true")
    act(() => item("menuitemcheckbox", "Poisoned")!.click())
    expect(setTokenStatus).toHaveBeenCalledWith(tokenId, {
      conditions: ["poisoned", "prone"],
    })
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
