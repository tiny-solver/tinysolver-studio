/**
 * `props.script` of a scene node, as the inspector edits it.
 *
 * The engine accepts a name, an object `{ name, ...config }`, or a list of
 * either. The editor works on a flat list and writes back the smallest shape
 * that says the same thing, so a hand-written `"script": "float"` stays a
 * string after a round trip.
 */
export interface Behavior {
  name: string
  config: Record<string, unknown>
}

/** What the engine announced in `codeg:ready`. */
export interface EngineInfo {
  version: string | null
  /** Accepts `codeg:mode` (edit/play). */
  modes: boolean
  /** Registered script names: built-ins plus the project's. */
  scripts: string[]
  /** `logic.actions` operations the engine knows. */
  ops: string[]
  /** Config keys and defaults of the built-in scripts. */
  builtins: Record<string, Record<string, unknown>>
}

export const NO_ENGINE_INFO: EngineInfo = {
  version: null,
  modes: false,
  scripts: [],
  ops: [],
  builtins: {},
}

const NAME = /^[a-zA-Z0-9_-]{1,100}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function readBehaviors(script: unknown): Behavior[] {
  const entries = Array.isArray(script) ? script : script ? [script] : []
  const out: Behavior[] = []
  for (const entry of entries) {
    if (typeof entry === "string" && entry)
      out.push({ name: entry, config: {} })
    else if (isRecord(entry) && typeof entry.name === "string" && entry.name) {
      const { name, ...config } = entry
      out.push({ name: name as string, config })
    }
  }
  return out
}

/** `null` clears the prop (the command layer merges props shallowly, so a
 *  key cannot be deleted; the engine treats `null` as "no script"). */
export function writeBehaviors(list: Behavior[]): unknown {
  const entries = list
    .filter((b) => NAME.test(b.name))
    .map((b) =>
      Object.keys(b.config).length === 0
        ? b.name
        : { name: b.name, ...b.config }
    )
  if (entries.length === 0) return null
  return entries.length === 1 ? entries[0] : entries
}

/** Config to show for a behavior: the built-in's defaults under whatever the
 *  node overrides, so every knob is visible with its effective value. */
export function effectiveConfig(
  behavior: Behavior,
  info: EngineInfo
): Record<string, unknown> {
  return { ...(info.builtins[behavior.name] ?? {}), ...behavior.config }
}

/** Keep only what differs from the built-in default, so the file stays small
 *  and a later change of the default still reaches the node. */
export function trimConfig(
  name: string,
  config: Record<string, unknown>,
  info: EngineInfo
): Record<string, unknown> {
  const defaults = info.builtins[name] ?? {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (JSON.stringify(defaults[key]) !== JSON.stringify(value))
      out[key] = value
  }
  return out
}

/** Parse what the engine posted; anything malformed degrades to "unknown". */
export function readEngineInfo(data: unknown): EngineInfo {
  if (!isRecord(data)) return NO_ENGINE_INFO
  const names = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string" && NAME.test(v))
      : []
  const builtins: Record<string, Record<string, unknown>> = {}
  if (isRecord(data.builtins))
    for (const [name, config] of Object.entries(data.builtins))
      if (NAME.test(name) && isRecord(config)) builtins[name] = config
  return {
    version: typeof data.version === "string" ? data.version : null,
    modes: data.modes === true,
    scripts: names(data.scripts),
    ops: names(data.ops),
    builtins,
  }
}
