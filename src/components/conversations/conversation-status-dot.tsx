"use client"

import type { ConversationStatus } from "@/lib/types"
import { STATUS_COLORS } from "@/lib/types"
import { cn } from "@/lib/utils"

type ConversationStatusDotSize = "xs" | "sm" | "md"

interface ConversationStatusDotProps {
  status?: ConversationStatus | null
  size?: ConversationStatusDotSize
  className?: string
  title?: string
}

const SIZE_CLASS: Record<ConversationStatusDotSize, string> = {
  xs: "h-1 w-1",
  sm: "h-1.5 w-1.5",
  md: "h-2 w-2",
}

const FALLBACK_COLOR = "bg-gray-400 dark:bg-gray-500"

export function ConversationStatusDot({
  status,
  size = "md",
  className,
  title,
}: ConversationStatusDotProps) {
  const colorClass = (status && STATUS_COLORS[status]) || FALLBACK_COLOR
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded-full",
        SIZE_CLASS[size],
        colorClass,
        className
      )}
      title={title}
      aria-hidden={title ? undefined : true}
    />
  )
}
