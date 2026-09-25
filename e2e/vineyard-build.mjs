// Builds "The Vineyard" from the three Forgotten Adventures battlemaps in test_maps/ (local mode):
//
//  1. A new world → "From map images" (a new scene, its screen in Edit) → the import dialog: basement
//     (−12 ft) and second floor (+10 ft) get a floor traced from the image alpha and walls traced from
//     its outline; the ground floor is opaque.
//  2. The rest goes through the editor store (dev hook window.__atlasEditor) in ONE undoable edit, from
//     e2e/vineyard-plan.mjs (read off the art): walls, doors and windows of the three houses, the manor
//     stairs and two trapdoors, roofs over the winery and the cottage, the lamps and fires, the party
//     (a halfling and a dwarf with darkvision, a human) on the plaza and a hidden troll in the caves.
//  3. Checks: levels / backdrops / traced geometry, the document parses, every storey is reachable on
//     foot (A* through the stairs and trapdoors), undo removes the layout in one step.
//  4. A restore point (Ctrl+S) → reload → unchanged; export → test_maps/vineyard.atlas.json (gitignored:
//     third-party art).
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/vineyard-build.mjs
//   ATLAS_TEST_MAPS=/path/to/test_maps   the art (default <repo>/test_maps; see lib.mjs)
//   ATLAS_EXPORT=/path/to/vineyard.atlas.json   where the export goes (default test_maps/)
import fs from "node:fs"
import path from "node:path"

import {
  Checks,
  editorSummary,
  jsonDiff,
  openBrowser,
  outDir,
  seriousErrors,
  shot,
  sleep,
  TEST_MAPS,
  waitEditor,
  waitFor,
  watchPage,
} from "./lib.mjs"
import {
  CONNECTORS,
  GROUND_WALLS,
  LIGHTS,
  ROOFS,
  TOKENS,
} from "./vineyard-plan.mjs"
import { createWorld } from "./session.mjs"

const OUT = outDir("vineyard-build")
const EXPORT_TO =
  process.env.ATLAS_EXPORT ?? path.join(TEST_MAPS, "vineyard.atlas.json")
const MAPS = {
  basement: path.join(
    TEST_MAPS,
    "181-FA-Vineyard-Interior-27x47-NoGrid-Basement-Night.png"
  ),
  ground: path.join(
    TEST_MAPS,
    "181-FA-Vineyard-Interiors-27x47-NoGrid-FirstFloor-Night.jpg"
  ),
  upper: path.join(
    TEST_MAPS,
    "181-FA-Vineyard-Interior-27x47-NoGrid-SecondFloor-Night.png"
  ),
}
const ELEVATION = { basement: -12, ground: 0, upper: 10 }

const checks = new Checks("vineyard-build")
const logs = []
for (const f of Object.values(MAPS))
  if (!fs.existsSync(f)) throw new Error(`missing test map ${f}`)
const browser = await openBrowser()

/** Levels by role (lowest = basement, elevation 0 = ground, highest = upper). */
const roles = (page) =>
  page.evaluate(() => {
    const levels = Object.values(
      window.__atlasEditor.store.getState().scene.levels
    ).sort((a, b) => a.elevation - b.elevation)
    return {
      basement: levels[0].id,
      ground: levels.find((l) => l.elevation === 0)?.id ?? levels[1].id,
      upper: levels[levels.length - 1].id,
    }
  })

