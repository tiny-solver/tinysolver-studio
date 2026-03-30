"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Loader2,
  MessageCircle,
  Plus,
  Power,
  PowerOff,
  TestTube,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  listChatChannels,
  deleteChatChannel,
  connectChatChannel,
  disconnectChatChannel,
  testChatChannel,
  updateChatChannel,
  getChatChannelStatus,
} from "@/lib/api"
import type { ChatChannelInfo, ChannelStatusInfo } from "@/lib/types"
import { AddChatChannelDialog } from "./add-chat-channel-dialog"

export function ChatChannelSettings() {
  const t = useTranslations("ChatChannelSettings")
  const [channels, setChannels] = useState<ChatChannelInfo[]>([])
  const [statuses, setStatuses] = useState<ChannelStatusInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ChatChannelInfo | null>(null)
  const [actionLoading, setActionLoading] = useState<number | null>(null)

  const loadChannels = useCallback(async () => {
    try {
      const [chs, sts] = await Promise.all([
        listChatChannels(),
        getChatChannelStatus().catch(() => []),
      ])
      setChannels(chs)
      setStatuses(sts)
    } catch (err) {
      toast.error(t("loadFailed"))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadChannels().catch(console.error)
  }, [loadChannels])

  const handleToggleEnabled = useCallback(
    async (ch: ChatChannelInfo) => {
      try {
        await updateChatChannel({ id: ch.id, enabled: !ch.enabled })
        await loadChannels()
      } catch (err) {
        toast.error(t("saveFailed"))
      }
    },
    [loadChannels, t],
  )

  const handleConnect = useCallback(
    async (id: number) => {
      setActionLoading(id)
      try {
        await connectChatChannel(id)
        toast.success(t("connectSuccess"))
        await loadChannels()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(t("connectFailed") + ": " + msg)
      } finally {
        setActionLoading(null)
      }
    },
    [loadChannels, t],
  )

  const handleDisconnect = useCallback(
    async (id: number) => {
      setActionLoading(id)
      try {
        await disconnectChatChannel(id)
        toast.success(t("disconnectSuccess"))
        await loadChannels()
      } catch (err) {
        toast.error(t("disconnectFailed"))
      } finally {
        setActionLoading(null)
      }
    },
    [loadChannels, t],
  )

  const handleTest = useCallback(
    async (id: number) => {
      setActionLoading(id)
      try {
        await testChatChannel(id)
        toast.success(t("testSuccess"))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(t("testFailed") + ": " + msg)
      } finally {
        setActionLoading(null)
      }
    },
    [t],
  )

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await deleteChatChannel(deleteTarget.id)
      toast.success(t("deleteSuccess"))
      setDeleteTarget(null)
      await loadChannels()
    } catch (err) {
      toast.error(t("deleteFailed"))
    }
  }, [deleteTarget, loadChannels, t])

  const getChannelStatus = (id: number) =>
    statuses.find((s) => s.channel_id === id)?.status ?? "disconnected"

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="w-full space-y-4">
        <section className="space-y-1">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-sm font-semibold">{t("sectionTitle")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("sectionDescription")}
              </p>
            </div>
            <Button size="sm" onClick={() => setAddDialogOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              {t("addChannel")}
            </Button>
          </div>
        </section>

        {channels.length === 0 ? (
          <section className="rounded-xl border bg-card p-8 text-center">
            <MessageCircle className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">
              {t("noChannels")}
            </p>
          </section>
        ) : (
          <section className="space-y-2">
            {channels.map((ch) => {
              const status = getChannelStatus(ch.id)
              const isConnected = status === "connected"
              const isLoading = actionLoading === ch.id

              return (
                <div
                  key={ch.id}
                  className="rounded-xl border bg-card p-4 flex items-center gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{ch.name}</span>
                      <Badge variant="outline" className="text-xs">
                        {ch.channel_type}
                      </Badge>
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          isConnected
                            ? "bg-green-500"
                            : status === "connecting"
                              ? "bg-yellow-500 animate-pulse"
                              : status === "error"
                                ? "bg-red-500"
                                : "bg-gray-400"
                        }`}
                      />
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      {ch.daily_report_enabled && (
                        <span className="text-xs text-muted-foreground">
                          {t("dailyReport")}: {ch.daily_report_time || "18:00"}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Switch
                      checked={ch.enabled}
                      onCheckedChange={() => handleToggleEnabled(ch)}
                    />
                    {isConnected ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isLoading}
                        onClick={() => handleDisconnect(ch.id)}
                      >
                        {isLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <PowerOff className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isLoading || !ch.enabled}
                        onClick={() => handleConnect(ch.id)}
                      >
                        {isLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Power className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isLoading}
                      onClick={() => handleTest(ch.id)}
                    >
                      <TestTube className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(ch)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </section>
        )}
      </div>

      <AddChatChannelDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onChannelAdded={loadChannels}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmMessage")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
