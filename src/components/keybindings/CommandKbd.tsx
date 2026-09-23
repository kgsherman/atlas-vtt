import { Kbd } from "@/components/ui/kbd"

import { useCommandLabel, type KeymapScope } from "./keymapStore"

/** A command's current key as a key cap (follows the user's remaps; nothing when unbound). */
export function CommandKbd({ scope, command, className }: { scope: KeymapScope; command: string; className?: string }) {
  const label = useCommandLabel(scope, command)
  return label ? <Kbd className={className}>{label}</Kbd> : null
}
