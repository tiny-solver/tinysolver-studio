"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"

interface ShadcnPreviewProps {
  previewUrl: string
}

export function ShadcnPreview({ previewUrl }: ShadcnPreviewProps) {
  const t = useTranslations("ProjectBoot")
  const [debouncedUrl, setDebouncedUrl] = useState(previewUrl)
  const [loading, setLoading] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }
    timerRef.current = setTimeout(() => {
      setDebouncedUrl(previewUrl)
      setLoading(true)
    }, 500)
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [previewUrl])

  return (
    <div className="relative h-full w-full">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">
            {t("preview.loading")}
          </span>
        </div>
      )}
      <iframe
        key={debouncedUrl}
        src={debouncedUrl}
        className="h-full w-full border-0"
        onLoad={() => setLoading(false)}
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </div>
  )
}
