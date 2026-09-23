import { describe, expect, it } from "vitest"

import { guessGridFromName, normalisedSize, probeImageSize, readImageSize } from "./import"

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)))
const be16 = (v: number) => [(v >> 8) & 255, v & 255]
const be32 = (v: number) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255]
const le16 = (v: number) => [v & 255, (v >> 8) & 255]
const le24 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255]
const le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]

function png(w: number, h: number): Uint8Array<ArrayBuffer> {
  return bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0])
}

/** JPEG with an APP1 segment of `pad` bytes before the SOF0 marker. */
function jpeg(w: number, h: number, pad = 16): Uint8Array<ArrayBuffer> {
  return bytes([0xff, 0xd8], [0xff, 0xe1], be16(pad + 2), new Array(pad).fill(0), [0xff, 0xdb], be16(4), [0, 0], [0xff, 0xc0], be16(17), [8], be16(h), be16(w), [3], new Array(9).fill(0))
}

describe("readImageSize", () => {
  it("reads PNG, GIF and BMP headers", () => {
    expect(readImageSize(png(3780, 6580))).toEqual({ width: 3780, height: 6580, format: "png" })
    expect(readImageSize(bytes("GIF89a", le16(640), le16(480), [0, 0, 0, 0]))).toEqual({ width: 640, height: 480, format: "gif" })
    expect(readImageSize(bytes("BM", new Array(16).fill(0), le32(800), le32(-600 >>> 0), [0, 0]))).toEqual({ width: 800, height: 600, format: "bmp" })
  })

  it("walks JPEG segments to the SOF marker", () => {
    expect(readImageSize(jpeg(9000, 15000))).toEqual({ width: 9000, height: 15000, format: "jpeg" })
    // Truncated before the SOF: more bytes needed.
    expect(readImageSize(jpeg(9000, 15000, 500).subarray(0, 300))).toBe("more")
  })

  it("reads the three WebP flavours", () => {
    const riff = (chunk: string, payload: number[]) => bytes("RIFF", le32(100), "WEBP", chunk, le32(payload.length), payload)
    expect(readImageSize(riff("VP8X", [0, 0, 0, 0, ...le24(3779), ...le24(6579)]))).toEqual({ width: 3780, height: 6580, format: "webp" })
    const lossless = 0x2f
    const bits = ((6580 - 1) << 14) | (3780 - 1)
    expect(readImageSize(riff("VP8L", [lossless, ...le32(bits)]))).toEqual({ width: 3780, height: 6580, format: "webp" })
    expect(readImageSize(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(1024), ...le16(768)]))).toEqual({ width: 1024, height: 768, format: "webp" })
  })

  it("rejects non-images", () => {
    expect(readImageSize(bytes("hello world, not an image"))).toBeNull()
    expect(readImageSize(new Uint8Array(0))).toBeNull()
  })

  it("probes blobs, reading further when EXIF pushes the SOF past the first chunk", async () => {
    const big = jpeg(9000, 15000, 60_000)
    const blob = new Blob([big, new Uint8Array(200_000)], { type: "image/jpeg" })
    expect(await probeImageSize(blob)).toEqual({ width: 9000, height: 15000, format: "jpeg" })
    expect(await probeImageSize(new Blob([png(10, 20)]))).toEqual({ width: 10, height: 20, format: "png" })
    expect(await probeImageSize(new Blob(["nope"]))).toBeNull()
  })
})

describe("normalisedSize", () => {
  it("stores Forgotten Adventures maps at 140 px per cell", () => {
    expect(normalisedSize({ width: 3780, height: 6580 }, { cellsX: 27, cellsZ: 47 })).toEqual({ width: 3780, height: 6580, pxPerCell: 140 })
    // The 9000×15000 JPEG is downscaled to the same grid-exact size.
    expect(normalisedSize({ width: 9000, height: 15000 }, { cellsX: 27, cellsZ: 47 })).toEqual({ width: 3780, height: 6580, pxPerCell: 140 })
  })

  it("never upscales and keeps whole px per cell", () => {
    expect(normalisedSize({ width: 1000, height: 1000 }, { cellsX: 27, cellsZ: 27 })).toEqual({ width: 999, height: 999, pxPerCell: 37 })
  })

  it("caps each side at 8192 px", () => {
    const s = normalisedSize({ width: 30000, height: 30000 }, { cellsX: 100, cellsZ: 100 })
    expect(s.pxPerCell).toBe(81)
    expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(8192)
  })

  it("rejects an empty calibration", () => {
    expect(() => normalisedSize({ width: 10, height: 10 }, { cellsX: 0, cellsZ: 5 })).toThrow()
  })
})

describe("guessGridFromName", () => {
  it("finds the grid in Forgotten Adventures names", () => {
    expect(guessGridFromName("181-FA-Vineyard-Interiors-27x47-NoGrid-FirstFloor-Night.jpg")).toEqual({ cellsX: 27, cellsZ: 47 })
    expect(guessGridFromName("181-FA-Vineyard-Interior-27x47-NoGrid-Basement-Night.png")).toEqual({ cellsX: 27, cellsZ: 47 })
    expect(guessGridFromName("Tavern [30 x 20].webp")).toEqual({ cellsX: 30, cellsZ: 20 })
    expect(guessGridFromName("crypt_40×32_night.png")).toEqual({ cellsX: 40, cellsZ: 32 })
  })

  it("ignores resolutions, versions and out-of-range grids", () => {
    expect(guessGridFromName("map-1920x1080.png")).toBeNull()
    expect(guessGridFromName("dungeon 300x40.png")).toBeNull()
    expect(guessGridFromName("v2x3map.png")).toBeNull()
    expect(guessGridFromName("plain.png")).toBeNull()
  })
})
