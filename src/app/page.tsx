"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { isDesktop } from "@/lib/platform"

export default function Page() {
  const router = useRouter()
  useEffect(() => {
    if (isDesktop()) {
      router.replace("/workspace")
      return
    }
    // Web mode: validate token before entering app
    const token = localStorage.getItem("codeg_token")
    if (!token) {
      router.replace("/login")
      return
    }
    // Verify token is still valid
    fetch("/api/health", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    })
      .then((res) => {
        if (res.ok) {
          router.replace("/workspace")
        } else {
          localStorage.removeItem("codeg_token")
          router.replace("/login")
        }
      })
      .catch(() => {
        // Server unreachable
        localStorage.removeItem("codeg_token")
        router.replace("/login")
      })
  }, [router])
  return null
}
