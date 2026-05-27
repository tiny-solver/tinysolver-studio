import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(
  resolve(process.cwd(), "src/components/layout/aux-panel-file-tree-tab.tsx"),
  "utf8"
)

describe("aux-panel-file-tree-tab external conflict reload wiring", () => {
  it("invokes openFilePreview with { reload: true } from handleReloadExternalConflict", () => {
    const startMarker = "const handleReloadExternalConflict = useCallback("
    const start = source.indexOf(startMarker)
    expect(start).toBeGreaterThan(-1)

    // The callback body ends with the closing of useCallback's dependency
    // array. Scan to the next "}, [" which closes the inner arrow function
    // and starts the deps array — that bounds the callback we care about.
    const end = source.indexOf("}, [", start)
    expect(end).toBeGreaterThan(start)

    const block = source.slice(start, end)

    // openFilePreview must be invoked with the explicit reload option so the
    // user's "Reload" choice bypasses the workspace-context cache hit and
    // actually re-reads from disk, discarding the dirty buffer.
    expect(block).toMatch(
      /openFilePreview\([^)]*externalConflictPrompt\.path[^)]*\{[^}]*reload:\s*true[^}]*\}/
    )
  })
})

describe("aux-panel-file-tree-tab workspace-change watcher coverage", () => {
  it("destructures the background-reload and stale APIs from the workspace context", () => {
    // Catching external changes for non-active tabs requires both APIs.
    // Source-grep them so a future refactor cannot silently regress to
    // active-tab-only behavior by dropping the imports.
    expect(source).toMatch(/\breloadOpenFileBackground\b/)
    expect(source).toMatch(/\bmarkTabsStale\b/)
  })

  it("iterates fileTabs in the workspace-seq watcher effect, not just the active tab", () => {
    // Locate the seq-gated watcher effect.
    const guardIdx = source.indexOf("previousWorkspaceSeqRef.current = nextSeq")
    expect(guardIdx).toBeGreaterThan(-1)

    // Find the end of the surrounding useEffect callback. The effect body
    // ends at the next "}, [" that opens the dependency array.
    const effectEnd = source.indexOf("}, [", guardIdx)
    expect(effectEnd).toBeGreaterThan(guardIdx)

    const effectBody = source.slice(guardIdx, effectEnd)

    // The watcher must visit every open file tab; a literal iteration over
    // the workspace tab list is the simplest invariant to lock. Accept the
    // ref-flavored reading (fileTabsRef.current) used to guarantee the
    // latest snapshot after async settles.
    expect(effectBody).toMatch(
      /\bfor\s*\(\s*const\s+\w+\s+of\s+fileTabs(?:Ref\.current)?\b/
    )
  })
})
