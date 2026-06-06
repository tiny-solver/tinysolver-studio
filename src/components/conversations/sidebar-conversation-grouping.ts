import type { DbConversationSummary } from "@/lib/types"
import type { SidebarSortMode } from "@/lib/sidebar-view-mode-storage"

export function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function compareByUpdatedAtDesc(
  left: DbConversationSummary,
  right: DbConversationSummary
): number {
  const updatedDiff =
    parseTimestamp(right.updated_at) - parseTimestamp(left.updated_at)
  if (updatedDiff !== 0) return updatedDiff

  const createdDiff =
    parseTimestamp(right.created_at) - parseTimestamp(left.created_at)
  if (createdDiff !== 0) return createdDiff

  return right.id - left.id
}

export function compareByCreatedAtDesc(
  left: DbConversationSummary,
  right: DbConversationSummary
): number {
  const createdDiff =
    parseTimestamp(right.created_at) - parseTimestamp(left.created_at)
  if (createdDiff !== 0) return createdDiff

  const updatedDiff =
    parseTimestamp(right.updated_at) - parseTimestamp(left.updated_at)
  if (updatedDiff !== 0) return updatedDiff

  return right.id - left.id
}

/**
 * Relative time label (e.g. "5m", "3h", "2d"). `now` is passed in rather than
 * read from `Date.now()` so a whole render tick shares one value: every
 * unchanged row then produces an identical label string and the card `memo`
 * stays hit. The list refreshes `now` once a minute (see
 * `SidebarConversationList`), bounding label staleness without making a single
 * status event re-render every card.
 */
export function formatRelative(iso: string, now: number): string {
  const ts = parseTimestamp(iso)
  if (!ts) return ""
  const diff = Math.max(0, now - ts)
  const m = Math.floor(diff / 60000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo`
  const y = Math.floor(mo / 12)
  return `${y}y`
}

function arraysShallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Return `prev` when `next` has identical string membership, else `next`.
 *
 * `tabs` is rebuilt (new array) on every `conversations` change (tab-context
 * re-derives titles/status), so `openTabKeys` recomputes every status event.
 * Without this reuse the freshly-built Set would be a new reference each time
 * and would defeat the `FolderGroupItem` memo for *every* folder. Content
 * equality keeps the reference stable when the open-tab set is actually
 * unchanged.
 */
export function reuseSet(prev: Set<string>, next: Set<string>): Set<string> {
  if (prev === next) return prev
  if (prev.size !== next.size) return next
  for (const key of next) {
    if (!prev.has(key)) return next
  }
  return prev
}

export interface SelectedConversationRef {
  id: number
  agentType: string
}

/**
 * Return `prev` when it denotes the same conversation as `next`, else `next`.
 * Same motivation as {@link reuseSet}: keeps `selectedConversation` reference
 * stable across the `tabs` churn so unaffected folders stay memoized.
 */
export function reuseSelected(
  prev: SelectedConversationRef | null,
  next: SelectedConversationRef | null
): SelectedConversationRef | null {
  if (
    prev &&
    next &&
    prev.id === next.id &&
    prev.agentType === next.agentType
  ) {
    return prev
  }
  return next
}

/**
 * Group conversations by folder, sorting each bucket, while reusing the
 * previous render's bucket array whenever a folder's sorted membership is
 * referentially unchanged.
 *
 * Reference stability is the whole point: a single `conversation_status_changed`
 * event replaces exactly one summary object (slice + spread in
 * `updateConversationLocal`), so only the touched folder's bucket fails the
 * shallow-equality check and gets a fresh array. Every sibling folder keeps its
 * old array reference, letting a memoized `FolderGroupItem` bail out — and
 * inside the one folder that did change, every unchanged summary keeps its
 * object identity so the card `memo` still bails out for all but the one
 * affected row.
 *
 * `prev` is the map returned by the last call (the caller threads it via a ref).
 */
export function groupByFolderWithReuse(
  filtered: readonly DbConversationSummary[],
  sortMode: SidebarSortMode,
  prev: Map<number, DbConversationSummary[]>
): Map<number, DbConversationSummary[]> {
  const next = new Map<number, DbConversationSummary[]>()
  for (const conv of filtered) {
    const list = next.get(conv.folder_id)
    if (list) list.push(conv)
    else next.set(conv.folder_id, [conv])
  }

  const comparator =
    sortMode === "updated" ? compareByUpdatedAtDesc : compareByCreatedAtDesc
  for (const [folderId, list] of next) {
    list.sort(comparator)
    const prevList = prev.get(folderId)
    // Replacing an existing key's value mid-iteration is safe (we never add or
    // remove keys here).
    if (prevList && arraysShallowEqual(prevList, list)) {
      next.set(folderId, prevList)
    }
  }
  return next
}
