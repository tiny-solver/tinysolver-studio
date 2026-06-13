"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Loader2,
  Pause,
  Play,
  RotateCw,
  Trash2,
  FolderOpen,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  getLogSettings,
  getRecentLogs,
  listLogFiles,
  openLogsDir,
  readLogFile,
  setLogSettings,
  subscribeLogAppended,
  subscribeLogSettingsChanged,
} from "@/lib/api"
import { isDesktop, openPath } from "@/lib/platform"
import { toErrorMessage } from "@/lib/app-error"
import type { LogFileInfo, LogLevel, LogRecord } from "@/lib/types"

// Capture levels offered in the level dropdown (controls what the backend
// records). `off` disables capture entirely.
const CAPTURE_LEVELS: LogLevel[] = [
  "off",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]

// View filter: minimum severity to display (client-side). "all" keeps every
// record currently in the buffer.
const VIEW_LEVELS = ["all", "error", "warn", "info", "debug", "trace"] as const

// Newest records kept in the DOM. A rendering bound (the backend ring buffer is
// the source of truth); aligned with the backend's buffer size.
const DISPLAY_LIMIT = 5000

// Mirror of the backend `READ_LOG_MAX_BYTES` (commands/logging.rs): a single
// file download returns at most the newest 16 MiB. Larger files come back
// truncated, which the download flow surfaces explicitly rather than passing a
// tail off as the complete log.
const READ_LOG_MAX_BYTES = 16 * 1024 * 1024

const LEVEL_RANK: Record<string, number> = {
  ERROR: 5,
  WARN: 4,
  INFO: 3,
  DEBUG: 2,
  TRACE: 1,
}

const MIN_RANK: Record<string, number> = {
  all: 0,
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
}

function rankOf(level: string): number {
  return LEVEL_RANK[level.toUpperCase()] ?? 0
}

function matchesFilter(
  r: LogRecord,
  minLevel: string,
  search: string
): boolean {
  if (rankOf(r.level) < (MIN_RANK[minLevel] ?? 0)) return false
  const q = search.trim().toLowerCase()
  if (q) {
    if (
      !r.message.toLowerCase().includes(q) &&
      !r.target.toLowerCase().includes(q)
    ) {
      return false
    }
  }
  return true
}

