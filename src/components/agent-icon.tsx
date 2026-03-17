import type { AgentType } from "@/lib/types"
import { AGENT_COLORS } from "@/lib/types"
import { cn } from "@/lib/utils"

import ClaudeColor from "@lobehub/icons/es/Claude/components/Color"
import GeminiColor from "@lobehub/icons/es/Gemini/components/Color"
import OpenClawColor from "@lobehub/icons/es/OpenClaw/components/Color"
import { OpenAI, OpenCode } from "@lobehub/icons"

interface AgentIconProps {
  agentType: AgentType
  className?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyIcon = React.ComponentType<any>

const COLOR_ICONS: Partial<Record<AgentType, AnyIcon>> = {
  claude_code: ClaudeColor,
  gemini: GeminiColor,
  open_claw: OpenClawColor,
}

const MONO_ICONS: Partial<Record<AgentType, AnyIcon>> = {
  codex: OpenAI,
  open_code: OpenCode,
}

// Text-color versions for Mono icons
const AGENT_TEXT_COLORS: Partial<Record<AgentType, string>> = {
  open_code: "text-blue-500",
}

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
