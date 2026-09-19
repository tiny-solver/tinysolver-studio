import {
  MAX_ASSET_BYTES,
  MAX_BUNDLE_BYTES,
  parseDocument,
  type StudioAsset,
  type StudioDocument,
} from "./document"

interface SavedDraft {
  document: StudioDocument
  version: number
}
const DATABASE = "codeg-content-studio-v1"
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore("drafts")
      request.result.createObjectStore("blobs")
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () =>
      reject(new Error("Close other Studio tabs and retry"))
    request.onsuccess = () => resolve(request.result)
  })
}

export async function loadDraft(): Promise<{
  document: StudioDocument
  version: number
  blobs: Map<string, Blob>
} | null> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["drafts", "blobs"], "readonly")
    const request = tx.objectStore("drafts").get("current")
    let result: {
      document: StudioDocument
      version: number
      blobs: Map<string, Blob>
    } | null = null
    let failure: unknown
    request.onsuccess = () => {
      if (!request.result) return
      try {
        const saved = request.result as SavedDraft
        result = {
          document: parseDocument(saved.document),
          version: saved.version,
          blobs: new Map(),
        }
        for (const asset of result.document.assets) {
          const read = tx.objectStore("blobs").get(asset.id)
          read.onsuccess = () => {
            if (
              !(read.result instanceof Blob) ||
              read.result.size !== asset.size
            ) {
              failure = new Error(`Missing asset: ${asset.name}`)
              tx.abort()
            } else result?.blobs.set(asset.id, read.result)
          }
        }
      } catch (error) {
        failure = error
        tx.abort()
      }
    }
    tx.oncomplete = () => {
      db.close()
      resolve(result)
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(failure ?? tx.error ?? new Error("Cannot load draft"))
    }
  })
}

/** Atomically save metadata and bytes, rejecting stale writes from other tabs. */
export async function saveDraft(
  document: StudioDocument,
  blobs: Map<string, Blob>,
  expectedVersion: number
): Promise<number> {
  const validated = parseDocument(document)
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["drafts", "blobs"], "readwrite")
    let failure: unknown
    const drafts = tx.objectStore("drafts")
    const request = drafts.get("current")
    request.onsuccess = () => {
      if ((request.result?.version ?? 0) !== expectedVersion) {
        failure = new Error(
          "Another tab changed this draft. Export your changes, then reload."
        )
        tx.abort()
        return
      }
      for (const asset of validated.assets) {
        const blob = blobs.get(asset.id)
        if (!blob || blob.size !== asset.size) {
          failure = new Error(`Missing asset: ${asset.name}`)
          tx.abort()
          return
        }
        tx.objectStore("blobs").put(blob, asset.id)
      }
      drafts.put(
        { document: validated, version: expectedVersion + 1 },
        "current"
      )
    }
    tx.oncomplete = () => {
      db.close()
      resolve(expectedVersion + 1)
    }
    tx.onabort = tx.onerror = () => {
      db.close()
      reject(failure ?? tx.error ?? new Error("Cannot save draft"))
    }
  })
}

export async function inspectImage(
  blob: Blob,
  name: string
): Promise<StudioAsset> {
  if (!blob.size || blob.size > MAX_ASSET_BYTES)
    throw new Error("Images must be smaller than 10 MB")
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let mime: StudioAsset["mime"]
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)
    mime = "image/png"
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    mime = "image/jpeg"
  else if (
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  )
    mime = "image/webp"
  else throw new Error("Choose a PNG, JPEG or WebP image")
  const bitmap = await createImageBitmap(blob)
  const { width, height } = bitmap
  bitmap.close()
  if (width > 8192 || height > 8192 || width * height > 16_777_216)
    throw new Error("Image dimensions exceed the preview limit")
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  const id = Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")
  return {
    id,
    name: name.slice(0, 255) || "Image",
    mime,
    width,
    height,
    size: blob.size,
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(blob)
  })
}

export async function exportBundle(
  document: StudioDocument,
  blobs: Map<string, Blob>
): Promise<string> {
  const data: Record<string, string> = {}
  for (const asset of document.assets) {
    const blob = blobs.get(asset.id)
    if (!blob) throw new Error(`Missing asset: ${asset.name}`)
    data[asset.id] = await blobToDataUrl(blob)
  }
  return JSON.stringify(
    { format: "codeg-studio", document, blobs: data },
    null,
    2
  )
}

export async function importBundle(
  text: string
): Promise<{ document: StudioDocument; blobs: Map<string, Blob> }> {
  if (new Blob([text]).size > MAX_BUNDLE_BYTES)
    throw new Error("Bundle exceeds 32 MB")
  const input = JSON.parse(text)
  if (input?.format !== "codeg-studio") throw new Error("Not a Studio bundle")
  const document = parseDocument(input.document)
  const blobs = new Map<string, Blob>()
  for (const asset of document.assets) {
    const data = input.blobs?.[asset.id]
    if (
      typeof data !== "string" ||
      !data.startsWith(`data:${asset.mime};base64,`)
    )
      throw new Error("Invalid image payload")
    const bytes = Uint8Array.from(atob(data.split(",")[1]), (c) =>
      c.charCodeAt(0)
    )
    const blob = new Blob([bytes], { type: asset.mime })
    const inspected = await inspectImage(blob, asset.name)
    if (
      inspected.id !== asset.id ||
      inspected.size !== asset.size ||
      inspected.width !== asset.width ||
      inspected.height !== asset.height ||
      inspected.mime !== asset.mime
    )
      throw new Error("Image content does not match its metadata")
    blobs.set(asset.id, blob)
  }
  return { document, blobs }
}

export function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" })
  )
  const anchor = window.document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
