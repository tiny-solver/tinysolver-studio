"use client"

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import {
  getWorkspaceSnapshot,
  startWorkspaceStateStream,
  stopWorkspaceStateStream,
} from "@/lib/api"
import { subscribe } from "@/lib/platform"
import type {
  FileTreeNode,
  WorkspaceDelta,
  WorkspaceDeltaEnvelope,
  WorkspaceGitEntry,
  WorkspaceSnapshotResponse,
  WorkspaceStateEvent,
} from "@/lib/types"

type WorkspaceHealth = "healthy" | "resyncing" | "degraded"

export interface WorkspaceStateView {
  rootPath: string
  seq: number
  version: number
  health: WorkspaceHealth
  tree: FileTreeNode[]
  git: WorkspaceGitEntry[]
  error: string | null
}

export interface WorkspaceStateResult extends WorkspaceStateView {
  requestResync: (reason?: string) => Promise<void>
}

const WORKSPACE_PROTOCOL_VERSION = 1
const STORE_EVICT_DELAY_MS = 120_000
const STORE_SHUTDOWN_GRACE_MS = 600
const WORKSPACE_DEBUG_LOG = process.env.NODE_ENV === "development"

const EMPTY_STATE: WorkspaceStateView = {
  rootPath: "",
  seq: 0,
  version: WORKSPACE_PROTOCOL_VERSION,
  health: "healthy",
  tree: [],
  git: [],
  error: null,
}

function normalizeComparePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function logWorkspaceDebug(message: string, payload?: Record<string, unknown>) {
  if (!WORKSPACE_DEBUG_LOG) return
  if (payload) {
    console.info(`[WorkspaceStateStore] ${message}`, payload)
    return
  }
  console.info(`[WorkspaceStateStore] ${message}`)
}

function summarizeSnapshot(snapshot: WorkspaceSnapshotResponse) {
  return {
    rootPath: snapshot.root_path,
    seq: snapshot.seq,
    full: snapshot.full,
    deltas: snapshot.deltas.length,
    treeRoots: snapshot.tree_snapshot?.length ?? 0,
    gitEntries: snapshot.git_snapshot?.length ?? 0,
  }
}

function summarizeEvent(event: WorkspaceStateEvent, localSeq: number) {
  return {
    rootPath: event.root_path,
    kind: event.kind,
    eventSeq: event.seq,
    localSeq,
    requiresResync: event.requires_resync,
    payloadKinds: event.payload.map((delta) => delta.kind),
    payloadCount: event.payload.length,
  }
}

function applyDeltaToState(
  state: WorkspaceStateView,
  delta: WorkspaceDelta
): WorkspaceStateView {
  switch (delta.kind) {
    case "tree_replace":
      return { ...state, tree: delta.nodes }
    case "git_replace":
      return { ...state, git: delta.entries }
    case "meta":
      return state
  }
}

function applyDeltaEnvelope(
  state: WorkspaceStateView,
  envelope: WorkspaceDeltaEnvelope
): WorkspaceStateView {
  let next = state
  for (const delta of envelope.payload) {
    next = applyDeltaToState(next, delta)
  }
  return {
    ...next,
    seq: envelope.seq,
    version: WORKSPACE_PROTOCOL_VERSION,
    health: envelope.requires_resync ? "resyncing" : "healthy",
    error: envelope.requires_resync ? "resync requested" : null,
  }
}

function applySnapshot(
  state: WorkspaceStateView,
  snapshot: WorkspaceSnapshotResponse
): WorkspaceStateView {
  if (snapshot.full) {
    if (snapshot.seq < state.seq) {
      return state
    }
    return {
      rootPath: snapshot.root_path,
      seq: snapshot.seq,
      version: snapshot.version,
      health: "healthy",
      tree: snapshot.tree_snapshot ?? [],
      git: snapshot.git_snapshot ?? [],
      error: null,
    }
  }

  let next = state
  const ordered = [...snapshot.deltas].sort(
    (left, right) => left.seq - right.seq
  )

  for (const envelope of ordered) {
    if (envelope.seq <= next.seq) continue
    if (envelope.seq !== next.seq + 1) {
      throw new Error("workspace state delta gap")
    }
    next = applyDeltaEnvelope(next, envelope)
  }

  return {
    ...next,
    seq: Math.max(next.seq, snapshot.seq),
    version: snapshot.version,
    health: "healthy",
    error: null,
  }
}

