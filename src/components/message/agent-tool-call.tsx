import { memo, useMemo, useState, type ReactNode } from "react"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type { AgentToolCall } from "@/lib/types"
import { tryParseJson, extractJsonField } from "./content-parts-renderer"
import { MessageResponse } from "@/components/ai-elements/message"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { getStatusBadge } from "@/components/ai-elements/tool"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CompassIcon,
  MapIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

// ── helpers ────────────────────────────────────────────────────────────

const ICON_CLASS = "size-4 text-muted-foreground"

function getAgentIcon(subagentType: string | null) {
  const t = subagentType?.toLowerCase() ?? ""
  if (t.includes("explore")) return <CompassIcon className={ICON_CLASS} />
  if (t.includes("plan")) return <MapIcon className={ICON_CLASS} />
  if (t.includes("bash")) return <TerminalIcon className={ICON_CLASS} />
  return <WrenchIcon className={ICON_CLASS} />
}

function getAccentColor(subagentType: string | null): string {
  const t = subagentType?.toLowerCase() ?? ""
  if (t.includes("explore"))
    return "border-l-blue-500/50 dark:border-l-blue-400/40"
  if (t.includes("plan"))
    return "border-l-amber-500/50 dark:border-l-amber-400/40"
  if (t.includes("bash"))
    return "border-l-green-500/50 dark:border-l-green-400/40"
  return "border-l-purple-500/50 dark:border-l-purple-400/40"
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  return `${(sec / 60).toFixed(1)}m`
}

/** Convert AgentToolCall[] to AdaptedContentPart[] for reuse with ToolCallPart */
function adaptToolCalls(
  calls: AgentToolCall[],
  parentId: string
): AdaptedContentPart[] {
  return calls.map(
    (call, i): Extract<AdaptedContentPart, { type: "tool-call" }> => ({
      type: "tool-call",
      toolCallId: `${parentId}-sub-${i}`,
      toolName: call.tool_name,
      input: call.input_preview ?? null,
      state: call.is_error ? "output-error" : "output-available",
      output: call.output_preview ?? null,
      errorText: call.is_error ? (call.output_preview ?? undefined) : undefined,
    })
  )
}

// ── main component ────────────────────────────────────────────────────

export const AgentToolCallPart = memo(function AgentToolCallPart({
  part,
  renderToolCall,
}: {
  part: Extract<AdaptedContentPart, { type: "tool-call" }>
  /** Render a single tool-call part — injected by the parent to avoid
   *  circular imports (content-parts-renderer → agent-tool-call → renderer). */
  renderToolCall: (
    part: Extract<AdaptedContentPart, { type: "tool-call" }>,
    key: string
  ) => ReactNode
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const tTool = useTranslations("Folder.chat.tool")

  const isRunning =
    part.state === "input-available" || part.state === "input-streaming"
  const isError = part.state === "output-error"

  const [bodyOpen, setBodyOpen] = useState(isRunning || isError)
  const [promptOpen, setPromptOpen] = useState(false)

  const parsed = useMemo(
    () => (part.input ? tryParseJson(part.input) : null),
    [part.input]
  )

  const subagentType = useMemo(
    () =>
      (parsed?.subagent_type as string | undefined) ??
      (part.input ? extractJsonField(part.input, "subagent_type") : null),
    [parsed, part.input]
  )

  const description = useMemo(
    () =>
      (parsed?.description as string | undefined) ??
      (part.input ? extractJsonField(part.input, "description") : null),
    [parsed, part.input]
  )

  const prompt = useMemo(
    () =>
      (parsed?.prompt as string | undefined) ??
      (part.input ? extractJsonField(part.input, "prompt") : null),
    [parsed, part.input]
  )

  const model = useMemo(
    () =>
      (parsed?.model as string | undefined) ??
      (part.input ? extractJsonField(part.input, "model") : null),
    [parsed, part.input]
  )

  const icon = useMemo(() => getAgentIcon(subagentType), [subagentType])
  const accentColor = useMemo(
    () => getAccentColor(subagentType),
    [subagentType]
  )

  const title = useMemo(() => {
    const prefix = subagentType ?? "Agent"
    return description ? `${prefix}: ${description}` : prefix
  }, [subagentType, description])

  const statusLabel =
    part.state === "input-available"
      ? tTool("status.inputAvailable")
      : part.state === "input-streaming"
        ? tTool("status.inputStreaming")
        : part.state === "output-available"
          ? tTool("status.outputAvailable")
          : tTool("status.outputError")

  const agentStats = part.agentStats ?? null
  const adaptedToolCalls = useMemo(
    () => adaptToolCalls(agentStats?.tool_calls ?? [], part.toolCallId),
    [agentStats?.tool_calls, part.toolCallId]
  )

  const durationSuffix = useMemo(() => {
    if (!agentStats?.total_duration_ms) return null
    return formatDuration(agentStats.total_duration_ms)
  }, [agentStats])

  return (
    <Collapsible open={bodyOpen} onOpenChange={setBodyOpen}>
      <div
        className={cn(
          "rounded-md border border-border/60 bg-muted/20 overflow-hidden",
          "border-l-[3px]",
          accentColor
        )}
      >
        {/* Header — clickable to toggle body */}
        <CollapsibleTrigger className="flex w-full min-w-0 items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0">{icon}</span>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-sm font-medium text-left">
              {title}
            </span>
            {!bodyOpen && durationSuffix && (
              <span className="shrink-0 text-xs text-muted-foreground/60">
                {durationSuffix}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {getStatusBadge(part.state, statusLabel)}
            <ChevronDownIcon
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                !bodyOpen && "-rotate-90"
              )}
            />
          </div>
        </CollapsibleTrigger>

        {/* Collapsible body */}
        <CollapsibleContent>
          <div className="space-y-3 px-4 pb-4">
            {/* Model + duration summary */}
            {(model || durationSuffix) && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {model && (
                  <span>
                    {t("agentModelLabel")}:{" "}
                    <span className="font-mono">{model}</span>
                  </span>
                )}
                {durationSuffix && <span>{durationSuffix}</span>}
              </div>
            )}

            {/* Collapsible prompt */}
            {prompt && (
              <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
                <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
                  <ChevronRightIcon
                    className={cn(
                      "size-3.5 transition-transform",
                      promptOpen && "rotate-90"
                    )}
                  />
                  {t("agentPromptLabel")}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                    {prompt}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}

            {/* Subagent tool calls — rendered with the same ToolCallPart
                as the outer conversation for consistent appearance */}
            {adaptedToolCalls.length > 0 && (
              <div className="space-y-2">
                {adaptedToolCalls.map((tc, i) =>
                  renderToolCall(
                    tc as Extract<AdaptedContentPart, { type: "tool-call" }>,
                    `subagent-tc-${i}`
                  )
                )}
              </div>
            )}

            {/* Running indicator */}
            {isRunning && !part.output && (
              <Shimmer className="text-sm" duration={2}>
                Running...
              </Shimmer>
            )}

            {/* Error output */}
            {isError && part.errorText && (
              <div className="rounded-md bg-destructive/10 p-3">
                <pre className="whitespace-pre-wrap break-words text-xs text-destructive">
                  {part.errorText}
                </pre>
              </div>
            )}

            {/* Final output */}
            {part.output && !isError && (
              <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
                <MessageResponse>{part.output}</MessageResponse>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
})
