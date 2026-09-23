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
import type { HostSnapshot } from "@/net/host"
import { NetError } from "@/net/supabase"

import {
  changedSinceStart,
  useSaveMap,
  type SaveMap,
  type SaveMapRunner,
} from "./useSaveMap"

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
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const SESSION_START = "2026-09-01T10:00:00.000Z"

type Library = HostSnapshot["library"]

function fakeServices(opts: { exists?: boolean; updatedAt?: string } = {}) {
  const summary = {
    id: "row-1",
    name: "The Crooked Lantern",
    visibility: "private",
    shareSlug: null,
    latestVersion: 4,
    createdAt: SESSION_START,
    updatedAt: opts.updatedAt ?? "2026-09-01T09:00:00.000Z",
  }
  const services = {
    sessions: {
      listMySessions: async () => [
        {
          id: "sess",
          sceneId: "row-1",
          roomCode: "ABCDEFGH",
          status: "active",
          hostEpoch: 1,
          createdAt: SESSION_START,
          endedAt: null,
        },
      ],
    },
    scenes: {
      get: async (id: string) =>
        id === "row-1" && opts.exists !== false ? summary : null,
    },
  } as unknown as AppServices
  return services
}

/** A runner whose save bumps the origin like HostRunner does (version + 1, clean). */
function fakeRunner(
  initial: Library,
  save?: (o?: { force?: boolean }) => Promise<number>
) {
  const box = { library: initial }
  const saveMapToLibrary = vi.fn(
    save ??
      (async () => {
        const next = (box.library?.version ?? 4) + 1
        box.library = { sceneId: "row-1", version: next, dirty: false }
        return next
      })
  )
  const runner: SaveMapRunner = { saveMapToLibrary }
  return { runner, saveMapToLibrary, box }
}

async function mount(
  services: AppServices,
  runner: SaveMapRunner,
  box: { library: Library }
): Promise<{ current: SaveMap; rerender(): Promise<void> }> {
  const ref = { current: null as unknown as SaveMap }
  function Probe() {
    ref.current = useSaveMap(runner, {
      sessionId: "sess",
      library: box.library,
    })
    return null
  }
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  const render = async () => {
    await act(async () => {
      root!.render(
        <ServicesContext.Provider value={services}>
          <ConfirmContext.Provider value={async () => true}>
            <Probe />
          </ConfirmContext.Provider>
        </ServicesContext.Provider>
      )
    })
  }
  await render()
  return Object.assign(ref, { rerender: render })
}

describe("useSaveMap", () => {
  it("compares the library row's update time with the session start", () => {
    expect(changedSinceStart("2026-09-01T11:00:00Z", SESSION_START)).toBe(true)
    expect(changedSinceStart("2026-09-01T09:00:00Z", SESSION_START)).toBe(false)
    expect(changedSinceStart("garbage", SESSION_START)).toBe(false)
  })

  it("saves the live map through the host runner and follows its origin", async () => {
    const { runner, saveMapToLibrary, box } = fakeRunner({
      sceneId: "row-1",
      version: 4,
      dirty: true,
    })
    const ref = await mount(fakeServices(), runner, box)
    expect(ref.current.library).toEqual({
      status: "linked",
      sceneId: "row-1",
      name: "The Crooked Lantern",
    })
    // Dirty comes from the game's origin (set by Edit map changes on the host).
    expect(ref.current.dirty).toBe(true)
    let ok = false
    await act(async () => {
      ok = await ref.current.save()
    })
    expect(ok).toBe(true)
    expect(saveMapToLibrary).toHaveBeenCalledWith({ force: undefined })
    expect(toast.success).toHaveBeenCalledWith(
      "Saved version 5",
      expect.anything()
    )
    await ref.rerender()
    expect(ref.current.dirty).toBe(false)
  })

  it("offers to overwrite on a version conflict from the runner", async () => {
    const { runner, saveMapToLibrary, box } = fakeRunner(
      { sceneId: "row-1", version: 4, dirty: true },
      async (o) => {
        if (!o?.force) throw new NetError("version_conflict", "conflict")
        return 6
      }
    )
    const ref = await mount(fakeServices(), runner, box)
    let ok = true
    await act(async () => {
      ok = await ref.current.save({ confirm: false })
    })
    expect(ok).toBe(false)
    expect(ref.current.dirty).toBe(true)
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
    expect(saveMapToLibrary).toHaveBeenLastCalledWith({ force: true })
  })

  it("asks first when no base version is known and the library changed since the session started", async () => {
    const { runner, saveMapToLibrary, box } = fakeRunner({
      sceneId: "row-1",
      version: null,
      dirty: false,
    })
    const ref = await mount(
      fakeServices({ updatedAt: "2026-09-01T12:00:00.000Z" }),
      runner,
      box
    )
    let ok = true
    await act(async () => {
      ok = await ref.current.save({ confirm: false })
    })
    expect(ok).toBe(false)
    expect(saveMapToLibrary).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      "The library map was changed since this session started",
      expect.anything()
    )
    await act(async () => {
      ok = await ref.current.save({ confirm: false, force: true })
    })
    expect(ok).toBe(true)
    expect(saveMapToLibrary).toHaveBeenCalledWith({ force: true })
  })

  it("has nothing to save to when the library scene is gone", async () => {
    const none = fakeRunner(null)
    const ref = await mount(fakeServices(), none.runner, none.box)
    expect(ref.current.library).toEqual({ status: "deleted" })
    let ok = true
    await act(async () => {
      ok = await ref.current.save()
    })
    expect(ok).toBe(false)
    expect(none.saveMapToLibrary).not.toHaveBeenCalled()
    act(() => root?.unmount())

    // Deleted from the library after the session started.
    const deleted = fakeRunner({ sceneId: "row-1", version: 3, dirty: true })
    const ref2 = await mount(
      fakeServices({ exists: false }),
      deleted.runner,
      deleted.box
    )
    expect(ref2.current.library).toEqual({ status: "deleted" })
  })

  it("reports a library scene deleted while saving", async () => {
    const { runner, box } = fakeRunner(
      { sceneId: "row-1", version: 4, dirty: true },
      async () => {
        throw new NetError("not_found", "gone")
      }
    )
    const ref = await mount(fakeServices(), runner, box)
    await act(async () => {
      await ref.current.save({ confirm: false })
    })
    expect(toast.error).toHaveBeenCalledWith(
      "The library scene was deleted",
      expect.anything()
    )
    expect(ref.current.library).toEqual({ status: "deleted" })
  })
})
