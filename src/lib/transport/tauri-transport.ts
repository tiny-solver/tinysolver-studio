import type { Transport, UnsubscribeFn } from "./types"

export class TauriTransport implements Transport {
  async call<T>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke(command, args)
  }

  async subscribe<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<UnsubscribeFn> {
    const { listen } = await import("@tauri-apps/api/event")
    return listen<T>(event, (e) => handler(e.payload))
  }

  isDesktop(): boolean {
    return true
  }
}