class WorkspaceStateStore {
  private readonly rootPath: string
  private readonly normalizedRootPath: string
  private listeners = new Set<() => void>()
  private state: WorkspaceStateView
  private refCount = 0
  private started = false
  private starting: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private unlisten: (() => void) | null = null
  private resyncInFlight: Promise<void> | null = null
  private lifecycleId = 0
  private evictionTimer: ReturnType<typeof setTimeout> | null = null
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null
  private hasBaselineSnapshot = false

  constructor(rootPath: string) {
    this.rootPath = rootPath
    this.normalizedRootPath = normalizeComparePath(rootPath)
    this.state = {
      ...EMPTY_STATE,
      rootPath,
    }
  }

  getSnapshot = (): WorkspaceStateView => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  acquire = () => {
    this.cancelPendingShutdown()
    this.cancelEviction()
    this.refCount += 1
    logWorkspaceDebug("acquire", {
      rootPath: this.rootPath,
      refCount: this.refCount,
      started: this.started,
    })
    if (this.refCount === 1) {
      const canReuseLifecycle =
        this.lifecycleId > 0 &&
        (this.started || this.starting !== null || this.stopping !== null)
      if (!canReuseLifecycle) {
        this.lifecycleId += 1
      }
      const lifecycleId = this.lifecycleId
      void this.ensureStarted(lifecycleId)
    }
  }

  release = () => {
    if (this.refCount === 0) return
    this.refCount -= 1
    logWorkspaceDebug("release", {
      rootPath: this.rootPath,
      refCount: this.refCount,
      started: this.started,
    })
    if (this.refCount === 0) {
      const lifecycleId = this.lifecycleId
      this.scheduleShutdown(lifecycleId)
    }
  }

  requestResync = async (reason?: string) => {
    void reason
    if (this.resyncInFlight) {
      logWorkspaceDebug("requestResync skip in-flight", {
        rootPath: this.rootPath,
        reason: reason ?? "unknown",
      })
      return this.resyncInFlight
    }

    const run = async () => {
      const startedAt = performance.now()
      this.patchState((prev) => ({
        ...prev,
        health: "resyncing",
      }))

      try {
        const sinceSeq = this.hasBaselineSnapshot ? this.state.seq : undefined
        logWorkspaceDebug("requestResync start", {
          rootPath: this.rootPath,
          reason: reason ?? "unknown",
          sinceSeq: sinceSeq ?? null,
        })
        const snapshot = await getWorkspaceSnapshot(this.rootPath, sinceSeq)
        this.patchState((prev) => applySnapshot(prev, snapshot))
        if (snapshot.full) {
          this.hasBaselineSnapshot = true
        }
        logWorkspaceDebug("requestResync success", {
          ...summarizeSnapshot(snapshot),
          reason: reason ?? "unknown",
          durationMs: Math.round(performance.now() - startedAt),
        })
      } catch (error) {
        this.patchState((prev) => ({
          ...prev,
          health: "degraded",
          error: toErrorMessage(error),
        }))
        logWorkspaceDebug("requestResync failed", {
          rootPath: this.rootPath,
          reason: reason ?? "unknown",
          durationMs: Math.round(performance.now() - startedAt),
          error: toErrorMessage(error),
        })
      }
    }

    this.resyncInFlight = run().finally(() => {
      this.resyncInFlight = null
    })

    return this.resyncInFlight
  }

