"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { WelcomeScreen } from "@/components/welcome/welcome-screen"

export default function WelcomePage() {
  const t = useTranslations("WelcomePage")

  useEffect(() => {
    document.title = `${t("title")} - codeg`
  }, [t])

  return <WelcomeScreen />
}
