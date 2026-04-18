/**
 * Locale-independent patterns that identify a "not a git repository" error
 * from the raw stderr of a failed git invocation.
 *
 * Git translates its error messages via gettext based on the **system**
 * LC_MESSAGES locale, which may differ from the user's browser locale.
 * Detection therefore needs patterns for every language git might emit on
 * the server, not just the one the UI is localized into.
 *
 * These patterns are a belt-and-suspenders fallback. The primary detection
 * path is the typed `not_a_git_repository` error code returned by backend
 * commands wrapped with a filesystem preflight check (see
 * `src-tauri/src/commands/folders.rs::ensure_git_repo`). Patterns only apply
 * when an un-preflighted command leaks raw stderr to the client.
 *
 * Locales covered match git's own gettext translations. Arabic falls back to
 * English in upstream git (no ar translation), so no separate pattern.
 */
export const NOT_A_GIT_REPO_PATTERNS: readonly RegExp[] = [
  /not a git repository/i, // en
  /不是\s*git\s*仓库/i, // zh-CN
  /不是\s*git\s*儲存庫/i, // zh-TW
  /git\s*リポジトリではありません/i, // ja
  /git\s*저장소가\s*아닙니다/i, // ko
  /kein\s*git[-\s]*repository/i, // de
  /pas\s*(?:un|dans\s*un)\s*d[ée]p[oô]t\s*git/i, // fr
  /no\s*es\s*un\s*repositorio\s*git/i, // es
  /n[ãa]o\s*[ée]\s*um\s*reposit[oó]rio\s*git/i, // pt
]
