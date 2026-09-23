import * as React from "react"
import { KeyRoundIcon } from "lucide-react"

import { parseRoomCodeInput, ROOM_CODE_LENGTH } from "@/app/roomCodeInput"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

export interface RoomCodeInputProps {
  /** Normalised code (0–8 Crockford characters). */
  value: string
  onChange(code: string, info: { rejected: string[] }): void
  size?: "default" | "lg"
  invalid?: boolean
  id?: string
  autoFocus?: boolean
  inputRef?: React.Ref<HTMLInputElement>
  className?: string
  onEnter?(): void
}

/**
 * Room-code entry that formats as you type ("ABCD-1234"), accepts pasted invite links, and maps
 * look-alikes (O → 0, I/L → 1).
 */
export function RoomCodeInput({ value, onChange, size = "default", invalid, id, autoFocus, inputRef, className, onEnter }: RoomCodeInputProps) {
  const display = parseRoomCodeInput(value).display
  const complete = value.length === ROOM_CODE_LENGTH
  return (
    <InputGroup className={cn(size === "lg" && "h-11", className)}>
      <InputGroupAddon>
        <KeyRoundIcon className={cn(size === "lg" && "size-4", complete ? "text-primary dark:text-sidebar-primary" : "text-muted-foreground")} />
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        ref={inputRef}
        autoFocus={autoFocus}
        value={display}
        placeholder="ABCD-1234"
        inputMode="text"
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-label="Room code"
        maxLength={64}
        className={cn(
          "font-mono tracking-[0.18em] uppercase placeholder:tracking-[0.18em] placeholder:text-muted-foreground/50",
          size === "lg" && "text-lg md:text-lg"
        )}
        onChange={(e) => {
          const raw = e.target.value
          const parsed = parseRoomCodeInput(raw)
          // Backspace over the auto-inserted dash deletes the character before it.
          if (parsed.code === value && raw.length < display.length && value.length > 4) {
            onChange(value.slice(0, 3) + value.slice(4), { rejected: [] })
            return
          }
          onChange(parsed.code, { rejected: parsed.rejected })
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) {
            e.preventDefault()
            onEnter()
          }
        }}
      />
      <InputGroupAddon align="inline-end">
        <span className={cn("font-mono text-[0.65rem] tabular-nums", complete ? "text-primary dark:text-sidebar-primary" : "text-muted-foreground")}>
          {value.length}/{ROOM_CODE_LENGTH}
        </span>
      </InputGroupAddon>
    </InputGroup>
  )
}
