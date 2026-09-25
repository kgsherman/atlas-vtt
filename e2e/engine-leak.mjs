// WebGL context leak check (local mode): scene screen ↔ world page round trips must release each
// engine's WebGL context. Module-level textures and geometries shared by every engine used to keep a
// `dispose` listener that captured the renderer that last used them, so every editor / host / play
// visit kept its context (drawing buffers, textures, buffers) alive, and after 16 visits Chrome started
// force-losing contexts ("Too many active WebGL contexts").
//
// An init script wraps HTMLCanvasElement.prototype.getContext and keeps only WeakRefs to the WebGL2
// contexts the page creates. After each trip back to the world page the page runs gc() (Chromium
// started with --js-flags=--expose-gc) and counts the engine contexts that are neither collected nor
// lost.
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/engine-leak.mjs
//   ATLAS_TRIPS=5+18   round trips before the first check + after it (default 5+18)
import {
  Checks,
  openBrowser,
  seriousErrors,
  sleep,
  waitFor,
  watchPage,
} from "./lib.mjs"
import { openSceneInEditor } from "./session.mjs"

const [FIRST, MORE] = (process.env.ATLAS_TRIPS ?? "5+18")
  .split("+")
  .map((n) => Number(n))
const checks = new Checks("engine-leak")
const logs = []
const browser = await openBrowser({ extraArgs: ["--js-flags=--expose-gc"] })

/** Init script: remember every WebGL2 context the page creates, weakly. */
function trackContexts() {
  const refs = (window.__atlasGlRefs = [])
  const getContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = getContext.call(this, type, ...rest)
    if (ctx && type === "webgl2" && !refs.some((r) => r.ref.deref() === ctx))
      refs.push({
        ref: new WeakRef(ctx),
        engine: this.getAttribute("data-slot") === "engine-canvas",
        trip: window.__atlasTrip ?? 0,
      })
    return ctx
  }
}

/** Contexts created so far by state: collected by GC, lost (released), or alive. */
async function contexts(page) {
  return page.evaluate(async () => {
    for (let k = 0; k < 4; k++) {
      window.gc()
      await new Promise((r) => setTimeout(r, 100))
    }
    const out = { engine: { alive: 0, lost: 0, collected: 0 }, other: 0 }
    for (const r of window.__atlasGlRefs) {
      if (!r.engine) {
        out.other++
        continue
      }
      const c = r.ref.deref()
      if (c === undefined) out.engine.collected++
      else if (c.isContextLost()) out.engine.lost++
      else out.engine.alive++
    }
    out.heapMB = Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)
    return out
  })
}

/**
 * The world page → "Open a copy" of the sample → the scene screen with a live engine → back to the
 * world page.
 */
async function roundTrip(page, worldId, trip) {
  await page.evaluate((t) => (window.__atlasTrip = t), trip)
  await page
    .locator("[data-slot=card]", { hasText: "The Crooked Lantern" })
    .getByRole("button", { name: "Open a copy" })
    .click({ timeout: 30000 })
  await waitFor(
    page,
    () =>
      location.pathname.startsWith("/host/") &&
      window.__atlasEditor?.engine != null,
    null,
    { timeout: 60000, label: `editor (trip ${trip})` }
  )
  await sleep(600)
  await page.goBack()
  await waitFor(page, (id) => location.pathname === `/world/${id}`, worldId, {
    label: `the world page (trip ${trip})`,
  })
  await sleep(300)
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  await context.addInitScript(trackContexts)
  const page = await context.newPage()
  watchPage(page, "page", logs)

  checks.step(
    "Open the sample once (the first visit also runs the quality probe)"
  )
  await openSceneInEditor(page, { mode: "local" })
  const worldId = await page.evaluate(
    () => window.__atlasHost.runner.getSnapshot().world?.id
  )
  await page.goBack()
  await waitFor(page, (id) => location.pathname === `/world/${id}`, worldId, {
    label: "the world page",
  })
  let c = await contexts(page)
  console.log(`   after the first visit: ${JSON.stringify(c)}`)

  checks.step(`${FIRST} scene screen ↔ world page round trips`)
  for (let t = 1; t <= FIRST; t++) await roundTrip(page, worldId, t)
  c = await contexts(page)
  const created = c.engine.alive + c.engine.lost + c.engine.collected
  console.log(`   ${JSON.stringify(c)}`)
  checks.ok(
    created >= FIRST + 1,
    `each visit created an engine context (${created} for ${FIRST + 1} visits)`
  )
  checks.eq(
    c.engine.alive,
    0,
    "back on the world page, no engine context is still alive (each was lost or collected)"
  )

  checks.step(`${MORE} more round trips`)
  for (let t = FIRST + 1; t <= FIRST + MORE; t++) {
    await roundTrip(page, worldId, t)
    if (t % 6 === 0)
      console.log(`   trip ${t}: ${JSON.stringify(await contexts(page))}`)
  }
  c = await contexts(page)
  console.log(`   ${JSON.stringify(c)}`)
  checks.eq(c.engine.alive, 0, "still no engine context alive")
  const tooMany = logs.filter((l) => /Too many active WebGL contexts/.test(l))
  checks.eq(
    tooMany.length,
    0,
    `no "Too many active WebGL contexts" warning after ${FIRST + MORE + 1} visits`
  )
} catch (err) {
  checks.fail("engine-leak crashed", err)
} finally {
  const errors = seriousErrors(logs)
  checks.ok(
    errors.length === 0,
    "no console errors",
    errors.slice(0, 5).join("\n")
  )
  await browser.close()
  checks.done()
}
