import { describe, expect, it } from "vitest"

import {
  effectiveConfig,
  NO_ENGINE_INFO,
  readBehaviors,
  readEngineInfo,
  trimConfig,
  writeBehaviors,
} from "./behaviors"

const info = readEngineInfo({
  type: "codeg:ready",
  version: "0.4.0",
  modes: true,
  scripts: ["float", "patrol", "bad name", 7],
  ops: ["say", "shake"],
  builtins: { float: { amplitude: 12, period: 2 }, "no good": {}, spin: 3 },
})

describe("behaviors", () => {
  it("reads every shape the engine accepts", () => {
    expect(readBehaviors("float")).toEqual([{ name: "float", config: {} }])
    expect(readBehaviors({ name: "patrol", to: 700 })).toEqual([
      { name: "patrol", config: { to: 700 } },
    ])
    expect(
      readBehaviors(["float", { name: "spin", speed: 30 }, 5, {}])
    ).toEqual([
      { name: "float", config: {} },
      { name: "spin", config: { speed: 30 } },
    ])
    expect(readBehaviors(null)).toEqual([])
    expect(readBehaviors(undefined)).toEqual([])
  })

  it("writes the smallest equivalent shape", () => {
    expect(writeBehaviors([])).toBeNull()
    expect(writeBehaviors([{ name: "float", config: {} }])).toBe("float")
    expect(writeBehaviors([{ name: "float", config: { period: 3 } }])).toEqual({
      name: "float",
      period: 3,
    })
    expect(
      writeBehaviors([
        { name: "float", config: {} },
        { name: "no good", config: {} },
        { name: "spin", config: { speed: 30 } },
      ])
    ).toEqual(["float", { name: "spin", speed: 30 }])
  })

  it("round-trips a hand-written value unchanged", () => {
    for (const value of ["float", { name: "patrol", to: 700 }, ["a", "b"]])
      expect(writeBehaviors(readBehaviors(value))).toEqual(value)
  })

  it("shows defaults and stores only overrides", () => {
    const behavior = { name: "float", config: { period: 3 } }
    expect(effectiveConfig(behavior, info)).toEqual({
      amplitude: 12,
      period: 3,
    })
    expect(trimConfig("float", { amplitude: 12, period: 3 }, info)).toEqual({
      period: 3,
    })
    expect(trimConfig("patrol", { to: 700 }, info)).toEqual({ to: 700 })
  })

  it("sanitizes what the engine announces", () => {
    expect(info.scripts).toEqual(["float", "patrol"])
    expect(info.ops).toEqual(["say", "shake"])
    expect(Object.keys(info.builtins)).toEqual(["float"])
    expect(info.modes).toBe(true)
    expect(readEngineInfo("nope")).toBe(NO_ENGINE_INFO)
    expect(readEngineInfo({}).scripts).toEqual([])
  })
})
