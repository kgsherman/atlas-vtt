import { afterEach, describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"
import { createMemoryStore } from "@/net/localStore"

import { createServices } from "./createServices"
import type { AppServices } from "./services"

let services: AppServices | null = null

afterEach(async () => {
  await services?.transport.dispose()
  services = null
})

describe("createServices (local mode)", () => {
  it("wires a local identity, library, sessions and transport", async () => {
    services = await createServices({ mode: "local", store: createMemoryStore() })
    expect(services.mode).toBe("local")
    expect(services.identity.mode).toBe("local")
    expect(services.identity.userId).toMatch(/^[0-9a-f-]{36}$/)
    expect(services.scenes.storage).toBe("local")
    expect(services.sessions.storage).toBe("local")
    expect(services.transport.kind).toBe("local")

    const summary = await services.scenes.create(createScene({ name: "Keep" }))
    expect((await services.scenes.list()).map((s) => s.name)).toEqual(["Keep"])

    // Sessions act as the services' identity.
    const created = await services.sessions.createSession(summary.id)
    const mine = await services.sessions.listMySessions()
    expect(mine.map((s) => s.id)).toEqual([created.sessionId])
    expect((await services.sessions.sessionInfo(created.sessionId))?.role).toBe("dm")
  })

  it("normalises and remembers the display name", async () => {
    services = await createServices({ mode: "local", store: createMemoryStore() })
    await expect(services.setDisplayName("   Ser   Brienne  ")).resolves.toBe("Ser Brienne")
    expect(services.identity.displayName).toBe("Ser Brienne")
    await expect(services.setDisplayName("   ")).rejects.toMatchObject({ code: "invalid_display_name" })
  })

  it("never fails because of the tile source", async () => {
    services = await createServices({ mode: "local", store: createMemoryStore() })
    const tiles = services.tilesFor("s1")
    expect(typeof tiles.getTile).toBe("function")
    tiles.dispose()
  })
})
