// Session helpers shared by the multiplayer end-to-end scripts: wire capture, host / player handles,
// the "expected view" oracle and the leak scanner.
import { BASE, sleep, waitFor, jsonDiff, watchPage } from "./lib.mjs"

/**
 * Init script for player pages (local mode): records every broadcast frame the page's
 * BroadcastChannels receive, i.e. everything LocalTransport delivers to this tab (its own view / req
 * topics, the host topic, the lobby). `window.__atlasWire` = [{ name, event, json }].
 */
export function captureBroadcastChannel() {
  const Orig = window.BroadcastChannel
  const log = (window.__atlasWire = [])
  window.BroadcastChannel = class extends Orig {
    constructor(name) {
      super(name)
      this.addEventListener("message", (ev) => {
        const d = ev.data
        if (d && d.k === "b" && typeof d.json === "string")
          log.push({ name, event: d.event, json: d.json })
      })
    }
  }
}

/** Drain the frames captured so far on a player page. */
export async function drainWire(page) {
  return page.evaluate(() => (window.__atlasWire ?? []).splice(0))
}

// ---- setting up a game ---------------------------------------------------------------------------------

/**
 * Home → "New world" (ARCHITECTURE §6.9) → the world's page. Resolves with the world's id.
 */
export async function createWorld(
  page,
  { mode = "local", name = "E2E world" } = {}
) {
  await page.goto(`${BASE}/?local=${mode === "local" ? 1 : 0}`, {
    waitUntil: "domcontentloaded",
  })
  await page
    .getByRole("button", { name: /New world/ })
    .first()
    .click()
  const dialog = page.getByRole("dialog", { name: "New world" })
  await dialog.getByLabel("Name").fill(name)
  await dialog.getByRole("button", { name: "Create world" }).click()
  await waitFor(page, () => location.pathname.startsWith("/world/"), null, {
    timeout: 30000,
    label: "the world page",
  })
  return page.evaluate(() => location.pathname.split("/")[2])
}

/**
 * Open a scene (its scene screen, in Edit) in a new world: a copy of a sample (`sample`: its display
 * name) or an imported .atlas.json (`file`). `mode`: "local" (?local=1) or "supabase" (?local=0).
 * Resolves with the scene's library id once the editor is on it (the table is closed).
 */
export async function openSceneInEditor(
  page,
  {
    mode = "local",
    sample = "The Crooked Lantern",
    file = null,
    world = "E2E world",
  } = {}
) {
  await createWorld(page, { mode, name: world })
  if (file) {
    await page.locator('input[type="file"]').first().setInputFiles(file)
    // The success toast offers to open the imported scene.
    await page
      .getByRole("button", { name: "Open", exact: true })
      .first()
      .click({ timeout: 120000 })
  } else {
    await page
      .locator("[data-slot=card]", { hasText: sample })
      .getByRole("button", { name: "Open a copy" })
      .click({ timeout: 30000 })
  }
  await waitFor(
    page,
    () =>
      location.pathname.startsWith("/host/") &&
      window.__atlasHost?.mode === "edit" &&
      window.__atlasEditor?.engine != null,
    null,
    { timeout: 90000, label: "the scene screen in Edit" }
  )
  return page.evaluate(
    () => window.__atlasHost.runner.getSnapshot().library?.sceneId ?? null
  )
}

/**
 * On the scene screen: "Open the table" (players may join) and switch to Play. `freeAssets`: the labels
 * of the free asset categories the game loads (e.g. ["Token models"]), ticked in the Assets tab.
 * Returns the session id, room code and state.
 */
