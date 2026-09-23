/**
 * Realtime topic names and the ONE place Supabase channels are created.
 *
 * Every Atlas channel is private (RLS on realtime.messages, see the realtime_policies migration):
 * `createPrivateChannel` hard-codes `config.private = true` and its options type has no way to
 * override it. Nothing else in the app may call `client.channel(...)`.
 */
import type { RealtimeChannel } from "@supabase/supabase-js"

import type { AtlasClient } from "./supabase"

/** Canonical (lowercase) UUID, the only form the SQL topic parser accepts. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Same grammar as private.parse_topic() in SQL. */
const TOPIC_RE =
  /^session:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(req|view|host|lobby)(?::([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/

export type TopicKind = "req" | "view" | "host" | "lobby"

export interface ParsedTopic {
  sessionId: string
  kind: TopicKind
  userId: string | null
}

/** Broadcast event name per topic kind. */
export const BROADCAST_EVENTS = {
  req: "req",
  view: "view",
  host: "host",
} as const

function canonicalId(id: string, what: string): string {
  const lower = id.toLowerCase()
  if (!UUID_RE.test(lower)) throw new Error(`invalid ${what}: expected a UUID, got ${JSON.stringify(id)}`)
  return lower
}

export const topics = {
  req: (sessionId: string, userId: string) => `session:${canonicalId(sessionId, "session id")}:req:${canonicalId(userId, "user id")}`,
  view: (sessionId: string, userId: string) => `session:${canonicalId(sessionId, "session id")}:view:${canonicalId(userId, "user id")}`,
  host: (sessionId: string) => `session:${canonicalId(sessionId, "session id")}:host`,
  lobby: (sessionId: string) => `session:${canonicalId(sessionId, "session id")}:lobby`,
}

/** Parse a topic exactly like the database does; null when the database would deny it. */
export function parseTopic(topic: string): ParsedTopic | null {
  const m = TOPIC_RE.exec(topic)
  if (!m) return null
  const kind = m[2] as TopicKind
  const userId = m[3] ?? null
  // req/view carry a user id; host/lobby must not.
  if ((kind === "req" || kind === "view") !== (userId !== null)) return null
  return { sessionId: m[1], kind, userId }
}

export interface PrivateChannelOptions {
  /** Ask the server to acknowledge broadcasts (view channels). */
  ack?: boolean
  /** Presence key; presence receiving is enabled when set. */
  presenceKey?: string | null
}

/** The exact config passed to supabase-js (exported for tests). `private` is always true. */
export function privateChannelConfig(opts: PrivateChannelOptions = {}) {
  return {
    config: {
      // The channel adapter merges `config` shallowly, so `broadcast`/`presence` are given whole.
      broadcast: { ack: opts.ack ?? false, self: false },
      presence: { key: opts.presenceKey ?? "", enabled: opts.presenceKey != null },
      private: true as const,
    },
  }
}

/**
 * Create a private Realtime channel. Throws if a channel with the same topic already exists on the
 * client (supabase-js would silently hand back the existing one, with whatever config it had).
 */
export function createPrivateChannel(client: AtlasClient, topic: string, opts: PrivateChannelOptions = {}): RealtimeChannel {
  if (!parseTopic(topic)) throw new Error(`refusing to open a channel on a non-Atlas topic: ${topic}`)
  const realtimeTopic = `realtime:${topic}`
  if (client.getChannels().some((c) => c.topic === realtimeTopic)) {
    throw new Error(`a channel for ${topic} is already open on this client`)
  }
  const channel = client.channel(topic, privateChannelConfig(opts))
  if (!channel.private || channel.params.config.private !== true) {
    // Defence in depth: never proceed with a public channel.
    void client.removeChannel(channel)
    throw new Error(`channel ${topic} is not private`)
  }
  return channel
}
