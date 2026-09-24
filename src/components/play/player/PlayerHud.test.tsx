// @vitest-environment jsdom
/**
 * The HUD tells players when their own connection is down instead of blaming the DM
 * ("DM not responding" / "Waiting for the DM…").
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { createScene } from "@/core/scene/factory"
import type { PlayerView } from "@/core/session/types"
import type { PlayerClientSnapshot } from "@/net/player"

import { PlayerHud } from "./PlayerHud"

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
})

function snapshot(over: Partial<PlayerClientSnapshot>): PlayerClientSnapshot {
  const view = {
    scene: { name: "The Crooked Lantern" },
    controlledTokenIds: [],
    visionTokenIds: [],
    flags: { movementLocked: false, sharedVision: false, enforceSpeed: false },
  } as unknown as PlayerView
  return {
    status: "live",
    error: null,
    sessionId: "s",
    userId: "u",
    view,
    scene: null,
    revision: 1,
    epoch: "1.x",
    seq: 1,
    hostOnline: true,
    pending: [],
    results: [],
    hostUnresponsive: false,
    viewSource: "live",
    networkOffline: false,
    ...over,
  }
}

function render(snap: PlayerClientSnapshot): string {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <PlayerHud
        snap={snap}
        scene={createScene()}
        selectedId={null}
        onSelect={vi.fn()}
        tool="move"
        onTool={vi.fn()}
        climbs={[]}
        onClimb={vi.fn()}
        camera={{
          onRotate: vi.fn(),
          onZoom: vi.fn(),
          grid: true,
          onGrid: vi.fn(),
        }}
        chat={{
          entries: [],
          focusSignal: 0,
          disabledReason: null,
          onSay: vi.fn(),
          onRoll: vi.fn(),
        }}
        turn={null}
        onEndTurn={vi.fn()}
        onRollInitiative={vi.fn()}
        onFocusToken={vi.fn()}
      />
    )
  )
  return host.textContent ?? ""
}

describe("PlayerHud connection state", () => {
  it("says the player is offline rather than blaming the DM", () => {
    const text = render(
      snapshot({
        status: "syncing",
        hostUnresponsive: false,
        networkOffline: true,
      })
    )
    expect(text).toContain("You're offline, reconnecting…")
    expect(text).toContain("You're offline")
    expect(text).not.toContain("Syncing with the DM")
    expect(text).not.toContain("DM not responding")
  })

  it("still reports the DM when the player's own connection is fine", () => {
    expect(render(snapshot({ hostUnresponsive: true }))).toContain(
      "DM not responding"
    )
    act(() => root?.unmount())
    expect(render(snapshot({ status: "host-offline" }))).toContain(
      "Waiting for the DM…"
    )
  })
})