export async function startSession(dm, { freeAssets = null } = {}) {
  await waitHosting(dm, 60000)
  await sleep(300)
  await dm.getByRole("button", { name: "Open the table" }).click()
  await waitFor(
    dm,
    () => window.__atlasHost?.runner.getSnapshot().tableOpen === true,
    null,
    { timeout: 30000, label: "the table is open" }
  )
  if ((await dm.evaluate(() => window.__atlasHost.mode)) !== "play")
    await dm.getByRole("button", { name: "Play", exact: true }).click()
  await waitFor(dm, () => window.__atlasHost?.mode === "play", null, {
    timeout: 10000,
    label: "Play",
  })
  if (freeAssets) {
    // The Assets tab's switches (a new table loads the categories last chosen on this browser).
    await dm.getByRole("tab", { name: /Assets/ }).click()
    for (const section of await dm
      .locator("aside section", { has: dm.locator("[role=switch]") })
      .all()) {
      const text = (await section.textContent()) ?? ""
      const want = freeAssets.some((label) => text.includes(label))
      const toggle = section.locator("[role=switch]").first()
      if (((await toggle.getAttribute("aria-checked")) === "true") !== want)
        await toggle.click()
    }
  }
  const h = await hostState(dm)
  return {
    sessionId: await dm.evaluate(() => location.pathname.split("/").pop()),
    roomCode: h.roomCode,
    state: h.state,
  }
}

/**
 * A player joins by room code in a new tab of `context` (local mode: same context as the DM, since
 * BroadcastChannel does not cross contexts) and goes live. `capture` records the tab's BroadcastChannel
 * frames (see captureBroadcastChannel).
 */
export async function joinGame(
  context,
  { roomCode, name, mode = "local", capture = false, logs = null }
) {
  const page = await context.newPage()
  if (logs) watchPage(page, name, logs)
  if (capture) await page.addInitScript(captureBroadcastChannel)
  await page.goto(
    `${BASE}/join/${roomCode}?local=${mode === "local" ? 1 : 0}`,
    { waitUntil: "domcontentloaded" }
  )
  await page.getByPlaceholder("e.g. Morgana").fill(name)
  await page.getByRole("button", { name: "Join game" }).click()
  await waitFor(page, () => location.pathname.startsWith("/play/"), null, {
    timeout: 30000,
    label: `${name}: play route`,
  })
  await waitPlayerLive(page, 45000)
  return { page, name, uid: (await playerSnap(page)).userId }
}

/** DM: Players tab → "Assign" on the player's card → tick the token; waits until the player controls it. */
export async function assignToken(dm, player, token) {
  await dm.getByRole("tab", { name: /Players/ }).click()
  const row = dm.locator("div.rounded-lg.border", {
    has: dm.getByRole("button", { name: `More for ${player.name}` }),
  })
  await row.getByRole("button", { name: /Assign/ }).click()
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const names = [token.name, token.label].filter(Boolean).map(esc).join("|")
  await dm
    .getByRole("menuitemcheckbox", { name: new RegExp(`^\\s*(${names})\\b`) })
    .first()
    .click()
  await dm.keyboard.press("Escape")
  await waitFor(
    player.page,
    (id) =>
      window.__atlasPlayer.client
        .getSnapshot()
        .view?.controlledTokenIds.includes(id),
    token.id,
    {
      timeout: 20000,
      label: `${player.name} controls ${token.name}`,
    }
  )
}

// ---- host (DM tab) ----------------------------------------------------------------------------------

export async function waitHosting(dm, timeout = 45000) {
  await waitFor(
    dm,
    () => window.__atlasHost?.runner.getSnapshot().status === "hosting",
    null,
    { timeout, label: "host status 'hosting'" }
  )
}

export async function hostState(dm) {
  return dm.evaluate(() => {
    const snap = window.__atlasHost.runner.getSnapshot()
    return {
      status: snap.status,
      roomCode: snap.roomCode,
      epoch: snap.epoch,
      state: JSON.parse(JSON.stringify(snap.state)),
      members: snap.members,
    }
  })
}

/**
 * What `uid` should see right now according to the authoritative pipeline, recomputed from scratch in
 * the DM tab: a FRESH core/vision engine (no worker caches) → updateKnowledge on a copy of the host
 * state → filterForPlayer. The player's view must equal it once the host has flushed.
 */
