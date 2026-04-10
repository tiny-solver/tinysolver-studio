"use client"

import { useEffect, useMemo, useState } from "react"

import { expertsListForAgent } from "@/lib/api"
import type { AgentType, ExpertListItem } from "@/lib/types"

const agentCache = new Map<AgentType, ExpertListItem[]>()
const inflightMap = new Map<AgentType, Promise<ExpertListItem[]>>()

const EMPTY: ExpertListItem[] = []

export function useAgentExperts(agentType: AgentType | null): ExpertListItem[] {
  const cached = useMemo(
    () => (agentType ? (agentCache.get(agentType) ?? null) : null),
    [agentType]
  )
  // Track which agent type the fetched result belongs to so stale data
  // from a previous agent is never returned after a switch.
  const [fetched, setFetched] = useState<{
    agentType: AgentType
    experts: ExpertListItem[]
  } | null>(null)

  useEffect(() => {
    if (!agentType || agentCache.has(agentType)) return

    let cancelled = false
    let promise = inflightMap.get(agentType)
    if (!promise) {
      promise = expertsListForAgent(agentType)
        .then((list) => {
          agentCache.set(agentType, list)
          inflightMap.delete(agentType)
          return list
        })
        .catch((err) => {
          inflightMap.delete(agentType)
          console.warn("[useAgentExperts] failed:", err)
          return EMPTY
        })
      inflightMap.set(agentType, promise)
    }

    promise.then((list) => {
      if (!cancelled) setFetched({ agentType, experts: list })
    })

    return () => {
      cancelled = true
    }
  }, [agentType])

  if (!agentType) return EMPTY
  if (cached) return cached
  if (fetched && fetched.agentType === agentType) return fetched.experts
  return EMPTY
}

export function invalidateAgentExpertsCache(agentType?: AgentType) {
  if (agentType) {
    agentCache.delete(agentType)
    inflightMap.delete(agentType)
  } else {
    agentCache.clear()
    inflightMap.clear()
  }
}
