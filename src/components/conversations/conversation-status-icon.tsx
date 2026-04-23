"use client"

import type { ConversationStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

interface ConversationStatusIconProps {
  status: ConversationStatus
  className?: string
}

export function ConversationStatusIcon({
  status,
  className,
}: ConversationStatusIconProps) {
  return (
    <svg
      className={cn("shrink-0", className)}
      width="1em"
      height="1em"
      viewBox="0 0 10 10"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      {status === "in_progress" ? (
        <>
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
        </>
      ) : status === "pending_review" ? (
        <>
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
        </>
      ) : status === "cancelled" ? (
        <>
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
        </>
      ) : (
        <>
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
        </>
      )}
    </svg>
  )
}
