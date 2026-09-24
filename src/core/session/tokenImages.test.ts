import { describe, expect, it } from "vitest"

import { playerTokenImageAllowed, tokenImageUrl } from "./tokenImages"

const BASE = "https://ref.supabase.co/storage/v1/object/public/token-images/"
const UID = "0b7f3c2e-6f59-4d0e-9d43-1c1f5f0f4a11"

describe("playerTokenImageAllowed", () => {
  it("allows images in the player's own folder", () => {
    expect(playerTokenImageAllowed(tokenImageUrl(BASE, UID, "a1B2_c3-d4.webp"), BASE, UID)).toBe(true)
    expect(playerTokenImageAllowed(`${BASE}${UID}/hero.png`, BASE, UID)).toBe(true)
  })

  it("refuses other folders, hosts, names and anything without a store", () => {
    const other = "11111111-2222-3333-4444-555555555555"
    for (const url of [
      `${BASE}${other}/hero.png`,
      `https://evil.example/${UID}/hero.png`,
      `${BASE}${UID}/hero.gif`,
      `${BASE}${UID}/sub/hero.png`,
      `${BASE}${UID}/../${other}/hero.png`,
      `${BASE}${UID}/hero.png?x=1`,
      `${BASE}${UID}/hero.png#x`,
      `${BASE}${UID}/.png`,
      `${BASE}${UID}/`,
      `${BASE}${UID}hero.png`,
      `${BASE}${UID}/${"a".repeat(65)}.png`,
    ])
      expect(playerTokenImageAllowed(url, BASE, UID), url).toBe(false)
    expect(playerTokenImageAllowed(`${BASE}${UID}/hero.png`, null, UID)).toBe(false)
    expect(playerTokenImageAllowed(`${BASE}${UID}/hero.png`, BASE.slice(0, -1), UID)).toBe(false)
    expect(playerTokenImageAllowed(`${BASE}__proto__/hero.png`, BASE, "__proto__")).toBe(false)
    expect(playerTokenImageAllowed(`${BASE}${UID}/${"a".repeat(3000)}.png`, BASE, UID)).toBe(false)
  })
})
