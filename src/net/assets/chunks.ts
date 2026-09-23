/**
 * Backdrop tile chunks (ARCHITECTURE §9). During an online session the host uploads, for EACH player,
 * the explored part of every level's battlemap in square chunks of TILE_CHUNK × TILE_CHUNK grid cells:
 * `session-tiles/{sessionId}/{userId}/{levelId}/{ci}_{cj}.webp`, readable only by that player (while
 * an active member) and the DM. A chunk image is TILE_CHUNK·tilePx pixels square; it holds the pixels
 * of the sub-cells (4×4 per cell, core/vision) that player has explored — a fully explored cell whole,
 * a partly explored one only its explored sub-cells — and is transparent everywhere else.
 *
 * The host tells the player which cells each uploaded chunk holds with `{t: "tiles"}` messages:
 * `[ci, cj, mask, rev]` entries whose mask has bit (j mod 4)·4 + (i mod 4) set for every cell with
 * pixels in the object, and whose `rev` (a non-zero hash of the cells' sub-cell masks) changes whenever
 * the object is re-cut, e.g. when a partly explored cell grows. Removals are `[ci, cj, 0]`.
 * Uploading per player chunk (instead of one object per cell) keeps an open outdoor map's first view at
 * ~70 uploads/downloads instead of ~1000, which Storage rate-limits.
 */
import type { Id } from "@/core/scene/types"

/** Grid cells per chunk side. */
export const TILE_CHUNK = 4
/** Every cell of a chunk. */
export const FULL_CHUNK_MASK = (1 << (TILE_CHUNK * TILE_CHUNK)) - 1
/** Chunk coordinates stay below this (grids are ≤ 200 cells: ≤ 50 chunks per side). */
export const MAX_CHUNK_COORD = 64

/**
 * `[ci, cj, mask, rev?]`: the cells (mask bits) whose pixels the uploaded chunk (ci, cj) holds, and the
 * version of its content (absent from older hosts: treat as 0).
 */
export type ChunkEntry = [ci: number, cj: number, mask: number] | [ci: number, cj: number, mask: number, rev: number]

export interface CellChunk {
  ci: number
  cj: number
  /** Bit of the cell inside its chunk. */
  bit: number
}

export function chunkOfCell(i: number, j: number): CellChunk {
  const ci = Math.floor(i / TILE_CHUNK)
  const cj = Math.floor(j / TILE_CHUNK)
  return { ci, cj, bit: (j - cj * TILE_CHUNK) * TILE_CHUNK + (i - ci * TILE_CHUNK) }
}

/** Compact numeric key of a chunk. */
export const chunkKey = (ci: number, cj: number): number => cj * MAX_CHUNK_COORD + ci

export function chunkFromKey(key: number): { ci: number; cj: number } {
  return { ci: key % MAX_CHUNK_COORD, cj: Math.floor(key / MAX_CHUNK_COORD) }
}

/** Storage path of one player's chunk. */
export const chunkPath = (sessionId: string, userId: string, levelId: Id, ci: number, cj: number): string => `${sessionId}/${userId}/${levelId}/${ci}_${cj}.webp`

/** A well-formed wire entry (integers in range, mask within 16 bits, rev a uint32). */
export function isChunkEntry(e: unknown): e is ChunkEntry {
  return (
    Array.isArray(e) &&
    (e.length === 3 || e.length === 4) &&
    e.every((n) => Number.isInteger(n) && n >= 0) &&
    (e[0] as number) < MAX_CHUNK_COORD &&
    (e[1] as number) < MAX_CHUNK_COORD &&
    (e[2] as number) <= FULL_CHUNK_MASK &&
    (e.length === 3 || (e[3] as number) < 2 ** 32)
  )
}