export async function expectedView(dm, uid) {
  return dm.evaluate(async (uid) => {
    const [vision, session] = await Promise.all([
      import("/src/core/vision/index.ts"),
      import("/src/core/session/index.ts"),
    ])
    const state = structuredClone(window.__atlasHost.runner.getSnapshot().state)
    const engine = vision.createVisionEngine(state.scene)
    const viewers = session
      .viewerTokenIds(state, uid)
      .map((id) => engine.viewerFor(state.scene.tokens[id]))
    const vis = engine.compute(viewers)
    const view = session.filterForPlayer(
      session.updateKnowledge(state, uid, vis),
      uid,
      vis
    )
    return JSON.parse(JSON.stringify(view))
  }, uid)
}

// ---- player tab -----------------------------------------------------------------------------------

export async function waitPlayerLive(page, timeout = 30000) {
  await waitFor(
    page,
    () =>
      window.__atlasPlayer?.client.getSnapshot().status === "live" &&
      window.__atlasPlayer.client.getSnapshot().view != null,
    null,
    {
      timeout,
      label: "player client live",
    }
  )
}

export async function playerView(page) {
  return page.evaluate(() =>
    JSON.parse(JSON.stringify(window.__atlasPlayer.client.getSnapshot().view))
  )
}

export async function playerSnap(page) {
  return page.evaluate(() => {
    const s = window.__atlasPlayer.client.getSnapshot()
    return {
      status: s.status,
      epoch: s.epoch,
      seq: s.seq,
      results: JSON.parse(JSON.stringify(s.results ?? [])),
      userId: s.view?.userId ?? null,
    }
  })
}

/** Poll until the player's view equals the oracle; returns the remaining differences (empty = match). */
export async function viewConverges(dm, page, uid, timeout = 10000) {
  const t0 = performance.now()
  let diff = []
  while (performance.now() - t0 < timeout) {
    const [want, got] = await Promise.all([
      expectedView(dm, uid),
      playerView(page),
    ])
    diff = jsonDiff(want, got, 8)
    if (diff.length === 0) return diff
    await sleep(250)
  }
  return diff
}

/** Request a move along the planner's path to `cell` (same code path as a drag release). */
export async function requestMoveTo(page, tokenId, cell) {
  return page.evaluate(
    ({ tokenId, cell }) => {
      const p = window.__atlasPlayer
      const snap = p.client.getSnapshot()
      const t = snap.scene.tokens[tokenId]
      const plan = p.planner.plan(tokenId, cell, t.levelId)
      if (!plan?.path) return { reqId: null, plan: null }
      return {
        reqId: p.client.requestMove(tokenId, plan.path),
        steps: plan.path.length,
        feet: plan.distance,
      }
    },
    { tokenId, cell }
  )
}

export async function waitResult(page, reqId, timeout = 8000) {
  await waitFor(
    page,
    (id) =>
      (window.__atlasPlayer.client.getSnapshot().results ?? []).some(
        (r) => r.reqId === id
      ),
    reqId,
    { timeout, label: `result of ${reqId}` }
  )
  return page.evaluate(
    (id) =>
      JSON.parse(
        JSON.stringify(
          window.__atlasPlayer.client
            .getSnapshot()
            .results.find((r) => r.reqId === id)
        )
      ),
    reqId
  )
}

/**
 * The nearest door (among `doorIds`) a player's token can walk up to, chosen in the player's own scene:
 * a cell within one square of the door segment (the host's reach rule) that the planner can reach —
 * beside the door for axis-aligned walls, in the opening for rotated ones. Returns the door id, its
 * width, centre and direction along the wall, and the cell to walk to; null when none is reachable.
 */
