import { afterEach, describe, expect, it } from "vitest"

import { createPrivateChannel, parseTopic, privateChannelConfig, topics } from "./channels"
import { createAtlasClient, type AtlasClient } from "./supabase"

const SID = "0b5c3f5e-7a1d-4c1e-9f7a-2d3b4c5d6e7f"
const UID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"

describe("topics", () => {
  it("builds the four §6.1 topics", () => {
    expect(topics.req(SID, UID)).toBe(`session:${SID}:req:${UID}`)
    expect(topics.view(SID, UID)).toBe(`session:${SID}:view:${UID}`)
    expect(topics.host(SID)).toBe(`session:${SID}:host`)
    expect(topics.lobby(SID)).toBe(`session:${SID}:lobby`)
  })

  it("canonicalises ids to lowercase (the SQL parser only accepts lowercase)", () => {
    expect(topics.view(SID.toUpperCase(), UID.toUpperCase())).toBe(`session:${SID}:view:${UID}`)
  })

  it("rejects non-UUID ids", () => {
    expect(() => topics.host("not-a-uuid")).toThrow(/session id/)
    expect(() => topics.req(SID, `${UID}:x`)).toThrow(/user id/)
    expect(() => topics.lobby("")).toThrow()
  })
})

describe("parseTopic (mirror of private.parse_topic)", () => {
  it("parses valid topics", () => {
    expect(parseTopic(topics.req(SID, UID))).toEqual({ sessionId: SID, kind: "req", userId: UID })
    expect(parseTopic(topics.host(SID))).toEqual({ sessionId: SID, kind: "host", userId: null })
  })

  it.each([
    `session:${SID}:view`,
    `session:${SID}:req`,
    `session:${SID}:host:${UID}`,
    `session:${SID}:lobby:${UID}`,
    `session:${SID}:view:${UID}:x`,
    `session:${SID.toUpperCase()}:host`,
    `session:${SID}:HOST`,
    `session:${SID}:host `,
    `xsession:${SID}:host`,
    "session:*:host",
    "room-1",
  ])("rejects %s", (topic) => {
    expect(parseTopic(topic)).toBeNull()
  })
})

describe("createPrivateChannel", () => {
  let client: AtlasClient | null = null
  afterEach(async () => {
    await client?.removeAllChannels()
    client = null
  })
  // Creating channels does not open a socket; nothing here touches the network.
  const makeClient = () => (client = createAtlasClient({ url: "https://example.supabase.co", publishableKey: "sb_publishable_test" }, { worker: false, persistSession: false }))

  it("always sets config.private = true", () => {
    const c = makeClient()
    const plain = createPrivateChannel(c, topics.host(SID))
    expect(plain.private).toBe(true)
    expect(plain.params.config.private).toBe(true)
    const acked = createPrivateChannel(c, topics.view(SID, UID), { ack: true })
    expect(acked.private).toBe(true)
    expect(acked.params.config.broadcast).toEqual({ ack: true, self: false })
    const withPresence = createPrivateChannel(c, topics.lobby(SID), { presenceKey: UID })
    expect(withPresence.private).toBe(true)
    expect(withPresence.params.config.presence).toEqual({ key: UID, enabled: true })
  })

  it("cannot be talked into a public channel", () => {
    const c = makeClient()
    // Even a caller bypassing the types cannot override `private`.
    const sneaky = { ack: false, private: false } as unknown as Parameters<typeof createPrivateChannel>[2]
    expect(createPrivateChannel(c, topics.host(SID), sneaky).private).toBe(true)
    for (const opts of [{}, { ack: true }, { presenceKey: "k" }, { presenceKey: null }]) {
      expect(privateChannelConfig(opts).config.private).toBe(true)
    }
  })

  it("refuses a second channel on the same topic (supabase-js would silently share it)", () => {
    const c = makeClient()
    createPrivateChannel(c, topics.host(SID))
    expect(() => createPrivateChannel(c, topics.host(SID))).toThrow(/already open/)
  })

  it("refuses topics outside the Atlas grammar", () => {
    const c = makeClient()
    expect(() => createPrivateChannel(c, "room-1")).toThrow(/non-Atlas topic/)
    expect(() => createPrivateChannel(c, `session:${SID}:view`)).toThrow(/non-Atlas topic/)
  })

  it("configures presence off unless a key is given", () => {
    expect(privateChannelConfig().config.presence).toEqual({ key: "", enabled: false })
    expect(privateChannelConfig().config.broadcast).toEqual({ ack: false, self: false })
  })
})
