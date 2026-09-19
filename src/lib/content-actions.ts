import {
  BookOpenText,
  Clapperboard,
  FolderOpen,
  Gamepad2,
  Globe2,
  Images,
  LayoutList,
  Layers,
  ScrollText,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react"

import type { ContentOutputKind } from "@/lib/types"

/**
 * A creative (content project) shortcut on the welcome page. Unlike office
 * and research actions these are not gated by a skill install: each one is a
 * plain prompt that assumes the project layout `create_content_project`
 * scaffolds (bible / assets / outputs), so any agent can act on it.
 */
export interface ContentAction {
  /** Stable id; also the i18n label key (`<id>`) and description (`<id>Desc`)
   *  under `Folder.chat.welcomePanel.quickActions.creative`. */
  id: string
  icon: LucideIcon
  /**
   * What clicking does. `prompt` injects the localized template at
   * `creative.prompts.<id>`; the two `open-*` kinds open the launcher or the
   * folder dialog instead, because there is no prompt to write until a
   * project exists; `open-studio` navigates to the scene editor on the
   * active folder.
   */
  kind: "prompt" | "open-launcher" | "open-folder" | "open-studio"
  /** When set, the action only makes sense for a project targeting this
   *  output; shown regardless, but the welcome tab can hint otherwise. */
  output?: ContentOutputKind
}

/**
 * Every creative action in display order. The welcome page promotes the
 * first three to colored cards and scrolls the rest.
 */
export const CONTENT_ACTIONS: ContentAction[] = [
  { id: "newProject", icon: Sparkles, kind: "open-launcher" },
  { id: "world", icon: Globe2, kind: "prompt" },
  { id: "storyboard", icon: Clapperboard, kind: "prompt", output: "video" },
  { id: "openStudio", icon: Layers, kind: "open-studio", output: "game" },
  { id: "openProject", icon: FolderOpen, kind: "open-folder" },
  { id: "characters", icon: Users, kind: "prompt" },
  { id: "story", icon: BookOpenText, kind: "prompt" },
  { id: "instatoon", icon: Images, kind: "prompt", output: "instatoon" },
  { id: "webtoon", icon: LayoutList, kind: "prompt", output: "webtoon" },
  { id: "novel", icon: ScrollText, kind: "prompt", output: "novel" },
  { id: "gameScene", icon: Gamepad2, kind: "prompt", output: "game" },
]

/** Accent per promoted card; ids not listed here render in the rail. */
export const CONTENT_FEATURED_ACCENTS: Record<string, string> = {
  newProject: "amber",
  world: "violet",
  storyboard: "pink",
}
