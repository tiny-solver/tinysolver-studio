"use client"

import { cn } from "@/lib/utils"

export type SidebarBeadStatus = "done" | "active" | "running" | "failed"

interface SidebarStatusIconProps {
  status: SidebarBeadStatus
  emphasized?: boolean
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
        "pointer-events-none absolute top-1/2 z-10",
        "flex items-center justify-center rounded-full bg-sidebar",
        colorClass,
        className
      )}
      style={{
        left: "0.875rem",
        width: "0.75rem",
        height: "0.75rem",
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
  emphasized = false,
  className,
}: SidebarStatusIconProps) {
  if (status === "running") {
    return (
      <IconFrame
        colorClass={
          emphasized ? "text-sidebar-primary" : "text-sidebar-primary/65"
        }
        className={className}
      >
        <svg
          width="0.75rem"
          height="0.75rem"
          viewBox="0 0 10 10"
          preserveAspectRatio="xMidYMid meet"
        >
          <circle
            cx="5"
            cy="5"
            r="3.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
            opacity="0.28"
          />
          <path
            d="M5 1.2 A 3.8 3.8 0 1 1 1.2 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
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
      <IconFrame
        colorClass={
          emphasized ? "text-sidebar-primary" : "text-sidebar-primary/65"
        }
        className={className}
      >
        <svg
          width="0.75rem"
          height="0.75rem"
          viewBox="0 0 10 10"
          preserveAspectRatio="xMidYMid meet"
        >
          <circle
            cx="5"
            cy="5"
            r="3.9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
          />
          <path
            d="M3.4 3.4L6.6 6.6M6.6 3.4L3.4 6.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      </IconFrame>
    )
  }

  if (status === "active") {
    return (
      <IconFrame
        colorClass={
          emphasized ? "text-sidebar-primary" : "text-sidebar-primary/65"
        }
        className={className}
      >
        <svg
          width="0.75rem"
          height="0.75rem"
          viewBox="0 0 10 10"
          preserveAspectRatio="xMidYMid meet"
        >
          <circle
            cx="5"
            cy="5"
            r="3.9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
            opacity="0.35"
          />
          <circle cx="5" cy="5" r="2" fill="currentColor" />
        </svg>
      </IconFrame>
    )
  }

  return (
    <IconFrame
      colorClass={
        emphasized ? "text-sidebar-primary/75" : "text-sidebar-primary/40"
      }
      className={className}
    >
      <svg
        width="0.75rem"
        height="0.75rem"
        viewBox="0 0 10 10"
        preserveAspectRatio="xMidYMid meet"
      >
        <circle
          cx="5"
          cy="5"
          r="3.9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
        />
        <path
          d="M3.2 5.1 L4.4 6.3 L6.9 3.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
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
