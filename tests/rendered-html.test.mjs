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

test("renders a reader-first four-section AI daily", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>AI 前沿日报｜模型、芯片、底层研究与 Harness<\/title>/i);
  assert.match(html, /今日判断/);
  for (const heading of ["前沿模型公司", "芯片与算力", "模型规则与底层分析", "Harness 进展"]) assert.match(html, new RegExp(heading));
  assert.match(html, /Kimi K3：产品与 API 已上线/);
  assert.match(html, /固定 GPU 预算，也能把强化学习上下文推到 200 万 token/);
  assert.match(html, /OpenAI Agents SDK：重点不在版本号/);
  assert.match(html, /为什么值得看/);
  assert.match(html, /需要保留的边界/);
  assert.doesNotMatch(html, /UKGovernmentBEIS\/inspect_evals v0\.15\.0/);
  assert.doesNotMatch(html, /48 个注册源|来源不是越多越好|静默 0\/7|T4-official/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
});

test("exposes the public digest API", async () => {
  const response = await render("/api/digests");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.digests.length >= 1, true);
  assert.equal(body.digests[0].papers.length, 5);
});
