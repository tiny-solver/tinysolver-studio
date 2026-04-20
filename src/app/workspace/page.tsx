"use client"

import { ConversationDetailPanel } from "@/components/conversations/conversation-detail-panel"
import { useAppWorkspace } from "@/contexts/app-workspace-context"
import { WorkspaceEmpty } from "@/components/workspace-empty/workspace-empty"

export default function WorkspacePage() {
  const { folders, foldersHydrated } = useAppWorkspace()

  if (foldersHydrated && folders.length === 0) {
    return <WorkspaceEmpty />
  }

  return <ConversationDetailPanel />
}