  private ensureStarted = async (lifecycleId: number) => {
    if (this.started) return
    if (this.starting) {
      await this.starting
      if (!this.isLifecycleActive(lifecycleId) || this.started) {
        return
      }
      await this.ensureStarted(lifecycleId)
      return
    }

    const start = async () => {
      if (this.stopping) {
        await this.stopping
      }
      if (!this.isLifecycleActive(lifecycleId)) {
        return
      }

      try {
        const streamStartedAt = performance.now()
        logWorkspaceDebug("ensureStarted start stream", {
          rootPath: this.rootPath,
          lifecycleId,
        })
        const initialSnapshot = await startWorkspaceStateStream(this.rootPath)
        if (!this.isLifecycleActive(lifecycleId)) {
          await stopWorkspaceStateStream(this.rootPath).catch(() => {})
          logWorkspaceDebug("ensureStarted aborted after initial snapshot", {
            rootPath: this.rootPath,
            lifecycleId,
          })
          return
        }
        this.patchState((prev) => applySnapshot(prev, initialSnapshot))
        this.hasBaselineSnapshot = true
        logWorkspaceDebug("ensureStarted initial snapshot", {
          ...summarizeSnapshot(initialSnapshot),
          lifecycleId,
          durationMs: Math.round(performance.now() - streamStartedAt),
        })

        const unlisten = await subscribe<WorkspaceStateEvent>(
          "folder://workspace-state-event",
          (event) => {
            if (
              normalizeComparePath(event.root_path) !== this.normalizedRootPath
            ) {
              return
            }
            this.handleEvent(event)
          }
        )
        logWorkspaceDebug("ensureStarted subscribe ready", {
          rootPath: this.rootPath,
          lifecycleId,
        })

        if (!this.isLifecycleActive(lifecycleId)) {
          unlisten()
          await stopWorkspaceStateStream(this.rootPath).catch(() => {})
          return
        }

        this.unlisten = unlisten
        this.started = true
        const catchUpStartedAt = performance.now()
        const catchUpSnapshot = await getWorkspaceSnapshot(
          this.rootPath,
          this.state.seq
        )
        if (!this.isLifecycleActive(lifecycleId)) {
          logWorkspaceDebug("ensureStarted aborted after catch-up snapshot", {
            rootPath: this.rootPath,
            lifecycleId,
          })
          return
        }
        this.patchState((prev) => applySnapshot(prev, catchUpSnapshot))
        logWorkspaceDebug("ensureStarted catch-up snapshot", {
          ...summarizeSnapshot(catchUpSnapshot),
          lifecycleId,
          durationMs: Math.round(performance.now() - catchUpStartedAt),
        })
      } catch (error) {
        this.patchState((prev) => ({
          ...prev,
          health: "degraded",
          error: toErrorMessage(error),
        }))
        logWorkspaceDebug("ensureStarted failed", {
          rootPath: this.rootPath,
          lifecycleId,
          error: toErrorMessage(error),
        })
      }
    }

    this.starting = start().finally(() => {
      this.starting = null
    })

    await this.starting
  }

  private shutdown = async (lifecycleId: number) => {
    void lifecycleId
    this.started = false
    logWorkspaceDebug("shutdown", {
      rootPath: this.rootPath,
      lifecycleId,
    })
    const unlisten = this.unlisten
    this.unlisten = null
    if (unlisten) {
      unlisten()
    }
    await stopWorkspaceStateStream(this.rootPath).catch(() => {})
  }

  private cancelPendingShutdown = () => {
    if (!this.shutdownTimer) return
    clearTimeout(this.shutdownTimer)
    this.shutdownTimer = null
  }