try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  })
  const page = await context.newPage()
  watchPage(page, "editor", logs)

  // ---- 1. import -----------------------------------------------------------------------------------
  checks.step("New scene from map images (import dialog)")
  await createWorld(page, { name: "Vineyard world" })
  await page
    .getByRole("button", { name: /From map images/ })
    .first()
    .click()
  await waitEditor(page)
  const dialog = page.getByRole("dialog")
  await dialog.waitFor()
  await dialog
    .locator('[data-testid="map-import-input"]')
    .setInputFiles([MAPS.basement, MAPS.ground, MAPS.upper])
  for (const [role, file] of Object.entries(MAPS)) {
    const card = dialog.locator("div.grid.rounded-lg", {
      hasText: path.basename(file),
    })
    await card.getByText(/px per cell/).waitFor({ timeout: 20000 })
    const cells = [
      await card.getByRole("textbox", { name: "Cells across" }).inputValue(),
      await card.getByRole("textbox", { name: "Cells down" }).inputValue(),
    ]
    checks.eq(
      cells,
      ["27", "47"],
      `${role}: grid 27×47 read from the file name`
    )
    const elevation = card.getByRole("textbox", { name: "Elevation" })
    await elevation.fill(String(ELEVATION[role]))
    await elevation.press("Enter")
    const floor = card.getByRole("checkbox").nth(0)
    const walls = card.getByRole("checkbox").nth(1)
    const want = { floor: true, walls: role !== "ground" }
    for (const [box, on] of [
      [floor, want.floor],
      [walls, want.walls],
    ]) {
      if (((await box.getAttribute("aria-checked")) === "true") !== on)
        await box.click()
    }
  }
  await shot(page, OUT, "01-import-dialog")
  const t0 = performance.now()
  await dialog
    .getByRole("button", { name: /Create scene from 3 images/ })
    .click()
  await dialog.waitFor({ state: "detached", timeout: 120000 })
  checks.ok(
    true,
    `three maps imported, floors and walls traced (${((performance.now() - t0) / 1000).toFixed(1)} s)`
  )
  await sleep(1500)

  const L = await roles(page)
  const imported = await page.evaluate((L) => {
    const s = window.__atlasEditor.store.getState().scene
    const on = (id, type) =>
      Object.values(s.objects).filter(
        (o) => o.levelId === id && o.type === type
      )
    const lvl = (id) => ({
      name: s.levels[id].name,
      elevation: s.levels[id].elevation,
      backdrop: !!s.levels[id].backdrop,
      floors: on(id, "floor").length,
      masked: on(id, "floor").filter((f) => f.mask).length,
      walls: on(id, "wall").length,
    })
    return {
      grid: [s.grid.width, s.grid.depth],
      basement: lvl(L.basement),
      ground: lvl(L.ground),
      upper: lvl(L.upper),
      env: s.environment,
    }
  }, L)
  checks.eq(imported.grid, [27, 47], "scene grid is 27×47")
  checks.eq(
    [
      imported.basement.elevation,
      imported.ground.elevation,
      imported.upper.elevation,
    ],
    [-12, 0, 10],
    "levels at −12 / 0 / +10 ft"
  )
  checks.ok(
    imported.basement.backdrop &&
      imported.ground.backdrop &&
      imported.upper.backdrop,
    "each level has its battlemap backdrop"
  )
  checks.ok(
    imported.basement.masked === 1 && imported.upper.masked === 1,
    "basement and second floor: floors traced from the image alpha",
    imported
  )
  checks.ok(
    imported.ground.floors === 1 && imported.ground.masked === 0,
    "ground floor: one full floor (opaque image)",
    imported.ground
  )
  checks.ok(
    imported.basement.walls > 50 && imported.upper.walls >= 4,
    `walls traced from the outlines (basement ${imported.basement.walls}, second floor ${imported.upper.walls})`
  )
  checks.ok(
    imported.env.directional.enabled &&
      imported.env.directional.kind === "moon",
    "moonlit night preset picked from the file names"
  )

  // ---- 2. layout through the editor store --------------------------------------------------------
  checks.step(
    "Houses, stairs, roofs, lights and tokens through the editor store"
  )
  const plan = { GROUND_WALLS, ROOFS, CONNECTORS, LIGHTS, TOKENS }
  // The modules first, then one synchronous evaluate for the edit: an async evaluate whose edit goes
  // through the scene screen's host fails in Playwright with "Resulting promise was garbage collected".
  await page.evaluate(async () => {
    window.__vineyardModules = {
      f: await import("/src/core/scene/factory.ts"),
      heightmap: await import("/src/core/scene/heightmap.ts"),
      snap: await import("/src/editor/snapping.ts"),
    }
  })
  const built = await page.evaluate(
    ({ plan, L }) => {
      const { f, snap } = window.__vineyardModules
      const { bytesToBase64 } = window.__vineyardModules.heightmap
      const store = window.__atlasEditor.store
      const st = store.getState()

      // Openings are placed by distance along a run, resolved to (segment, offset) through the editor's
      // own placement (placeOpening, as the door / window tools use it): with snapping on, a door in a
      // rotated wall goes where grid movement can walk through it (at most a foot or two along).
      const placed = { objects: {}, grid: st.scene.grid }
      const locate = (walls, at, width, kind) => {
        for (const w of walls) {
          const len = Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z)
          if (at > len) {
            at -= len
            continue
          }
          const desired = Math.min(Math.max(at, 3.5), len - 3.5)
          const { offset, valid } = snap.placeOpening(
            placed,
            w,
            desired,
            width,
            { mode: kind === "door" ? "center" : "free", kind }
          )
          return valid ? { wall: w, offset } : null
        }
        return null
      }
      // Mask floor covering a world polygon (mask cells on the world-origin lattice of `spacing`).
      const polygonFloor = (levelId, polygon, spacing, material) => {
        const xs = polygon.map((p) => p[0])
        const zs = polygon.map((p) => p[1])
        const x0 = Math.floor(Math.min(...xs) / spacing) * spacing
        const z0 = Math.floor(Math.min(...zs) / spacing) * spacing
        const cols = Math.ceil((Math.max(...xs) - x0) / spacing)
        const rows = Math.ceil((Math.max(...zs) - z0) / spacing)
        const inside = (x, z) => {
          let hit = false
          for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const [xi, zi] = polygon[i]
            const [xj, zj] = polygon[j]
            if (
              zi > z !== zj > z &&
              x < ((xj - xi) * (z - zi)) / (zj - zi) + xi
            )
              hit = !hit
          }
          return hit
        }
        const bits = new Uint8Array(Math.ceil((cols * rows) / 8))
        for (let v = 0; v < rows; v++)
          for (let u = 0; u < cols; u++)
            if (inside(x0 + (u + 0.5) * spacing, z0 + (v + 0.5) * spacing))
              bits[(v * cols + u) >> 3] |= 1 << ((v * cols + u) & 7)
        const floor = f.createFloor(
          levelId,
          { x: x0, z: z0, w: cols * spacing, d: rows * spacing },
          material
        )
        return {
          ...floor,
          mask: { spacing, cols, rows, b64: bytesToBase64(bits) },
        }
      }

      const objects = []
      for (const r of plan.GROUND_WALLS) {
        const walls = []
        for (let k = 0; k < r.points.length - 1; k++) {
          const [a, b] = [r.points[k], r.points[k + 1]]
          walls.push(
            f.createWall(
              L.ground,
              { x: a[0], z: a[1] },
              { x: b[0], z: b[1] },
              {
                name: r.name,
                material: r.material,
                height: r.height ?? 10,
                thickness: r.thickness ?? 0.75,
              }
            )
          )
        }
        objects.push(...walls)
        const add = (o) => {
          objects.push(o)
          placed.objects[o.id] = o
        }
        for (const w of walls) placed.objects[w.id] = w
        for (const d of r.doors) {
          const width = d.width ?? 6.5
          const at = locate(walls, d.at, width, "door")
          if (!at) throw new Error(`no room for ${d.name}`)
          add(
            f.createDoor(at.wall, at.offset, {
              name: d.name,
              state: "closed",
              width,
              leaves: d.leaves ?? "double",
            })
          )
        }
        for (const w of r.windows) {
          const at = locate(walls, w.at, 3, "window")
          if (!at) throw new Error(`no room for a window at ${w.at} ft`)
          add(f.createWindow(at.wall, at.offset, { name: "Window", width: 3 }))
        }
      }
      // Roof slabs follow the rotated outlines at 0.625 ft steps (finer than traced floors: seen edge-on).
      for (const r of plan.ROOFS)
        objects.push({
          ...polygonFloor(
            L.upper,
            r.polygon,
            st.scene.grid.cellSize / 8,
            r.material ?? "tile"
          ),
          name: r.name,
        })
      for (const c of plan.CONNECTORS)
        objects.push({
          ...f.createConnector(
            L[c.from],
            L[c.to],
            c.rect,
            c.direction,
            c.style
          ),
          name: c.name,
        })
      for (const [role, specs] of Object.entries(plan.LIGHTS))
        for (const [preset, x, z, o] of specs)
          objects.push(f.createLight(L[role], preset, { x, z }, o))
      const tokens = plan.TOKENS.map(({ role, at, ...partial }) =>
        f.createToken(L[role], { x: at[0], z: at[1] }, partial)
      )

      const patches = st.apply((draft) => {
        draft.name = "The Vineyard"
        draft.levels[L.basement].height = 11
        draft.levels[L.ground].height = 10
        draft.levels[L.upper].height = 9
        draft.environment.ambientIntensity = 0.22
        for (const o of objects) draft.objects[o.id] = o
        for (const t of tokens) draft.tokens[t.id] = t
      }, "Vineyard layout")
      return {
        patches: patches.length,
        rejected: store.getState().lastRejected,
        objects: objects.length,
        tokens: tokens.map((t) => ({
          id: t.id,
          name: t.name,
          levelId: t.levelId,
        })),
      }
    },
    { plan, L }
  )
  checks.ok(
    built.patches > 0 && !built.rejected,
    `one edit adds ${built.objects} objects and ${built.tokens.length} tokens`,
    built.rejected
  )
  const summary = await editorSummary(page)
  console.log("  ", JSON.stringify(summary.objects), `${summary.tokens} tokens`)
  checks.eq(summary.undo, "Vineyard layout", "the layout is one undo step")

  // ---- 3. validity & reachability ----------------------------------------------------------------------
  checks.step(
    "The document parses and every storey is reachable on foot (doors open)"
  )
  const verdict = await page.evaluate(
    async ({ L, tokens }) => {
      const [{ parseScene }, occ, mv] = await Promise.all([
        import("/src/core/scene/schema.ts"),
        import("/src/core/occlusion/index.ts"),
        import("/src/core/movement/index.ts"),
      ])
      const doc = window.__atlasEditor.store.getState().scene
      const parsed = parseScene(JSON.parse(JSON.stringify(doc)))
      // Walk with every door open (closed doors block movement).
      const scene = structuredClone(doc)
      for (const o of Object.values(scene.objects))
        if (o.type === "door") o.state = "open"
      const world = occ.buildOcclusionWorld(scene)
      const wren =
        scene.tokens[tokens.find((t) => t.name.startsWith("Wren")).id]
      const cell = (x, z) => ({
        i: Math.floor(x / scene.grid.cellSize),
        j: Math.floor(z / scene.grid.cellSize),
      })
      const reach = (target, levelId) => {
        const p = mv.findPath(
          scene,
          world,
          wren,
          { cell: target, levelId },
          { maxSteps: 256, nodeLimit: 200000 }
        )
        return p
          ? {
              steps: p.length - 1,
              levels: [...new Set(p.map((s) => s.levelId))].length,
            }
          : null
      }
      // Every door on its own: from the cell centre nearest a point 6 ft in front of it to the one 6 ft
      // behind, in at most 4 steps (i.e. through the doorway, not around the house).
      const cs = scene.grid.cellSize
      const doors = Object.values(scene.objects).filter(
        (o) => o.type === "door"
      )
      const stuck = []
      for (const d of doors) {
        const w = scene.objects[d.wallId]
        const len = Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z)
        const u = { x: (w.b.x - w.a.x) / len, z: (w.b.z - w.a.z) / len }
        const c = { x: w.a.x + u.x * d.offset, z: w.a.z + u.z * d.offset }
        const side = (k) => cell(c.x - u.z * 6 * k, c.z + u.x * 6 * k)
        const probe = { ...wren, levelId: w.levelId }
        probe.position = {
          x: (side(1).i + 0.5) * cs,
          z: (side(1).j + 0.5) * cs,
        }
        const p = mv.findPath(
          scene,
          world,
          probe,
          { cell: side(-1), levelId: w.levelId },
          { maxSteps: 4, nodeLimit: 5000 }
        )
        if (!p) stuck.push(d.name ?? d.id)
      }
      return {
        ok: parsed.ok,
        issues: parsed.ok ? [] : parsed.issues.slice(0, 5),
        doors: doors.length,
        stuck,
        // Both ends of the manor's upper storey (via the manor stairs).
        upper: reach(cell(37.5, 22.5), L.upper),
        upperSW: reach(cell(22.5, 57.5), L.upper),
        // The smugglers' shelf in the sea cave (via the winery trapdoor).
        basementNE: reach(cell(102.5, 42.5), L.basement),
        // The cottage (walk south along the vineyard path).
        cottage: reach(cell(22.5, 207.5), L.ground),
      }
    },
    { L, tokens: built.tokens }
  )
  checks.ok(verdict.ok, "parseScene accepts the document", verdict.issues)
  checks.ok(
    verdict.doors > 0 && verdict.stuck.length === 0,
    `each of the ${verdict.doors} doors (rotated walls) can be walked through when open`,
    verdict.stuck
  )
  checks.ok(
    verdict.upper?.levels === 2 && verdict.upperSW?.levels === 2,
    "both ends of the manor's second floor are reachable by the stairs",
    { upper: verdict.upper, upperSW: verdict.upperSW }
  )
  checks.ok(
    verdict.basementNE?.levels === 2,
    "the sea cave is reachable through the winery trapdoor",
    verdict.basementNE
  )
  checks.ok(
    verdict.cottage !== null,
    "the cottage door lets the party in",
    verdict.cottage
  )

  // ---- screenshots ----------------------------------------------------------------------------------
  await page.getByRole("button", { name: "Top-down camera" }).click()
  for (const role of ["ground", "basement", "upper"]) {
    await page.evaluate(
      (id) => window.__atlasEditor.store.getState().setActiveLevel(id),
      L[role]
    )
    await page.getByRole("button", { name: "Frame the scene" }).click()
    await sleep(1200)
    await shot(page, OUT, `02-top-${role}`)
  }
  await page.evaluate(
    (id) => window.__atlasEditor.store.getState().setActiveLevel(id),
    L.ground
  )
  await page.getByRole("button", { name: "3D orbit camera" }).click()
  await page.getByRole("button", { name: "Frame the scene" }).click()
  await sleep(1500)
  await shot(page, OUT, "03-orbit")

  // ---- 4. undo / save / reload / export ----------------------------------------------------------------
  checks.step("Undo, save, reload, export")
  const full = await page.evaluate(() =>
    JSON.parse(JSON.stringify(window.__atlasEditor.store.getState().scene))
  )
  await page.mouse.move(800, 500)
  await page.keyboard.press("Control+z")
  await sleep(300)
  const afterUndo = await editorSummary(page)
  checks.ok(
    afterUndo.tokens === 0 && !afterUndo.objects.door,
    "one undo removes the whole layout",
    afterUndo.objects
  )
  await page.keyboard.press("Control+Shift+z")
  await sleep(300)
  checks.eq(
    jsonDiff(
      full,
      await page.evaluate(() =>
        JSON.parse(JSON.stringify(window.__atlasEditor.store.getState().scene))
      )
    ),
    [],
    "redo restores it"
  )

  await page.keyboard.press("Control+s")
  await waitFor(
    page,
    () => {
      const lib = window.__atlasHost.runner.getSnapshot().library
      return lib !== null && lib.version >= 2 && !lib.dirty
    },
    null,
    { timeout: 60000, label: "restore point saved" }
  )
  const saved = await page.evaluate(() =>
    JSON.parse(JSON.stringify(window.__atlasEditor.store.getState().scene))
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await waitFor(page, () => window.__atlasHost?.mode === "edit", null, {
    timeout: 60000,
    label: "the scene screen again, in Edit",
  })
  await waitEditor(page, 60000)
  const reloaded = await page.evaluate(() =>
    JSON.parse(JSON.stringify(window.__atlasEditor.store.getState().scene))
  )
  const strip = (s) => ({ ...s, updatedAt: null })
  checks.eq(
    jsonDiff(strip(saved), strip(reloaded)),
    [],
    "reloaded document is identical"
  )

  const downloadP = page.waitForEvent("download", { timeout: 120000 })
  await page.getByRole("menuitem", { name: "File" }).click()
  await page.getByRole("menuitem", { name: "Export .atlas.json" }).click()
  const download = await downloadP
  await download.saveAs(EXPORT_TO)
  const exported = JSON.parse(fs.readFileSync(EXPORT_TO, "utf8"))
  const assetIds = Object.keys(exported.scene?.assets ?? exported.assets ?? {})
  const embedded = Object.keys(exported.assetsData ?? {})
  checks.ok(
    embedded.length === 3 && assetIds.every((id) => embedded.includes(id)),
    `export embeds the three map images (${(fs.statSync(EXPORT_TO).size / 1e6).toFixed(1)} MB → ${EXPORT_TO})`,
    { assetIds, embedded }
  )
  const sceneRoles = await roles(page)
  await page.evaluate(
    (id) => window.__atlasEditor.store.getState().setActiveLevel(id),
    sceneRoles.ground
  )
  await sleep(800)
  await shot(page, OUT, "04-saved")
} catch (err) {
  checks.fail("vineyard-build crashed", err)
} finally {
  const errors = seriousErrors(logs)
  checks.ok(
    errors.length === 0,
    "no console errors",
    errors.slice(0, 6).join("\n")
  )
  await browser.close()
  checks.done()
}
