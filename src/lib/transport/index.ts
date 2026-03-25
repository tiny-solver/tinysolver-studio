import { detectEnvironment } from "./detect"
import type { Transport } from "./types"

export type { Transport, UnsubscribeFn } from "./types"

let _transport: Transport | null = null

export function getTransport(): Transport {
  if (!_transport) {
    const env = detectEnvironment()
    if (env === "tauri") {
      // Use dynamic require to avoid bundling tauri deps in web mode.
      // TauriTransport uses dynamic imports internally.
      const { TauriTransport } = require("./tauri-transport") as {
        TauriTransport: new () => Transport
      }
      _transport = new TauriTransport()
    } else {
      const { WebTransport } = require("./web-transport") as {
        WebTransport: new (baseUrl: string) => Transport
      }
      // In web mode, the API is served from the same origin.
      // Token is read from localStorage on each request.
      const baseUrl = window.location.origin
      _transport = new WebTransport(baseUrl)
    }
  }
  return _transport
}

export function isDesktop(): boolean {
  return getTransport().isDesktop()
}
