/**
 * Drives the committed bundle in a real engine and prints what it produces.
 *
 *     pnpm browser:agent:probe
 *
 * The unit tests cover the part of `src/index.ts` that is pure. They cannot
 * cover the tree: jsdom reports every element as zero-sized, and `ai` mode
 * only names elements that are visible and receive pointer events, so under
 * jsdom the tree comes back with no refs and proves nothing. This asks a
 * browser instead.
 *
 * Chrome, because it is the one engine present on all three of our
 * development machines and it speaks CDP without a driver. It is not the
 * engine any platform actually ships — WKWebView, WebView2 and WebKitGTK are —
 * so a green run here says the bundle is sound, not that it is verified on a
 * platform. Manual, not part of `pnpm test`: it needs a browser on the box.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const BUNDLE = readFileSync(
  resolve(root, "src-tauri/src/browser/js/agent.bundle.js"),
  "utf8"
)

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const PORT = 9333

const PAGE = `<!doctype html><html><head><title>Probe</title></head><body>
<header><a href="/docs">Docs</a></header>
<main>
  <h1>Orders</h1>
  <label>Search <input type="search" name="q"></label>
  <button id="exp" style="cursor:pointer">Export</button>
  <div id="pointer" style="cursor:pointer">Pointer but no handler</div>
  <div id="handler" onclick="void 0">Handler but no pointer</div>
  <div id="focusable" tabindex="0">Focusable but neither</div>
  <div id="hidden" style="display:none"><button>Invisible</button></div>
  <ul><li>alpha</li><li>beta</li></ul>
  <section id="act">
    <button id="count" onclick="this.dataset.n = (Number(this.dataset.n || 0) + 1)">Count</button>
    <form id="f" onsubmit="event.preventDefault(); this.dataset.submitted = document.getElementById('name').value">
      <label>Name <input id="name" name="name"></label>
      <button type="submit" id="save" onclick="this.dataset.clicked = 1">Save</button>
    </form>
    <label>Size <select id="size"><option value="s">Small</option><option value="m" selected>Medium</option><option value="l">Large</option></select></label>
    <div id="note" contenteditable="true">draft</div>
    <div style="position:relative;height:60px">
      <button id="under">Under</button>
      <div id="veil" style="position:absolute;inset:0;background:rgba(0,0,0,.2)"></div>
    </div>
    <a id="anchor" href="#went">Anchor</a>
  </section>
</main>
<script>
  // What a React-style page does to a field: track the value on the instance
  // and only treat an input event as a change when the DOM disagrees.
  const name = document.getElementById("name")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
  let tracked = ""
  Object.defineProperty(name, "value", {
    configurable: true,
    get: () => setter.get.call(name),
    set: (v) => { tracked = v; setter.set.call(name, v) },
  })
  name.addEventListener("input", () => {
    if (setter.get.call(name) !== tracked) name.dataset.seen = setter.get.call(name)
  })
  document.getElementById("size").addEventListener("change", (e) => {
    e.target.dataset.changed = e.target.value
  })
  document.getElementById("count").addEventListener("pointerdown", function () {
    this.dataset.pointer = "1"
  })
</script></body></html>`

const dir = mkdtempSync(join(tmpdir(), "codeg-agent-probe-"))
const pageFile = join(dir, "probe.html")
writeFileSync(pageFile, PAGE)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(dir, "profile")}`,
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ],
  { stdio: "ignore" }
)

let ws
let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}: ${JSON.stringify(actual)}`)
}

try {
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${PORT}/json/list`)
      ).json()
      const page = list.find((t) => t.type === "page")
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl)
    } catch {
      await sleep(100)
    }
  }
  if (!ws) throw new Error(`no page target — is Chrome at ${CHROME}?`)
  await new Promise((r) => (ws.onopen = r))

  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  }
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })

  await send("Page.enable")
  await send("Page.navigate", { url: `file://${pageFile}` })
  await sleep(700)

  // An isolated world, created the way the shims create one.
  const { result: frameTree } = await send("Page.getFrameTree")
  const { result: world } = await send("Page.createIsolatedWorld", {
    frameId: frameTree.frameTree.frame.id,
    worldName: "codeg",
    grantUniveralAccess: false,
  })

  const run = async (expression, contextId = world.executionContextId) => {
    const { result } = await send("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
    })
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails, null, 2))
    return result.result.value
  }

  await run(BUNDLE)

  const snap = JSON.parse(
    await run("JSON.stringify(__codegAgent.snapshot({}))")
  )
  console.log("\n=== tree ===\n" + snap.tree + "\n")
  console.log(`url=${snap.url} title=${snap.title} refs=${snap.refsCount}\n`)

  // Roleless divs that behave like controls have to be namable, or an agent
  // cannot act on the many pages that are built out of them. This is the whole
  // reason there is no promotion pass of our own: `ai` mode refs everything
  // visible that receives pointer events, so each of these is already named,
  // whichever single attribute makes it interesting. Kept as three separate
  // elements so that one of them regressing cannot hide behind another.
  const named = (id, text) =>
    check(
      `a roleless div is namable — ${id}`,
      new RegExp(`generic \\[ref=e\\d+\\][^\\n]*: ${text}`).test(snap.tree),
      true
    )
  named("cursor:pointer only", "Pointer but no handler")
  named("onclick only", "Handler but no pointer")
  named("tabindex only", "Focusable but neither")

  // …and `cursor: pointer` is additionally marked, which is how an agent tells
  // "this looks clickable" from "this is merely visible".
  check(
    "cursor:pointer is reported, and only where it applies",
    [
      /\[cursor=pointer\][^\n]*: Pointer but no handler/.test(snap.tree),
      /\[cursor=pointer\][^\n]*: Handler but no pointer/.test(snap.tree),
    ],
    [true, false]
  )

  check(
    "a display:none subtree is left out",
    snap.tree.includes("Invisible"),
    false
  )
  check("the link keeps its href", snap.tree.includes("/url: /docs"), true)

  // The page must not be able to see, call or forge the agent surface.
  const mainWorld = await send("Runtime.evaluate", {
    expression: "typeof globalThis.__codegAgent",
    returnByValue: true,
  })
  check(
    "the page cannot see __codegAgent",
    mainWorld.result.result.value,
    "undefined"
  )

  const cut = JSON.parse(
    await run("JSON.stringify(__codegAgent.snapshot({maxChars: 40}))")
  )
  check("a capped tree reports the cut", cut.truncated, true)
  check("a capped tree ends on a line boundary", cut.tree.endsWith(":"), true)

  // Every snapshot hands out its own token, and the capped one above was a
  // snapshot: the refs used from here on come from a fresh one.
  const live = JSON.parse(
    await run("JSON.stringify(__codegAgent.snapshot({}))")
  )
  const g = JSON.stringify(live.generation)
  // Two refs: one to spend on the removal case, one that must stay in the page
  // so the same-document case cannot pass for the wrong reason.
  const kept = JSON.stringify(
    live.tree.match(/button "Export" \[ref=(e\d+)\]/)[1]
  )
  const spent = JSON.stringify(
    live.tree.match(/listitem \[ref=(e\d+)\]: alpha/)[1]
  )

  check(
    "a live ref resolves",
    await run(`!!__codegAgent.elementForRef(${g}, ${kept})`),
    true
  )
  check(
    "a ref from another document does not",
    await run(`__codegAgent.elementForRef("other", ${kept})`),
    null
  )
  check(
    "a ref for a removed element does not",
    await run(
      `(() => { __codegAgent.elementForRef(${g}, ${spent}).remove();
                return __codegAgent.elementForRef(${g}, ${spent}) })()`
    ),
    null
  )

  // A single-page app's route change: same document, same world, same
  // generation, and the element is still in the page. Only the address moved.
  // Asserting that it is still connected is the point — otherwise a `null`
  // here would prove nothing about the address and everything about the node.
  check(
    "a ref does not survive a pushState, though its element does",
    await run(
      `(() => { const el = __codegAgent.elementForRef(${g}, ${kept});
                history.pushState({}, "", "?routed");
                return [el.isConnected, __codegAgent.elementForRef(${g}, ${kept})] })()`
    ),
    [true, null]
  )
  check(
    "and a snapshot at the new address hands out refs that work again",
    await run(
      `(() => { const s = __codegAgent.snapshot({});
                const m = s.tree.match(/button "Export" \\[ref=(e\\d+)\\]/);
                return !!__codegAgent.elementForRef(s.generation, m[1]) })()`
    ),
    true
  )

  // An address is not an identity: a route that leaves and comes back
  // arrives at a string that matches, and a framework may have kept the node
  // and changed what it means. The world cannot see the transition — the
  // page's own `pushState` is invisible from an isolated world — but it can
  // see what the transition leaves behind: two more history entries.
  check(
    "an address that leaves and returns is caught by the history length",
    await run(
      `(() => { const here = location.href;
                const s = __codegAgent.snapshot({});
                const m = s.tree.match(/button "Export" \\[ref=(e\\d+)\\]/);
                history.pushState({}, "", "?elsewhere");
                history.pushState({}, "", here);
                return __codegAgent.elementForRef(s.generation, m[1]) })()`
    ),
    null
  )
  // …and a back-and-forward that lands where it started moves neither the
  // address nor the length, and is caught by the events it fires.
  check(
    "a back and forward that return to the same page are caught by popstate",
    await new Promise(async (resolve) => {
      await run(
        `history.pushState({}, "", "?one"); history.pushState({}, "", "?two");
         history.back();`
      )
      await sleep(150)
      await run(
        `globalThis.__s = __codegAgent.snapshot({});
         globalThis.__m = __s.tree.match(/button "Export" \\[ref=(e\\d+)\\]/)[1];
         history.back(); history.forward();`
      )
      await sleep(250)
      resolve(await run(`__codegAgent.elementForRef(__s.generation, __m)`))
    }),
    null
  )

  // ── acting ─────────────────────────────────────────────────────────────

  const fresh = async () => {
    const s = JSON.parse(await run("JSON.stringify(__codegAgent.snapshot({}))"))
    const ref = (pattern) => {
      const m = s.tree.match(pattern)
      if (!m) throw new Error(`no match for ${pattern} in\n${s.tree}`)
      return m[1]
    }
    return { gen: JSON.stringify(s.generation), ref }
  }
  const actJson = async (gen, ref, request) =>
    JSON.parse(
      await run(
        `JSON.stringify(__codegAgent.act(${gen}, ${JSON.stringify(ref)}, ${JSON.stringify(request)}))`
      )
    )

  {
    const { gen, ref } = await fresh()
    const count = ref(/button "Count" \[ref=(e\d+)\]/)
    const result = await actJson(gen, count, { kind: "click" })
    check(
      "a click lands: handler ran, pointerdown seen, element focused",
      [
        result.ok,
        await run(`document.getElementById("count").dataset.n`),
        await run(`document.getElementById("count").dataset.pointer`),
        await run(`document.activeElement.id`),
      ],
      [true, "1", "1", "count"]
    )
    check(
      "a second click with the same ref still works — the page did not move",
      (await actJson(gen, count, { kind: "click" })).ok &&
        (await run(`document.getElementById("count").dataset.n`)),
      "2"
    )
  }
  {
    const { gen, ref } = await fresh()
    const name = ref(/textbox "Name" \[ref=(e\d+)\]/)
    const result = await actJson(gen, name, { kind: "type", text: "Ada" })
    check(
      "typing replaces the value and a React-style tracker sees the change",
      [
        result.ok,
        await run(`document.getElementById("name").value`),
        await run(`document.getElementById("name").dataset.seen`),
      ],
      [true, "Ada", "Ada"]
    )
    const submit = await actJson(gen, name, {
      kind: "type",
      text: "Grace",
      submit: true,
    })
    check(
      "type with submit goes through the form's default button",
      [
        submit.ok,
        await run(`document.getElementById("save").dataset.clicked`),
        await run(`document.getElementById("f").dataset.submitted`),
      ],
      [true, "1", "Grace"]
    )
  }
  {
    const { gen, ref } = await fresh()
    const size = ref(/combobox "Size" \[ref=(e\d+)\]/)
    check(
      "select by label fires change with the new value",
      [
        (await actJson(gen, size, { kind: "select", values: ["Large"] })).ok,
        await run(`document.getElementById("size").value`),
        await run(`document.getElementById("size").dataset.changed`),
      ],
      [true, "l", "l"]
    )
    const missing = await actJson(gen, size, { kind: "select", values: ["XL"] })
    check(
      "a value that is not an option is refused with the options listed",
      [missing.ok, missing.error, missing.detail.includes('"m"')],
      [false, "no-option", true]
    )
  }
  {
    const { gen, ref } = await fresh()
    const note = ref(/generic \[ref=(e\d+)\]: draft/)
    check(
      "typing into a contenteditable replaces its text",
      [
        (await actJson(gen, note, { kind: "type", text: "final" })).ok,
        await run(`document.getElementById("note").textContent`),
      ],
      [true, "final"]
    )
  }
  {
    const { gen, ref } = await fresh()
    const under = ref(/button "Under" \[ref=(e\d+)\]/)
    const result = await actJson(gen, under, { kind: "click" })
    check(
      "a click on a covered element is refused, naming what covers it",
      [result.ok, result.error, result.detail.includes("div#veil")],
      [false, "obscured", true]
    )
    const located = JSON.parse(
      await run(
        `JSON.stringify(__codegAgent.locate(${gen}, ${JSON.stringify(under)}))`
      )
    )
    check("locate refuses on the same grounds", located.error, "obscured")
    const count = ref(/button "Count" \[ref=(e\d+)\]/)
    const point = JSON.parse(
      await run(
        `JSON.stringify(__codegAgent.locate(${gen}, ${JSON.stringify(count)}))`
      )
    )
    check(
      "locate answers with the point inside the element's box",
      point.ok &&
        (await run(
          `(() => { const r = document.getElementById("count").getBoundingClientRect();
                  return ${point.x} > r.left && ${point.x} < r.right && ${point.y} > r.top && ${point.y} < r.bottom })()`
        )),
      true
    )
  }
  {
    const { gen, ref } = await fresh()
    const spent = ref(/listitem \[ref=(e\d+)\]: beta/)
    await run(
      `__codegAgent.elementForRef(${gen}, ${JSON.stringify(spent)}).remove()`
    )
    const result = await actJson(gen, spent, { kind: "click" })
    check(
      "acting on a removed element is stale, not a click on something else",
      [result.ok, result.error],
      [false, "stale"]
    )
    check(
      "a key press to the focused element needs a current snapshot too",
      (
        await actJson(JSON.stringify("other"), null, {
          kind: "press",
          key: "Escape",
        })
      ).error,
      "stale"
    )
  }
  {
    // Two snapshots of one document under one epoch are two snapshots: a
    // token from the first does not resolve refs against the second's map.
    const a = JSON.parse(await run("JSON.stringify(__codegAgent.snapshot({}))"))
    const b = JSON.parse(await run("JSON.stringify(__codegAgent.snapshot({}))"))
    const m = b.tree.match(/button "Count" \[ref=(e\d+)\]/)[1]
    check(
      "each snapshot hands out its own token, and an older one is refused",
      [
        a.generation !== b.generation,
        await run(
          `__codegAgent.elementForRef(${JSON.stringify(a.generation)}, ${JSON.stringify(m)})`
        ),
        !!(await run(
          `__codegAgent.elementForRef(${JSON.stringify(b.generation)}, ${JSON.stringify(m)})`
        )),
      ],
      [true, null, true]
    )
    // A capped tree hands out only the refs it showed.
    const cut = JSON.parse(
      await run("JSON.stringify(__codegAgent.snapshot({maxChars: 60}))")
    )
    const shown = [...cut.tree.matchAll(/\[ref=(e\d+)\]/g)].map((x) => x[1])
    const hidden = "e" + (Math.max(...shown.map((r) => Number(r.slice(1)))) + 3)
    check(
      "a ref the cap hid from the agent is not actable",
      [
        cut.truncated,
        shown.length > 0,
        await run(
          `__codegAgent.elementForRef(${JSON.stringify(cut.generation)}, ${JSON.stringify(hidden)})`
        ),
      ],
      [true, true, null]
    )
  }
  {
    // Where the engine has the Navigation API, even a replaceState away and
    // back — no length change, no event, same address — is caught.
    const has = await run(
      "typeof navigation !== 'undefined' && !!navigation.currentEntry"
    )
    if (has) {
      check(
        "with the Navigation API, replaceState away and back is caught",
        await run(
          `(() => { const here = location.href;
                    const s = __codegAgent.snapshot({});
                    const m = s.tree.match(/button "Count" \\[ref=(e\\d+)\\]/)[1];
                    history.replaceState({}, "", "?away"); history.replaceState({}, "", here);
                    return __codegAgent.elementForRef(s.generation, m) })()`
        ),
        null
      )
    } else console.log("skip  Navigation API not present in this engine")
  }
  {
    // A disabled control is refused before anything is dispatched.
    await run(`document.getElementById("count").disabled = true`)
    const { gen, ref } = await fresh()
    void ref
    const s2 = JSON.parse(
      await run("JSON.stringify(__codegAgent.snapshot({}))")
    )
    const m = (s2.tree.match(/button "Count" \[ref=(e\d+)\]/) || [])[1]
    if (m) {
      const r = await actJson(JSON.stringify(s2.generation), m, {
        kind: "click",
      })
      check("a disabled button is refused as disabled", r.error, "disabled")
    } else
      console.log(
        "skip  disabled button is not named by the tree (as ai mode has it)"
      )
    await run(`document.getElementById("count").disabled = false`)
    void gen
  }
  {
    const { gen, ref } = await fresh()
    const anchor = ref(/link "Anchor" \[ref=(e\d+)\]/)
    void anchor
    const before = await run("location.href")
    const result = await actJson(gen, anchor, { kind: "click" })
    check(
      "a dispatched click on a link follows it",
      [
        result.ok,
        (await run("location.href")) !== before && (await run("location.hash")),
      ],
      [true, "#went"]
    )
  }

  // …which is why the token carries whatever the host puts in it. The host
  // does see the transition, and a ref quoting an epoch it has moved past is
  // refused — by the host on the spot, and by this world from the next
  // snapshot on, which is what these two assert.
  check(
    "a host epoch reaches the token an agent echoes",
    await run(
      `__codegAgent.snapshot({epoch: "nav-7"}).generation.endsWith(".nav-7")`
    ),
    true
  )
  check(
    "and a ref from an earlier epoch dies at the next snapshot",
    await run(
      `(() => { const s = __codegAgent.snapshot({epoch: "nav-7"});
                const m = s.tree.match(/button "Export" \\[ref=(e\\d+)\\]/);
                __codegAgent.snapshot({epoch: "nav-8"});
                return __codegAgent.elementForRef(s.generation, m[1]) })()`
    ),
    null
  )

  // The premise the whole design rests on, measured instead of assumed: this
  // world cannot intercept the page's own history calls, which is why
  // deciding when refs die has to be the host's job. Patch
  // `History.prototype.pushState` here, then have the *page* navigate, and
  // watch the patch not fire. Last, because it leaves the page elsewhere.
  await run(`globalThis.__patchFired = false;
             History.prototype.pushState = new Proxy(History.prototype.pushState, {
               apply(t, self, args) { globalThis.__patchFired = true;
                                      return Reflect.apply(t, self, args) } })`)
  const before = await run("location.href")
  await send("Runtime.evaluate", {
    // No contextId: the page's own world, holding its own History.prototype.
    expression: 'history.pushState({}, "", "?from-the-page")',
    returnByValue: true,
  })
  check(
    "a page's own pushState is invisible to a patch in this world",
    [
      await run("globalThis.__patchFired"),
      (await run("location.href")) !== before,
    ],
    // Did not fire, yet the address did move — so the page really navigated
    // and the patch really did not see it.
    [false, true]
  )

  console.log(failures ? `\n${failures} failed` : "\nall checks passed")
} finally {
  ws?.close()
  chrome.kill()
}

process.exit(failures ? 1 : 0)
