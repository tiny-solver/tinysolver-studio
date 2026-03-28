import { computeLineDiff, type DiffHunk } from "@/components/merge/merge-diff"

/**
 * Maximum product of line counts before falling back to naive diff.
 * Avoids O(n*m) LCS blowup for very large inputs.
 */
const LCS_PAIR_BUDGET = 200_000

/**
 * Generate a unified diff string from old and new text.
 *
 * Uses LCS-based line diff when within budget, falls back to
 * simple "all deletions then all additions" for very large inputs.
 */
export function generateUnifiedDiff(
  oldText: string,
  newText: string,
  filePath?: string,
  contextLines: number = 3
): string | null {
  if (!oldText && !newText) return null
  if (oldText === newText) return null

  const oldLines = oldText ? splitLines(oldText) : []
  const newLines = newText ? splitLines(newText) : []

  const path = filePath ?? "file"
  const header = `--- a/${path}\n+++ b/${path}`

  // Performance gate: fall back to naive diff for large inputs
  if (oldLines.length * newLines.length > LCS_PAIR_BUDGET) {
    return buildNaiveDiff(header, oldLines, newLines)
  }

  const hunks = computeLineDiff(oldLines, newLines)
  if (hunks.length === 0) return null

  const unifiedHunks = buildUnifiedHunks(oldLines, hunks, contextLines)

  return `${header}\n${unifiedHunks}`
}

function splitLines(text: string): string[] {
  const lines = text.split("\n")
  // Remove trailing empty line from trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop()
  }
  return lines
}

/**
 * Naive diff: all deletions first, then all additions, with a single hunk header.
 * Used as fallback when inputs are too large for LCS.
 */
function buildNaiveDiff(
  header: string,
  oldLines: string[],
  newLines: string[]
): string {
  const oldStart = oldLines.length === 0 ? 0 : 1
  const newStart = newLines.length === 0 ? 0 : 1
  const hunkHeader = `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`

  const parts = [header, hunkHeader]
  for (const line of oldLines) parts.push(`-${line}`)
  for (const line of newLines) parts.push(`+${line}`)
  return parts.join("\n")
}

/**
 * Convert DiffHunk[] into unified diff text with context lines and hunk headers.
 *
 * Groups nearby hunks that overlap in their context windows into a single
 * unified hunk, producing output similar to `diff -u`.
 */
function buildUnifiedHunks(
  oldLines: string[],
  hunks: DiffHunk[],
  contextLines: number
): string {
  // Build "change regions" with context, then merge overlapping ones
  const regions = hunks.map((hunk) => ({
    // Context-expanded range in old lines
    ctxOldStart: Math.max(0, hunk.baseStart - contextLines),
    ctxOldEnd: Math.min(
      oldLines.length,
      hunk.baseStart + hunk.baseCount + contextLines
    ),
    hunk,
  }))

  // Merge overlapping regions
  const merged: {
    ctxOldStart: number
    ctxOldEnd: number
    hunks: DiffHunk[]
  }[] = []

  for (const region of regions) {
    const last = merged[merged.length - 1]
    if (last && region.ctxOldStart <= last.ctxOldEnd) {
      // Overlapping — extend and add hunk
      last.ctxOldEnd = Math.max(last.ctxOldEnd, region.ctxOldEnd)
      last.hunks.push(region.hunk)
    } else {
      merged.push({
        ctxOldStart: region.ctxOldStart,
        ctxOldEnd: region.ctxOldEnd,
        hunks: [region.hunk],
      })
    }
  }

  // Render each merged region as a unified hunk
  const output: string[] = []

  for (const group of merged) {
    const lines: string[] = []
    let oldCursor = group.ctxOldStart
    let newLineCount = 0
    const oldLineCount = group.ctxOldEnd - group.ctxOldStart

    for (const hunk of group.hunks) {
      // Context lines before this change
      while (oldCursor < hunk.baseStart) {
        lines.push(` ${oldLines[oldCursor]}`)
        newLineCount++
        oldCursor++
      }

      // Deleted lines
      for (let i = 0; i < hunk.baseCount; i++) {
        lines.push(`-${oldLines[hunk.baseStart + i]}`)
        oldCursor++
      }

      // Added lines
      for (const newLine of hunk.newLines) {
        lines.push(`+${newLine}`)
        newLineCount++
      }
    }

    // Trailing context
    while (oldCursor < group.ctxOldEnd) {
      lines.push(` ${oldLines[oldCursor]}`)
      newLineCount++
      oldCursor++
    }

    // Compute hunk header
    const oldStart = oldLineCount === 0 ? 0 : group.ctxOldStart + 1
    const newStart =
      newLineCount === 0
        ? 0
        : group.ctxOldStart +
          1 +
          computeNewOffset(group.hunks, group.ctxOldStart)

    output.push(
      `@@ -${oldStart},${oldLineCount} +${newStart},${newLineCount} @@`
    )
    output.push(...lines)
  }

  return output.join("\n")
}

/**
 * Compute the offset applied to new-line numbering by hunks before a given position.
 */
function computeNewOffset(hunks: DiffHunk[], beforeOldLine: number): number {
  let offset = 0
  for (const hunk of hunks) {
    if (hunk.baseStart >= beforeOldLine) break
    offset += hunk.newLines.length - hunk.baseCount
  }
  return offset
}
