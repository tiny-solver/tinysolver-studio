"use client"

import { useState } from "react"
import Image from "next/image"
import type { UserImageDisplay } from "@/lib/adapters/ai-elements-adapter"
import { ImagePreviewDialog } from "@/components/ui/image-preview-dialog"

interface UserImageAttachmentsProps {
  images: UserImageDisplay[]
  className?: string
}

export function UserImageAttachments({
  images,
  className,
}: UserImageAttachmentsProps) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)

  if (images.length === 0) return null

  const previewImage =
    previewIndex !== null && previewIndex < images.length
      ? images[previewIndex]
      : null

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-1.5">
        {images.map((image, index) => (
          <button
            key={`${image.uri ?? image.name}-${index}`}
            type="button"
            onClick={() => setPreviewIndex(index)}
            className="cursor-pointer overflow-hidden rounded-md border border-border/70 bg-muted/30 transition-opacity hover:opacity-80"
          >
            <Image
              src={`data:${image.mime_type};base64,${image.data}`}
              alt={image.name}
              width={56}
              height={56}
              unoptimized
              className="h-14 w-14 object-cover"
            />
          </button>
        ))}
      </div>
      <ImagePreviewDialog
        src={
          previewImage
            ? `data:${previewImage.mime_type};base64,${previewImage.data}`
            : ""
        }
        alt={previewImage?.name ?? ""}
        open={previewImage !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewIndex(null)
        }}
      />
    </div>
  )
}
