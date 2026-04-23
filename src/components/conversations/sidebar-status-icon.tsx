"use client"

import type { ConversationStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import { ConversationStatusIcon } from "./conversation-status-icon"

interface SidebarStatusIconProps {
  status: ConversationStatus
  emphasized?: boolean
  className?: string
}

export function SidebarStatusIcon({
  status,
  emphasized = false,
  className,
}: SidebarStatusIconProps) {
  const colorClass =
    status === "completed"
      ? emphasized
        ? "text-sidebar-primary/75"
        : "text-sidebar-primary/40"
      : emphasized
        ? "text-sidebar-primary"
        : "text-sidebar-primary/65"

  return (
    <div
      className={cn(
        "pointer-events-none absolute top-1/2 z-10",
        "flex items-center justify-center rounded-full bg-sidebar",
        colorClass,
        className
      )}
      style={{
        left: "var(--conv-rail-axis, 0.875rem)",
        width: "0.75rem",
        height: "0.75rem",
        transform: "translate(-50%, -50%)",
      }}
      aria-hidden
    >
      <ConversationStatusIcon
        status={status}
        className="h-[0.75rem] w-[0.75rem]"
      />
    </div>
  )
}
