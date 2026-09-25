// Firefox smoke test (local mode, headless Firefox from `npx playwright install firefox`; WebGL2 runs on
// its software rasteriser there): the home page → a new world's page lists the samples → the editor on
// a copy of the Crooked Lantern renders at the tier the start-up probe picks → the DM starts a session,
// a player joins in another tab, gets a character, and their view equals the authoritative oracle and
// renders → no console errors. Screenshots of each page go to ATLAS_OUT.
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/firefox-smoke.mjs
import { createRequire } from "node:module"

import {
  BASE,
  Checks,
  outDir,
  seriousErrors,
  shot,
  sleep,
  waitFor,
  watchPage,
} from "./lib.mjs"
import {
  assignToken,
  createWorld,
  hostState,
  joinGame,
  startSession,
  viewConverges,
} from "./session.mjs"

const require = createRequire(import.meta.url)
const { firefox } = require("playwright")

const OUT = outDir("firefox-smoke")
const checks = new Checks("firefox-smoke")
const logs = []
const browser = await firefox.launch({ headless: true })

/** Frame stats of a page's engine over `ms` (frames drawn, last stats). */
async function frameStats(page, handle, ms = 2000) {
  return page.evaluate(
    async ({ handle, ms }) => {
      const e = window[handle].engine
      let frames = 0
      let last = null
      const off = e.onFrame((s) => {
        frames++
        last = s
      })
      await new Promise((r) => setTimeout(r, ms))
      off()
      return {
        frames,
        drawCalls: last?.drawCalls ?? 0,
        quality: last?.quality ?? null,
        ceiling: e.getQualityCeiling(),
      }
    },
    { handle, ms }
  )
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  console.log(`Firefox ${browser.version()}`)

  checks.step("Home page and a world")
  const dm = await context.newPage()
  watchPage(dm, "dm", logs)
  await dm.goto(`${BASE}/?local=1`, { waitUntil: "domcontentloaded" })
  const newWorld = dm.getByRole("button", { name: /New world/ }).first()
  await newWorld.waitFor({ timeout: 30000 })
  checks.ok(await newWorld.isVisible(), "the home page offers a new world")
  const renderer = await dm.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2")
    return gl ? gl.getParameter(gl.RENDERER) : null
  })
  console.log(`  WebGL2 renderer: ${renderer}`)
  checks.ok(renderer !== null, "WebGL2 is available")
  await sleep(2500) // the hero's storeys fade in one after another
  await shot(dm, OUT, "01-home")
  await createWorld(dm, { name: "Firefox world" })
  const card = dm.locator("[data-slot=card]", {
    hasText: "The Crooked Lantern",
  })
  await card.first().waitFor({ timeout: 30000 })
  checks.ok(
    await card.first().isVisible(),
    "the world's page lists the samples"
  )
  await shot(dm, OUT, "01-world")

  checks.step("Editor on a copy of the Crooked Lantern")
  await card.getByRole("button", { name: "Open a copy" }).click()
  await waitFor(
    dm,
    () =>
      location.pathname.startsWith("/host/") &&
      window.__atlasHost?.mode === "edit" &&
      window.__atlasEditor?.engine != null,
    null,
    { timeout: 90000, label: "the scene screen in Edit" }
  )
  await sleep(1500)
  const ed = await frameStats(dm, "__atlasEditor")
  console.log(`  editor: ${JSON.stringify(ed)}`)
  checks.ok(
    ed.frames > 0 && ed.drawCalls > 0,
    "the editor engine draws frames",
    ed
  )
  checks.ok(
    ed.quality !== null && ed.ceiling === ed.quality,
    `the engine runs at the probed tier (${ed.quality})`,
    ed
  )
  await shot(dm, OUT, "02-editor")
  // The probe picks low on a software rasteriser; the other tiers' shader variants must compile and
  // draw in Firefox too (its GLSL translator is not Chromium's).
  const tierLogs = logs.length
  const tiers = []
  for (const q of ["medium", "high", "ultra", "low"]) {
    await dm.evaluate((q) => {
      const e = window.__atlasEditor.engine
      e.debugFreezeQuality?.(true)
      e.setQuality(q)
    }, q)
    await sleep(3000)
    const s = await frameStats(dm, "__atlasEditor", 1500)
    tiers.push(`${q}: ${s.quality}, ${s.frames} frames`)
    if (q === "ultra") await shot(dm, OUT, "02-editor-ultra")
    checks.ok(
      s.quality === q && s.frames > 0 && s.drawCalls > 0,
      `the editor draws at ${q}`,
      s
    )
  }
  console.log(`  ${tiers.join(" · ")}`)
  checks.ok(
    seriousErrors(logs.slice(tierLogs)).length === 0,
    "no shader or console errors on any tier",
    seriousErrors(logs.slice(tierLogs)).slice(0, 5)
  )

  checks.step("Local session: a player joins and plays")
  const h = await startSession(dm)
  checks.ok(/^[0-9A-Z]{8}$/.test(h.roomCode), "session hosted", h.roomCode)
  const player = await joinGame(context, {
    roomCode: h.roomCode,
    name: "Morgana",
    logs,
  })
  const tokens = Object.values((await hostState(dm)).state.scene.tokens)
  const tok =
    tokens.find((t) => /^Brunhild/.test(t.name)) ??
    tokens.find((t) => t.kind === "pc" && !t.hidden)
  await dm.bringToFront()
  await assignToken(dm, player, tok)
  checks.ok(true, `the player controls ${tok.name}`)
  const diff = await viewConverges(dm, player.page, player.uid, 15000)
  checks.ok(diff.length === 0, "the player's view equals the oracle", diff)
  await player.page.bringToFront()
  await waitFor(player.page, () => window.__atlasPlayer?.engine != null, null, {
    label: "player engine",
  })
  await sleep(1500)
  const pl = await frameStats(player.page, "__atlasPlayer")
  console.log(`  player: ${JSON.stringify(pl)}`)
  checks.ok(
    pl.frames > 0 && pl.drawCalls > 0,
    "the player's engine draws frames",
    pl
  )
  await shot(player.page, OUT, "03-player")
  await dm.bringToFront()
  await sleep(500)
  await shot(dm, OUT, "04-host")

  const errors = seriousErrors(logs)
  checks.ok(errors.length === 0, "no console errors", errors.slice(0, 8))
  const warnings = logs.filter((l) => l.includes(" warning]"))
  if (warnings.length > 0)
    console.log(
      `  ${warnings.length} console warnings:\n    ${warnings.slice(0, 20).join("\n    ")}`
    )
} catch (err) {
  checks.fail("unexpected error", err)
  const errors = seriousErrors(logs)
  if (errors.length > 0) console.log(errors.slice(0, 10).join("\n"))
} finally {
  await browser.close()
  checks.done()
}
