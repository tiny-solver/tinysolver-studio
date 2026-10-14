import { describe, expect, it } from "vitest"

import type { NodeRecord, RunRecord } from "@/lib/studio/flows"
import {
  chainOf,
  depths,
  graphFromChain,
  makingGraph,
  portType,
  roleOf,
} from "@/lib/studio/library"
import type { StudioAsset } from "@/lib/types"

const asset = (a: Partial<StudioAsset> & { id: string; file: string }) =>
  ({ exists: true, kind: "model", ...a }) as StudioAsset

const register: StudioAsset[] = [
  asset({
    id: "hero-tpose",
    file: "characters/hero-tpose.png",
    kind: "image",
    source: {
      kind: "image",
      workflow: "qwen-image-21-rgba",
      prompt: "a hero",
      seed: 1014,
    },
  }),
  asset({
    id: "hero-mesh",
    file: "characters/hero-mesh.glb",
    triangles: 20000,
    source: {
      kind: "3d",
      workflow: "trellis2",
      from: "hero-tpose",
      params: { target_faces: 20000 },
    },
  }),
  asset({
    id: "hero-rigged",
    file: "characters/hero-rigged.glb",
    bones: 34,
    source: { kind: "rig", workflow: "skintokens", from: "hero-mesh" },
  }),
  asset({
    id: "hero",
    file: "characters/hero.glb",
    bones: 34,
    animations: 2,
    clips: [
      { name: "Idle", seconds: 2 },
      { name: "Walk", seconds: 1 },
    ],
    source: { kind: "bake", from: "hero-rigged" },
  }),
]

const rec = (
  key: string,
  input: unknown,
  output: unknown,
  extra: Partial<NodeRecord> = {}
) =>
  ({
    key,
    node: key,
    kind: "op",
    status: "done",
    input,
    output,
    started_at: "2026-10-14T04:00:00Z",
    ms: 1000,
    ...extra,
  }) as NodeRecord

const run = (id: string, status: RunRecord["status"], nodes: NodeRecord[]) =>
  ({
    id,
    flow: "char3d",
    status,
    want: { text: "a moving hero" },
    inputs: {},
    started_at: `2026-10-14T0${id === "ok" ? 5 : 4}:00:00Z`,
    ms: 5000,
    cost_usd: 0,
    nodes,
    waiting: [],
    answers: {},
    output: null,
    flow_doc: { steps: [{ id: "n1", note: "그림 만들기" }] },
  }) as RunRecord

const good = run("ok", "done", [
  rec(
    "n1",
    { prompt: "a hero", workflow: "qwen-image-21-rgba", seed: 1014 },
    { image: "assets/characters/hero-tpose.png" }
  ),
  rec(
    "n3",
    {
      image: "assets/characters/hero-tpose.png",
      params: { target_faces: 20000 },
    },
    {
      mesh: "assets/characters/hero-mesh.glb",
      preview: ["runs/char3d/ok/m.jpg"],
    }
  ),
  rec(
    "n4",
    { mesh: "assets/characters/hero-mesh.glb" },
    { rig: "assets/characters/hero-rigged.glb" }
  ),
  rec(
    "n5",
    { rig: "assets/characters/hero-rigged.glb" },
    { limbs: { handL: 8 } }
  ),
  rec(
    "n6",
    { rig: "assets/characters/hero-rigged.glb", limbs: { handL: 8 } },
    { anim: "assets/characters/hero.glb", report: "Walk 1.00 pass", ok: true }
  ),
])
const bad = run("first", "failed", [
  rec(
    "n3",
    { image: "assets/characters/hero-tpose.png" },
    { mesh: "GLB · no arms" }
  ),
  rec(
    "n6",
    { mesh: "GLB · no arms" },
    { report: "Walk −0.05" },
    { status: "failed", note: "body folds" }
  ),
])

describe("3D library", () => {
  it("calls a rigged model a character unless the register says otherwise", () => {
    expect(roleOf(register[3])).toBe("character")
    expect(roleOf(register[1])).toBe("prop")
    expect(roleOf({ ...register[1], role: "scene" })).toBe("scene")
  })

  it("types a port by its key, then by its value", () => {
    const byFile = new Map(register.map((a) => [a.file, a]))
    expect(portType("prompt", "a hero")).toBe("TEXT")
    expect(portType("x", "a/b.png")).toBe("IMAGE")
    expect(portType("x", "assets/characters/hero-mesh.glb", byFile)).toBe(
      "MESH"
    )
    expect(portType("x", "assets/characters/hero-rigged.glb", byFile)).toBe(
      "RIGGED"
    )
    expect(portType("x", "assets/characters/hero.glb", byFile)).toBe("ANIM")
    expect(portType("limbs", { handL: 8 })).toBe("LIMBS")
    expect(portType("x", { a: 1 })).toBe("DATA")
  })

  it("follows source.from back to the first material", () => {
    expect(chainOf(register[3], register).map((a) => a.id)).toEqual([
      "hero-tpose",
      "hero-mesh",
      "hero-rigged",
      "hero",
    ])
    const g = graphFromChain(register[3], register)
    expect(g.nodes).toHaveLength(4)
    expect(g.edges).toHaveLength(3)
    expect(g.nodes[1].settings).toContainEqual(["workflow", "trellis2"])
    expect(g.nodes[1].ins.map((p) => p.type)).toEqual(["IMAGE"])
  })

  it("draws the run that made the material, wired by value, failed tries beside", () => {
    const { main, failed } = makingGraph(register[3], register, [bad, good])
    expect(main.origin).toBe("char3d/ok")
    expect(main.nodes[0].title).toBe("그림 만들기")
    // prompt → in port, workflow and seed → settings
    expect(main.nodes[0].ins.map((p) => p.key)).toEqual(["prompt"])
    expect(main.nodes[0].settings).toContainEqual(["seed", "1014"])
    // params fold into settings; preview pictures go on the card, not a port
    expect(main.nodes[1].settings).toContainEqual(["target_faces", "20000"])
    expect(main.nodes[1].outs.map((p) => p.key)).toEqual(["mesh"])
    expect(main.nodes[1].thumbs.map((t) => t.path)).toContain(
      "runs/char3d/ok/m.jpg"
    )
    // `ok` is plumbing, not an output
    expect(main.nodes[4].outs.map((p) => p.key)).toEqual(["anim", "report"])
    const pairs = main.edges.map((e) => `${e.from}>${e.to}`)
    expect(pairs).toContain("n4.out.rig>n6.in.rig")
    expect(pairs).toContain("n5.out.limbs>n6.in.limbs")
    expect(main.edges.find((e) => e.to === "n4.in.mesh")?.type).toBe("MESH")
    expect(depths(main).get("n6")).toBe(4)
    expect(failed.map((g) => g.origin)).toEqual(["char3d/first"])
    expect(failed[0].nodes[1].status).toBe("failed")
    expect(failed[0].nodes[1].notes).toContain("body folds")
  })

  it("falls back to the register chain when no run names the file", () => {
    const { main, failed } = makingGraph(register[3], register, [bad])
    expect(main.origin).toBe("chain")
    expect(failed).toEqual([])
  })
})