function levelBadgeClasses(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
      return "text-red-400"
    case "WARN":
      return "text-amber-400"
    case "INFO":
      return "text-sky-400"
    case "DEBUG":
      return "text-muted-foreground"
    default:
      return "text-muted-foreground/70"
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  const millis = String(d.getMilliseconds()).padStart(3, "0")
  return `${hh}:${mm}:${ss}.${millis}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function LogsSettings() {
  const t = useTranslations("LogsSettings")
  const desktop = isDesktop()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [savingLevel, setSavingLevel] = useState(false)

  const [captureLevel, setCaptureLevel] = useState<LogLevel>("info")
  const [envLocked, setEnvLocked] = useState(false)
  const [records, setRecords] = useState<LogRecord[]>([])
  const [search, setSearch] = useState("")
  const [viewLevel, setViewLevel] = useState<string>("all")
  const [liveTail, setLiveTail] = useState(true)

  const [logFiles, setLogFiles] = useState<LogFileInfo[]>([])

  const listRef = useRef<HTMLDivElement | null>(null)

  const refreshLogs = useCallback(async () => {
    const recent = await getRecentLogs({ limit: DISPLAY_LIMIT })
    setRecords(recent)
  }, [])

  const loadInitial = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [settings, recent, files] = await Promise.all([
        getLogSettings(),
        getRecentLogs({ limit: DISPLAY_LIMIT }),
        desktop ? Promise.resolve<LogFileInfo[]>([]) : listLogFiles(),
      ])
      setCaptureLevel(settings.level)
      setEnvLocked(settings.env_locked)
      setRecords(recent)
      setLogFiles(files)
    } catch (err) {
      setLoadError(toErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [desktop])

  useEffect(() => {
    loadInitial().catch((err) => {
      console.error("[LogsSettings] initial load failed:", err)
    })
  }, [loadInitial])

  // Cross-window sync of the capture level.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribeLogSettingsChanged((s) => {
        setCaptureLevel(s.level)
      })
      if (disposed) dispose()
      else unlisten = dispose
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // Live tail: append new records (capped) while enabled.
  useEffect(() => {
    if (!liveTail) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribeLogAppended((record) => {
        setRecords((prev) => {
          // Monotonic-seq guard: the backend assigns strictly increasing seqs
          // and both the initial snapshot and live events arrive in seq order,
          // so a record at or below the newest one we already hold is the
          // snapshot/live overlap on mount — drop it instead of doubling a row.
          if (prev.length > 0 && record.seq <= prev[prev.length - 1].seq) {
            return prev
          }
          const next =
            prev.length >= DISPLAY_LIMIT ? prev.slice(1) : prev.slice()
          next.push(record)
          return next
        })
      })
      if (disposed) dispose()
      else unlisten = dispose
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [liveTail])

  const visible = records.filter((r) => matchesFilter(r, viewLevel, search))

  // Stick to bottom while live-tailing if the user is already near the bottom.
  useEffect(() => {
    if (!liveTail) return
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [visible.length, liveTail])

  const handleLevelChange = useCallback(
    async (value: string) => {
      const level = value as LogLevel
      const previous = captureLevel
      setCaptureLevel(level)
      setSavingLevel(true)
      try {
        await setLogSettings({ level })
      } catch (err) {
        setCaptureLevel(previous)
        toast.error(t("levelSaveFailed"), { description: toErrorMessage(err) })
      } finally {
        setSavingLevel(false)
      }
    },
    [captureLevel, t]
  )

  const handleOpenFolder = useCallback(async () => {
    try {
      const path = await openLogsDir()
      await openPath(path)
    } catch (err) {
      toast.error(t("openFolderFailed"), { description: toErrorMessage(err) })
    }
  }, [t])

  const handleDownload = useCallback(
    async (file: LogFileInfo) => {
      try {
        const content = await readLogFile(file.name)
        // Files past the backend read cap come back as the newest slice only;
        // mark the download name and warn so a tail is never mistaken for the
        // full log (the complete file stays in the logs directory on disk).
        const truncated = file.size_bytes > READ_LOG_MAX_BYTES
        const downloadName = truncated
          ? `${file.name.replace(/\.log$/, "")}.tail.log`
          : file.name
        const blob = new Blob([content], { type: "text/plain" })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = downloadName
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(url)
        if (truncated) {
          toast.info(
            t("downloadTruncated", { size: formatBytes(READ_LOG_MAX_BYTES) })
          )
        }
      } catch (err) {
        toast.error(t("downloadFailed"), { description: toErrorMessage(err) })
      }
    },
    [t]
  )

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        <section className="space-y-1">
          <h1 className="text-sm font-semibold">{t("sectionTitle")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </section>

        {loadError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
            {loadError}
          </div>
        )}

        {/* Capture level */}
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t("captureTitle")}</h2>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("captureDescription")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t("captureLabel")}
            </span>
            <Select
              value={captureLevel}
              onValueChange={handleLevelChange}
              disabled={envLocked}
            >
              <SelectTrigger
                className="h-8 w-40 text-xs"
                disabled={savingLevel || envLocked}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAPTURE_LEVELS.map((level) => (
                  <SelectItem key={level} value={level} className="text-xs">
                    {t(`levels.${level}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {savingLevel && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
          </div>
          {envLocked && (
            <p className="text-[11px] text-amber-500">
              {t("captureEnvLocked")}
            </p>
          )}
        </section>

        {/* Viewer */}
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">{t("viewerTitle")}</h2>
              <p className="text-xs leading-5 text-muted-foreground">
                {t("viewerDescription")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={liveTail ? "default" : "outline"}
                onClick={() => setLiveTail((v) => !v)}
              >
                {liveTail ? (
                  <Pause className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {liveTail ? t("pause") : t("resume")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  refreshLogs().catch((err) => {
                    console.error("[LogsSettings] refresh failed:", err)
                  })
                }}
              >
                <RotateCw className="h-3.5 w-3.5" />
                {t("refresh")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRecords([])}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("clear")}
              </Button>
              {desktop && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    handleOpenFolder().catch((err) => {
                      console.error("[LogsSettings] open folder failed:", err)
                    })
                  }}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t("openFolder")}
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-8 max-w-xs text-xs"
            />
            <Select value={viewLevel} onValueChange={setViewLevel}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VIEW_LEVELS.map((level) => (
                  <SelectItem key={level} value={level} className="text-xs">
                    {t(`viewLevels.${level}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">
              {t("shownCount", {
                shown: visible.length,
                total: records.length,
              })}
            </span>
          </div>

          <div
            ref={listRef}
            className="h-[480px] overflow-y-auto rounded-md border bg-background/50 font-mono text-[11px] leading-5"
          >
            {visible.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t("empty")}
              </div>
            ) : (
              <div className="divide-y divide-border/40">
                {visible.map((r) => (
                  <div
                    key={r.seq}
                    className="flex gap-2 px-2 py-1 hover:bg-muted/40"
                  >
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatTime(r.timestamp_ms)}
                    </span>
                    <span
                      className={`w-12 shrink-0 font-semibold uppercase ${levelBadgeClasses(
                        r.level
                      )}`}
                    >
                      {r.level}
                    </span>
                    <span
                      className="shrink-0 truncate text-muted-foreground/80"
                      style={{ maxWidth: "12rem" }}
                      title={r.target}
                    >
                      {r.target}
                    </span>
                    <span className="whitespace-pre-wrap break-all text-foreground/90">
                      {r.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* On-disk files (web mode: download for history beyond the buffer) */}
        {!desktop && (
          <section className="space-y-3 rounded-xl border bg-card p-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">{t("filesTitle")}</h2>
              <p className="text-xs leading-5 text-muted-foreground">
                {t("filesDescription")}
              </p>
            </div>
            {logFiles.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {t("filesEmpty")}
              </p>
            ) : (
              <div className="space-y-1">
                {logFiles.map((file) => (
                  <div
                    key={file.name}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5"
                  >
                    <span className="truncate font-mono text-xs">
                      {file.name}
                    </span>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-[11px] text-muted-foreground">
                        {formatBytes(file.size_bytes)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          handleDownload(file).catch((err) => {
                            console.error(
                              "[LogsSettings] download failed:",
                              err
                            )
                          })
                        }}
                      >
                        {t("download")}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </ScrollArea>
  )
}
