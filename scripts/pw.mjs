// Shared Playwright launcher for browser checks in this WSL environment.
//   import { launchBrowser } from "/home/kevin/js/atlas-vtt/scripts/pw.mjs"
//   const browser = await launchBrowser("nvidia")   // "nvidia" | "amd" | "swiftshader"
// GPU backends go through Mesa's d3d12 driver (WSL). The installed Playwright expects a newer browser
// revision than is cached, so we point at the cached headless shell explicitly.
// Elsewhere, ATLAS_CHROMIUM names the browser executable (e.g. a Playwright-managed Chromium), and
// ATLAS_GPU=swiftshader picks software WebGL.
import { createRequire } from "node:module"

const require = createRequire(new URL("../package.json", import.meta.url))
const { chromium } = require("playwright")

export const HEADLESS_SHELL =
  process.env.ATLAS_CHROMIUM ??
  "/home/kevin/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell"

const gpuArgs = [
  "--use-gl=angle",
  "--use-angle=gl",
  "--ignore-gpu-blocklist",
  "--enable-gpu",
  "--disable-gpu-sandbox",
  "--no-sandbox",
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
]

export function launchOptions(backend = "nvidia") {
  switch (backend) {
    case "swiftshader":
      return {
        args: [
          "--use-gl=angle",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
        ],
        env: process.env,
      }
    case "amd":
    case "nvidia":
      return {
        args: gpuArgs,
        env: {
          ...process.env,
          GALLIUM_DRIVER: "d3d12",
          MESA_D3D12_DEFAULT_ADAPTER_NAME: backend === "amd" ? "AMD" : "NVIDIA",
          LD_LIBRARY_PATH: "/usr/lib/wsl/lib",
        },
      }
    default:
      throw new Error(`unknown backend ${backend}`)
  }
}

export async function launchBrowser(backend = "nvidia", extra = {}) {
  const o = launchOptions(backend)
  return chromium.launch({
    headless: true,
    executablePath: HEADLESS_SHELL,
    args: o.args,
    env: o.env,
    ...extra,
  })
}

export { chromium }
