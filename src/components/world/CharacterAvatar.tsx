import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { initialsOf } from "@/lib/initials"
import type { WorldCharacter } from "@/net/worldsRepo"
import { cn } from "@/lib/utils"

/**
 * A character's portrait (its image, else initials) ringed in its colour. The colour is the DM's data
 * (like a token's), so it is an inline style rather than a theme token.
 */
export function CharacterAvatar({
  character,
  size = "default",
  className,
}: {
  character: Pick<WorldCharacter, "name" | "color" | "imageUrl">
  size?: "sm" | "default" | "lg"
  className?: string
}) {
  return (
    <Avatar size={size} className={cn("ring-2 ring-offset-1 ring-offset-card", className)} style={{ ["--tw-ring-color" as string]: character.color }}>
      {character.imageUrl ? <AvatarImage src={character.imageUrl} alt="" /> : null}
      <AvatarFallback
        className="bg-muted font-medium text-foreground"
        style={{ backgroundImage: `linear-gradient(135deg, ${character.color}55, transparent)` }}
      >
        {initialsOf(character.name)}
      </AvatarFallback>
    </Avatar>
  )
}
