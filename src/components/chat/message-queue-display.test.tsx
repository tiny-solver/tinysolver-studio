import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { QueuedMessage } from "@/hooks/use-message-queue"

import { MessageQueueDisplay } from "./message-queue-display"

const TQ = enMessages.Folder.chat.messageQueue

function item(id: string, text: string): QueuedMessage {
  return {
    id,
    draft: { blocks: [{ type: "text", text }], displayText: text },
    modeId: null,
  }
}

function renderDisplay(
  props: Partial<React.ComponentProps<typeof MessageQueueDisplay>> = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageQueueDisplay
        queue={[item("q1", "use pnpm"), item("q2", "run the tests")]}
        onReorder={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        editingItemId={null}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

afterEach(cleanup)

describe("MessageQueueDisplay click-to-insert", () => {
  it("offers no insert button without a steering handler", () => {
    renderDisplay()
    expect(screen.queryByTitle(TQ.steerItemNow)).toBeNull()
    expect(screen.queryByTitle(TQ.steerItemAsNote)).toBeNull()
  })

  it("inserts the row the button belongs to, with the native promise", async () => {
    const onSteerItem = vi.fn(async () => {})
    renderDisplay({ onSteerItem, steerChannel: "native" })

    const buttons = screen.getAllByTitle(TQ.steerItemNow)
    expect(buttons).toHaveLength(2)

    await userEvent.click(buttons[1])
    expect(onSteerItem).toHaveBeenCalledWith("q2")
  })

  it("keys the copy to the pull channel (waiting note, not an insert)", async () => {
    const onSteerItem = vi.fn(async () => {})
    renderDisplay({ onSteerItem, steerChannel: "pull" })

    // The insert label must not appear on a pull session — it would promise
    // an instant injection the channel can't deliver.
    expect(screen.queryByTitle(TQ.steerItemNow)).toBeNull()
    await userEvent.click(screen.getAllByTitle(TQ.steerItemAsNote)[0])
    expect(onSteerItem).toHaveBeenCalledWith("q1")
  })

  it("disables every row while an insert is in flight (single-flight)", async () => {
    let release: () => void = () => {}
    const onSteerItem = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    renderDisplay({ onSteerItem, steerChannel: "native" })

    const buttons = screen.getAllByTitle(TQ.steerItemNow) as HTMLButtonElement[]
    await userEvent.click(buttons[0])
    await waitFor(() => expect(onSteerItem).toHaveBeenCalledTimes(1))

    expect(buttons[1].disabled).toBe(true)
    // A second click while in flight must not race the same channel.
    await userEvent.click(buttons[1])
    expect(onSteerItem).toHaveBeenCalledTimes(1)

    release()
    await waitFor(() => expect(buttons[1].disabled).toBe(false))
  })
})
