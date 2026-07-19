import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the verified Top 3 mechanism brief before the community paper supplement", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>前沿信号｜少而精的 AI 机制日报<\/title>/i);
  assert.match(html, /少而精的 AI/);
  const expectedTop3 = JSON.parse(await readFile(new URL("../data/top3-latest.json", import.meta.url), "utf8"));
  assert.match(html, new RegExp(`今日 (?:<!-- -->)?${expectedTop3.dossiers.length}(?:<!-- -->)? 条`));
  assert.ok(expectedTop3.dossiers.length > 0 && expectedTop3.dossiers.length <= 3);
  for (const dossier of expectedTop3.dossiers) assert.ok(html.includes(escapeHtml(dossier.title)), dossier.title);
  assert.match(html, /证据边界/);
  if (expectedTop3.dossiers.some((dossier) => /T\^2MLR/.test(dossier.title))) assert.match(html, /跨 token 的状态丢失/);
  assert.equal((html.match(/class="brief-card /g) || []).length, expectedTop3.dossiers.length);
  assert.match(html, /研究问题/);
  assert.match(html, /公众号角度/);
  assert.match(html, /未入选论文补充/);
  assert.equal((html.match(/<details class="paper-card">/g) || []).length, 5);
  assert.match(html, /默认折叠，不与 Top 3 混排/);
  assert.match(html, /公司研究雷达/);
  assert.match(html, /底层机制雷达/);
  assert.match(html, /当日来源质量账本/);
  assert.match(html, /噪声观察（不代表删源）/);
  assert.match(html, /src="\/formulas\/formula-[a-f0-9]{12}\.png"/);
  assert.match(html, /Claude Constitution/);
  assert.match(html, /Ouro \/ Looped Language Model/);
  assert.match(html, /Coconut \/ Continuous Latent Thought/);
  assert.match(html, /Agent &amp; Evaluation Harness/);
  assert.match(html, /OpenAI/);
  assert.match(html, /Anthropic/);
  assert.match(html, /Google DeepMind/);
  assert.match(html, /DeepSeek/);
  const arxivIds = new Set(
    [...html.matchAll(/https:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/g)].map((match) => match[1]),
  );
  assert.equal(arxivIds.size >= 5, true);
  const latest = JSON.parse(await readFile(new URL("../data/latest.json", import.meta.url), "utf8"));
  for (const paper of latest.papers) assert.equal(arxivIds.has(paper.id), true, paper.id);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
});

test("exposes the public digest API", async () => {
  const response = await render("/api/digests");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.digests.length >= 1, true);
  assert.equal(body.digests[0].papers.length, 5);
});
