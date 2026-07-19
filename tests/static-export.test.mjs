import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFormulaSiteData } from "../automation/formula-site-data.mjs";

test("static site renders the four reader-facing news sections", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "frontier-static-"));
  try {
    const result = spawnSync(process.execPath, ["automation/export-static.mjs", "data/seed.json", output], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const html = await readFile(path.join(output, "index.html"), "utf8");
    assert.equal(await readFile(path.join(output, "article.html"), "utf8"), html);
    assert.match(html, /<title>AI 前沿日报｜模型、芯片、底层研究与 Harness<\/title>/);
    for (const heading of ["前沿模型公司", "芯片与算力", "模型规则与底层分析", "Harness 进展"]) assert.match(html, new RegExp(heading));
    assert.match(html, /Kimi K3：产品与 API 已上线/);
    assert.match(html, /固定 GPU 预算，也能把强化学习上下文推到 200 万 token/);
    assert.match(html, /OpenAI Agents SDK：重点不在版本号/);
    assert.match(html, /SearchOS：让搜索 Agent 共享进度/);
    assert.match(html, /本期没有可确认的硬件公司级重大更新/);
    assert.doesNotMatch(html, /UKGovernmentBEIS\/inspect_evals v0\.15\.0/);
    assert.doesNotMatch(html, /48 个注册源|来源不是越多越好|静默 0\/7|T4-official|A0/);
    assert.doesNotMatch(html, /MathJax|katex|<script/i);

    const payload = JSON.parse(await readFile(path.join(output, "digests.json"), "utf8"));
    assert.equal(payload.editorial.sections.length, 4);
    assert.equal(payload.editorial.manual_review_only, true);
    assert.equal(payload.editorial.notification_enabled, false);
    assert.equal(payload.top3.manual_review_only, true);
    assert.equal(payload.source_quality.policy.automatic_pruning_enabled, false);
    for (const formula of payload.formula_assets.formulas) {
      const bytes = await readFile(path.join(output, "formulas", formula.asset_file));
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    }

    const wechat = await readFile(path.join(output, "wechat.html"), "utf8");
    assert.match(wechat, /<section id="article" style=/);
    for (const heading of ["前沿模型公司", "芯片与算力", "模型规则与底层分析", "Harness 进展"]) assert.match(wechat, new RegExp(heading));
    assert.match(wechat, /不会自动发送/);
    assert.doesNotMatch(wechat, /UKGovernmentBEIS\/inspect_evals|MathJax|katex|<script|<link rel="stylesheet"/i);

    const archive = JSON.parse(await readFile(path.join(output, "archive/index.json"), "utf8"));
    assert.equal(archive.latest, "2026-07-19");
    assert.deepEqual(archive.entries[0].sections.map((section) => section.id), ["model-companies", "hardware", "constitution-analysis", "harness"]);
    const archived = await readFile(path.join(output, "archive/2026-07-19/index.html"), "utf8");
    assert.match(archived, /href="\.\.\/\.\.\/assets\/site\.css"/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("empty editorial sections stay explicit and archives remain additive", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "frontier-empty-"));
  const output = path.join(fixtureDir, "site");
  const digestPath = path.join(fixtureDir, "digest.json");
  const top3Path = path.join(fixtureDir, "top3.json");
  const sourceQualityPath = path.join(fixtureDir, "source-quality.json");
  const formulaPath = path.join(fixtureDir, "formulas.json");
  const editorialPath = path.join(fixtureDir, "editorial.json");
  try {
    await writeFile(digestPath, JSON.stringify({ date: "2026-07-18", generated_at: "2026-07-18T23:30:00.000Z", papers: [], companies: {}, warnings: [] }));
    const top3 = { mode: "local-top3-site-snapshot", generated_at: "2026-07-18T23:30:00.000Z", manual_review_only: true, notification_enabled: false, publishing_enabled: false, metrics: { dossiers_created: 0, key_points_extracted: 0 }, dossiers: [] };
    await writeFile(top3Path, JSON.stringify(top3));
    await writeFile(formulaPath, JSON.stringify(buildFormulaSiteData(top3)));
    const sourceQuality = JSON.parse(await readFile("data/source-quality-latest.json", "utf8"));
    sourceQuality.summary.selected_story_ids = [];
    await writeFile(sourceQualityPath, JSON.stringify(sourceQuality));
    const editorial = JSON.parse(await readFile("data/editorial-latest.json", "utf8"));
    editorial.date = "2026-07-19";
    editorial.generated_at = "2026-07-18T23:30:00.000Z";
    for (const section of editorial.sections) section.stories = [];
    await writeFile(editorialPath, JSON.stringify(editorial));

    const env = { ...process.env, TOP3_SITE_DATA_PATH: top3Path, SOURCE_QUALITY_SITE_DATA_PATH: sourceQualityPath, FORMULA_SITE_DATA_PATH: formulaPath, EDITORIAL_SITE_DATA_PATH: editorialPath };
    const first = spawnSync(process.execPath, ["automation/export-static.mjs", digestPath, output], { cwd: process.cwd(), encoding: "utf8", env });
    assert.equal(first.status, 0, first.stderr);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    assert.equal((html.match(/本期留空/g) || []).length, 4);

    editorial.date = "2026-07-20";
    editorial.generated_at = "2026-07-19T23:30:00.000Z";
    await writeFile(editorialPath, JSON.stringify(editorial));
    const second = spawnSync(process.execPath, ["automation/export-static.mjs", digestPath, output], { cwd: process.cwd(), encoding: "utf8", env });
    assert.equal(second.status, 0, second.stderr);
    const archive = JSON.parse(await readFile(path.join(output, "archive/index.json"), "utf8"));
    assert.deepEqual(archive.entries.map((entry) => entry.date), ["2026-07-20", "2026-07-19"]);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
