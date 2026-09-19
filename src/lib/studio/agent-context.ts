/**
 * What the Studio hands to the chat composer so the agent starts from what
 * the user is looking at: which scene, which node, whether the engine takes
 * live updates, and the runtime errors the preview just reported.
 *
 * Plain text, English, addressed to the agent. The user's own request goes
 * after it in the composer; nothing is sent until they press send.
 */
import type { SceneFile, SceneNode } from "./document"

export const MAX_ENGINE_ERRORS = 5
const MAX_PROPS_CHARS = 600

export interface AgentContextInput {
  projectName?: string | null
  /** Project-relative path of the open scene file. */
  scenePath?: string | null
  scene?: SceneFile | null
  selected?: SceneNode | null
  /** Engine accepted `codeg:scene` (edits render without a reload). */
  hot?: boolean
  /** Project-relative game directory, for the game view (no scene open). */
  gameDir?: string | null
  engineErrors?: string[]
}

/** Keep the last few distinct messages; a repeating error stays one entry. */
export function pushEngineError(list: string[], message: string): string[] {
  const text = message.trim()
  if (!text || list[list.length - 1] === text) return list
  return [...list.filter((m) => m !== text), text].slice(-MAX_ENGINE_ERRORS)
}

function describeNode(node: SceneNode): string {
  const t = node.transform
  let props = JSON.stringify(node.props)
  if (props.length > MAX_PROPS_CHARS)
    props = `${props.slice(0, MAX_PROPS_CHARS)}…`
  return (
    `Selected node \`${node.id}\` (${node.type}): x=${t.x} y=${t.y} ` +
    `w=${t.w} h=${t.h} anchor=${t.anchor} z=${t.z} parent=${node.parent}; ` +
    `props: ${props}`
  )
}

export function buildAgentContext(input: AgentContextInput): string {
  const lines: string[] = []
  const project = input.projectName ? ` · project ${input.projectName}` : ""
  if (input.scene && input.scenePath) {
    const { width, height } = input.scene.document.container
    lines.push(
      `[Codeg Studio${project}] Scene \`${input.scene.id}\` — ` +
        `${input.scenePath} (${width}×${height}, ` +
        `${input.scene.document.nodes.length} nodes). Preview: ` +
        (input.hot ? "live (edits render instantly)" : "reloads after save") +
        "."
    )
    lines.push(
      input.selected ? describeNode(input.selected) : "No node is selected."
    )
    lines.push(
      "For placement, visibility, text or color use the studio_apply_scene_commands tool " +
        "(studio_read_scene first); edit files directly for logic.actions and engine code."
    )
  } else {
    lines.push(
      `[Codeg Studio${project}] Game preview of ` +
        `${input.gameDir ?? "outputs/game"}/ (reloads when its files change).`
    )
  }
  const errors = input.engineErrors ?? []
  if (errors.length > 0) {
    lines.push("Runtime errors reported by the preview (oldest first):")
    for (const message of errors)
      lines.push(`- ${message.replace(/\s*\n\s*/g, " ⏎ ")}`)
  }
  return `${lines.join("\n")}\n\n`
}
