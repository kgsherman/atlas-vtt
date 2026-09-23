// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { ServicesContext, type AppServices } from "@/app/services"
import { ConfirmContext } from "@/components/editor/context"
import { createScene } from "@/core/scene/factory"
import type { Scene } from "@/core/scene/types"
import { NetError } from "@/net/supabase"

import { changedSinceStart, useSaveMap, type SaveMap } from "./useSaveMap"

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}))
const { toast } = await import("sonner")

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const SESSION_START = "2026-09-01T10:00:00.000Z"

function fakeServices(
  opts: {
    sceneId?: string | null
    updatedAt?: string
    saveVersion?: (
      id: string,
      scene: Scene,
      o?: { baseVersion?: number; name?: string }
    ) => Promise<number>
  } = {}
) {
  const sceneId = opts.sceneId === undefined ? "row-1" : opts.sceneId
  const summary = {
    id: "row-1",
    name: "The Crooked Lantern",
    visibility: "private",
    shareSlug: null,
    latestVersion: 4,
    createdAt: SESSION_START,
    updatedAt: opts.updatedAt ?? "2026-09-01T09:00:00.000Z",
  }
  const saveVersion = vi.fn(opts.saveVersion ?? (async () => 5))
  const services = {
    sessions: {
      listMySessions: async () => [
        {
          id: "sess",
          sceneId,
          roomCode: "ABCDEFGH",
          status: "active",
          hostEpoch: 1,
          createdAt: SESSION_START,
          endedAt: null,
        },
      ],
    },
    scenes: {
      get: async (id: string) => (id === "row-1" && sceneId ? summary : null),
      saveVersion,
    },
  } as unknown as AppServices
  return { services, saveVersion }
}

async function mount(
  services: AppServices,
  scene: Scene
): Promise<{ current: SaveMap }> {
  const ref = { current: null as unknown as SaveMap }
  function Probe() {
    ref.current = useSaveMap("sess", () => scene)
    return null
  }
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ServicesContext.Provider value={services}>
        <ConfirmContext.Provider value={async () => true}>
          <Probe />
        </ConfirmContext.Provider>
      </ServicesContext.Provider>
    )
  })
  return ref
}

describe("useSaveMap", () => {
  it("compares the library row's update time with the session start", () => {
    expect(changedSinceStart("2026-09-01T11:00:00Z", SESSION_START)).toBe(true)
    expect(changedSinceStart("2026-09-01T09:00:00Z", SESSION_START)).toBe(false)
    expect(changedSinceStart("garbage", SESSION_START)).toBe(false)
  })

  it("saves the live map as a new version on top of the library's latest", async () => {
    const { services, saveVersion } = fakeServices()
    const scene = createScene({ name: "Old name" })
    const ref = await mount(services, scene)
    expect(ref.current.library).toEqual({
      status: "linked",
      sceneId: "row-1",
      name: "The Crooked Lantern",
    })
    act(() => ref.current.markDirty())
    expect(ref.current.dirty).toBe(true)
    let ok = false
    await act(async () => {
      ok = await ref.current.save()
    })
    expect(ok).toBe(true)
    expect(saveVersion).toHaveBeenCalledTimes(1)
    const [id, doc, o] = saveVersion.mock.calls[0]
    expect(id).toBe("row-1")
    expect(doc.id).toBe(scene.id)
    expect(doc.name).toBe("The Crooked Lantern")
    expect(o).toEqual({ baseVersion: 4, name: "The Crooked Lantern" })
    expect(ref.current.dirty).toBe(false)
    expect(toast.success).toHaveBeenCalledWith(
      "Saved version 5",
      expect.anything()
    )
    // The next save builds on the version saved here.
    await act(async () => {
      await ref.current.save({ confirm: false })
    })
    expect(saveVersion.mock.calls[1][2]).toMatchObject({ baseVersion: 5 })
  })

  it("asks before overwriting a library scene changed since the session started", async () => {
    const { services, saveVersion } = fakeServices({
      updatedAt: "2026-09-01T12:00:00.000Z",
    })
    const ref = await mount(services, createScene())
    let ok = true
    await act(async () => {
      ok = await ref.current.save({ confirm: false })
    })
    expect(ok).toBe(false)
    expect(saveVersion).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      "The library map was changed since this session started",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Overwrite" }),
      })
    )
    await act(async () => {
      ok = await ref.current.save({ confirm: false, force: true })
    })
    expect(ok).toBe(true)
    expect(saveVersion.mock.calls[0][2]).toEqual({
      baseVersion: undefined,
      name: "The Crooked Lantern",
    })
  })

  it("reports a version conflict from the repository", async () => {
    const { services } = fakeServices({
      saveVersion: async () => {
        throw new NetError("version_conflict", "conflict")
      },
    })
    const ref = await mount(services, createScene())
    act(() => ref.current.markDirty())
    let ok = true
    await act(async () => {
      ok = await ref.current.save({ confirm: false })
    })
    expect(ok).toBe(false)
    expect(ref.current.dirty).toBe(true)
    expect(toast.error).toHaveBeenCalledWith(
      "The library map was changed since this session started",
      expect.anything()
    )
  })

  it("has nothing to save to when the library scene was deleted", async () => {
    const { services, saveVersion } = fakeServices({ sceneId: null })
    const ref = await mount(services, createScene())
    expect(ref.current.library).toEqual({ status: "deleted" })
    let ok = true
    await act(async () => {
      ok = await ref.current.save()
    })
    expect(ok).toBe(false)
    expect(saveVersion).not.toHaveBeenCalled()
  })

  it("remembers unsaved edits per session across reloads", async () => {
    const { services } = fakeServices()
    const first = await mount(services, createScene())
    act(() => first.current.markDirty())
    act(() => root?.unmount())
    const second = await mount(services, createScene())
    expect(second.current.dirty).toBe(true)
  })
})
