"use client"

import { useEffect } from "react"
import "overlayscrollbars/overlayscrollbars.css"
import { useOverlayScrollbars } from "overlayscrollbars-react"

export function OverlayScrollbarsInit() {
  const [init] = useOverlayScrollbars({
    options: {
      scrollbars: {
        theme: "os-theme-codeg",
        autoHide: "leave",
        clickScroll: true,
      },
      overflow: { x: "hidden" },
    },
    defer: true,
  })

  useEffect(() => {
    init(document.body)
  }, [init])

  return null
}