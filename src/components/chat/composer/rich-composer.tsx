"use client"

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react"
import { type Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"

import { cn } from "@/lib/utils"

import { buildComposerExtensions } from "./editor-config"
import { shouldSubmitOnEnter } from "./submit-key"

/**
 * Imperative handle exposed to the parent (e.g. the message input that owns
 * attachments, queue and send orchestration). The parent reads/writes Markdown
 * and controls focus without re-rendering the editor.
 */
export interface RichComposerHandle {
  /** Serialize the current document to Markdown. */
  getMarkdown: () => string
  /** Replace the whole document from a Markdown string. */
  setMarkdown: (markdown: string) => void
  /** Clear the document. */
  clear: () => void
  /** Focus the editor at the end of the document. */
  focus: () => void
  /** Whether the document is empty (no text, no nodes). */
  isEmpty: () => boolean
  /** Escape hatch to the underlying editor (null until initialized). */
  getEditor: () => Editor | null
}

export interface RichComposerProps {
  /** Initial content, parsed as Markdown. Applied once on creation. */
  defaultMarkdown?: string
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  /** Accessible label for the editing surface. */
  ariaLabel?: string
  /** Outer wrapper className (host controls border/ring/max-height). */
  className?: string
  /** Inline style for the outer wrapper (e.g. max-height). */
  style?: CSSProperties
  /**
   * Fires on every document change with the serialized Markdown. Serialization
   * runs once per keystroke *only when a handler is attached* (the call is
   * skipped entirely otherwise). Callers that persist drafts must debounce —
   * the Phase 3 draft layer owns that.
   */
  onChange?: (markdown: string) => void
  /**
   * Submit intent: Enter without Shift, while not composing (IME-safe) and not
   * inside a code block. The host decides what "submit" means.
   */
  onSubmit?: () => void
  onFocus?: () => void
  onBlur?: () => void
}

/**
 * Phase 0 rich-text composer: a Tiptap editor with live WYSIWYG Markdown and
 * IME-safe Enter-to-submit. Reference badges and the unified `@` panel are
 * layered on in later phases; this component is the foundation that de-risks
 * IME, auto-grow and Markdown round-trip.
 */
export const RichComposer = forwardRef<RichComposerHandle, RichComposerProps>(
  function RichComposer(
    {
      defaultMarkdown,
      placeholder,
      autoFocus,
      disabled,
      ariaLabel,
      className,
      style,
      onChange,
      onSubmit,
      onFocus,
      onBlur,
    },
    ref
  ) {
    // Keep callbacks in refs so the editor (and its keymap) is created once and
    // never torn down just because a parent re-renders with new closures.
    const onChangeRef = useRef(onChange)
    const onSubmitRef = useRef(onSubmit)
    const onFocusRef = useRef(onFocus)
    const onBlurRef = useRef(onBlur)
    useEffect(() => {
      onChangeRef.current = onChange
      onSubmitRef.current = onSubmit
      onFocusRef.current = onFocus
      onBlurRef.current = onBlur
    })

    const editor = useEditor({
      // Static export / SSR safety: never render on the server.
      immediatelyRender: false,
      extensions: buildComposerExtensions({ placeholder }),
      editable: !disabled,
      autofocus: autoFocus ? "end" : false,
      editorProps: {
        attributes: {
          class: "codeg-composer-content",
          role: "textbox",
          "aria-multiline": "true",
          ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        },
        handleKeyDown: (view, event) => {
          // Only Enter is special; let everything else fall through cheaply.
          if (event.key !== "Enter") return false
          // Resolve structural context: code blocks and list items keep Enter
          // (newline / list split) instead of submitting.
          const { $from } = view.state.selection
          let inCodeBlock = $from.parent.type.spec.code === true
          let inList = false
          for (let depth = $from.depth; depth > 0; depth--) {
            const name = $from.node(depth).type.name
            if (name === "codeBlock") inCodeBlock = true
            if (name === "listItem" || name === "taskItem") inList = true
          }
          const submit = shouldSubmitOnEnter(
            {
              key: event.key,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              isComposing: event.isComposing,
              keyCode: (event as { keyCode?: number }).keyCode ?? 0,
            },
            { composing: view.composing, inCodeBlock, inList }
          )
          if (submit && onSubmitRef.current) {
            onSubmitRef.current()
            return true
          }
          return false
        },
      },
      onCreate: ({ editor }) => {
        if (defaultMarkdown) {
          editor.commands.setContent(defaultMarkdown, {
            contentType: "markdown",
            emitUpdate: false,
          })
        }
      },
      onUpdate: ({ editor }) => {
        onChangeRef.current?.(editor.getMarkdown())
      },
      onFocus: () => onFocusRef.current?.(),
      onBlur: () => onBlurRef.current?.(),
    })

    // Reflect disabled changes onto the live editor. Pass emitUpdate=false so
    // toggling editability never fires onUpdate/onChange without a real edit.
    useEffect(() => {
      editor?.setEditable(!disabled, false)
    }, [editor, disabled])

    useImperativeHandle(
      ref,
      (): RichComposerHandle => ({
        getMarkdown: () => editor?.getMarkdown() ?? "",
        setMarkdown: (markdown) =>
          editor?.commands.setContent(markdown, { contentType: "markdown" }),
        clear: () => editor?.commands.clearContent(true),
        focus: () => editor?.commands.focus("end"),
        isEmpty: () => editor?.isEmpty ?? true,
        getEditor: () => editor ?? null,
      }),
      [editor]
    )

    return (
      <div
        className={cn("codeg-composer flex min-h-0 flex-col", className)}
        style={style}
        data-disabled={disabled || undefined}
      >
        <EditorContent
          editor={editor}
          className="codeg-composer-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2 text-base md:text-sm"
        />
      </div>
    )
  }
)
