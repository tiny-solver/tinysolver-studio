import { Bot, FileText, Folder, GitCommit, Hash, Sparkles } from "lucide-react"
import type { ReactNode } from "react"

import { AgentIcon } from "@/components/agent-icon"
import {
  STATUS_COLORS,
  type AgentType,
  type ConversationStatus,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import type { ReferenceAttrs } from "../types"

const ICON_CLASS = "size-3.5 shrink-0"

export function ReferenceIcon({ data }: { data: ReferenceAttrs }) {
  const meta = data.meta
  let icon: ReactNode = null
  switch (data.refType) {
    case "file":
      icon =
        meta?.fileKind === "dir" ? (
          <Folder className={ICON_CLASS} />
        ) : (
          <FileText className={ICON_CLASS} />
        )
      break
    case "agent": {
      const agentType = meta?.agentType ?? (data.id as AgentType)
      icon = agentType ? (
        <AgentIcon agentType={agentType} className={ICON_CLASS} />
      ) : (
        <Bot className={ICON_CLASS} />
      )
      break
    }
    case "session":
      icon = meta?.agentType ? (
        <AgentIcon agentType={meta.agentType} className={ICON_CLASS} />
      ) : (
        <Hash className={ICON_CLASS} />
      )
      break
    case "commit":
      icon = <GitCommit className={ICON_CLASS} />
      break
    case "skill":
      icon = <Sparkles className={ICON_CLASS} />
      break
    default:
      return null
  }
  // Decorative wherever it appears (popup option, badge): the accessible name
  // comes from the adjacent label (or the badge's own role="img" name), so hide
  // it — otherwise AgentIcon's titled <svg> leaks into the option name (e.g.
  // "Codex Codex Helper").
  return (
    <span aria-hidden="true" className="inline-flex shrink-0">
      {icon}
    </span>
  )
}

export interface ReferenceBadgeProps {
  data: ReferenceAttrs
  className?: string
}

/**
 * Presentational inline chip for a reference. Shared by the editor node view and
 * (later) message-transcript rendering. Purely visual — no editor coupling.
 */
export function ReferenceBadge({ data, className }: ReferenceBadgeProps) {
  const statusColor =
    data.refType === "session" && data.meta?.status
      ? STATUS_COLORS[data.meta.status as ConversationStatus]
      : undefined

  return (
    <span
      data-reference-badge=""
      data-ref-type={data.refType}
      title={data.uri ?? data.label}
      // The badge is an inline contentEditable=false atom. `role="img"` makes it
      // a single named unit so `aria-label` is a reliable accessible name (a
      // bare span's aria-label is not), and collapses the decorative icon —
      // including AgentIcon's titled <svg> — into that one name.
      role="img"
      aria-label={`${data.refType}: ${data.label || data.id}`}
      className={cn(
        "inline-flex max-w-[18rem] items-center gap-1 rounded-md border border-border/60 bg-muted/60 px-1.5 py-px align-baseline text-[0.85em] leading-snug text-foreground",
        className
      )}
    >
      <ReferenceIcon data={data} />
      <span className="truncate">{data.label || data.id}</span>
      {statusColor && (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", statusColor)}
        />
      )}
    </span>
  )
}
