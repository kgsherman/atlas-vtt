/**
 * Route paths and the lazy loaders of the heavy pages (three.js lives only in these chunks, never
 * in the home bundle). `preloadRoute` warms a chunk ahead of navigation (hover / intent).
 */
export const loaders = {
  host: () => import("@/routes/HostPage"),
  play: () => import("@/routes/PlayPage"),
  tokens: () => import("@/routes/TokenMakerPage"),
}

export type LazyRoute = keyof typeof loaders

const warmed = new Set<LazyRoute>()

export function preloadRoute(route: LazyRoute): void {
  if (warmed.has(route)) return
  warmed.add(route)
  loaders[route]().catch(() => warmed.delete(route))
}

export const paths = {
  home: () => "/",
  /** One of the DM's maps, at its table (Edit / Play; `mode` picks one instead of the remembered one). */
  map: (sceneId: string, opts: { mode?: "edit" | "play" } = {}) => `/map/${encodeURIComponent(sceneId)}${opts.mode ? `?mode=${opts.mode}` : ""}`,
  newScene: () => "/map/new",
  newFromImages: () => "/map/new?import=1",
  /** A map's table by session id (where /map/:sceneId lands). */
  host: (sessionId: string) => `/host/${encodeURIComponent(sessionId)}`,
  play: (sessionId: string) => `/play/${encodeURIComponent(sessionId)}`,
  join: (code?: string) => (code ? `/join/${encodeURIComponent(code)}` : "/join"),
  shared: (slug: string) => `/shared/${encodeURIComponent(slug)}`,
  /** The Token Maker, optionally for a game (and one of its tokens). */
  tokens: (opts: { session?: string; token?: string } = {}) => {
    const q = new URLSearchParams()
    if (opts.session) q.set("session", opts.session)
    if (opts.token) q.set("token", opts.token)
    const s = q.toString()
    return s ? `/tokens?${s}` : "/tokens"
  },
}

/** Open the Token Maker in its own browser tab (the game keeps running in this one). */
export function openTokenMaker(opts: { session?: string; token?: string } = {}): void {
  window.open(paths.tokens(opts), "_blank", "noopener")
}
