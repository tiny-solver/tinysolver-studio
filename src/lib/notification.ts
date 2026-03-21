import { invoke } from "@tauri-apps/api/core"

export async function notifyTurnComplete(
  title: string,
  body: string,
): Promise<void> {
  if (!document.hidden) return
  await invoke("send_notification", { title, body })
}
