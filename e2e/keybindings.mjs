// Keyboard shortcuts and key remapping (local mode): the theme's "D" hotkey works on the home page but
// not on the map views (D is the door tool / pans right) → the editor's "?" opens the Keyboard shortcuts
// dialog → recording a key (Escape cancels without closing the dialog, a key taken from another command
// moves, browser-reserved keys are refused, Enter records without re-triggering the button) → the remapped
// keys drive the editor and survive a reload → reset → the play tab refuses camera keys → in a session, the
// DM's V previews vision and can be remapped from the HUD's shortcuts popover → a player's popover and
// dialog show only player keys.
//
//   ATLAS_URL=http://127.0.0.1:5173 node e2e/keybindings.mjs
import {
  Checks,
  openBrowser,
  outDir,
  seriousErrors,
  shot,
  sleep,
  waitFor,
  watchPage,
} from "./lib.mjs"
import { joinGame, openSceneInEditor, startSession } from "./session.mjs"

const OUT = outDir("keybindings")
const checks = new Checks("keybindings")
const logs = []
const browser = await openBrowser()

const theme = (page) =>
  page.evaluate(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light"
  )
const tool = (page) =>
  page.evaluate(() => window.__atlasEditor.store.getState().tool)
const status = (dialog) => dialog.getByRole("status").textContent()

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()
  watchPage(page, "dm", logs)

  checks.step("Theme hotkey")
  await openSceneInEditor(page, { mode: "local" })
  const t0 = await theme(page)
  await page.goBack({ waitUntil: "domcontentloaded" })
  await page
    .getByRole("button", { name: /New scene/ })
    .first()
    .waitFor()
  await page.keyboard.press("d")
  checks.ok((await theme(page)) !== t0, "D toggles the theme on the home page")
  await page.keyboard.press("d")
  checks.eq(await theme(page), t0, "D toggles it back")
  await page.goForward({ waitUntil: "domcontentloaded" })
  await waitFor(page, () => window.__atlasEditor?.engine != null, null, {
    timeout: 60000,
    label: "editor",
  })
  await page.mouse.click(700, 450)
  await page.keyboard.press("d")
  checks.eq(await tool(page), "door", "D selects the door tool in the editor")
  checks.eq(await theme(page), t0, "and does not toggle the theme")
  await page.keyboard.press("v")

  checks.step("Keyboard shortcuts dialog")
  await page.keyboard.press("Shift+?")
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" })
  await dialog.waitFor({ timeout: 5000 })
  checks.ok(true, "? opens the dialog")
  await dialog.getByRole("button", { name: "Change W" }).click()
  checks.ok(
    /Press the new key for “Wall”/.test(await status(dialog)),
    "clicking a key starts recording"
  )
  await page.keyboard.press("Escape")
  await sleep(150)
  checks.ok(
    await dialog.isVisible(),
    "Escape cancels recording without closing the dialog"
  )
  await dialog.getByRole("button", { name: "Change W" }).click()
  await page.keyboard.press("q")
  await sleep(300)
  checks.ok(
    await dialog.getByRole("button", { name: "Change Q" }).isVisible(),
    "Wall is now on Q"
  )
  checks.eq(
    await dialog
      .getByRole("button", { name: "Recording: press a key" })
      .count(),
    0,
    "recording stops after one key"
  )
  await dialog.getByRole("button", { name: "Add a key for Wall" }).click()
  await page.keyboard.press("g")
  await sleep(150)
  checks.ok(
    /G moved here from “Toggle grid”/.test(await status(dialog)),
    "a key taken from another command moves, and the dialog says so"
  )
  await dialog.getByRole("button", { name: "Add a key for Undo" }).click()
  await page.keyboard.press("Control+w").catch(() => {})
  await sleep(150)
  checks.ok(/browser keeps/.test(await status(dialog)), "Ctrl+W is refused")
  await page.keyboard.press("Escape")
  await dialog.getByRole("button", { name: "Change H" }).click()
  await page.keyboard.press("Enter")
  await sleep(300)
  checks.eq(
    await dialog
      .getByRole("button", { name: "Recording: press a key" })
      .count(),
    0,
    "recording Enter does not click the key button again"
  )
  await shot(page, OUT, "editor-dialog")
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden", timeout: 3000 })
  checks.ok(true, "Escape closes the dialog when not recording")

  checks.step("Remapped keys")
  await page.mouse.click(700, 450)
  await page.keyboard.press("w")
  checks.eq(await tool(page), "select", "W no longer selects the wall tool")
  await page.keyboard.press("q")
  checks.eq(await tool(page), "wall", "Q does")
  await page.keyboard.press("v")
  await page.keyboard.press("g")
  checks.eq(await tool(page), "wall", "so does G")
  await page.getByRole("button", { name: "Wall", exact: true }).hover()
  await page
    .locator("[data-slot=tooltip-content]", { hasText: "Wall" })
    .locator("kbd", { hasText: "Q" })
    .waitFor({ timeout: 3000 })
  checks.ok(true, "the tool rail tooltip shows the new key")
  await page.reload({ waitUntil: "domcontentloaded" })
  await waitFor(page, () => window.__atlasEditor?.engine != null, null, {
    timeout: 60000,
    label: "editor after reload",
  })
  await page.mouse.click(700, 450)
  await page.keyboard.press("v")
  await page.keyboard.press("q")
  checks.eq(await tool(page), "wall", "remaps survive a reload")
  await page.keyboard.press("v")
  await page.keyboard.press("Shift+?")
  await dialog.waitFor()
  await dialog
    .getByRole("button", { name: /Reset all map editor keys/ })
    .click()
  await sleep(150)
  checks.ok(
    await dialog.getByRole("button", { name: "Change W" }).isVisible(),
    "reset all brings W back"
  )
  await dialog.getByRole("tab", { name: "Play" }).click()
  await dialog.getByRole("button", { name: "Change Q" }).click()
  await page.keyboard.press("w")
  await sleep(150)
  checks.ok(
    /pans the camera/.test(await status(dialog)),
    "play commands refuse camera pan keys"
  )
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden", timeout: 3000 })

  checks.step("DM session")
  const { roomCode } = await startSession(page)
  const preview = page.getByRole("button", { name: "Preview vision" })
  await page.mouse.click(700, 450)
  await page.keyboard.press("d")
  checks.eq(await theme(page), t0, "D does not toggle the theme on the host")
  await page.keyboard.press("v")
  await sleep(200)
  checks.eq(
    await preview.getAttribute("aria-pressed"),
    "true",
    "V previews vision"
  )
  await page.keyboard.press("v")
  checks.eq(
    await preview.getAttribute("aria-pressed"),
    "false",
    "V again ends the preview"
  )
  await page.getByRole("button", { name: "Keyboard shortcuts" }).click()
  checks.ok(
    await page.getByRole("dialog").getByText("Preview vision").isVisible(),
    "the DM's popover lists Preview vision"
  )
  await page.getByRole("button", { name: "Customize keys…" }).click()
  await dialog.waitFor()
  await shot(page, OUT, "host-dialog")
  await dialog.getByRole("button", { name: "Change V" }).click()
  await page.keyboard.press("b")
  await sleep(150)
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden", timeout: 3000 })
  await page.mouse.click(700, 450)
  await page.keyboard.press("v")
  await sleep(200)
  checks.eq(
    await preview.getAttribute("aria-pressed"),
    "false",
    "V no longer previews"
  )
  await page.keyboard.press("b")
  await sleep(200)
  checks.eq(await preview.getAttribute("aria-pressed"), "true", "B does")
  await page.keyboard.press("b")

  checks.step("Player")
  const player = await joinGame(context, { roomCode, name: "Morgana", logs })
  const pp = player.page
  await pp.mouse.click(700, 450)
  await pp.keyboard.press("d")
  checks.eq(await theme(pp), t0, "D does not toggle the theme for a player")
  await pp.getByRole("button", { name: "Keyboard shortcuts" }).click()
  checks.eq(
    await pp.getByRole("dialog").getByText("Preview vision").count(),
    0,
    "the player's popover has no DM keys"
  )
  await pp.getByRole("button", { name: "Customize keys…" }).click()
  const pdialog = pp.getByRole("dialog", { name: "Keyboard shortcuts" })
  await pdialog.waitFor()
  checks.eq(
    await pdialog.getByRole("tab").count(),
    0,
    "the player's dialog shows only play keys"
  )
  await shot(pp, OUT, "player-dialog")
  await pp.keyboard.press("Escape")

  checks.ok(
    seriousErrors(logs).length === 0,
    "no console errors",
    seriousErrors(logs)
  )
} catch (e) {
  checks.fail("script", e.stack)
} finally {
  await browser.close()
  checks.done()
}
