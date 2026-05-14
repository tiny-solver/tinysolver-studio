import { WS_READY_CHANNEL } from "./constants"
import type { Transport, UnsubscribeFn } from "./types"
import { buildCodegWebSocketProtocols } from "./ws-auth"

const WEB_CALL_TIMEOUT_MS = 30_000
// Upper bound on how long `subscribe()` will wait for the server `__ready__`
// frame. Generous enough to cover slow local servers and remote round-trips
// (typical: <100ms local, <1s WAN), but bounded so an older server (no
// `__ready__` support), a hung backend task, or a buffering proxy can't
// permanently lock the UI. On timeout we proceed without confirmation — the
// pre-fix race window reopens, but the UI stays responsive.
const READY_TIMEOUT_MS = 5_000

interface WebEvent {
  channel: string
  payload: unknown
}

function getToken(): string {
  return localStorage.getItem("codeg_token") ?? ""
}

export class WebTransport implements Transport {
  private ws: WebSocket | null = null
  private handlers = new Map<string, Set<(payload: unknown) => void>>()
  private baseUrl: string
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private wsFailCount = 0
  private readyPromise!: Promise<void>
  private readyResolve!: () => void

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
    this.resetReady()
  }

  private resetReady() {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve
    })
  }

  // Bounded wait on `readyPromise`. If `__ready__` does not arrive within
  // `READY_TIMEOUT_MS`, log a warning and fall through — degrades to the
  // pre-handshake behavior instead of hanging the UI forever.
  private async waitForReady(): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), READY_TIMEOUT_MS)
    })
    const result = await Promise.race([
      this.readyPromise.then(() => "ready" as const),
      timeoutPromise,
    ])
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (result === "timeout") {
      console.warn(
        `[WebTransport] WS __ready__ frame did not arrive within ${READY_TIMEOUT_MS}ms; ` +
          "proceeding without server-side subscribe confirmation (initial-connect race may reopen)."
      )
    }
  }

  async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const token = getToken()
    const controller = new AbortController()
    const timeout = window.setTimeout(
      () => controller.abort(),
      WEB_CALL_TIMEOUT_MS
    )
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/${command}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(args ?? {}),
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("Request timed out")
      }
      throw err
    } finally {
      window.clearTimeout(timeout)
    }
    if (res.status === 401) {
      WebTransport.redirectToLogin()
      throw new Error("Unauthorized")
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({
        code: "network_error",
        message: `HTTP ${res.status}`,
      }))
      throw error
    }
    return res.json()
  }

  async subscribe<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<UnsubscribeFn> {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    const wrappedHandler = handler as (payload: unknown) => void
    this.handlers.get(event)!.add(wrappedHandler)

    // If WS is not connected but we now have a token, connect
    if (!this.ws && getToken()) {
      this.connectWs()
    }

    // Gate on the server-side broadcaster receiver actually being subscribed.
    // The backend WS handler sends a `__ready__` frame after subscribing, so
    // any event emitted past this await is guaranteed to reach a receiver.
    // Without this, events fired before the server-side subscribe (e.g. the
    // ACP `Connected` event after a fast Initialize) are silently dropped
    // because the broadcaster skips `send` when receiver_count == 0, leaving
    // the UI permanently stuck on "正在连接".
    if (getToken()) {
      await this.waitForReady()
    }

    return () => {
      this.handlers.get(event)?.delete(wrappedHandler)
    }
  }

  isDesktop(): boolean {
    return false
  }

  private static redirectToLogin() {
    if (window.location.pathname.startsWith("/login")) return
    localStorage.removeItem("codeg_token")
    window.location.href = "/login"
  }

  private connectWs() {
    const token = getToken()
    if (!token) return

    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/ws/events"
    this.ws = new WebSocket(wsUrl, buildCodegWebSocketProtocols(token))

    this.ws.onopen = () => {
      this.wsFailCount = 0
    }

    this.ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as WebEvent
        if (event.channel === WS_READY_CHANNEL) {
          this.readyResolve()
          return
        }
        const handlers = this.handlers.get(event.channel)
        if (handlers) {
          for (const h of handlers) {
            h(event.payload)
          }
        }
      } catch {
        // ignore malformed messages
      }
    }

    this.ws.onclose = () => {
      this.ws = null
      // New subscribers (and any concurrent subscribe() calls in flight)
      // must wait for the next connection's `__ready__` before resolving.
      this.resetReady()
      this.wsFailCount++
      if (this.wsFailCount >= 3) {
        WebTransport.redirectToLogin()
        return
      }
      this.reconnectTimer = setTimeout(() => this.connectWs(), 3000)
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  destroy() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    this.ws?.close()
    this.ws = null
    this.handlers.clear()
    // Settle any in-flight `subscribe()` awaiters so their promises don't
    // leak alongside the destroyed transport. Safe to call multiple times —
    // resolving an already-settled Promise is a no-op.
    this.readyResolve?.()
  }
}
