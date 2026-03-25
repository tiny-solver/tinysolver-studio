import type { Transport, UnsubscribeFn } from "./types"

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

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  async call<T>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> {
    const token = getToken()
    const res = await fetch(`${this.baseUrl}/api/${command}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args ?? {}),
    })
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

    const wsUrl =
      this.baseUrl.replace(/^http/, "ws") +
      `/ws/events?token=${encodeURIComponent(token)}`
    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
      this.wsFailCount = 0
    }

    this.ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as WebEvent
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
  }
}
