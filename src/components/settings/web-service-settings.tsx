"use client"

import { useCallback, useEffect, useState } from "react"
import { Check, Copy, ExternalLink, Eye, EyeOff } from "lucide-react"
import { useTranslations } from "next-intl"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  startWebServer,
  stopWebServer,
  getWebServerStatus,
  type WebServerInfo,
} from "@/lib/api"
import { openUrl } from "@/lib/platform"

function AddressCard({ label, value }: { label: string; value: string }) {
  const t = useTranslations("WebServiceSettings")
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="group relative flex items-center rounded-md border bg-muted/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-sm select-all">
          {value}
        </code>
        <div className="ml-2 flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => openUrl(value)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title={t("open")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

function TokenCard({ label, value }: { label: string; value: string }) {
  const t = useTranslations("WebServiceSettings")
  const [copied, setCopied] = useState(false)
  const [revealed, setRevealed] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const displayValue = revealed
    ? value
    : "\u2022".repeat(Math.max(value.length, 12))

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="group relative flex items-center rounded-md border bg-muted/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-sm select-all">
          {displayValue}
        </code>
        <div className="ml-2 flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title={revealed ? t("hide") : t("show")}
          >
            {revealed ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title={t("copy")}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

export function WebServiceSettings() {
  const t = useTranslations("WebServiceSettings")
  const [status, setStatus] = useState<WebServerInfo | null>(null)
  const [port, setPort] = useState("3080")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const fetchStatus = useCallback(async () => {
    try {
      const info = await getWebServerStatus()
      setStatus(info)
      if (info) {
        setPort(String(info.port))
      }
    } catch {
      // Server status unavailable
    }
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  async function handleStart() {
    setError("")
    setLoading(true)
    try {
      const info = await startWebServer({
        port: parseInt(port, 10) || 3080,
      })
      setStatus(info)
    } catch (e: unknown) {
      const msg =
        e && typeof e === "object" && "message" in e
          ? (e as { message: string }).message
          : t("startFailed")
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  async function handleStop() {
    setLoading(true)
    try {
      await stopWebServer()
      setStatus(null)
    } catch {
      setError(t("stopFailed"))
    } finally {
      setLoading(false)
    }
  }

  const isRunning = status !== null

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-medium">{t("sectionTitle")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </div>

        <div className="space-y-4">
          {/* Port config */}
          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium">{t("port")}</label>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              disabled={isRunning}
              min={1024}
              max={65535}
              className="flex h-9 w-32 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
          </div>

          {/* Start/Stop button */}
          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium">{t("status")}</label>
            <div className="flex items-center gap-3">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  isRunning ? "bg-green-500" : "bg-muted-foreground/30"
                }`}
              />
              <span className="text-sm">
                {isRunning ? t("running") : t("stopped")}
              </span>
              <button
                onClick={isRunning ? handleStop : handleStart}
                disabled={loading}
                className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-xs font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                {loading ? t("processing") : isRunning ? t("stop") : t("start")}
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {/* Connection info */}
          {isRunning && (
            <div className="space-y-3">
              {status.addresses.map((addr) => (
                <AddressCard
                  key={addr}
                  label={t("addressLabel")}
                  value={addr}
                />
              ))}
              <TokenCard label={t("tokenLabel")} value={status.token} />
              <p className="text-xs text-muted-foreground">{t("tokenHint")}</p>
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}
