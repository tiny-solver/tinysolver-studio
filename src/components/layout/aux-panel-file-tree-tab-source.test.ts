import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(
  resolve(
    process.cwd(),
    "src/components/layout/aux-panel-file-tree-tab.tsx"
  ),
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