export async function reachableDoor(page, tokenId, doorIds) {
  return page.evaluate(
    async ({ id, doorIds }) => {
      const [{ openingSegment }, { segmentRectDistance }] = await Promise.all([
        import("/src/core/scene/queries.ts"),
        import("/src/core/session/index.ts"),
      ])
      const p = window.__atlasPlayer
      const scene = p.client.getSnapshot().scene
      const t = scene.tokens[id]
      const cs = scene.grid.cellSize
      const doors = Object.values(scene.objects)
        .filter(
          (o) =>
            o.type === "door" &&
            o.levelId === t.levelId &&
            doorIds.includes(o.id)
        )
        .map((d) => {
          const seg = openingSegment(scene.objects[d.wallId], d)
          const c = { x: (seg.a.x + seg.b.x) / 2, z: (seg.a.z + seg.b.z) / 2 }
          return {
            d,
            seg,
            c,
            dist: Math.hypot(c.x - t.position.x, c.z - t.position.z),
          }
        })
        .sort((a, b) => a.dist - b.dist)
      for (const { d, seg, c } of doors) {
        let best = null
        for (
          let i = Math.floor(c.x / cs) - 2;
          i <= Math.floor(c.x / cs) + 2;
          i++
        ) {
          for (
            let j = Math.floor(c.z / cs) - 2;
            j <= Math.floor(c.z / cs) + 2;
            j++
          ) {
            if (
              segmentRectDistance(seg.a, seg.b, {
                x: i * cs,
                z: j * cs,
                w: cs,
                d: cs,
              }) > cs
            )
              continue
            const plan = p.planner.plan(id, { i, j }, t.levelId)
            if (plan?.path && (!best || plan.path.length < best.steps))
              best = { cell: { i, j }, steps: plan.path.length }
          }
        }
        const len = Math.hypot(seg.b.x - seg.a.x, seg.b.z - seg.a.z)
        if (best)
          return {
            id: d.id,
            width: d.width,
            cell: best.cell,
            c,
            u: { x: (seg.b.x - seg.a.x) / len, z: (seg.b.z - seg.a.z) / len },
          }
      }
      return null
    },
    { id: tokenId, doorIds }
  )
}

/** Click a door's leaf beside its centre (a token standing in a doorway covers the centre). */
export async function clickDoor(page, door, elevation) {
  const along = Math.min(2.6, door.width / 2 - 0.3)
  const p = await projectIn(page, "__atlasPlayer", {
    x: door.c.x + door.u.x * along,
    y: elevation + 3,
    z: door.c.z + door.u.z * along,
  })
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await sleep(150)
  await page.mouse.click(p.x, p.y)
}

/** Screen (client px) position of a world point in a page whose automation handle has an engine. */
export async function projectIn(page, handle, p) {
  return page.evaluate(
    ({ handle, p }) => {
      const engine = window[handle].engine
      const q = engine.project(p)
      const r = document
        .querySelector("canvas[data-slot=engine-canvas]")
        .getBoundingClientRect()
      return { x: r.left + q.x, y: r.top + q.y, visible: q.visible }
    },
    { handle, p }
  )
}

/** Drag the mouse in small steps (pointer events the play controller sees as a drag). */
export async function mouseDrag(page, from, to, steps = 14) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let k = 1; k <= steps; k++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * k) / steps,
      from.y + ((to.y - from.y) * k) / steps
    )
    await sleep(25)
  }
  await sleep(150)
  await page.mouse.up()
}

// ---- leak scanning ---------------------------------------------------------------------------------

/**
 * Secrets of a scene that no player may ever receive: ids of hidden tokens (and their attached lights),
 * ids of hidden objects, unrevealed secret doors, backdrop asset ids / names, and DM-only strings:
 * every dmNotes, hidden tokens' names, and object names (objects never travel with a name; names that
 * are also public — a level, the scene or a visible token — are skipped, as are short ones).
 */
