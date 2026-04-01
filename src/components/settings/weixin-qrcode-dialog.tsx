"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ExternalLink, Loader2, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { weixinGetQrcode, weixinCheckQrcode } from "@/lib/api"

interface WeixinQrcodeDialogProps {
  open: boolean
  channelId: number
  onOpenChange: (open: boolean) => void
  onAuthSuccess: (channelId: number) => void
}

function WeixinQrcodeContent({
  channelId,
  onAuthSuccess,
  onClose,
}: {
  channelId: number
  onAuthSuccess: (channelId: number) => void
  onClose: () => void
}) {
  const t = useTranslations("ChatChannelSettings")
  const [qrcodeImg, setQrcodeImg] = useState<string | null>(null)
  const [qrcodeUrl, setQrcodeUrl] = useState<string | null>(null)
  const [imgFailed, setImgFailed] = useState(false)
  const [qrcodeId, setQrcodeId] = useState<string | null>(null)
  const [status, setStatus] = useState<"loading" | "waiting" | "expired">(
    "loading"
  )
  const [error, setError] = useState<string | null>(null)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }, [])

  const fetchQrcode = useCallback(async () => {
    setStatus("loading")
    setError(null)
    setQrcodeImg(null)
    setQrcodeUrl(null)
    setImgFailed(false)
    setQrcodeId(null)
    stopPolling()

    try {
      const result = await weixinGetQrcode()
      setQrcodeId(result.qrcode_id)

      if (result.qrcode_img_content) {
        const raw = result.qrcode_img_content
        // Keep the original URL for fallback link
        if (raw.startsWith("http")) {
          setQrcodeUrl(raw)
        }
        const imgSrc = raw.startsWith("data:")
          ? raw
          : raw.startsWith("http")
            ? raw
            : `data:image/png;base64,${raw}`
        setQrcodeImg(imgSrc)
      }

      setStatus("waiting")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setStatus("expired")
    }
  }, [stopPolling])

  // Fetch QR code on mount + cleanup polling on unmount
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    fetchQrcode()
    return () => stopPolling()
  }, [fetchQrcode, stopPolling])

  // Start polling when we have a qrcodeId
  useEffect(() => {
    if (!qrcodeId || status !== "waiting") return

    pollingRef.current = setInterval(async () => {
      try {
        const result = await weixinCheckQrcode(channelId, qrcodeId)
        if (result.status === "confirmed") {
          stopPolling()
          onAuthSuccess(channelId)
          onClose()
        } else if (result.status === "expired") {
          stopPolling()
          setStatus("expired")
        }
      } catch {
        // Polling error — keep trying
      }
    }, 2000)

    return () => stopPolling()
  }, [qrcodeId, status, channelId, stopPolling, onAuthSuccess, onClose])

  return (
    <div className="flex flex-col items-center gap-4 py-4">
      <p className="text-sm text-muted-foreground text-center">
        {t("weixinScanDescription")}
      </p>

      {status === "loading" && (
        <div className="flex h-48 w-48 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {status === "waiting" && qrcodeImg && (
        <>
          {!imgFailed ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrcodeImg}
                alt="WeChat QR Code"
                className="h-48 w-48 rounded-md"
                referrerPolicy="no-referrer"
                onError={() => setImgFailed(true)}
              />
            </>
          ) : qrcodeUrl ? (
            <a
              href={qrcodeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-48 w-48 flex-col items-center justify-center gap-2 rounded-md border border-dashed text-sm text-muted-foreground hover:bg-muted"
            >
              <ExternalLink className="h-6 w-6" />
              {t("weixinOpenQrcode")}
            </a>
          ) : null}
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("weixinWaitingScan")}
          </p>
        </>
      )}

      {status === "expired" && (
        <>
          <div className="flex h-48 w-48 items-center justify-center rounded-md bg-muted">
            <p className="text-sm text-muted-foreground">
              {t("weixinQrcodeExpired")}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchQrcode}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            {t("weixinRefreshQrcode")}
          </Button>
        </>
      )}

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}
    </div>
  )
}

export function WeixinQrcodeDialog({
  open,
  channelId,
  onOpenChange,
  onAuthSuccess,
}: WeixinQrcodeDialogProps) {
  const t = useTranslations("ChatChannelSettings")
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("weixinScanTitle")}</DialogTitle>
        </DialogHeader>
        {open && (
          <WeixinQrcodeContent
            channelId={channelId}
            onAuthSuccess={onAuthSuccess}
            onClose={handleClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
