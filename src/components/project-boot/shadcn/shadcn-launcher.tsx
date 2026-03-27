"use client"

import { useMemo, useState } from "react"
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable"
import { ShadcnConfigPanel } from "./shadcn-config-panel"
import { ShadcnPreview } from "./shadcn-preview"
import {
  DEFAULT_PRESET_CONFIG,
  encodePreset,
  buildPreviewUrl,
  type ShadcnPresetConfig,
} from "./constants"

export function ShadcnLauncher() {
  const [config, setConfig] = useState<ShadcnPresetConfig>(
    DEFAULT_PRESET_CONFIG
  )

  const presetCode = useMemo(() => encodePreset(config), [config])
  const previewUrl = useMemo(
    () => buildPreviewUrl(config.base, presetCode),
    [config.base, presetCode]
  )

  const updateConfig = (key: keyof ShadcnPresetConfig, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full">
      <ResizablePanel defaultSize={40} minSize={30} maxSize={50}>
        <ShadcnConfigPanel
          config={config}
          onConfigChange={updateConfig}
          presetCode={presetCode}
        />
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel defaultSize={60} minSize={40}>
        <ShadcnPreview previewUrl={previewUrl} />
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