export function sceneSecrets(scene) {
  const ids = new Set()
  const strings = new Set()
  const hiddenTokens = new Set()
  const publicNames = new Set([
    scene.name,
    ...Object.values(scene.levels).map((l) => l.name),
  ])
  for (const t of Object.values(scene.tokens)) {
    if (t.dmNotes) strings.add(t.dmNotes)
    if (t.hidden) {
      hiddenTokens.add(t.id)
      ids.add(t.id)
      strings.add(t.name)
    } else {
      publicNames.add(t.name)
      if (t.label) publicNames.add(t.label)
    }
  }
  for (const o of Object.values(scene.objects)) {
    if (o.dmNotes) strings.add(o.dmNotes)
    if (o.name && o.name.length >= 8 && !publicNames.has(o.name))
      strings.add(o.name)
    if (o.hidden) ids.add(o.id)
    if (o.type === "door" && o.style === "secret") ids.add(o.id)
    if (
      o.type === "light" &&
      o.attachedTokenId &&
      hiddenTokens.has(o.attachedTokenId)
    )
      ids.add(o.id)
  }
  for (const a of Object.values(scene.assets ?? {})) {
    ids.add(a.id)
    if (a.name && a.name.length >= 4) strings.add(a.name)
  }
  for (const l of Object.values(scene.levels))
    if (l.backdrop) ids.add(l.backdrop.assetId)
  return {
    ids: [...ids].filter((s) => s.length >= 4),
    strings: [...strings].filter((s) => typeof s === "string" && s.length >= 4),
  }
}

/** Occurrences of any secret inside the given payload texts: [{ secret, where }]. */
export function findLeaks(texts, secrets, allow = new Set()) {
  const hits = []
  for (const { where, text } of texts) {
    for (const s of [...secrets.ids, ...secrets.strings]) {
      if (allow.has(s)) continue
      if (text.includes(s) || text.includes(JSON.stringify(s).slice(1, -1)))
        hits.push({ secret: s.slice(0, 60), where })
    }
  }
  return hits
}

// ---- host console map menus ------------------------------------------------------------------------

/** The page hit the app's error boundary ("Something went wrong"). */
export async function crashed(page) {
  return page.getByText("Something went wrong").isVisible()
}

/**
 * The level the host console shows by default (HostSession `defaultLevel`): the level with the most
 * visible PCs, else the one nearest elevation 0.
 */
export async function hostActiveLevel(dm) {
  return dm.evaluate(() => {
    const s = window.__atlasHost.runner.getSnapshot().state.scene
    const counts = new Map()
    for (const t of Object.values(s.tokens))
      if (t.kind === "pc" && !t.hidden)
        counts.set(t.levelId, (counts.get(t.levelId) ?? 0) + 1)
    let best = null
    let n = 0
    for (const [id, c] of counts) if (c > n && s.levels[id]) [best, n] = [id, c]
    if (best) return best
    const levels = Object.values(s.levels)
    let g = levels[0]
    for (const l of levels)
      if (Math.abs(l.elevation) < Math.abs(g.elevation)) g = l
    return g.id
  })
}

/**
 * Right-click targets on a level of the host map, in client px: tokens (body centre), doors (leaf centre,
 * 3 ft up) and static lights (their ground point, which the host's menu resolves within 1.5 ft). Only
 * points inside the canvas are returned.
 */
export async function hostMenuTargets(dm, levelId) {
  return dm.evaluate(async (levelId) => {
    const { groundHeightAt, openingSegment } =
      await import("/src/core/scene/queries.ts")
    const { engine, runner } = window.__atlasHost
    const s = runner.getSnapshot().state.scene
    const r = document
      .querySelector("canvas[data-slot=engine-canvas]")
      .getBoundingClientRect()
    const at = (x, z, dy) => {
      const q = engine.project({
        x,
        y: groundHeightAt(s, levelId, { x, z }) + dy,
        z,
      })
      const p = { x: r.left + q.x, y: r.top + q.y }
      const inside =
        q.visible &&
        p.x > r.left + 8 &&
        p.x < r.right - 8 &&
        p.y > r.top + 8 &&
        p.y < r.bottom - 8
      return inside ? p : null
    }
    const out = { tokens: [], doors: [], lights: [] }
    for (const t of Object.values(s.tokens)) {
      if (t.levelId !== levelId) continue
      const p = at(t.position.x, t.position.z, Math.min(1, t.height / 2))
      if (p) out.tokens.push({ id: t.id, name: t.name, ...p })
    }
    for (const o of Object.values(s.objects)) {
      if (o.levelId !== levelId) continue
      if (o.type === "door" && s.objects[o.wallId]) {
        const seg = openingSegment(s.objects[o.wallId], o)
        const p = at((seg.a.x + seg.b.x) / 2, (seg.a.z + seg.b.z) / 2, 3)
        if (p) out.doors.push({ id: o.id, state: o.state, ...p })
      } else if (o.type === "light" && !o.attachedTokenId) {
        const p = at(o.position.x, o.position.z, 0)
        if (p) out.lights.push({ id: o.id, name: o.name, on: o.on, ...p })
      }
    }
    return out
  }, levelId)
}