  private scheduleShutdown = (lifecycleId: number) => {
    this.cancelPendingShutdown()
    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null
      if (this.refCount !== 0) {
        logWorkspaceDebug("shutdown grace canceled by new acquire", {
          rootPath: this.rootPath,
          lifecycleId,
          refCount: this.refCount,
        })
        return
      }
      const dispose = async () => {
        await this.shutdown(lifecycleId)
      }
      const stopping = dispose().finally(() => {
        if (this.stopping === stopping) {
          this.stopping = null
        }
        if (this.refCount === 0) {
          this.scheduleEviction()
        }
      })
      this.stopping = stopping
      void stopping
    }, STORE_SHUTDOWN_GRACE_MS)
  }

  private cancelEviction = () => {
    if (!this.evictionTimer) return
    clearTimeout(this.evictionTimer)
    this.evictionTimer = null
  }

  private scheduleEviction = () => {
    this.cancelEviction()
    this.evictionTimer = setTimeout(() => {
      this.evictionTimer = null
      if (this.refCount !== 0) return
      if (this.started || this.starting || this.stopping || this.unlisten)
        return
      deleteStore(this.normalizedRootPath, this)
    }, STORE_EVICT_DELAY_MS)
  }

  private isLifecycleCurrent = (lifecycleId: number) => {
    return this.lifecycleId === lifecycleId
  }

  private isLifecycleActive = (lifecycleId: number) => {
    return this.isLifecycleCurrent(lifecycleId) && this.refCount > 0
  }

  private handleEvent = (event: WorkspaceStateEvent) => {
    logWorkspaceDebug("event received", summarizeEvent(event, this.state.seq))

    if (event.version !== WORKSPACE_PROTOCOL_VERSION) {
      logWorkspaceDebug("event version mismatch", {
        rootPath: this.rootPath,
        eventVersion: event.version,
        expectedVersion: WORKSPACE_PROTOCOL_VERSION,
      })
      void this.requestResync("version_mismatch")
      return
    }

    if (event.requires_resync || event.seq !== this.state.seq + 1) {
      logWorkspaceDebug("event requires resync", {
        rootPath: this.rootPath,
        kind: event.kind,
        eventSeq: event.seq,
        localSeq: this.state.seq,
        requiresResync: event.requires_resync,
      })
      void this.requestResync("seq_gap_or_hint")
      return
    }

    let next = this.state
    for (const delta of event.payload) {
      next = applyDeltaToState(next, delta)
    }

    this.patchState(() => ({
      ...next,
      rootPath: event.root_path,
      seq: event.seq,
      version: event.version,
      health: "healthy",
      error: null,
    }))

    logWorkspaceDebug("event applied", {
      rootPath: event.root_path,
      seq: event.seq,
      treeRoots: next.tree.length,
      gitEntries: next.git.length,
    })
  }

  private patchState = (
    updater:
      | WorkspaceStateView
      | ((prev: WorkspaceStateView) => WorkspaceStateView)
  ) => {
    this.state =
      typeof updater === "function"
        ? (updater as (prev: WorkspaceStateView) => WorkspaceStateView)(
            this.state
          )
        : updater
    this.emit()
  }

  private emit = () => {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

const stores = new Map<string, WorkspaceStateStore>()

function deleteStore(normalizedRootPath: string, store: WorkspaceStateStore) {
  const current = stores.get(normalizedRootPath)
  if (current === store) {
    stores.delete(normalizedRootPath)
  }
}

function getStore(rootPath: string): WorkspaceStateStore {
  const normalized = normalizeComparePath(rootPath)
  const existing = stores.get(normalized)
  if (existing) return existing

  const created = new WorkspaceStateStore(rootPath)
  stores.set(normalized, created)
  return created
}

export function useWorkspaceStateStore(
  rootPath: string | null
): WorkspaceStateResult {
  const store = useMemo(() => {
    if (!rootPath) return null
    return getStore(rootPath)
  }, [rootPath])

  useEffect(() => {
    if (!store || !rootPath) return
    store.acquire()

    return () => {
      store.release()
    }
  }, [rootPath, store])

  const subscribeToStore = useCallback(
    (onStoreChange: () => void) => {
      if (!store) return () => {}
      return store.subscribe(onStoreChange)
    },
    [store]
  )

  const getSnapshot = useCallback(() => {
    if (!store) return EMPTY_STATE
    return store.getSnapshot()
  }, [store])

  const snapshot = useSyncExternalStore(
    subscribeToStore,
    getSnapshot,
    getSnapshot
  )

  const requestResync = useCallback(
    async (reason?: string) => {
      if (!store) return
      await store.requestResync(reason)
    },
    [store]
  )

  if (!rootPath) {
    return {
      ...EMPTY_STATE,
      requestResync,
    }
  }

  return {
    ...snapshot,
    requestResync,
  }
}
