"use client"

import { useEffect, useState } from "react"
import { MessageCircleCode } from "lucide-react"
import { useTranslations } from "next-intl"
import { getCurrentAppVersion } from "@/lib/updater"

export function SoftwareInfo() {
  const t = useTranslations("WelcomePage")
  const [version, setVersion] = useState<string>("")

  useEffect(() => {
    getCurrentAppVersion()
      .then(setVersion)
      .catch((err) => {
        console.error("[Welcome] get app version failed:", err)
      })
  }, [])

  return (
    <div className="w-full flex gap-4 px-6 py-8">
      <MessageCircleCode className="size-12" />
      <div className="flex flex-col">
        <span className="text-base">Codeg</span>
        <span className="text-sm text-muted-foreground">
          {version
            ? t("softwareVersion", { version })
            : t("softwareVersion", { version: "..." })}
        </span>
      </div>
    </div>
  )
}
