// Free assets end to end against the real Supabase backend: the DM starts a game with the "Token
// models" category ticked in the "Start a game" dialog, the host console's Assets tab lists the free
// token models, a click puts one on the selected token, a player who sees the token downloads the
// model from the public free-assets bucket and draws it, and unloading the category keeps the token's
// model. Cleans up: ends the session and deletes the scene copy.
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/free-assets.mjs
//
// ATLAS_FREE_ASSETS_DIR=<folder> serves the bucket's token-models/* from a local build of
// scripts/free-assets/build-token-models.mjs instead (before they are published).
import fs from "node:fs"
import path from "node:path"

import {
  BASE,
  Checks,
  openBrowser,
  outDir,
  seriousErrors,
  shot,
  sleep,
  waitFor,
  watchPage,
} from "./lib.mjs"
import {
  assignToken,
  hostState,
  joinGame,
  openSceneInEditor,
  playerView,
  startSession,
} from "./session.mjs"

const OUT = outDir("free-assets")
const checks = new Checks("free-assets")
const logs = []
const browser = await openBrowser()
const LOCAL = process.env.ATLAS_FREE_ASSETS_DIR ?? null
let cleanup = null
let dm = null

/** Poll a Node-side condition (route-fulfilled requests do not show in the page's Resource Timing). */
async function until(cond, timeout, label) {
  const t0 = performance.now()
  while (!cond()) {
    if (performance.now() - t0 > timeout)
      throw new Error(`timed out waiting for ${label}`)
    await sleep(100)
  }
}

/** Serve the bucket from a local folder (ATLAS_FREE_ASSETS_DIR) and record model downloads. */
async function freeAssetRoutes(context, downloads) {
  await context.route(
    /\/storage\/v1\/object\/public\/free-assets\//,
    (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith(".glb")) downloads.push(url.pathname)
      if (!LOCAL) return route.continue()
      const file = path.join(LOCAL, path.basename(url.pathname))
      if (!fs.existsSync(file)) return route.fulfill({ status: 404 })
      return route.fulfill({
        status: 200,
        body: fs.readFileSync(file),
        headers: {
          "content-type": file.endsWith(".glb")
            ? "model/gltf-binary"
            : "image/png",
          "access-control-allow-origin": "*",
        },
      })
    }
  )
}

