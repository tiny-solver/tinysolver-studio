"use client"

import { cn } from "@/lib/utils"

export type SidebarBeadStatus = "done" | "active" | "running" | "failed"

interface SidebarStatusIconProps {
  status: SidebarBeadStatus
  className?: string
}

function IconFrame({
  children,
  colorClass,
  className,
}: {
  children: React.ReactNode
  colorClass: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute top-1/2",
        "flex items-center justify-center",
        colorClass,
        className
      )}
      style={{
        left: "0.875rem",
        width: "0.625rem",
        height: "0.625rem",
        transform: "translate(-50%, -50%)",
      }}
      aria-hidden
    >
      {children}
    </div>
  )
}

export function SidebarStatusIcon({
  status,
  className,
}: SidebarStatusIconProps) {
  if (status === "running") {
    return (
      <IconFrame
        colorClass="text-amber-600 dark:text-amber-400"
        className={className}
      >
        <svg
          width="0.625rem"
          height="0.625rem"
          viewBox="0 0 10 10"
          preserveAspectRatio="xMidYMid meet"
        >
          <circle
            cx="5"
            cy="5"
            r="3.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            opacity="0.28"
          />
          <path
            d="M5 1.4 A 3.6 3.6 0 1 1 1.4 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          >
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 5 5"
              to="360 5 5"
              dur="1.1s"
              repeatCount="indefinite"
            />
          </path>
        </svg>
      </IconFrame>
    )
  }

  if (status === "failed") {
    return (
      <IconFrame colorClass="text-destructive" className={className}>
        <svg
          width="0.625rem"
          height="0.625rem"
          viewBox="0 0 10 10"
          preserveAspectRatio="xMidYMid meet"
        >
          <circle
            cx="5"
            cy="5"
            r="3.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M3.5 3.5L6.5 6.5M6.5 3.5L3.5 6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </IconFrame>
    )
  }

  if (status === "active") {
    return (
      <IconFrame colorClass="text-sidebar-primary" className={className}>
        <svg
          width="0.625rem"
          height="0.625rem"
          viewBox="0 0 10 10"
          preserveAspectRatio="xMidYMid meet"
        >
          <circle
            cx="5"
            cy="5"
            r="3.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            opacity="0.35"
          />
          <circle cx="5" cy="5" r="2" fill="currentColor" />
        </svg>
      </IconFrame>
    )
  }

  return (
    <IconFrame colorClass="text-sidebar-primary/40" className={className}>
      <svg
        width="0.625rem"
        height="0.625rem"
        viewBox="0 0 10 10"
        preserveAspectRatio="xMidYMid meet"
      >
        <circle cx="5" cy="5" r="3" fill="currentColor" />
      </svg>
    </IconFrame>
  )
}

export function conversationStatusToBead(status: string): SidebarBeadStatus {
  switch (status) {
    case "in_progress":
      return "running"
    case "pending_review":
      return "active"
    case "cancelled":
      return "failed"
    case "completed":
    default:
      return "done"
  }
}
