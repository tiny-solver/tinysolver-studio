"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { formatDistanceToNow } from "date-fns"
import { enUS, zhCN, zhTW } from "date-fns/locale"
import { File, Folder } from "lucide-react"
import ig from "ignore"
import { useLocale, useTranslations } from "next-intl"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useFolderContext } from "@/contexts/folder-context"
import { useTabContext } from "@/contexts/tab-context"
import { useWorkspaceContext } from "@/contexts/workspace-context"
import {
  getFileTree,
  listFolderConversations,
  readFilePreview,
} from "@/lib/api"
import type {
  AgentType,
  ConversationStatus,
  DbConversationSummary,
  FileTreeNode,
} from "@/lib/types"
import { AGENT_LABELS, STATUS_COLORS, compareAgentType } from "@/lib/types"
import { AgentIcon } from "@/components/agent-icon"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { cn } from "@/lib/utils"

type SearchTab = "conversations" | "files"

interface FlatFileEntry {
  name: string
  /** Relative path from folder root (same as FileTreeNode.path) */
  relativePath: string
  kind: "file" | "dir"
  /** Pre-computed lowercase relativePath for filtering */
  lowerPath: string
  /** Pre-computed lowercase name for filtering */
  lowerName: string
}

function flattenTree(nodes: FileTreeNode[]): FlatFileEntry[] {
  const entries: FlatFileEntry[] = []
  function walk(node: FileTreeNode) {
    entries.push({
      name: node.name,
      relativePath: node.path,
      kind: node.kind,
      lowerPath: node.path.toLowerCase(),
      lowerName: node.name.toLowerCase(),
    })
    if (node.kind === "dir" && node.children) {
      for (const child of node.children) {
        walk(child)
      }
    }
  }
  for (const node of nodes) {
    walk(node)
  }
  return entries
}

/** Check whether any ancestor directory of `path` is in `ignoredDirs`. */
function hasIgnoredAncestor(path: string, ignoredDirs: Set<string>): boolean {
  let idx = path.indexOf("/")
  while (idx !== -1) {
    if (ignoredDirs.has(path.slice(0, idx))) return true
    idx = path.indexOf("/", idx + 1)
  }
  return false
}

