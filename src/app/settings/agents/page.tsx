"use client"

import { Suspense } from "react"
import { useTranslations } from "next-intl"
import { AcpAgentSettings } from "@/components/settings/acp-agent-settings"
import { DelegationSettingsSection } from "@/components/settings/delegation-settings"

export default function SettingsAgentsPage() {
  const t = useTranslations("SettingsPages")

  return (
    <Suspense
      fallback={
        <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
          {t("agentsLoading")}
        </div>
      }
    >
      <div className="h-full overflow-y-auto">
        <div className="min-h-full flex flex-col">
          <div className="flex-1 min-h-[600px]">
            <AcpAgentSettings />
          </div>
          <div className="shrink-0 px-3 md:px-4 pb-4 pt-0">
            <DelegationSettingsSection />
          </div>
        </div>
      </div>
    </Suspense>
  )
}
