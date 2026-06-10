import { act, render, waitFor } from "@testing-library/react"
import { createRef } from "react"
import { describe, expect, it, vi } from "vitest"

import { RichComposer, type RichComposerHandle } from "./rich-composer"

/** Wait until the editor has mounted (immediatelyRender:false makes it async). */
async function mount(props: React.ComponentProps<typeof RichComposer> = {}) {
  const ref = createRef<RichComposerHandle>()
  const result = render(<RichComposer ref={ref} {...props} />)
  // Generous timeout: editor construction (ProseMirror + React node view) can
  // be slow under parallel worker CPU contention.
  await waitFor(() => expect(ref.current?.getEditor()).not.toBeNull(), {
    timeout: 5000,
  })
  return { ref, ...result }
}

describe("RichComposer", () => {
  it("mounts and reports an empty document via the handle", async () => {
    const { ref } = await mount()
    expect(ref.current?.isEmpty()).toBe(true)
    expect(ref.current?.getMarkdown()).toBe("")
  })

  it("paints the placeholder on the empty document", async () => {
    const { ref, container } = await mount({ placeholder: "Ask anything" })
    expect(ref.current).not.toBeNull()
    expect(
      container.querySelector('[data-placeholder="Ask anything"]')
    ).not.toBeNull()
  })

  it("exposes an accessible multiline textbox", async () => {
    const { container } = await mount({ ariaLabel: "Message" })
    const textbox = container.querySelector('[role="textbox"]')
    expect(textbox).not.toBeNull()
    expect(textbox).toHaveAttribute("aria-multiline", "true")
    expect(textbox).toHaveAttribute("aria-label", "Message")
  })

  it("round-trips markdown through the handle and notifies onChange", async () => {
    const onChange = vi.fn()
    const { ref } = await mount({ onChange })

    act(() => {
      ref.current?.setMarkdown("hello **world**")
    })

    expect(ref.current?.getMarkdown()).toContain("**world**")
    expect(ref.current?.isEmpty()).toBe(false)
    expect(onChange).toHaveBeenCalled()
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]
    expect(lastCall?.[0]).toContain("**world**")

    act(() => {
      ref.current?.clear()
    })
    expect(ref.current?.isEmpty()).toBe(true)
  })

  it("preserves CJK content through the handle", async () => {
    const { ref } = await mount()
    act(() => {
      ref.current?.setMarkdown("发送给智能体的消息")
    })
    expect(ref.current?.getMarkdown()).toContain("发送给智能体的消息")
  })

  it("initializes from defaultMarkdown without firing onChange", async () => {
    const onChange = vi.fn()
    const { ref } = await mount({
      defaultMarkdown: "# Heading",
      onChange,
    })
    expect(ref.current?.getMarkdown().trim()).toBe("# Heading")
    // onCreate sets content with emitUpdate:false → no spurious change events.
    expect(onChange).not.toHaveBeenCalled()
  })
})