try {
  checks.step("DM starts a game with the token models loaded")
  const dmCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const dmDownloads = []
  await freeAssetRoutes(dmCtx, dmDownloads)
  dm = await dmCtx.newPage()
  watchPage(dm, "dm", logs)
  const sceneId = await openSceneInEditor(dm, { mode: "supabase" })
  cleanup = { sceneId, sessionId: null }
  await dm.getByRole("button", { name: "Start session" }).click()
  const dialog = dm.getByRole("dialog", { name: "Start a game" })
  await dialog.getByRole("checkbox", { name: "Token models" }).waitFor()
  await waitFor(
    dm,
    () => document.querySelectorAll("[role=dialog] img").length >= 4,
    null,
    {
      timeout: 20000,
      label: "model thumbnails in the dialog",
    }
  )
  await shot(dm, OUT, "01-start-dialog")
  await dm.keyboard.press("Escape")
  const h0 = await startSession(dm, { freeAssets: ["Token models"] })
  cleanup.sessionId = h0.sessionId
  checks.eq(
    h0.state.freeAssets,
    ["token-models"],
    "the game loads the token models"
  )

  checks.step("Assets tab: put a model on a token")
  const token = Object.values(h0.state.scene.tokens).find(
    (t) => !t.hidden && t.kind === "pc"
  )
  await dm.getByRole("tab", { name: /Tokens/ }).click()
  await dm
    .getByRole("button", { name: new RegExp(token.label ?? token.name) })
    .first()
    .click()
  await dm.getByRole("tab", { name: /Assets/ }).click()
  const models = dm.getByRole("button", { name: "Elf archer" })
  await models.waitFor()
  checks.ok(
    (await dm.locator("aside button[aria-pressed]").count()) >= 4,
    "the Assets tab lists the free token models"
  )
  await models.click()
  await waitFor(
    dm,
    (id) =>
      window.__atlasHost.runner.getSnapshot().state.scene.tokens[id]?.model ===
      "free:elf-archer",
    token.id,
    {
      timeout: 10000,
      label: "token model set",
    }
  )
  checks.ok(true, `${token.name} now has the elf archer model`)
  await until(
    () => dmDownloads.some((p) => p.endsWith("/token-models/elf-archer.glb")),
    20000,
    "DM downloads the model"
  )
  checks.ok(
    dmDownloads.some((p) => p.endsWith("/token-models/elf-archer.glb")),
    "the host console downloaded the model from the free-assets bucket"
  )
  checks.ok(
    (await hostState(dm)).state.origin?.dirty === true,
    "a model change is a map edit (unsaved-edits dot)"
  )
  await sleep(1500)
  await shot(dm, OUT, "02-host-assets-tab")

  checks.step("A player who sees the token draws its model")
  const plCtx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  })
  const plDownloads = []
  await freeAssetRoutes(plCtx, plDownloads)
  const player = await joinGame(plCtx, {
    roomCode: h0.roomCode,
    name: "Morgana",
    mode: "supabase",
    logs,
  })
  await assignToken(dm, player, token)
  await waitFor(
    player.page,
    (id) =>
      window.__atlasPlayer.client.getSnapshot().view?.tokens[id]?.model ===
      "free:elf-archer",
    token.id,
    {
      timeout: 15000,
      label: "player view carries the model",
    }
  )
  checks.ok(true, "the player's view of the token carries its model")
  await until(() => plDownloads.length > 0, 20000, "player downloads the model")
  checks.ok(
    plDownloads.length > 0,
    "the player downloaded the model from the public bucket"
  )
  const view = await playerView(player.page)
  checks.ok(
    Object.values(view.tokens).every(
      (t) => t.model === undefined || /^free:[a-z0-9-]+$/.test(t.model)
    ),
    "the player receives only model references"
  )
  await sleep(2000)
  await shot(player.page, OUT, "03-player")

  checks.step("Unloading the category keeps the token's model")
  await dm.getByRole("tab", { name: /Assets/ }).click()
  const toggle = dm.getByRole("switch", { name: /Token models/ })
  await toggle.click()
  await waitFor(
    dm,
    () =>
      (window.__atlasHost.runner.getSnapshot().state.freeAssets ?? [])
        .length === 0,
    null,
    {
      timeout: 10000,
      label: "category unloaded",
    }
  )
  const after = await hostState(dm)
  checks.eq(
    after.state.freeAssets,
    [],
    "the game no longer loads the token models"
  )
  checks.eq(
    after.state.scene.tokens[token.id].model,
    "free:elf-archer",
    "the token keeps its model"
  )
  checks.eq(
    await dm.getByRole("button", { name: "Elf archer" }).count(),
    0,
    "the Assets tab no longer offers the models"
  )
} catch (err) {
  checks.fail("unexpected error", err)
  console.log(logs.slice(-12).join("\n"))
} finally {
  if (cleanup && dm) {
    try {
      // As the DM (same anonymous user): end the session, delete the scene copy.
      await dm.goto(`${BASE}/?local=0`, { waitUntil: "domcontentloaded" })
      const who = await dm.evaluate(async ({ sceneId, sessionId }) => {
        const m = await import("/src/app/createServices.ts")
        const s = await m.createServices({ mode: "supabase" })
        if (sessionId) await s.sessions.endSession(sessionId).catch(() => false)
        await s.scenes.remove(sceneId)
        return s.identity.userId
      }, cleanup)
      console.log(
        `  cleanup: session ended, scene ${cleanup.sceneId} deleted (anonymous users remain, DM ${who})`
      )
    } catch (err) {
      console.log(`  cleanup failed: ${err.message}`)
    }
  }
  const errors = seriousErrors(logs)
  checks.ok(
    errors.length === 0,
    "no console errors",
    errors.slice(0, 6).join("\n")
  )
  await browser.close()
  checks.done()
}
