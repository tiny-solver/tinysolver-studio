// Generates public/how-built.html — an interactive, conclusion-first view of
// how Tinysolver Studio was built on top of upstream codeg. Data lives in
// docs/studio/how-built.json (layers, flow, timeline) and decisions/checks
// are pulled from docs/studio/roadmap.json so the two pages never disagree.
// No external scripts: the page embeds its data and a small vanilla-JS
// controller, so it works from the static export and inside the desktop app.
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const source = new URL("../docs/studio/how-built.json", import.meta.url)
const roadmapUrl = new URL("../docs/studio/roadmap.json", import.meta.url)
const destination = new URL("../public/how-built.html", import.meta.url)
const data = JSON.parse(await readFile(source, "utf8"))
const roadmap = JSON.parse(await readFile(roadmapUrl, "utf8"))

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]
  )

const layerIds = new Set(data.layers.map((l) => l.id))
for (const step of data.flow) {
  if (!layerIds.has(step.layer))
    throw new Error(`flow step "${step.title}" points at unknown layer`)
}

const payload = {
  layers: data.layers,
  flow: data.flow,
  timeline: data.timeline,
  decisions: roadmap.decisions,
  checks: roadmap.checks,
  next: data.next,
}
// `</script` inside JSON would end the tag early; escape it.
const json = JSON.stringify(payload).replace(/<\//g, "<\\/")

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(data.title)}</title>
<style>
:root{color-scheme:light dark;--bg:light-dark(#f6f7fb,#0f141c);--surface:light-dark(#fff,#18202d);--surface-2:light-dark(#eef1f8,#202a3a);--ink:light-dark(#151c30,#e8edf7);--muted:light-dark(#5b6579,#9aa6bb);--line:light-dark(#dde2ee,#2c3748);--accent:#d98b1c;--accent-ink:light-dark(#7a4a00,#ffd28a);--l-upstream:#6b7280;--l-brand:#d98b1c;--l-studio:#7c5cff;--l-project:#17a67a;--l-entry:#e0508a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}a{color:var(--accent-ink)}main{max-width:1080px;margin:0 auto;padding:28px 20px 80px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}.top a{border:1px solid var(--line);border-radius:999px;padding:6px 12px;text-decoration:none;text-transform:none;letter-spacing:0;color:var(--ink);background:var(--surface)}
h1{font-size:clamp(26px,4vw,38px);line-height:1.2;margin:18px 0 10px;letter-spacing:-.02em}h2{font-size:20px;margin:36px 0 12px}
.conclusion{font-size:17px;line-height:1.75;padding:18px 20px;border-left:4px solid var(--accent);background:var(--surface);border-radius:0 12px 12px 0;margin:0}
.numbers{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0 0}.numbers div{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.numbers b{display:block;font-size:30px;line-height:1;letter-spacing:-.03em}.numbers span{color:var(--muted);font-size:13px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:30px 0 16px;border-bottom:1px solid var(--line);padding-bottom:10px}.tabs button{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:7px 14px;font:inherit;font-size:14px;cursor:pointer}.tabs button[aria-selected=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
[hidden]{display:none!important}
.stack{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.9fr);gap:18px;align-items:start}@media(max-width:820px){.stack{grid-template-columns:1fr}}
.layers{display:flex;flex-direction:column-reverse;gap:8px}.layer{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;width:100%;text-align:left;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:12px;padding:14px 16px;font:inherit;cursor:pointer;transition:transform .15s,border-color .15s}.layer:hover{transform:translateX(4px)}.layer[aria-pressed=true]{border-color:var(--c);box-shadow:inset 4px 0 0 var(--c)}.layer .role{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--c);font-weight:700;min-width:36px}.layer b{font-size:15px}.layer small{color:var(--muted);display:block;font-weight:400;margin-top:2px}.layer .n{width:26px;height:26px;border-radius:50%;background:var(--c);color:#fff;display:grid;place-items:center;font-size:12px;font-weight:700}
.detail{position:sticky;top:16px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 20px;min-height:260px}.detail h3{margin:0 0 6px;font-size:18px}.detail .role{color:var(--c);font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700}.detail p{margin:10px 0}.detail h4{margin:16px 0 6px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}.detail code{font-size:12.5px;background:var(--surface-2);padding:2px 6px;border-radius:6px;display:inline-block;margin:2px 4px 2px 0}.detail ul{margin:0;padding-left:18px}
.flow{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.9fr);gap:18px;align-items:start}@media(max-width:820px){.flow{grid-template-columns:1fr}}
.steps{display:flex;flex-direction:column;gap:0;position:relative}.step{display:grid;grid-template-columns:34px 1fr;gap:12px;align-items:start;width:100%;text-align:left;background:none;border:0;color:var(--ink);padding:8px 6px;font:inherit;cursor:pointer;border-radius:10px}.step:hover{background:var(--surface)}.step[aria-current=step]{background:var(--surface);box-shadow:inset 0 0 0 1px var(--line)}.step .dot{width:26px;height:26px;border-radius:50%;background:var(--c);color:#fff;display:grid;place-items:center;font-size:12px;font-weight:700;position:relative;z-index:1}.step .dot::after{content:"";position:absolute;left:12px;top:26px;width:2px;height:26px;background:var(--line)}.step:last-child .dot::after{display:none}.step b{display:block}.step span{color:var(--muted);font-size:13.5px}
.controls{display:flex;gap:8px;margin:12px 0 0}.controls button{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer}
.timeline{display:grid;gap:10px}.event{display:grid;grid-template-columns:110px 1fr;gap:14px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 16px}.event time{color:var(--muted);font-size:13px}.event code{font-size:12px;color:var(--accent-ink)}.event b{display:block}.event p{margin:4px 0 0;color:var(--muted);font-size:14px}
.decisions{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}.decision{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.decision .id{font-size:11px;color:var(--muted);letter-spacing:.08em}.decision b{display:block;margin:4px 0 6px}.decision p{margin:0;color:var(--muted);font-size:14px}
.checks{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 18px}.checks ul{margin:0;padding-left:18px;font-size:14px}.checks li{margin:4px 0}.next{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}.next div{background:var(--surface-2);border-radius:10px;padding:10px 14px;font-size:14px}
footer{margin-top:40px;color:var(--muted);font-size:13px}
</style></head><body><main>
<div class="top"><span>CODEG STUDIO / HOW IT WAS BUILT · ${escape(data.updated)}</span><span><a href="/studio-plan.html">진행 계획</a> <a href="/studio">편집기 열기 ↗</a></span></div>
<h1>${escape(data.title)}</h1>
<p class="conclusion">${escape(data.conclusion)}</p>
<div class="numbers">${data.numbers.map((n) => `<div><b>${escape(n.value)}</b><span>${escape(n.label)}</span></div>`).join("")}</div>
<div class="tabs" role="tablist"><button role="tab" data-tab="layers" aria-selected="true">층 구조</button><button role="tab" data-tab="flow" aria-selected="false">한 번의 흐름</button><button role="tab" data-tab="timeline" aria-selected="false">타임라인</button><button role="tab" data-tab="decisions" aria-selected="false">결정과 검증</button></div>
<section id="tab-layers"><h2>codeg 위에 얹은 층 — 아래가 기반, 위로 갈수록 이 포크의 것</h2><div class="stack"><div class="layers" id="layers"></div><aside class="detail" id="layer-detail" aria-live="polite"></aside></div></section>
<section id="tab-flow" hidden><h2>새 프로젝트 하나가 지나는 길 — 단계를 누르면 어느 층이 일하는지 보인다</h2><div class="flow"><div><div class="steps" id="steps"></div><div class="controls"><button id="prev">← 이전</button><button id="next">다음 →</button></div></div><aside class="detail" id="flow-detail" aria-live="polite"></aside></div></section>
<section id="tab-timeline" hidden><h2>언제 무엇을</h2><div class="timeline" id="timeline"></div></section>
<section id="tab-decisions" hidden><h2>왜 이렇게</h2><div class="decisions" id="decisions"></div><h2>검증 기록</h2><div class="checks"><ul id="checks"></ul></div><h2>다음</h2><div class="next" id="next-list"></div></section>
<footer>원본: <code>docs/studio/how-built.json</code> + <code>docs/studio/roadmap.json</code> · 생성: <code>pnpm studio:plan</code> · 외부 스크립트 없이 동작한다.</footer>
</main>
<script id="data" type="application/json">${json}</script>
<script>
(function(){
  var D=JSON.parse(document.getElementById("data").textContent);
  var esc=function(s){return String(s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})};
  var byId={};D.layers.forEach(function(l){byId[l.id]=l});
  var color=function(id){return"var(--l-"+id+")"};

  // Tabs — the hash remembers the tab so a link can land on one.
  var tabs=document.querySelectorAll('[role=tab]');
  function showTab(name){tabs.forEach(function(b){var on=b.dataset.tab===name;b.setAttribute("aria-selected",on);document.getElementById("tab-"+b.dataset.tab).hidden=!on});if(location.hash!=="#"+name)history.replaceState(null,"","#"+name)}
  tabs.forEach(function(b){b.addEventListener("click",function(){showTab(b.dataset.tab)})});
  var initial=location.hash.slice(1);showTab(document.getElementById("tab-"+initial)?initial:"layers");

  // Layers
  var layersEl=document.getElementById("layers"),detail=document.getElementById("layer-detail");
  function renderLayer(l){detail.style.setProperty("--c",color(l.id));detail.innerHTML='<div class="role">'+esc(l.role)+'</div><h3>'+esc(l.name)+'</h3><p>'+esc(l.summary)+'</p><h4>왜</h4><p>'+esc(l.why)+'</p>'+(l.adds.length?'<h4>추가한 것</h4><ul>'+l.adds.map(function(a){return"<li>"+esc(a)+"</li>"}).join("")+"</ul>":"")+'<h4>어디에</h4><div>'+l.files.map(function(f){return"<code>"+esc(f)+"</code>"}).join("")+"</div>";layersEl.querySelectorAll(".layer").forEach(function(b){b.setAttribute("aria-pressed",b.dataset.id===l.id)})}
  D.layers.forEach(function(l,i){var b=document.createElement("button");b.className="layer";b.dataset.id=l.id;b.style.setProperty("--c",color(l.id));b.innerHTML='<span class="role">'+esc(l.role)+'</span><span><b>'+esc(l.name)+'</b><small>'+esc(l.summary.split(". ")[0])+'.</small></span><span class="n">'+i+"</span>";b.addEventListener("click",function(){renderLayer(l)});layersEl.appendChild(b)});
  renderLayer(D.layers[D.layers.length-1]);

  // Flow stepper
  var stepsEl=document.getElementById("steps"),flowDetail=document.getElementById("flow-detail"),cur=0;
  function renderStep(i){cur=i;var s=D.flow[i],l=byId[s.layer];flowDetail.style.setProperty("--c",color(l.id));flowDetail.innerHTML='<div class="role">'+(i+1)+" / "+D.flow.length+" · "+esc(l.role)+" · "+esc(l.name)+'</div><h3>'+esc(s.title)+'</h3><p>'+esc(s.detail)+'</p><h4>이 단계를 맡는 층</h4><p>'+esc(l.summary)+'</p><h4>어디에</h4><div>'+l.files.map(function(f){return"<code>"+esc(f)+"</code>"}).join("")+"</div>";stepsEl.querySelectorAll(".step").forEach(function(b,j){if(j===i)b.setAttribute("aria-current","step");else b.removeAttribute("aria-current")})}
  D.flow.forEach(function(s,i){var b=document.createElement("button");b.className="step";b.style.setProperty("--c",color(s.layer));b.innerHTML='<span class="dot">'+(i+1)+'</span><span><b>'+esc(s.title)+"</b><span>"+esc(s.detail)+"</span></span>";b.addEventListener("click",function(){renderStep(i)});stepsEl.appendChild(b)});
  document.getElementById("prev").addEventListener("click",function(){renderStep((cur+D.flow.length-1)%D.flow.length)});
  document.getElementById("next").addEventListener("click",function(){renderStep((cur+1)%D.flow.length)});
  document.addEventListener("keydown",function(e){if(document.getElementById("tab-flow").hidden)return;if(e.key==="ArrowRight")renderStep((cur+1)%D.flow.length);if(e.key==="ArrowLeft")renderStep((cur+D.flow.length-1)%D.flow.length)});
  renderStep(0);

  // Timeline, decisions, checks, next
  document.getElementById("timeline").innerHTML=D.timeline.map(function(e){return'<article class="event"><div><time>'+esc(e.date)+"</time><br><code>"+esc(e.ref)+"</code></div><div><b>"+esc(e.title)+"</b><p>"+esc(e.detail)+"</p></div></article>"}).join("");
  document.getElementById("decisions").innerHTML=D.decisions.map(function(d){return'<article class="decision"><span class="id">'+esc(d.id)+"</span><b>"+esc(d.decision)+"</b><p>"+esc(d.reason)+"</p></article>"}).join("");
  document.getElementById("checks").innerHTML=D.checks.map(function(c){return"<li>"+esc(c)+"</li>"}).join("");
  document.getElementById("next-list").innerHTML=D.next.map(function(n){return"<div>"+esc(n)+"</div>"}).join("");
})();
</script></body></html>
`

if (process.argv.includes("--check")) {
  if ((await readFile(destination, "utf8")) !== html)
    throw new Error("how-built.html is stale. Run pnpm studio:plan")
  console.log("how-built.html matches its sources")
} else {
  await writeFile(destination, html)
  console.log(fileURLToPath(destination))
}
