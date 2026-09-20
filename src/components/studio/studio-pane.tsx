"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Gamepad2, Layers } from "lucide-react"

import { useContentProject } from "@/hooks/use-content-project"
import { splitEntry } from "@/lib/studio/game-url"
import { cn } from "@/lib/utils"
import { GamePreview } from "./game-preview"
import { StudioWorkspace } from "./studio-workspace"

type View = "game" | "scene"

/**
 * The Content Studio pane beside the chat: the running game first, the scene
 * editor behind a toggle. "Game" is what the agent is actually building in
 * `outputs/game/`, so it is the default whenever the project's manifest
 * names an engine entry; projects without one open straight on the editor.
 */
export function StudioPane({ projectRoot }: { projectRoot: string }) {
  const t = useTranslations("Studio")
  const manifest = useContentProject(projectRoot)
  const entry = manifest?.engine?.entry ?? null
  // `null` = follow the manifest (game when it names an entry); a click pins
  // the choice so a manifest re-read on window focus cannot flip it back.
  const [choice, setChoice] = useState<View | null>(null)
  const view: View = choice ?? (entry ? "game" : "scene")
  const pick = (next: View) => setChoice(next)

  const tabBtn =
    "flex h-6 items-center gap-1.5 rounded px-2 text-xs transition-colors"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/50 px-2 py-1">
        <button
          type="button"
          onClick={() => pick("game")}
          disabled={!entry}
          title={entry ? undefined : t("noGameEntry")}
          className={cn(
            tabBtn,
            view === "game"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-primary/8",
            !entry && "opacity-50"
          )}
        >
          <Gamepad2 className="h-3.5 w-3.5" />
          {t("gameView")}
        </button>
        <button
          type="button"
          onClick={() => pick("scene")}
          className={cn(
            tabBtn,
            view === "scene"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-primary/8"
          )}
        >
          <Layers className="h-3.5 w-3.5" />
          {t("sceneView")}
        </button>
        <span className="min-w-0 flex-1 truncate pl-2 text-xs text-muted-foreground">
          {manifest?.name ?? ""}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {view === "game" && entry ? (
          <GamePreview
            root={projectRoot}
            dir={splitEntry(entry).dir}
            entryFile={splitEntry(entry).file}
            projectName={manifest?.name ?? null}
          />
        ) : (
          <StudioWorkspace projectRoot={projectRoot} embedded />
        )}
      </div>
    </div>
  )
}
