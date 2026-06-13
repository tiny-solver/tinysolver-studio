import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { ReferenceBadge } from "./reference-badge"
import type { ReferenceAttrs } from "../types"

function ref(partial: Partial<ReferenceAttrs>): ReferenceAttrs {
  return {
    refType: "file",
    id: "",
    label: "",
    uri: null,
    meta: null,
    ...partial,
  }
}

/** The badge root carries `data-reference-badge` and `data-ref-type`. */
function badgeOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-reference-badge]")
  if (!el) throw new Error("no reference badge rendered")
  return el
}

describe("ReferenceBadge", () => {
  it("renders the label and is vertically centered (align-middle)", () => {
    const { container } = render(
      <ReferenceBadge data={ref({ refType: "file", label: "app.ts" })} />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveTextContent("app.ts")
    // Task 3: badges sit on the text's middle, not its baseline.
    expect(badge).toHaveClass("align-middle")
    expect(badge).not.toHaveClass("align-baseline")
  })

  it("colors a file reference blue with no background or border", () => {
    const { container } = render(
      <ReferenceBadge data={ref({ refType: "file", label: "app.ts" })} />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveAttribute("data-ref-type", "file")
    // Text-only: a color, but no background / border (req 3).
    expect(badge).toHaveClass("text-blue-700")
    expect(badge.className).not.toMatch(/\bbg-/)
    expect(badge.className).not.toMatch(/\bborder\b/)
    expect(container.querySelector(".lucide-file-text")).not.toBeNull()
  })

  it("colors a session reference emerald", () => {
    const { container } = render(
      <ReferenceBadge data={ref({ refType: "session", label: "#42" })} />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveAttribute("data-ref-type", "session")
    expect(badge).toHaveClass("text-emerald-700")
    // No agentType meta → falls back to the Hash icon.
    expect(container.querySelector(".lucide-hash")).not.toBeNull()
  })

  it("renders a command/skill with the command glyph, colored rose", () => {
    const { container } = render(
      <ReferenceBadge
        data={ref({
          refType: "skill",
          id: "build",
          label: "build",
          meta: { invocationPrefix: "/" },
        })}
      />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveAttribute("data-ref-type", "skill")
    expect(badge).toHaveClass("text-rose-700")
    expect(container.querySelector(".lucide-command")).not.toBeNull()
  })

  it("renders an expert with the SAME command glyph + color (unified, no star)", () => {
    const { container } = render(
      <ReferenceBadge
        data={ref({
          refType: "skill",
          id: "reviewer",
          label: "Reviewer",
          meta: { scope: "expert", invocationPrefix: "/" },
        })}
      />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveAttribute("data-ref-type", "skill")
    // Experts are no longer distinguished — same rose color, command glyph.
    expect(badge).toHaveClass("text-rose-700")
    expect(container.querySelector(".lucide-command")).not.toBeNull()
    expect(container.querySelector(".lucide-sparkles")).toBeNull()
  })
})
