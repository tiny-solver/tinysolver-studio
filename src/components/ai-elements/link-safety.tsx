"use client"

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { openUrl } from "@/lib/platform"
import type { LinkSafetyConfig, LinkSafetyModalProps } from "streamdown"
import { toast } from "sonner"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useWorkspaceContext } from "@/contexts/workspace-context"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface LocalFileTarget {
  path: string
  line: number | null
}

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/
const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/

function normalizeSlashPath(path: string): string {
  return path.replace(/\\/g, "/")
}

/** Strip leading slash before Windows drive letter: /C:/foo → C:/foo */
function stripLeadingSlashOnWindows(p: string): string {
  if (p.startsWith("/") && WINDOWS_ABSOLUTE_PATH.test(p.slice(1))) {
    return p.slice(1)
  }
  return p
}

function decodeUriSafely(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseLineValue(raw: string | undefined): number | null {
  if (!raw) return null
  const line = Number.parseInt(raw, 10)
  if (!Number.isFinite(line) || line <= 0) return null
  return line
}

function parseHashLine(hash: string): number | null {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash
  if (!normalized) return null
  return (
    parseLineValue(normalized.match(/^L(\d+)$/i)?.[1]) ??
    parseLineValue(normalized.match(/^line=(\d+)$/i)?.[1]) ??
    parseLineValue(normalized.match(/^(\d+)$/)?.[1])
  )
}

function splitPathAndLine(rawPath: string): LocalFileTarget {
  const trimmed = rawPath.trim()
  const match = trimmed.match(/^(.*):(\d+)(?::\d+)?$/)
  if (!match) {
    return { path: trimmed, line: null }
  }

  const maybePath = match[1]
  if (!maybePath || maybePath.endsWith("://")) {
    return { path: trimmed, line: null }
  }

  const line = parseLineValue(match[2])
  if (!line) {
    return { path: trimmed, line: null }
  }

  return { path: maybePath, line }
}

function isLocalPathLike(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith("~/") ||
    WINDOWS_ABSOLUTE_PATH.test(path)
  )
}

function parseLocalFileTarget(rawUrl: string): LocalFileTarget | null {
  const raw = decodeUriSafely(rawUrl.trim())
  if (!raw) return null

  if (raw.toLowerCase().startsWith("file://")) {
    try {
      const parsed = new URL(raw)
      const rawPathname = decodeUriSafely(parsed.pathname)
      const normalizedPathname = stripLeadingSlashOnWindows(rawPathname)
      const pathAndLine = splitPathAndLine(normalizedPathname)
      if (!pathAndLine.path) return null
      return {
        path: normalizeSlashPath(pathAndLine.path),
        line: parseHashLine(parsed.hash) ?? pathAndLine.line,
      }
    } catch {
      return null
    }
  }

  if (URL_SCHEME.test(raw) && !WINDOWS_ABSOLUTE_PATH.test(raw)) {
    return null
  }

  const hashIndex = raw.indexOf("#")
  const hash = hashIndex >= 0 ? raw.slice(hashIndex) : ""
  const withoutHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
  const queryIndex = withoutHash.indexOf("?")
  const withoutQuery =
    queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash
  const pathAndLine = splitPathAndLine(withoutQuery)
  const normalizedPath = stripLeadingSlashOnWindows(pathAndLine.path)
  if (!isLocalPathLike(normalizedPath)) return null

  return {
    path: normalizeSlashPath(normalizedPath),
    line: parseHashLine(hash) ?? pathAndLine.line,
  }
}

function toWorkspaceRelativePath(
  path: string,
  workspacePath: string
): string | null {
  const normalizedPath = normalizeSlashPath(path)
  const normalizedWorkspace = normalizeSlashPath(workspacePath).replace(
    /\/+$/,
    ""
  )
  if (!normalizedPath || !normalizedWorkspace) return null

  if (!normalizedPath.startsWith("/") && !WINDOWS_ABSOLUTE_PATH.test(path)) {
    return normalizedPath.replace(/^\.\/+/, "")
  }

  const isWindows = WINDOWS_ABSOLUTE_PATH.test(normalizedWorkspace)
  const pathForCompare = isWindows
    ? normalizedPath.toLowerCase()
    : normalizedPath
  const workspaceForCompare = isWindows
    ? normalizedWorkspace.toLowerCase()
    : normalizedWorkspace

  if (pathForCompare === workspaceForCompare) return null
  if (!pathForCompare.startsWith(`${workspaceForCompare}/`)) return null

  return normalizedPath.slice(normalizedWorkspace.length + 1)
}

function LinkSafetyModal({
  url,
  isOpen,
  onClose,
  onAction,
}: LinkSafetyModalProps & {
  onAction: (url: string) => Promise<void>
}) {
  const t = useTranslations("Folder.chat.linkSafety")
  const [opening, setOpening] = useState(false)
  const localTarget = useMemo(() => parseLocalFileTarget(url), [url])
  const isLocalFile = Boolean(localTarget)

  const handleAction = useCallback(() => {
    if (opening) return
    setOpening(true)
    void onAction(url).finally(() => {
      setOpening(false)
    })
  }, [onAction, opening, url])

  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isLocalFile ? t("localFileTitle") : t("externalLinkTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isLocalFile
              ? t("localFileDescription")
              : t("externalLinkDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-28 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
          {localTarget?.path ?? url}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={opening}>
            {t("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction disabled={opening} onClick={handleAction}>
            {opening
              ? t("opening")
              : isLocalFile
                ? t("openFile")
                : t("openLink")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function useStreamdownLinkSafety(): LinkSafetyConfig {
  const t = useTranslations("Folder.chat.linkSafety")
  const { activeFolder: folder } = useActiveFolder()
  const folderPath = folder?.path
  const { openFilePreview } = useWorkspaceContext()

  const handleOpenTarget = useCallback(
    async (url: string) => {
      const localTarget = parseLocalFileTarget(url)
      if (localTarget) {
        if (!folderPath) {
          toast.error(t("errorCannotOpen"), {
            description: t("errorNoWorkspace"),
          })
          return
        }

        const relativePath = toWorkspaceRelativePath(
          localTarget.path,
          folderPath
        )
        if (!relativePath) {
          toast.error(t("errorCannotOpen"), {
            description: t("errorOutsideWorkspace"),
          })
          return
        }

        try {
          await openFilePreview(relativePath, {
            line: localTarget.line ?? undefined,
          })
        } catch (error) {
          toast.error(t("errorFailedOpen"), {
            description: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }

      try {
        await openUrl(url)
      } catch (error) {
        toast.error(t("errorFailedLink"), {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [folderPath, openFilePreview, t]
  )

  const renderModal = useCallback(
    (props: LinkSafetyModalProps) => (
      <LinkSafetyModal {...props} onAction={handleOpenTarget} />
    ),
    [handleOpenTarget]
  )

  return useMemo(
    () => ({
      enabled: true,
      renderModal,
    }),
    [renderModal]
  )
}
