// Editor smoke test (local mode): new scene → floor, walls, door, light, token through the real tools →
// undo / redo → save → reload → the document is unchanged → it is listed in the library.
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/editor-smoke.mjs
import {
  BASE,
  Checks,
  clickWorld,
  dragWorld,
  editorSummary,
  jsonDiff,
  openBrowser,
  outDir,
  seriousErrors,
  shot,
  sleep,
  waitEditor,
  waitFor,
  watchPage,
} from "./lib.mjs"

const OUT = outDir("editor-smoke")
const checks = new Checks("editor-smoke")
const logs = []
const browser = await openBrowser()

/** Deterministic snapshot of the document (ids sorted) to compare before save and after reload. */
const docJson = (page) =>
  page.evaluate(() => {
    const s = window.__atlasEditor.store.getState().scene
    const sort = (r) =>
      Object.fromEntries(
        Object.entries(r).sort(([a], [b]) => a.localeCompare(b))
      )
    return {
      name: s.name,
      grid: s.grid,
      levels: sort(s.levels),
      objects: sort(s.objects),
      tokens: sort(s.tokens),
      environment: s.environment,
    }
  })

async function pressTool(page, key) {
  await page.mouse.move(800, 520)
  await page.keyboard.press(key)
  await sleep(80)
}

try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  })
  const page = await context.newPage()
  watchPage(page, "editor", logs)

  checks.step("Library → New scene")
  await page.goto(`${BASE}/?local=1`, { waitUntil: "domcontentloaded" })
  await page
    .getByRole("button", { name: /New scene/ })
    .first()
    .click()
  await waitFor(page, () => location.pathname === "/editor/new", null, {
    label: "editor route",
  })
  await waitEditor(page)
  const initial = await editorSummary(page)
  checks.ok(
    initial.objects.floor === 1 && initial.tokens === 0,
    "new scene has one ground floor and no tokens",
    initial
  )
  const grid = await page.evaluate(
    () => window.__atlasEditor.store.getState().scene.grid
  )
  await page.getByRole("button", { name: "Top-down camera" }).click()
  await page.getByRole("button", { name: "Frame the scene" }).click()
  await sleep(700)

  // A 30 × 20 ft room in the middle of the grid.
  const cs = grid.cellSize
  const x0 = Math.floor(grid.width / 2 - 3) * cs
  const z0 = Math.floor(grid.depth / 2 - 2) * cs
  const x1 = x0 + 30
  const z1 = z0 + 20

  checks.step("Draw with the tools")
  await pressTool(page, "f")
  await dragWorld(page, [x0 + 1, z0 + 1], [x1 - 1, z1 - 1])
  let s = await editorSummary(page)
  checks.eq(s.objects.floor, 2, "floor tool: drag lays a slab")

  await pressTool(page, "w")
  for (const [x, z] of [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
    [x0, z0],
  ])
    await clickWorld(page, x, z)
  await page.keyboard.press("Enter")
  await sleep(100)
  s = await editorSummary(page)
  checks.eq(s.objects.wall, 4, "wall tool: a closed chain gives four walls")

  await pressTool(page, "d")
  await clickWorld(page, x0 + 15, z1)
  s = await editorSummary(page)
  checks.eq(s.objects.door, 1, "door tool: click on a wall places a door")

  await pressTool(page, "l")
  await clickWorld(page, x0 + 8, z0 + 8)
  s = await editorSummary(page)
  checks.eq(s.objects.light, 1, "light tool: click places a light")

  await pressTool(page, "k")
  await clickWorld(page, x0 + 22.5, z0 + 12.5)
  s = await editorSummary(page)
  checks.eq(s.tokens, 1, "token tool: click places a token")
  await pressTool(page, "v")
  await shot(page, OUT, "01-built")

  checks.step("Undo / redo")
  const built = await docJson(page)
  await page.keyboard.press("Control+z")
  await sleep(100)
  s = await editorSummary(page)
  checks.eq(s.tokens, 0, "Ctrl+Z removes the token")
  await page.getByRole("button", { name: "Undo" }).click()
  await sleep(100)
  s = await editorSummary(page)
  checks.ok(!s.objects.light, "the Undo button removes the light", s.objects)
  await page.keyboard.press("Control+Shift+z")
  await page.getByRole("button", { name: "Redo" }).click()
  await sleep(100)
  checks.eq(
    jsonDiff(built, await docJson(page)),
    [],
    "redo twice restores the exact document"
  )

  checks.step("Save and reload")
  const name = `E2E smoke ${new Date().toISOString().slice(11, 19)}`
  await page.getByRole("textbox", { name: "Scene name" }).fill(name)
  await page.keyboard.press("Enter")
  await page.mouse.move(800, 520)
  await page.keyboard.press("Control+s")
  await waitFor(
    page,
    () =>
      location.pathname !== "/editor/new" &&
      !window.__atlasEditor.store.getState().dirty,
    null,
    { label: "saved" }
  )
  const saved = await docJson(page)
  const sceneId = (await editorSummary(page)).path.split("/").pop()
  checks.ok(
    sceneId && sceneId !== "new",
    "the route switches to the saved scene id",
    sceneId
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await waitEditor(page)
  const reloaded = await docJson(page)
  checks.eq(
    jsonDiff(saved, reloaded),
    [],
    "after reload the document is identical"
  )
  s = await editorSummary(page)
  checks.ok(
    s.name === name &&
      s.objects.wall === 4 &&
      s.objects.door === 1 &&
      s.objects.light === 1 &&
      s.tokens === 1,
    "reloaded scene keeps name, walls, door, light, token",
    s
  )
  checks.ok(
    !s.dirty && s.undo === null,
    "a freshly opened scene is clean with an empty history",
    s
  )
  await shot(page, OUT, "02-reloaded")

  checks.step("Library lists the scene")
  await page.getByRole("button", { name: "Back to library" }).click()
  await waitFor(page, () => location.pathname === "/", null, {
    label: "library route",
  })
  await page.getByText(name).first().waitFor({ timeout: 10000 })
  checks.ok(true, "the saved scene appears in My scenes")
  await shot(page, OUT, "03-library")
} catch (err) {
  checks.fail("editor-smoke crashed", err)
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
