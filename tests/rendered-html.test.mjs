import assert from "node:assert/strict";
import test from "node:test";

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

test("renders the AI research daily from the validated seed", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>前沿信号｜AI 研究日报<\/title>/i);
  assert.match(html, /每日 AI 研究情报台/);
  assert.match(html, /热门论文/);
  assert.match(html, /公司研究雷达/);
  assert.match(html, /OpenAI/);
  assert.match(html, /Anthropic/);
  assert.match(html, /Google DeepMind/);
  assert.match(html, /DeepSeek/);
  const arxivIds = new Set(
    [...html.matchAll(/https:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/g)].map((match) => match[1]),
  );
  assert.equal(arxivIds.size, 5);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
});

test("exposes the public digest API", async () => {
  const response = await render("/api/digests");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.digests.length >= 1, true);
  assert.equal(body.digests[0].papers.length, 5);
});