interface SearchCommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SearchCommandDialog({
  open,
  onOpenChange,
}: SearchCommandDialogProps) {
  const t = useTranslations("Folder.search")
  const locale = useLocale()
  const dateFnsLocale =
    locale === "zh-CN" ? zhCN : locale === "zh-TW" ? zhTW : enUS
  const { folderId, folder, conversations } = useFolderContext()
  const { openTab } = useTabContext()
  const { openFilePreview } = useWorkspaceContext()
  const { revealInFileTree } = useAuxPanelContext()

  const [activeTab, setActiveTab] = useState<SearchTab>("conversations")
  const [query, setQuery] = useState("")
  const [agentFilter, setAgentFilter] = useState<AgentType | null>(null)
  const [results, setResults] = useState<DbConversationSummary[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // File search state
  const [allFiles, setAllFiles] = useState<FlatFileEntry[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const filesLoadedRef = useRef(false)

  const folderPath = folder?.path ?? ""

  // Compute which agent types exist in current folder
  const availableAgents = Array.from(
    new Set(conversations.map((c) => c.agent_type))
  ).sort(compareAgentType)

  // Load file tree when switching to files tab, filtering by .gitignore
  useEffect(() => {
    if (activeTab !== "files" || !folderPath || filesLoadedRef.current) return
    let canceled = false
    setFilesLoading(true)

    async function load() {
      try {
        const tree = await getFileTree(folderPath, 10)
        const flat = flattenTree(tree)

        // Collect all .gitignore files from the tree
        const gitignoreEntries = flat.filter(
          (f) => f.kind === "file" && f.name === ".gitignore"
        )

        // Build matchers keyed by directory prefix
        const matchers: { prefix: string; matcher: ReturnType<typeof ig> }[] =
          []
        await Promise.all(
          gitignoreEntries.map(async (entry) => {
            try {
              const result = await readFilePreview(
                folderPath,
                entry.relativePath
              )
              const lastSlash = entry.relativePath.lastIndexOf("/")
              const dir =
                lastSlash === -1 ? "" : entry.relativePath.slice(0, lastSlash)
              matchers.push({
                prefix: dir ? dir + "/" : "",
                matcher: ig().add(result.content),
              })
            } catch {
              // skip unreadable .gitignore
            }
          })
        )

        // Sort matchers by prefix length (shortest/root first) so that
        // parent rules are evaluated before child rules.
        matchers.sort((a, b) => a.prefix.length - b.prefix.length)

        // Filter: check each entry against all applicable .gitignore matchers
        const ignoredDirs = new Set<string>()
        const filtered = flat.filter((f) => {
          // Skip .gitignore files themselves from results
          if (f.name === ".gitignore") return false
          // If an ancestor directory is already ignored, skip — O(depth) lookup
          if (hasIgnoredAncestor(f.relativePath, ignoredDirs)) return false
          for (const { prefix, matcher } of matchers) {
            if (!f.relativePath.startsWith(prefix)) continue
            const relPath = f.relativePath.slice(prefix.length)
            if (!relPath) continue
            const testPath = f.kind === "dir" ? `${relPath}/` : relPath
            if (matcher.ignores(testPath)) {
              if (f.kind === "dir") ignoredDirs.add(f.relativePath)
              return false
            }
          }
          return true
        })

        if (!canceled) {
          setAllFiles(filtered)
          filesLoadedRef.current = true
        }
      } catch {
        if (!canceled) setAllFiles([])
      } finally {
        if (!canceled) setFilesLoading(false)
      }
    }

    void load()
    return () => {
      canceled = true
    }
  }, [activeTab, folderPath])

  // Filter files by query using pre-computed lowercase fields
  const filteredFiles = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) return allFiles.slice(0, 100)
    const lower = trimmed.toLowerCase()
    const matched: FlatFileEntry[] = []
    for (const f of allFiles) {
      if (f.lowerName.includes(lower) || f.lowerPath.includes(lower)) {
        matched.push(f)
        if (matched.length >= 100) break
      }
    }
    return matched
  }, [allFiles, query])

  const doSearch = useCallback(
    async (q: string, agent: AgentType | null) => {
      if (!q.trim() && !agent) {
        setResults([])
        setSearching(false)
        return
      }
      setSearching(true)
      try {
        const data = await listFolderConversations({
          folder_id: folderId,
          search: q.trim() || null,
          agent_type: agent,
        })
        setResults(data)
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    },
    [folderId]
  )

  // Debounced search on query change (conversations tab only)
  useEffect(() => {
    if (activeTab !== "conversations") return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doSearch(query, agentFilter)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, agentFilter, doSearch, activeTab])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("")
      setAgentFilter(null)
      setResults([])
      setActiveTab("conversations")
      filesLoadedRef.current = false
      setAllFiles([])
    }
  }, [open])

  const handleSelectConversation = useCallback(
    (conv: DbConversationSummary) => {
      openTab(conv.id, conv.agent_type, true)
      onOpenChange(false)
    },
    [openTab, onOpenChange]
  )

  const handleSelectFile = useCallback(
    (entry: FlatFileEntry) => {
      if (entry.kind === "dir") {
        revealInFileTree(entry.relativePath)
      } else {
        // Reveal parent directory in file tree, then open the file
        const lastSlash = entry.relativePath.lastIndexOf("/")
        if (lastSlash > 0) {
          revealInFileTree(entry.relativePath.slice(0, lastSlash))
        }
        openFilePreview(entry.relativePath)
      }
      onOpenChange(false)
    },
    [revealInFileTree, openFilePreview, onOpenChange]
  )

  const placeholder =
    activeTab === "conversations" ? t("placeholder") : t("filePlaceholder")

  return (
    <CommandDialog
      title={t("dialogTitle")}
      open={open}
      onOpenChange={onOpenChange}
      shouldFilter={activeTab === "conversations"}
    >
      {/* Tabs */}
      <div className="flex items-center gap-0 border-b px-3">
        <button
          onClick={() => setActiveTab("conversations")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            activeTab === "conversations"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabConversations")}
          {activeTab === "conversations" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
        <button
          onClick={() => setActiveTab("files")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            activeTab === "files"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabFiles")}
          {activeTab === "files" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
      </div>

      <CommandInput
        placeholder={placeholder}
        value={query}
        onValueChange={setQuery}
      />

      {/* Agent filter (conversations tab only) */}
      {activeTab === "conversations" && availableAgents.length > 1 && (
        <div className="flex items-center gap-1 px-3 py-2 border-b">
          <button
            onClick={() => setAgentFilter(null)}
            className={cn(
              "h-6 text-xs px-2 rounded-md transition-colors",
              agentFilter === null
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("allAgents")}
          </button>
          {availableAgents.map((at) => (
            <button
              key={at}
              onClick={() => setAgentFilter(at)}
              className={cn(
                "flex items-center gap-1.5 h-6 text-xs px-2 rounded-md transition-colors",
                agentFilter === at
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <AgentIcon agentType={at} className="w-3.5 h-3.5" />
              {AGENT_LABELS[at]}
            </button>
          ))}
        </div>
      )}

      <CommandList className="min-h-96">
        {/* Conversations tab */}
        {activeTab === "conversations" && (
          <>
            <CommandEmpty>
              {searching
                ? t("searching")
                : !query.trim() && !agentFilter
                  ? t("typeToSearch")
                  : t("noResults")}
            </CommandEmpty>
            {results.length > 0 && (
              <CommandGroup>
                {results.map((conv) => (
                  <CommandItem
                    key={conv.id}
                    value={`${conv.id}-${conv.title ?? ""}`}
                    onSelect={() => handleSelectConversation(conv)}
                  >
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full shrink-0",
                        STATUS_COLORS[conv.status as ConversationStatus] ??
                          "bg-gray-400"
                      )}
                    />
                    <span className="flex-1 truncate">
                      {conv.title || t("untitledConversation")}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {AGENT_LABELS[conv.agent_type]}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDistanceToNow(new Date(conv.created_at), {
                        addSuffix: true,
                        locale: dateFnsLocale,
                      })}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}

        {/* Files tab */}
        {activeTab === "files" && (
          <>
            <CommandEmpty>
              {filesLoading
                ? t("searching")
                : !query.trim()
                  ? t("typeToSearchFiles")
                  : t("noResults")}
            </CommandEmpty>
            {filteredFiles.length > 0 && (
              <CommandGroup>
                {filteredFiles.map((entry) => (
                  <CommandItem
                    key={entry.relativePath}
                    value={entry.relativePath}
                    onSelect={() => handleSelectFile(entry)}
                  >
                    {entry.kind === "dir" ? (
                      <Folder className="w-4 h-4 shrink-0 text-blue-500" />
                    ) : (
                      <File className="w-4 h-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate">{entry.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0 truncate max-w-48">
                      {entry.relativePath}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
