import { NOT_A_GIT_REPO_PATTERNS } from "@/i18n/git-error-patterns"
import type { AppCommandError } from "@/lib/types"

type ObjectLike = Record<string, unknown>

function asObject(value: unknown): ObjectLike | null {
  return value !== null && typeof value === "object"
    ? (value as ObjectLike)
    : null
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function parseErrorObject(value: unknown): AppCommandError | null {
  const obj = asObject(value)
  if (!obj) return null

  const code = normalizeString(obj.code)
  const message = normalizeString(obj.message)
  const detailRaw = normalizeString(obj.detail)
  const detail = detailRaw ?? null

  if (!code || !message) return null

  return {
    code,
    message,
    detail,
  }
}

export function extractAppCommandError(error: unknown): AppCommandError | null {
  const direct = parseErrorObject(error)
  if (direct) return direct

  const errorObject = asObject(error)
  const message = normalizeString(errorObject?.message)
  if (!message) return null

  try {
    const parsed = JSON.parse(message)
    return parseErrorObject(parsed)
  } catch {
    return null
  }
}

// Must mirror `AppErrorCode::NotAGitRepository` in src-tauri/src/app_error.rs.
// If the backend enum ever renames, both sides must change together.
export const NOT_A_GIT_REPO_CODE = "not_a_git_repository"

export function isNotAGitRepoError(error: unknown): boolean {
  const appError = extractAppCommandError(error)
  if (appError?.code === NOT_A_GIT_REPO_CODE) return true

  const candidates = [appError?.detail, appError?.message]
  return candidates.some(
    (text) =>
      typeof text === "string" &&
      NOT_A_GIT_REPO_PATTERNS.some((pattern) => pattern.test(text))
  )
}

export function toErrorMessage(error: unknown): string {
  const appError = extractAppCommandError(error)
  if (appError) {
    return appError.detail?.trim() || appError.message
  }

  if (error instanceof Error) {
    return error.message.trim()
  }

  if (typeof error === "string") {
    return error.trim()
  }

  try {
    const serialized = JSON.stringify(error)
    return serialized ? serialized.trim() : String(error)
  } catch {
    return String(error)
  }
}
