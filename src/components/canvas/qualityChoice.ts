/**
 * The viewer's render-quality choice ("Auto" or a fixed tier), shared by the editor, the host console
 * and the player page and remembered per device. "Auto" = EngineCanvas without a `quality` prop: the
 * device probe picks the starting tier and ceiling when the engine is created, so switching back to
 * Auto must remount the canvas (`engineKey`).
 */
import * as React from "react"

import type { Quality } from "@/render/contracts"

export type QualityChoice = Quality | "auto"

export const QUALITY_KEY = "atlas:quality"
/** Where the editor stored the choice before it was shared. */
export const LEGACY_QUALITY_KEY = "atlas-editor:quality"

export const QUALITY_ITEMS: readonly { value: QualityChoice; label: string }[] =
  [
    { value: "auto", label: "Auto" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "ultra", label: "Ultra" },
  ]

export function isQualityChoice(v: unknown): v is QualityChoice {
  return QUALITY_ITEMS.some((q) => q.value === v)
}

type StorageLike = Pick<Storage, "getItem" | "setItem">

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

export function readQualityChoice(
  storage: StorageLike | null = defaultStorage()
): QualityChoice {
  try {
    const v =
      storage?.getItem(QUALITY_KEY) ?? storage?.getItem(LEGACY_QUALITY_KEY)
    if (isQualityChoice(v)) return v
  } catch {
    // Storage unavailable: default.
  }
  return "auto"
}

export function writeQualityChoice(
  q: QualityChoice,
  storage: StorageLike | null = defaultStorage()
): void {
  try {
    storage?.setItem(QUALITY_KEY, q)
  } catch {
    // Storage full / blocked: the choice lasts for this page only.
  }
}

/** The explicit tier for EngineCanvas (undefined = Auto). */
export function qualityProp(choice: QualityChoice): Quality | undefined {
  return choice === "auto" ? undefined : choice
}

export interface QualityChoiceState {
  choice: QualityChoice
  setChoice(q: QualityChoice): void
  /** Pass as EngineCanvas `quality`. */
  quality: Quality | undefined
  /** Pass as the EngineCanvas (or its wrapper's) `key`: bumps when switching to Auto. */
  engineKey: number
}

export function useQualityChoice(): QualityChoiceState {
  const [choice, setChoiceState] =
    React.useState<QualityChoice>(readQualityChoice)
  const [engineKey, setEngineKey] = React.useState(0)
  const setChoice = React.useCallback((q: QualityChoice) => {
    writeQualityChoice(q)
    setChoiceState((prev) => {
      // "Auto" hands control back to the device probe + adaptation: recreate the engine.
      if (q === "auto" && prev !== "auto") setEngineKey((k) => k + 1)
      return q
    })
  }, [])
  return { choice, setChoice, quality: qualityProp(choice), engineKey }
}
