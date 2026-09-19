import { cp, mkdir, readFile, writeFile, access } from "node:fs/promises"

const source = new URL("../node_modules/monaco-editor/min/vs/", import.meta.url)
const destination = new URL("../public/vs/", import.meta.url)
await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true, force: true })
const loader = new URL("loader.js", destination)
await writeFile(
  loader,
  (await readFile(loader, "utf8")).replace(/\n\/\/# sourceMappingURL=.*/, "")
)
await access(new URL("editor/editor.main.js", destination))
console.log("Local Monaco assets prepared")
