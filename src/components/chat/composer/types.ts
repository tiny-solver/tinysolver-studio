import type { AgentType } from "@/lib/types"

/** The five kinds of inline reference the composer can embed. */
export type ReferenceKind = "file" | "agent" | "session" | "commit" | "skill"

export const REFERENCE_KINDS: readonly ReferenceKind[] = [
  "file",
  "agent",
  "session",
  "commit",
  "skill",
]

/**
 * Type-specific render hints carried alongside a reference. All fields are
 * optional — the badge reads only what its `refType` needs, and serialization
 * never depends on `meta`.
 */
export interface ReferenceMeta {
  /** file: whether the entry is a directory. */
  fileKind?: "file" | "dir"
  /** agent/session: agent type, drives the icon. */
  agentType?: AgentType
  /** agent: whether the agent is currently available. */
  available?: boolean
  /** session: conversation status (drives the status dot). */
  status?: string
  /** session: git branch. */
  branch?: string | null
  /** commit: short hash for display. */
  shortHash?: string
  /** commit: first line of the commit message. */
  message?: string
  /** commit: author name. */
  author?: string
  /** commit: whether the commit is pushed upstream. */
  pushed?: boolean | null
  /** skill: "global" | "project" scope. */
  scope?: string
  /** skill: category grouping. */
  category?: string
  /** skill: lucide icon name. */
  icon?: string | null
}

/**
 * The attribute payload stored on a `reference` ProseMirror node. Mirrors the
 * data the `@` panel collects per source and the badge renders.
 */
export interface ReferenceAttrs {
  refType: ReferenceKind
  /**
   * Stable identity: file relative path / agent_type / session id /
   * commit full hash / skill id.
   */
  id: string
  /** Human-readable display label. */
  label: string
  /**
   * Serialization URI (`file://…` / `codeg://…`) used when sending, or null for
   * agents and skills which serialize to plain text.
   */
  uri: string | null
  /** Type-specific render hints; see {@link ReferenceMeta}. */
  meta: ReferenceMeta | null
}
