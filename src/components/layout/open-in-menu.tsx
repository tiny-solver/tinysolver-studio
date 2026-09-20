"use client"

import { FolderClosed, Globe, Layers, SquareTerminal } from "lucide-react"

import { VSCodeIcon } from "@/components/vscode-icon"
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSubContent,
} from "@/components/ui/context-menu"
import { isRemoteDesktopWindow } from "@/lib/platform"

const itemClassName = "gap-1.5 px-3"

export function OpenInSubContent({
  explorerLabel,
  terminalLabel,
  codeLabel,
  onOpenExplorer,
  onOpenTerminal,
  onOpenCode,
  explorerDisabled,
  studioLabel,
  onOpenStudio,
  browserLabel,
  onOpenBrowser,
}: {
  explorerLabel: string
  terminalLabel: string
  codeLabel: string
  onOpenExplorer: () => void
  onOpenTerminal: () => void
  onOpenCode: () => void
  explorerDisabled?: boolean
  /** Set together for a content project with a game output: adds a leading
   *  row that opens the folder in Studio, inside the app rather than in an
   *  outside tool — hence first, and split off by a separator. */
  studioLabel?: string
  onOpenStudio?: () => void
  /** Rides with the Studio row: the running game in the system browser. */
  browserLabel?: string
  onOpenBrowser?: () => void
}) {
  // `open_in_code` runs on whichever host owns the path, so a remote-desktop
  // window would pop the editor up on the far machine and look like a no-op
  // here. Same reasoning `isLocalDesktop` documents for "reveal in file
  // manager" — don't render a dead row.
  const codeDisabled = isRemoteDesktopWindow()
  // The game is served from a loopback listener on the workspace host, which a
  // remote-desktop window's local browser can't reach — same gate the Studio
  // pane's preview applies.
  const browserDisabled = isRemoteDesktopWindow()
  return (
    <ContextMenuSubContent className="min-w-0 w-max">
      {studioLabel && onOpenStudio ? (
        <>
          <ContextMenuItem className={itemClassName} onSelect={onOpenStudio}>
            <Layers />
            {studioLabel}
          </ContextMenuItem>
          {browserLabel && onOpenBrowser ? (
            <ContextMenuItem
              className={itemClassName}
              disabled={browserDisabled}
              onSelect={onOpenBrowser}
            >
              <Globe />
              {browserLabel}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
        </>
      ) : null}
      <ContextMenuItem
        className={itemClassName}
        disabled={explorerDisabled}
        onSelect={onOpenExplorer}
      >
        <FolderClosed />
        {explorerLabel}
      </ContextMenuItem>
      <ContextMenuItem className={itemClassName} onSelect={onOpenTerminal}>
        <SquareTerminal />
        {terminalLabel}
      </ContextMenuItem>
      <ContextMenuItem
        className={itemClassName}
        disabled={codeDisabled}
        onSelect={onOpenCode}
      >
        <VSCodeIcon />
        {codeLabel}
      </ContextMenuItem>
    </ContextMenuSubContent>
  )
}
