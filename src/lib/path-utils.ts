export function joinFsPath(basePath: string, relPath: string): string {
  if (!relPath) return basePath
  const separator = basePath.includes("\\") ? "\\" : "/"
  const normalizedRel = relPath.replace(/[\\/]/g, separator)
  if (basePath.endsWith("/") || basePath.endsWith("\\")) {
    return `${basePath}${normalizedRel}`
  }
  return `${basePath}${separator}${normalizedRel}`
}
