// Editor smoke test (local mode): new scene → the start-up quality probe ran (Auto) → every menubar
// menu opens without crashing → floor, walls, door, light, token through the real tools → undo / redo →
// shortcuts still work after a Select popup was used → save → reload → the document is unchanged → it is
// listed in the library.
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

  checks.step("Start-up quality (Auto)")
  // A fresh browser context has no cached probe: opening the editor on "Auto" must run the device probe
  // (render/engine/autoQuality.ts), which caches its result per GPU.
  await waitFor(
    page,
    () => localStorage.getItem("atlas:quality-probe:v2") !== null,
    null,
    { timeout: 15000, label: "quality probe cached" }
  ).then(
    () => checks.ok(true, "Auto runs the start-up quality probe"),
    (e) => checks.fail("Auto runs the start-up quality probe", e.message)
  )
  const gl = await page.evaluate(() => {
    const probe = JSON.parse(localStorage.getItem("atlas:quality-probe:v2"))
    const ctx = document
      .querySelector("canvas[data-slot=engine-canvas]")
      .getContext("webgl2")
    return {
      probe: probe?.tier ?? null,
      antialias: ctx?.getContextAttributes()?.antialias ?? null,
    }
  })
  console.log(`   probe picked ${gl.probe}`)
  checks.ok(
    gl.antialias === false,
    "the WebGL context has no MSAA (tier MSAA comes from the post pipeline)",
    gl
  )

  checks.step("Every menubar menu opens without crashing the editor")
  const triggers = page.locator("[data-slot=menubar-trigger]")
  const nTriggers = await triggers.count()
  checks.ok(nTriggers >= 5, `the top bar has ${nTriggers} menus`)
  for (let k = 0; k < nTriggers; k++) {
    const trigger = triggers.nth(k)
    const label = (await trigger.innerText()).trim()
    const before = logs.length
    await trigger.click()
    await sleep(300)
    const opened =
      (await page.locator("[data-slot=menubar-content]:visible").count()) > 0
    const crashed = await page.getByText("Something went wrong").isVisible()
    const groupErrors = logs
      .slice(before)
      .map((l) => l.match(/Error: Base UI: MenuGroupContext[^\n]*/)?.[0])
      .filter(Boolean)
    checks.ok(
      opened && !crashed && groupErrors.length === 0,
      `the ${label} menu opens`,
      { opened, crashed, error: groupErrors[0] }
    )
    await page.keyboard.press("Escape")
    await sleep(150)
    if (crashed) {
      // Carry on with a fresh editor so the remaining steps still run.
      logs.splice(before)
      await page.reload({ waitUntil: "domcontentloaded" })
      await waitEditor(page)
    }
  }

  checks.step("Panel fields are labelled")
  await page.getByRole("tab", { name: "Levels" }).click()
  await sleep(150)
  checks.eq(
    await page.getByRole("textbox", { name: "Elevation", exact: true }).count(),
    1,
    "the Levels panel's Elevation field has a programmatic label"
  )

  checks.step("Tool options fit a 1280 px window")
  // The options bar used to scroll sideways with a hidden scrollbar: controls past its right edge were
  // invisible (door "Starts", light "Shadows"), and the terrain brush's segmented control overlapped
  // the Radius slider.
  await page.setViewportSize({ width: 1280, height: 900 })
  await sleep(300)
  for (const tool of ["door", "light", "terrain", "connector", "token"]) {
    await page.evaluate(
      (tool) => window.__atlasEditor.store.getState().setTool(tool),
      tool
    )
    await sleep(250)
    const problems = await page.evaluate(() => {
      // The bar: the first ancestor of the snap control wider than half the window.
      let bar = document.querySelector('[aria-label="Snap mode"]')
      while (bar && bar.getBoundingClientRect().width < innerWidth / 2)
        bar = bar.parentElement
      if (!bar) return ["no options bar"]
      const sel =
        "button, input:not([type=hidden]), [role=combobox], [role=switch], [data-slot=toggle-group], [data-slot=slider]"
      // Real controls only: not the visually hidden form inputs Base UI renders for selects / switches.
      const all = [...bar.querySelectorAll(sel)].filter(
        (el) =>
          el.getBoundingClientRect().width > 1 &&
          !el.closest("[aria-hidden=true]") &&
          getComputedStyle(el).opacity !== "0"
      )
      const top = all.filter(
        (el) => !all.some((o) => o !== el && o.contains(el))
      )
      const name = (el) =>
        el.getAttribute("aria-label") ||
        el.textContent.trim().slice(0, 20) ||
        el.tagName
      const out = []
      const b = bar.getBoundingClientRect()
      for (const el of top) {
        const r = el.getBoundingClientRect()
        if (r.left < b.left - 0.5 || r.right > b.right + 0.5)
          out.push(`${name(el)} outside the bar`)
        // Clipped by a scrolling / hidden-overflow ancestor inside the bar?
        for (let a = el.parentElement; a && a !== bar; a = a.parentElement) {
          if (getComputedStyle(a).overflowX === "visible") continue
          const ar = a.getBoundingClientRect()
          if (r.left < ar.left - 0.5 || r.right > ar.right + 0.5)
            out.push(`${name(el)} clipped`)
        }
        if (
          el.dataset.slot === "toggle-group" &&
          el.scrollWidth > el.clientWidth + 1
        )
          out.push(`${name(el)} squeezed`)
      }
      for (let i = 0; i < top.length; i++)
        for (let j = i + 1; j < top.length; j++) {
          const p = top[i].getBoundingClientRect()
          const q = top[j].getBoundingClientRect()
          const w = Math.min(p.right, q.right) - Math.max(p.left, q.left)
          const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top)
          if (w > 1 && h > 1)
            out.push(`${name(top[i])} overlaps ${name(top[j])}`)
        }
      return out
    })
    checks.eq(problems, [], `${tool} tool: every option is visible`)
  }
  await page.setViewportSize({ width: 1600, height: 1000 })
  await pressTool(page, "v")
  await sleep(300)

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

  checks.step("Shortcuts still work after a Select popup was used")
  // Base UI keeps a closed Select's listbox mounted (hidden); it must not count as an open overlay that
  // swallows every canvas shortcut for the rest of the page's life.
  await pressTool(page, "w")
  const snap = page.getByRole("combobox", { name: "Snap mode" })
  await snap.click()
  await page.getByRole("option", { name: "Cell centres" }).click()
  await sleep(200)
  await page.keyboard.press("Escape")
  await sleep(100)
  const depthBefore = await page.evaluate(
    () => window.__atlasEditor.store.getState().history.undoDepth
  )
  await page.mouse.move(800, 520)
  await page.keyboard.press("v")
  await sleep(100)
  checks.eq(
    await page.evaluate(() => window.__atlasEditor.store.getState().tool),
    "select",
    "after picking a snap mode, V still switches to the select tool"
  )
  await page.keyboard.press("Control+z")
  await sleep(100)
  const depthAfter = await page.evaluate(
    () => window.__atlasEditor.store.getState().history.undoDepth
  )
  checks.ok(
    depthAfter < depthBefore,
    "after picking a snap mode, Ctrl+Z still undoes",
    { depthBefore, depthAfter }
  )
  await page.keyboard.press("Control+Shift+z")
  await sleep(100)
  checks.eq(
    jsonDiff(built, await docJson(page)),
    [],
    "redo restores the document"
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
