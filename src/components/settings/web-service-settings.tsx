"use client"

import { useCallback, useEffect, useState } from "react"
import {
  startWebServer,
  stopWebServer,
  getWebServerStatus,
  type WebServerInfo,
} from "@/lib/api"

export function WebServiceSettings() {
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
          : "启动失败"
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
      setError("停止失败")
    } finally {
      setLoading(false)
    }
  }

  function copyToken() {
    if (status?.token) {
      navigator.clipboard.writeText(status.token)
    }
  }

  function copyUrl() {
    if (status?.addresses?.[1]) {
      navigator.clipboard.writeText(status.addresses[1])
    } else if (status?.addresses?.[0]) {
      navigator.clipboard.writeText(status.addresses[0])
    }
  }

  const isRunning = status !== null

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Web 服务</h3>
        <p className="text-sm text-muted-foreground">
          启用后可通过浏览器远程访问 Codeg
        </p>
      </div>

      <div className="space-y-4">
        {/* Port config */}
        <div className="flex items-center gap-4">
          <label className="w-20 text-sm font-medium">端口</label>
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
          <label className="w-20 text-sm font-medium">状态</label>
          <div className="flex items-center gap-3">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                isRunning ? "bg-green-500" : "bg-muted-foreground/30"
              }`}
            />
            <span className="text-sm">
              {isRunning ? "运行中" : "已停止"}
            </span>
            <button
              onClick={isRunning ? handleStop : handleStart}
              disabled={loading}
              className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-xs font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              {loading
                ? "处理中..."
                : isRunning
                  ? "停止"
                  : "启动"}
            </button>
          </div>
        </div>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        {/* Connection info */}
        {isRunning && (
          <div className="rounded-md border p-4 space-y-3">
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                访问地址
              </div>
              {status.addresses.map((addr) => (
                <div key={addr} className="flex items-center gap-2">
                  <code className="text-sm">{addr}</code>
                </div>
              ))}
              <button
                onClick={copyUrl}
                className="text-xs text-primary hover:underline"
              >
                复制局域网地址
              </button>
            </div>

            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                访问 Token
              </div>
              <div className="flex items-center gap-2">
                <code className="rounded bg-muted px-2 py-0.5 text-xs">
                  {status.token}
                </code>
                <button
                  onClick={copyToken}
                  className="text-xs text-primary hover:underline"
                >
                  复制
                </button>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Web 客户端首次访问时需输入此 Token
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
