import { describe, expect, it } from "vitest"
import {
  addCommand,
  findItem,
  freeId,
  sampleKeys,
  snapTime,
  type FilmSet,
} from "./film-set"

const set: FilmSet = {
  schema: 1,
  id: "cafe",
  name: "cafe",
  fps: 24,
  duration: 15,
  frame: { width: 720, height: 1280 },
  stage: {
    floor: { size: 30, color: "#d9d2c5" },
    background: "#ebe6de",
    ambient: 0.6,
  },
  props: [
    { id: "crate", asset: "crate", position: [0, 0, 0], rotation: [0, 0, 0] },
  ],
  actors: [],
  lights: [],
  cameras: [
    {
      id: "cam_a",
      lens: 35,
      ease: "smooth",
      keys: [
        { t: 1, position: [0, 0, 0], target: [0, 0, 0] },
        { t: 3, position: [10, 0, 0], target: [0, 2, 0] },
      ],
    },
  ],
}

describe("film set helpers", () => {
  it("samples keys with the same rule as studio_set.rs", () => {
    const cam = set.cameras[0]
    expect(sampleKeys(cam, 0)?.position).toEqual([0, 0, 0])
    expect(sampleKeys(cam, 2)?.position).toEqual([5, 0, 0])
    expect(sampleKeys(cam, 1.5)?.position[0]).toBeCloseTo(1.5625)
    expect(sampleKeys({ ...cam, ease: "linear" }, 1.5)?.position[0]).toBe(2.5)
    expect(sampleKeys(cam, 9)?.target).toEqual([0, 2, 0])
    const actor = {
      rotation: [0, 30, 0] as [number, number, number],
      ease: "linear" as const,
      keys: [
        { t: 0, position: [0, 0, 0] as [number, number, number], yaw: 90 },
        { t: 2, position: [2, 0, 0] as [number, number, number] },
      ],
    }
    expect(sampleKeys(actor, 1)?.yaw).toBe(60)
    expect(sampleKeys({}, 0)).toBeNull()
  })

  it("snaps time to the frame grid inside the duration", () => {
    expect(snapTime(set, 1.01)).toBe(1)
    expect(snapTime(set, 1.03)).toBe(1.042)
    expect(snapTime(set, 99)).toBe(15)
    expect(snapTime(set, -1)).toBe(0)
  })

  it("makes free ids and add commands", () => {
    expect(freeId(set, "crate")).toBe("crate-2")
    expect(freeId(set, "Big Box!")).toBe("big-box")
    const cam = addCommand(set, "camera") as {
      item: { id: string; keys: unknown[] }
    }
    expect(cam.item.id).toBe("cam_b")
    expect(cam.item.keys).toHaveLength(1)
    const actor = addCommand(set, "actor", "mina-rig") as {
      item: { asset: string }
    }
    expect(actor.item.asset).toBe("mina-rig")
    expect(findItem(set, "cam_a")?.kind).toBe("camera")
    expect(findItem(set, "nope")).toBeNull()
  })
})
