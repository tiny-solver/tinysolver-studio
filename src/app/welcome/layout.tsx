"use client"

import type { ReactNode } from "react"
import { GitCredentialProvider } from "@/contexts/git-credential-context"

export default function WelcomeLayout({ children }: { children: ReactNode }) {
  return <GitCredentialProvider>{children}</GitCredentialProvider>
}
