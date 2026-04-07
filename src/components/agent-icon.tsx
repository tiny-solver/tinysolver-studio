import type { AgentType } from "@/lib/types"
import { AGENT_COLORS } from "@/lib/types"
import { cn } from "@/lib/utils"

import {
  ClaudeCode,
  Cline,
  Codex,
  GeminiCLI,
  OpenClaw,
  OpenCode,
} from "@lobehub/icons"

interface AgentIconProps {
  agentType: AgentType
  className?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyIcon = React.ComponentType<any>

const COLOR_ICONS: Partial<Record<AgentType, AnyIcon>> = {
  claude_code: ClaudeCode.Color,
  codex: Codex.Color,
  gemini: GeminiCLI.Color,
  open_claw: OpenClaw.Color,
}

const MONO_ICONS: Partial<Record<AgentType, AnyIcon>> = {
  open_code: OpenCode,
  cline: Cline,
}

// Text-color versions for Mono icons
const AGENT_TEXT_COLORS: Partial<Record<AgentType, string>> = {}

export function AgentIcon({ agentType, className }: AgentIconProps) {
  const ColorIcon = COLOR_ICONS[agentType]
  if (ColorIcon) {
    return (
      <span className={cn("inline-flex shrink-0", className)}>
        <ColorIcon size="100%" />
      </span>
    )
  }

  const MonoIcon = MONO_ICONS[agentType]
  if (MonoIcon) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0",
          AGENT_TEXT_COLORS[agentType],
          className
        )}
      >
        <MonoIcon size="100%" />
      </span>
    )
  }

  return (
    <span
      className={cn(
        "rounded-full shrink-0",
        AGENT_COLORS[agentType],
        className
      )}
    />
  )
}
