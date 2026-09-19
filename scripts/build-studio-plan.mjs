import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const source = new URL("../docs/studio/roadmap.json", import.meta.url)
const destination = new URL("../public/studio-plan.html", import.meta.url)
const plan = JSON.parse(await readFile(source, "utf8"))
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]
  )
const labels = {
  done: "완료",
  review: "구현 · 검증 대기",
  active: "진행 중",
  planned: "예정",
}
for (const phase of plan.phases) {
  if (!labels[phase.status]) throw new Error(`Invalid status: ${phase.status}`)
}
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(plan.title)} — 진행 계획</title>
<style>
:root{color-scheme:light dark;--bg:light-dark(#f7f8fc,#10151e);--surface:light-dark(#fff,#192130);--ink:light-dark(#172039,#e6ecf7);--muted:light-dark(#566278,#a0aec2);--line:light-dark(#dce2ec,#2c3749);--accent:light-dark(#405bb8,#b3c2ff)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 system-ui,-apple-system,sans-serif}a{color:var(--accent)}main{max-width:1120px;margin:auto;padding:48px 28px 80px}.top{display:flex;justify-content:space-between;gap:20px;align-items:center;font-size:12px;color:var(--muted)}.open{padding:9px 15px;border:1px solid var(--line);border-radius:7px;text-decoration:none;background:var(--surface)}h1{font-size:clamp(36px,6vw,58px);letter-spacing:-2px;line-height:1.1;margin:42px 0 14px}h2{font-size:23px;letter-spacing:-.6px;margin:48px 0 18px}p{margin:8px 0}.subtitle{font-size:19px;color:var(--muted);max-width:720px}.goal{margin-top:25px;border-left:3px solid var(--accent);padding-left:17px}.flow{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin:28px 0}.flow article{position:relative;border:1px solid var(--line);background:var(--surface);padding:24px;border-radius:10px}.flow article:not(:last-child):after{content:'→';position:absolute;right:-16px;top:42px;color:var(--accent);z-index:1}.eyebrow{font-size:11px;letter-spacing:.1em;color:var(--muted)}h3{font-size:18px;margin:10px 0}.flow p{font-size:13px;color:var(--muted)}.loop{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px;color:var(--muted);padding:14px 0;border-block:1px solid var(--line)}.loop b{font-weight:500;color:var(--ink)}.timeline{display:grid;gap:0}.phase{display:grid;grid-template-columns:60px 1fr;gap:16px;padding:23px 0;border-bottom:1px solid var(--line)}.phase-id{font:14px/2 ui-monospace,monospace;color:var(--muted)}.phase-top{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.phase h3{margin:0}.badge{font-size:11px;border-radius:4px;background:var(--surface);padding:3px 9px;border:1px solid var(--line)}.done .badge{color:light-dark(#186747,#92dfb5)}.active .badge{color:var(--accent)}.phase p{font-size:13px;color:var(--muted)}.acceptance{font-size:12px;margin-top:8px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:36px}.columns h2{margin-top:38px}.columns ul{padding-left:18px;color:var(--muted);font-size:13px}.columns li{margin:10px 0}.decision{padding:15px 0;border-bottom:1px solid var(--line)}.decision strong{font-size:14px;font-weight:600}.decision p{font-size:13px;color:var(--muted)}.checks{padding:18px 22px;background:var(--surface);border-radius:8px;border:1px solid var(--line);font-size:13px}.checks ul{padding-left:18px;margin:0}.checks li{margin:8px 0}.maintenance{margin-top:40px;padding-top:20px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}code{font-family:ui-monospace,monospace}footer{margin-top:22px;font-size:12px;color:var(--muted)}@media(max-width:720px){main{padding:24px 18px 50px}.flow,.columns{grid-template-columns:1fr}.flow article:not(:last-child):after{display:none}.top{align-items:flex-start}.phase{grid-template-columns:35px 1fr;gap:10px}h1{margin-top:30px}}@media print{.open{display:none}main{padding:0;max-width:none}body{background:white;color:black}.phase,.flow article,.decision{break-inside:avoid}}
</style></head><body><main>
<div class="top"><span>CODEG / CONTENT AUTHORING<br>${escape(plan.version)} · ${escape(plan.updated)}</span><a class="open" href="/studio">편집기 열기 ↗</a></div>
<h1>${escape(plan.title)}</h1><p class="subtitle">${escape(plan.subtitle)}</p><p class="goal">${escape(plan.goal)}</p>
<div class="flow">${plan.firstSlice.map((part, index) => `<article><span class="eyebrow">0${index + 1} / ${escape(part.label)}</span><h3>${escape(part.title)}</h3><p>${escape(part.description)}</p></article>`).join("")}</div>
<div class="loop"><b>원본 에셋</b><span>→</span><b>편집 문서</b><span>→</span><b>명령·검증</b><span>→</span><b>실행 미리보기</b><span>→</span><b>수정·저장</b><span>↺</span><span>편집 변경은 빌드 없이 즉시 반영</span></div>
<h2>실행 계획</h2><div class="timeline">${plan.phases.map((phase) => `<article class="phase ${escape(phase.status)}"><div class="phase-id">${escape(phase.id)}</div><div><div class="phase-top"><h3>${escape(phase.title)}</h3><span class="badge">${labels[phase.status]}</span></div><p>${escape(phase.detail)}</p><div class="acceptance">완료 기준 · ${escape(phase.acceptance)}</div></div></article>`).join("")}</div>
<div class="columns"><section><h2>이번 단계의 경계</h2><ul>${plan.boundaries.map((item) => `<li>${escape(item)}</li>`).join("")}</ul></section><section><h2>설계 결정</h2>${plan.decisions.map((decision) => `<div class="decision"><span class="eyebrow">${escape(decision.id)}</span><br><strong>${escape(decision.decision)}</strong><p>${escape(decision.reason)}</p></div>`).join("")}</section></div>
<h2>검증 기록</h2><div class="checks">${plan.checks.length ? `<ul>${plan.checks.map((check) => `<li>${escape(check)}</li>`).join("")}</ul>` : "검증 진행 중 — 완료 후 실제 결과를 기록합니다."}</div>
<div class="maintenance"><strong>이 문서 유지관리</strong><p>${escape(plan.maintenance)}</p><p>원본: <code>docs/studio/roadmap.json</code> · 사용법·명령 규약: <code>docs/studio/README.md</code></p></div>
<footer>${plan.sources.map((source) => `<a href="${escape(source.url)}">${escape(source.title)}</a>`).join(" · ")}<p>이 문서는 외부 스크립트 없이 열 수 있습니다. 편집기는 개발 서버 또는 배포된 앱에서 실행하세요.</p></footer>
</main></body></html>
`
if (process.argv.includes("--check")) {
  if ((await readFile(destination, "utf8")) !== html)
    throw new Error("Studio plan is stale. Run pnpm studio:plan")
  console.log("Studio plan matches roadmap.json")
} else {
  await writeFile(destination, html)
  console.log(fileURLToPath(destination))
}