/** Right-click a client point on the host map; resolves true when a context menu opened. */
export async function hostContextMenu(dm, p) {
  await closeMenus(dm)
  await dm.mouse.move(p.x, p.y, { steps: 2 })
  await sleep(100)
  await dm.mouse.click(p.x, p.y, { button: "right" })
  await sleep(400)
  return (
    (await dm.locator("[data-slot=context-menu-content]:visible").count()) > 0
  )
}

/** Hover a submenu trigger of the open context menu (by its text) and give the submenu time to open. */
export async function hoverSubmenu(dm, text) {
  await dm
    .locator("[data-slot=context-menu-sub-trigger]:visible", { hasText: text })
    .first()
    .hover()
  await sleep(500)
}

/** Close every open context menu level (Escape closes one submenu level at a time). */
export async function closeMenus(page) {
  for (let k = 0; k < 4; k++) {
    if (
      (await page
        .locator("[data-slot=context-menu-content]:visible")
        .count()) === 0
    )
      return
    await page.keyboard.press("Escape")
    await sleep(150)
  }
}

/**
 * Walk a token toward `cell` through what its player has explored: each hop plans to the reachable cell
 * nearest the target (the planner only knows explored floor), moves there, and looks again. Resolves true
 * once the token stands on `cell`.
 */
export async function walkToward(page, tokenId, cell, hops = 5) {
  for (let k = 0; k < hops; k++) {
    const next = await page.evaluate(
      ({ tokenId, cell }) => {
        const p = window.__atlasPlayer
        const scene = p.client.getSnapshot().scene
        const t = scene.tokens[tokenId]
        const cs = scene.grid.cellSize
        const here = {
          i: Math.floor(t.position.x / cs),
          j: Math.floor(t.position.z / cs),
        }
        if (here.i === cell.i && here.j === cell.j) return { done: true }
        const cand = []
        for (let di = -8; di <= 8; di++)
          for (let dj = -8; dj <= 8; dj++)
            cand.push({ i: cell.i + di, j: cell.j + dj, d: Math.hypot(di, dj) })
        cand.sort((a, b) => a.d - b.d)
        const dHere = Math.hypot(here.i - cell.i, here.j - cell.j)
        for (const c of cand) {
          if (c.d >= dHere) break
          const plan = p.planner.plan(tokenId, { i: c.i, j: c.j }, t.levelId)
          if (plan?.path && plan.path.at(-1).levelId === t.levelId)
            return { reqId: p.client.requestMove(tokenId, plan.path) }
        }
        return { stuck: true }
      },
      { tokenId, cell }
    )
    if (next.done) return true
    if (!next.reqId) return false
    const res = await waitResult(page, next.reqId)
    if (!res.ok) return false
    await sleep(400)
  }
  return page.evaluate(
    ({ tokenId, cell }) => {
      const scene = window.__atlasPlayer.client.getSnapshot().scene
      const t = scene.tokens[tokenId]
      const cs = scene.grid.cellSize
      return (
        Math.floor(t.position.x / cs) === cell.i &&
        Math.floor(t.position.z / cs) === cell.j
      )
    },
    { tokenId, cell }
  )
}
