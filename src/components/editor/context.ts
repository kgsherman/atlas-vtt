/**
 * React plumbing shared by the editor components: the editor store + controller of the page, the
 * engine (once created), UI-only tool extras, and a confirm-dialog hook.
 */
import * as React from "react"
import { useStore } from "zustand"
import { useShallow } from "zustand/react/shallow"

import type { FreeAssetCategory } from "@/core/session/freeAssets"
import type { EditorController } from "@/editor/controller"
import type { EditorState, EditorStore } from "@/editor/store"
import type { Engine } from "@/render/contracts"

import type { ToolExtras, ToolExtrasStore } from "./lib/toolExtras"

export interface EditorContextValue {
  store: EditorStore
  controller: EditorController
  extras: ToolExtrasStore
}

export const EditorContext = React.createContext<EditorContextValue | null>(null)

export function useEditorContext(): EditorContextValue {
  const ctx = React.useContext(EditorContext)
  if (!ctx) throw new Error("editor components must be rendered inside <EditorContext.Provider>")
  return ctx
}

/** Subscribe to a slice of the page's editor store. */
export function useEditorState<T>(selector: (s: EditorState) => T): T {
  return useStore(useEditorContext().store, selector)
}

/** Subscribe to several fields at once (shallow-compared object/array selectors). */
export function useEditorShallow<T extends object>(selector: (s: EditorState) => T): T {
  return useStore(useEditorContext().store, useShallow(selector))
}

export function useToolExtras<T>(selector: (s: ToolExtras & { set(partial: Partial<ToolExtras>): void }) => T): T {
  return useStore(useEditorContext().extras, selector)
}

// ---------------------------------------------------------------------------
// Engine (published by the viewport so panels can focus the camera, read stats, …)
// ---------------------------------------------------------------------------

export interface EngineHandle {
  engine: Engine | null
}

export const EditorEngineContext = React.createContext<EngineHandle>({ engine: null })

export function useEditorEngine(): Engine | null {
  return React.useContext(EditorEngineContext).engine
}

// ---------------------------------------------------------------------------
// Confirm dialogs
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

export const ConfirmContext = React.createContext<ConfirmFn>(async () => true)

/** `await confirm({ title, description, destructive })` → true when the user confirmed. */
export function useConfirm(): ConfirmFn {
  return React.useContext(ConfirmContext)
}

// ---------------------------------------------------------------------------
// Page-level commands (menus, panels and shortcuts all call the same functions)
// ---------------------------------------------------------------------------

/**
 * Free asset categories whose assets the editor panels offer (e.g. token models in the inspector):
 * a live session's GameState.freeAssets; null (the editor) = every category.
 */
export const FreeAssetScopeContext = React.createContext<readonly FreeAssetCategory[] | null>(null)

export interface EditorActions {
  save(): void
  newScene(): void
  newFromImages(): void
  /** Open the map image import dialog (optionally targeting a level). */
  openMapImport(levelId?: string): void
  openVersions(): void
  exportFile(): void
  /** Pick an .atlas.json file and import it as a new library scene. */
  importFile(): void
  openShare(): void
  goHome(): void
  openShortcuts(): void
  frameScene(): void
  focusSelection(): void
  addLevel(): void
  duplicateLevel(levelId?: string): void
  deleteLevel(levelId: string): void
  deleteSelection(): void
}

export const EditorActionsContext = React.createContext<EditorActions | null>(null)

/**
 * The world's characters at a table (ARCHITECTURE §6.9), for linking tokens to them (the token inspector,
 * the DM's token menu). Absent outside a table that knows its world's roster.
 */
export interface CharacterLinks {
  /** The world's characters, by name. */
  characters: Array<{ id: string; name: string; players: string[] }>
  /** A player's name at the table. */
  playerName(userId: string): string
  /** Link a token to a character, or unlink it (null): an edit of the scene. */
  link(tokenId: string, characterId: string | null): void
  /** A new world character made from the token (its name, colour, portrait and players), linked to it. */
  makeCharacter(tokenId: string): Promise<void>
  /** Open the world's roster (who plays whom). */
  openRoster(): void
}

export const CharacterLinksContext = React.createContext<CharacterLinks | null>(null)

export function useCharacterLinks(): CharacterLinks | null {
  return React.useContext(CharacterLinksContext)
}

export function useEditorActions(): EditorActions {
  const ctx = React.useContext(EditorActionsContext)
  if (!ctx) throw new Error("useEditorActions() outside the editor page")
  return ctx
}
