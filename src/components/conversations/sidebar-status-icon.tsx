"use client"

import { cn } from "@/lib/utils"

export type SidebarBeadStatus = "done" | "active" | "running" | "failed"

interface SidebarStatusIconProps {
  status: SidebarBeadStatus
  className?: string
}

export function SidebarStatusIcon({
  status,
  className,
}: SidebarStatusIconProps) {
  if (status === "running") {
    return (
      <div
        className={cn(
          "pointer-events-none absolute top-1/2",
          "flex items-center justify-center",
          "text-amber-600 dark:text-amber-400",
          className
        )}
        style={{
          left: "0.625rem",
          width: "0.75rem",
          height: "0.75rem",
          transform: "translateY(-50%)",
        }}
        aria-hidden
      >
        <svg
          width="0.75rem"
          height="0.75rem"
          viewBox="0 0 12 12"
          className="absolute inset-0"
        >
          <circle
            cx="6"
            cy="6"
            r="5.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.18"
          />
        </svg>
        <svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10">
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
      </div>
    )
  }

  if (status === "failed") {
    return (
      <div
        className={cn(
          "pointer-events-none absolute top-1/2",
          "flex items-center justify-center",
          "text-destructive",
          className
        )}
        style={{
          left: "0.6875rem",
          width: "0.625rem",
          height: "0.625rem",
          transform: "translateY(-50%)",
        }}
        aria-hidden
      >
        <svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10">
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
      </div>
    )
  }

  if (status === "active") {
    return (
      <div
        className={cn(
          "pointer-events-none absolute top-1/2",
          "flex items-center justify-center",
          "text-sidebar-primary",
          className
        )}
        style={{
          left: "0.6875rem",
          width: "0.625rem",
          height: "0.625rem",
          transform: "translateY(-50%)",
        }}
        aria-hidden
      >
        <svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10">
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
      </div>
    )
  }

  return (
    <div
      className={cn(
        "pointer-events-none absolute top-1/2 rounded-full bg-sidebar-primary/40",
        className
      )}
      style={{
        left: "0.8125rem",
        width: "0.375rem",
        height: "0.375rem",
        transform: "translateY(-50%)",
      }}
      aria-hidden
    />
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
