// "Save map to library" end to end (local mode, The Crooked Lantern). Map edits made during a live session ("Edit map") only
// change the session; the host console's "Save map to library" writes them as a new version of the
// library scene the session was started from.
//
//   1. DM opens a copy of the sample, starts a session, adds a crate in Edit map, saves the map to the
//      library, ends the session, and finds the crate in the editor.
//   2. Conflict: a new session from that scene; meanwhile the scene is saved from the editor in another
//      tab. The host's save is refused with a conflict toast; "Overwrite" then saves, and the version
//      history keeps the other tab's version.
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/host-save-map.mjs
import {
  BASE,
  Checks,
  openBrowser,
  outDir,
  seriousErrors,
  shot,
  sleep,
  waitEditor,
  waitFor,
  watchPage,
} from "./lib.mjs"
import { openSceneInEditor, startSession } from "./session.mjs"

const OUT = outDir("host-save-map")
const checks = new Checks("host-save-map")
const logs = []
const browser = await openBrowser()
let dm = null

/** Switch the host console to "Edit map" and add a crate at the middle of the active level. */
async function addCrate(dm, name) {
  await dm.bringToFront()
  await sleep(300)
  await dm
    .getByRole("radio", { name: "Edit map" })
    .or(dm.getByRole("button", { name: "Edit map" }))
    .first()
    .click()
  await waitFor(dm, () => window.__atlasHost?.editor != null, null, {
    label: "host editor",
  })
  // No dynamic import here (a first-time module fetch in a tab that was in the background can hang):
  // copy one of the scene's own crates under a fresh id. The id is chosen here so a retried evaluate
  // (see evaluateRetry) cannot add a second crate.
  const id = `e2e${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
  return evaluateRetry(
    dm,
    ({ id, name }) => {
      const store = window.__atlasHost.editor.ctx.store
      const s = store.getState()
      if (Object.hasOwn(s.scene.objects, id)) return id
      const g = s.scene.grid
      const model = Object.values(s.scene.objects).find(
        (o) => o.type === "prop" && o.kind === "crate"
      )
      if (!model) throw new Error("the scene has no crate to copy")
      const crate = {
        ...structuredClone(model),
        id,
        name,
        levelId: s.activeLevelId,
        position: {
          x: (Math.floor(g.width / 2) + 0.5) * g.cellSize,
          y: 0,
          z: (Math.floor(g.depth / 2) + 0.5) * g.cellSize,
        },
      }
      store.getState().apply((d) => {
        d.objects[id] = crate
      }, "Add crate")
      return Object.hasOwn(store.getState().scene.objects, id) ? id : null
    },
    { id, name }
  )
}

/**
 * page.evaluate with retries. The first evaluate on the DM tab right after another tab of the context
 * closed sometimes fails with "Resulting promise was garbage collected" (a Playwright / Chromium quirk,
 * not an app error); the retried call then succeeds.
 */
async function evaluateRetry(page, fn, arg, tries = 3) {
  for (let k = 1; ; k++) {
    try {
      return await page.evaluate(fn, arg)
    } catch (err) {
      if (
        k >= tries ||
        !/garbage collected|context was destroyed/i.test(String(err?.message))
      )
        throw err
      console.log(
        `   (evaluate retried: ${String(err.message).split("\n")[0]})`
      )
      await sleep(300)
    }
  }
}

/** The library scene's latest version (local mode repositories, as the DM). */
async function libraryScene(page, sceneId) {
  return page.evaluate(async (sceneId) => {
    const m = await import("/src/app/createServices.ts")
    const s = await m.createServices({ mode: "local" })
    const doc = await s.scenes.load(sceneId)
    const scene = doc?.parsed?.ok ? doc.parsed.scene : null
    return {
      version: doc?.version ?? doc?.summary?.latestVersion ?? null,
      name: scene?.name ?? null,
      objectIds: scene ? Object.keys(scene.objects) : [],
    }
  }, sceneId)
}

async function toast(page, text, timeout = 10000) {
  return page
    .getByText(text)
    .first()
    .waitFor({ timeout })
    .then(
      () => true,
      () => false
    )
}

async function endSession(dm) {
  await dm.getByRole("button", { name: "End session" }).first().click()
  const dialog = dm.getByRole("alertdialog")
  await dialog
    .getByRole("button", { name: /^(End session|End without saving)$/ })
    .click()
  await waitFor(
    dm,
    () => window.__atlasHost?.runner.getSnapshot().status === "ended",
    null,
    { timeout: 20000, label: "session ended" }
  )
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  dm = await context.newPage()
  watchPage(dm, "dm", logs)

  checks.step("Edit the live map, save it to the library")
  const sceneId = await openSceneInEditor(dm, { mode: "local" })
  const v0 = await libraryScene(dm, sceneId)
  await startSession(dm)
  const crate = await addCrate(dm, "E2E crate one")
  checks.ok(
    await dm.evaluate(
      (id) =>
        Object.hasOwn(
          window.__atlasHost.runner.getSnapshot().state.scene.objects,
          id
        ),
      crate
    ),
    "the crate is in the live session"
  )
  checks.ok(
    !(await libraryScene(dm, sceneId)).objectIds.includes(crate),
    "the library scene does not have it yet"
  )
  await dm.getByRole("button", { name: /Save map to library/ }).click()
  await dm
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save map" })
    .click()
  checks.ok(
    await toast(dm, /Saved version/),
    "the host reports the saved version"
  )
  const v1 = await libraryScene(dm, sceneId)
  checks.ok(
    v1.objectIds.includes(crate) && v1.version > v0.version,
    `the library's latest version (${v1.version}) has the crate`,
    { v0: v0.version, v1: v1.version }
  )
  await shot(dm, OUT, "01-saved")

  checks.step("End the session, open the scene in the editor")
  await endSession(dm)
  await dm.goto(`${BASE}/editor/${sceneId}?local=1`, {
    waitUntil: "domcontentloaded",
  })
  await waitEditor(dm, 60000)
  checks.ok(
    await dm.evaluate(
      (id) =>
        Object.hasOwn(window.__atlasEditor.store.getState().scene.objects, id),
      crate
    ),
    "the editor opens the scene with the crate"
  )

  checks.step("Conflict: the scene is saved from the editor meanwhile")
  await startSession(dm)
  const other = await context.newPage()
  watchPage(other, "editor tab", logs)
  await other.goto(`${BASE}/editor/${sceneId}?local=1`, {
    waitUntil: "domcontentloaded",
  })
  await waitEditor(other, 60000)
  await other.evaluate(() => {
    const store = window.__atlasEditor.store
    const lvl = store.getState().activeLevelId
    store.getState().apply((d) => {
      d.levels[lvl].name = `${d.levels[lvl].name} (edited)`
    }, "Rename level")
  })
  await other.mouse.move(700, 450)
  await other.keyboard.press("Control+s")
  await waitFor(
    other,
    () => !window.__atlasEditor.store.getState().dirty,
    null,
    {
      label: "editor tab saved",
    }
  )
  const v2 = await libraryScene(other, sceneId)
  checks.ok(
    v2.version > v1.version,
    `the editor tab saved version ${v2.version}`
  )
  await other.close()

  const crate2 = await addCrate(dm, "E2E crate two")
  await dm.getByRole("button", { name: /Save map to library/ }).click()
  await dm
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save map" })
    .click()
  checks.ok(
    await toast(dm, /changed since this session started/),
    "the host's save is refused with a conflict"
  )
  checks.ok(
    !(await libraryScene(dm, sceneId)).objectIds.includes(crate2),
    "nothing was overwritten yet"
  )
  await dm.getByRole("button", { name: "Overwrite" }).click()
  checks.ok(await toast(dm, /Saved version/), "Overwrite saves the live map")
  const v3 = await libraryScene(dm, sceneId)
  checks.ok(
    v3.objectIds.includes(crate2) && v3.version > v2.version,
    `the library's latest version (${v3.version}) is the live map`,
    { v2: v2.version, v3: v3.version }
  )
  const history = await dm.evaluate(async (sceneId) => {
    const m = await import("/src/app/createServices.ts")
    const s = await m.createServices({ mode: "local" })
    return (await s.scenes.listVersions(sceneId)).map((v) => v.version)
  }, sceneId)
  checks.ok(
    history.includes(v2.version),
    "the version history still has the editor tab's version",
    history
  )
  await shot(dm, OUT, "02-overwritten")
  await endSession(dm)
} catch (err) {
  checks.fail("host-save-map crashed", err)
  if (dm) await shot(dm, OUT, "99-failure").catch(() => {})
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
