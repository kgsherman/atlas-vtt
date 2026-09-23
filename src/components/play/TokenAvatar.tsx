import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import type { Token } from "@/core/scene/types"
import { cn } from "@/lib/utils"
import { tokenInitials } from "@/play"

/**
 * A token's portrait (its image, else initials) ringed in the token's own colour. The colour is scene
 * data chosen by the DM (not a UI colour), so it is applied as an inline style.
 */
export function TokenAvatar({
  token,
  size = "default",
  className,
  dimmed,
}: {
  token: Pick<Token, "name" | "label" | "color" | "imageUrl">
  size?: "sm" | "default" | "lg"
  className?: string
  dimmed?: boolean
}) {
  return (
    <Avatar
      size={size}
      className={cn(
        "ring-2 ring-offset-1 ring-offset-card",
        dimmed && "opacity-50",
        className
      )}
      style={{ ["--tw-ring-color" as string]: token.color }}
    >
      {token.imageUrl ? <AvatarImage src={token.imageUrl} alt="" /> : null}
      <AvatarFallback
        className="bg-muted font-medium text-foreground"
        style={{
          backgroundImage: `linear-gradient(135deg, ${token.color}55, transparent)`,
        }}
      >
        {tokenInitials(token)}
      </AvatarFallback>
    </Avatar>
  )
}
