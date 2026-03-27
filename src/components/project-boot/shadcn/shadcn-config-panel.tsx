"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  BASE_OPTIONS,
  STYLE_OPTIONS,
  BASE_COLOR_OPTIONS,
  THEME_OPTIONS,
  ICON_LIBRARY_OPTIONS,
  FONT_OPTIONS,
  FONT_HEADING_OPTIONS,
  MENU_ACCENT_OPTIONS,
  MENU_COLOR_OPTIONS,
  RADIUS_OPTIONS,
  TEMPLATE_OPTIONS,
  type ShadcnPresetConfig,
} from "./constants"
import { CreateProjectDialog } from "./create-project-dialog"

interface ShadcnConfigPanelProps {
  config: ShadcnPresetConfig
  onConfigChange: (key: keyof ShadcnPresetConfig, value: string) => void
  presetCode: string
}

type ConfigI18nKey =
  | "config.base"
  | "config.style"
  | "config.baseColor"
  | "config.theme"
  | "config.chartColor"
  | "config.iconLibrary"
  | "config.font"
  | "config.fontHeading"
  | "config.menuAccent"
  | "config.menuColor"
  | "config.radius"
  | "config.template"

const CONFIG_FIELDS: {
  key: keyof ShadcnPresetConfig
  i18nKey: ConfigI18nKey
  options: { value: string; label: string }[]
}[] = [
  { key: "base", i18nKey: "config.base", options: BASE_OPTIONS },
  { key: "style", i18nKey: "config.style", options: STYLE_OPTIONS },
  { key: "baseColor", i18nKey: "config.baseColor", options: BASE_COLOR_OPTIONS },
  { key: "theme", i18nKey: "config.theme", options: THEME_OPTIONS },
  { key: "chartColor", i18nKey: "config.chartColor", options: THEME_OPTIONS },
  {
    key: "iconLibrary",
    i18nKey: "config.iconLibrary",
    options: ICON_LIBRARY_OPTIONS,
  },
  { key: "font", i18nKey: "config.font", options: FONT_OPTIONS },
  {
    key: "fontHeading",
    i18nKey: "config.fontHeading",
    options: FONT_HEADING_OPTIONS,
  },
  { key: "menuAccent", i18nKey: "config.menuAccent", options: MENU_ACCENT_OPTIONS },
  { key: "menuColor", i18nKey: "config.menuColor", options: MENU_COLOR_OPTIONS },
  { key: "radius", i18nKey: "config.radius", options: RADIUS_OPTIONS },
  { key: "template", i18nKey: "config.template", options: TEMPLATE_OPTIONS },
]

export function ShadcnConfigPanel({
  config,
  onConfigChange,
  presetCode,
}: ShadcnConfigPanelProps) {
  const t = useTranslations("ProjectBoot")
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1 px-4 py-3">
        <div className="space-y-3">
          {CONFIG_FIELDS.map((field) => (
            <div key={field.key} className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t(field.i18nKey)}
              </Label>
              <Select
                value={config[field.key]}
                onValueChange={(v) => onConfigChange(field.key, v)}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {field.options.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t px-4 py-3">
        <Button className="w-full" onClick={() => setCreateOpen(true)}>
          {t("config.createProject")}
        </Button>
      </div>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        presetCode={presetCode}
      />
    </div>
  )
}
