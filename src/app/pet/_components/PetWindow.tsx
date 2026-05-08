"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { getPet, getPetSettings, readPetSpritesheet } from "@/lib/pet/api"
import type { PetDetail, PetSpriteAsset } from "@/lib/pet/types"
import { isDesktop } from "@/lib/transport"
import { PET_FRAME_DURATIONS_MS, type PetState } from "@/lib/pet/animation"
import { usePetState } from "../_hooks/usePetState"
import { usePetDrag } from "../_hooks/usePetDrag"
import { PetSprite } from "./PetSprite"
import { PetMenu } from "./PetMenu"

export interface PetWindowProps {
  petId: string
}

const JUMPING_DURATION_MS = sumDurations("jumping") + 80
const WAVING_DURATION_MS = sumDurations("waving") + 80
const PET_HOVER_ENTER_EVENT = "pet://hover-enter"

function sumDurations(state: PetState): number {
  return PET_FRAME_DURATIONS_MS[state].reduce((acc, d) => acc + d, 0)
}

export function PetWindow({ petId }: PetWindowProps) {
  const t = useTranslations("Pet")
  const [pet, setPet] = useState<PetDetail | null>(null)
  const [asset, setAsset] = useState<PetSpriteAsset | null>(null)
  const [scale, setScale] = useState<number>(1)
  const [error, setError] = useState<string | null>(null)
  const agentState = usePetState()

  // Interaction-driven state takes priority over the agent-driven state so
  // a drag, hover, or click immediately wins over the ambient ACP animation.
  // The override is cleared either by the drag-idle timer (held still during
  // drag) or by the post-action timeout (after waving/jumping finishes).
  const [interactionState, setInteractionState] = useState<PetState | null>(
    null
  )
  const interactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleDragDirection = useCallback((s: PetState | null) => {
    if (interactionTimerRef.current) {
      clearTimeout(interactionTimerRef.current)
      interactionTimerRef.current = null
    }
    setInteractionState(s)
  }, [])

  const playOneShot = useCallback((state: PetState, durationMs: number) => {
    if (interactionTimerRef.current) clearTimeout(interactionTimerRef.current)
    setInteractionState(state)
    interactionTimerRef.current = setTimeout(() => {
      setInteractionState(null)
      interactionTimerRef.current = null
    }, durationMs)
  }, [])

  const handleClick = useCallback(() => {
    playOneShot("jumping", JUMPING_DURATION_MS)
  }, [playOneShot])

  // Hover detection runs in Rust (`spawn_pet_hover_watcher` polls the
  // global cursor position and emits `pet://hover-enter`). Going through
  // the OS window event system from JS is unreliable when the pet isn't
  // the key window, so we listen for the backend event instead.
  useEffect(() => {
    if (!isDesktop()) return
    let unlisten: (() => void) | null = null
    let cancelled = false
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event")
        const off = await listen(PET_HOVER_ENTER_EVENT, () => {
          if (cancelled) return
          playOneShot("waving", WAVING_DURATION_MS)
        })
        if (cancelled) off()
        else unlisten = off
      } catch (err) {
        console.warn("[Pet] hover subscription failed:", err)
      }
    })()
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [playOneShot])

  useEffect(() => {
    return () => {
      if (interactionTimerRef.current) clearTimeout(interactionTimerRef.current)
    }
  }, [])

  const drag = usePetDrag({
    onDragDirection: handleDragDirection,
    onClick: handleClick,
  })

  const renderState: PetState = interactionState ?? agentState

  useEffect(() => {
    let cancelled = false
    setError(null)

    async function load() {
      try {
        const [detail, sprite, config] = await Promise.all([
          getPet(petId),
          readPetSpritesheet(petId),
          getPetSettings(),
        ])
        if (cancelled) return
        setPet(detail)
        setAsset(sprite)
        setScale(config.scale ?? 1)
      } catch (err) {
        if (!cancelled) setError(toMessage(err))
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [petId])

  // Keep the document title clean. macOS hides it via title_bar_style anyway,
  // but server-mode preview shows it.
  useEffect(() => {
    document.title = pet ? `${pet.displayName} - codeg pet` : "codeg pet"
  }, [pet])

  // Fully transparent body so the OS chrome is invisible. Done in JS to keep
  // the global stylesheet untouched.
  useEffect(() => {
    const prevBg = document.body.style.background
    const prevHtmlBg = document.documentElement.style.background
    document.body.style.background = "transparent"
    document.documentElement.style.background = "transparent"
    document.body.classList.add("pet-body")
    return () => {
      document.body.style.background = prevBg
      document.documentElement.style.background = prevHtmlBg
      document.body.classList.remove("pet-body")
    }
  }, [])

  const openManager = () => {
    if (!isDesktop()) return
    void (async () => {
      try {
        const { getTransport } = await import("@/lib/transport")
        await getTransport().call("open_settings_window", {
          section: "appearance",
        })
      } catch (err) {
        console.warn("[Pet] failed to open manager:", err)
      }
    })()
  }

  if (error) {
    return (
      <div
        className="flex h-screen w-screen items-center justify-center text-xs text-destructive"
        style={{ background: "transparent" }}
        title={error}
      >
        {t("loadError")}
      </div>
    )
  }

  if (!pet || !asset) {
    return (
      <div
        className="flex h-screen w-screen items-center justify-center"
        style={{ background: "transparent" }}
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const dataUrl = `data:${asset.mime};base64,${asset.dataBase64}`

  return (
    <div
      className="relative flex h-screen w-screen select-none items-center justify-center"
      style={{ background: "transparent" }}
      onPointerDown={drag.onPointerDown}
    >
      <PetSprite
        spritesheetDataUrl={dataUrl}
        state={renderState}
        scale={scale}
        label={pet.displayName}
      />
      <PetMenu
        scale={scale}
        onScaleChange={setScale}
        onOpenSettings={openManager}
      />
    </div>
  )
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message
    if (typeof m === "string") return m
  }
  return String(err)
}
