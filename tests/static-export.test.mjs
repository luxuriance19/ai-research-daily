import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFormulaSiteData } from "../automation/formula-site-data.mjs";

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

test("static GitHub and Cloudflare artifact contains the verified Top 3 console", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "frontier-static-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["automation/export-static.mjs", "data/seed.json", output],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);

    const html = await readFile(path.join(output, "index.html"), "utf8");
    assert.equal(await readFile(path.join(output, "article.html"), "utf8"), html);
    assert.match(html, /<title>前沿信号｜少而精的 AI 机制日报<\/title>/);
    assert.match(html, /AI Signal Studio/);
    assert.match(html, /今天真正值得理解的/);
    assert.match(html, /48 个注册源完成发现/);
    assert.match(html, /来源不是越多越好/);
    assert.match(html, /当日来源质量账本/);
    assert.match(html, /class="formula"><img src="\.\/formulas\/formula-[a-f0-9]{12}\.png"/);
    assert.doesNotMatch(html, /MathJax|katex|<script/i);
    assert.match(html, /噪声观察（不代表删源）/);
    const expectedTop3 = JSON.parse(await readFile("data/top3-latest.json", "utf8"));
    assert.ok(expectedTop3.dossiers.length >= 0 && expectedTop3.dossiers.length <= 3);
    for (const dossier of expectedTop3.dossiers) assert.ok(html.includes(escapeHtml(dossier.title)), dossier.title);
    assert.equal((html.match(/class="brief-card /g) || []).length, expectedTop3.dossiers.length);
    assert.ok(html.includes(`<strong>${expectedTop3.metrics.key_points_extracted}</strong><em>机制要点`));
    const k3 = expectedTop3.dossiers.find((dossier) => /Kimi K3/i.test(dossier.title));
    if (k3) assert.match(html, /href="https:\/\/www\.kimi\.com\/blog\/kimi-k3"/);
    assert.match(html, /未入选论文补充/);
    assert.equal((html.match(/<details class="paper-card">/g) || []).length, 5);
    assert.match(html, /默认折叠，不与 Top 3 混排/);
    assert.match(html, /公司研究雷达/);
    assert.match(html, /底层机制雷达/);
    for (const title of ["Claude Constitution", "Ouro / Looped Language Model", "Coconut / Continuous Latent Thought", "Agent &amp; Evaluation Harness"]) assert.ok(html.includes(title), title);

    const payload = JSON.parse(await readFile(path.join(output, "digests.json"), "utf8"));
    assert.equal(payload.top3.manual_review_only, true);
    assert.equal(payload.top3.notification_enabled, false);
    assert.equal(payload.top3.publishing_enabled, false);
    assert.equal(payload.top3.dossiers.length, expectedTop3.dossiers.length);
    assert.equal(payload.mechanism_radar.cards.length, 4);
    assert.equal(payload.mechanism_radar.notification_enabled, false);
    assert.equal(payload.source_quality.sources.length, 48);
    assert.equal(payload.source_quality.policy.automatic_pruning_enabled, false);
    assert.equal(payload.source_quality.policy.ranking_impact, "none");
    assert.equal(payload.source_quality.policy.notification_enabled, false);
    assert.equal(payload.formula_assets.policy.inferred_or_reconstructed_formulas_allowed, false);
    assert.equal(payload.formula_assets.policy.wechat_raster_assets, true);
    for (const formula of payload.formula_assets.formulas) {
      const bytes = await readFile(path.join(output, "formulas", formula.asset_file));
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    }
    const wechatHtml = await readFile(path.join(output, "wechat.html"), "utf8");
    assert.match(wechatHtml, /<section id="article" style=/);
    assert.match(wechatHtml, /src="\.\/formulas\/formula-[a-f0-9]{12}\.png"/);
    assert.match(wechatHtml, /本地人工审阅稿/);
    assert.doesNotMatch(wechatHtml, /MathJax|katex|<script|<link rel="stylesheet"/i);
    assert.match(html, /论文热榜批次：/);
    assert.doesNotMatch(html, /DAILY MECHANISM BRIEF · 2026-07-18T/);
    const archive = JSON.parse(await readFile(path.join(output, "archive/index.json"), "utf8"));
    assert.equal(archive.entries.length, 1);
    assert.equal(archive.entries[0].date, "2026-07-19");
    assert.equal(archive.entries[0].top_count, expectedTop3.dossiers.length);
    const archivedHtml = await readFile(path.join(output, "archive/2026-07-19/index.html"), "utf8");
    assert.match(archivedHtml, /href="\.\.\/\.\.\/assets\/site\.css"/);
    assert.equal(await readFile(path.join(output, "archive/2026-07-19/article.html"), "utf8"), archivedHtml);
    assert.match(await readFile(path.join(output, "archive/2026-07-19/wechat.html"), "utf8"), /src="\.\.\/\.\.\/formulas\/formula-/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("static export keeps working when no story qualifies and paper data is unavailable", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "frontier-empty-"));
  const output = path.join(fixtureDir, "site");
  const digestPath = path.join(fixtureDir, "digest.json");
  const top3Path = path.join(fixtureDir, "top3.json");
  const sourceQualityPath = path.join(fixtureDir, "source-quality.json");
  const formulaPath = path.join(fixtureDir, "formulas.json");
  try {
    await writeFile(digestPath, JSON.stringify({
      date: "2026-07-18",
      generated_at: "2026-07-18T23:30:00.000Z",
      companies: {},
      warnings: [],
    }));
    const emptyTop3 = {
      mode: "local-top3-site-snapshot",
      generated_at: "2026-07-18T23:30:00.000Z",
      manual_review_only: true,
      notification_enabled: false,
      publishing_enabled: false,
      metrics: { dossiers_created: 0, key_points_extracted: 0 },
      dossiers: [],
    };
    await writeFile(top3Path, JSON.stringify(emptyTop3));
    await writeFile(formulaPath, JSON.stringify(buildFormulaSiteData(emptyTop3)));
    const sourceQuality = JSON.parse(await readFile("data/source-quality-latest.json", "utf8"));
    sourceQuality.summary.selected_stories = 0;
    sourceQuality.summary.selected_story_ids = [];
    sourceQuality.summary.selected_top3_contributors = 0;
    for (const source of sourceQuality.sources) source.today.selected_top3_attributions = 0;
    await writeFile(sourceQualityPath, JSON.stringify(sourceQuality));

    const result = spawnSync(
      process.execPath,
      ["automation/export-static.mjs", digestPath, output],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, TOP3_SITE_DATA_PATH: top3Path, SOURCE_QUALITY_SITE_DATA_PATH: sourceQualityPath, FORMULA_SITE_DATA_PATH: formulaPath },
      },
    );
    assert.equal(result.status, 0, result.stderr);

    const html = await readFile(path.join(output, "index.html"), "utf8");
    assert.match(html, /2026年7月19日/);
    assert.match(html, /今天没有达到门槛的代表事件/);
    assert.match(html, /论文热榜批次暂不可用/);

    const nextTop3 = JSON.parse(await readFile(top3Path, "utf8"));
    nextTop3.generated_at = "2026-07-19T23:30:00.000Z";
    await writeFile(top3Path, JSON.stringify(nextTop3));
    await writeFile(formulaPath, JSON.stringify(buildFormulaSiteData(nextTop3)));
    const nextResult = spawnSync(
      process.execPath,
      ["automation/export-static.mjs", digestPath, output],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, TOP3_SITE_DATA_PATH: top3Path, SOURCE_QUALITY_SITE_DATA_PATH: sourceQualityPath, FORMULA_SITE_DATA_PATH: formulaPath },
      },
    );
    assert.equal(nextResult.status, 0, nextResult.stderr);
    const archive = JSON.parse(await readFile(path.join(output, "archive/index.json"), "utf8"));
    assert.deepEqual(archive.entries.map((entry) => entry.date), ["2026-07-20", "2026-07-19"]);
    assert.equal(await readFile(path.join(output, "archive/2026-07-19/metadata.json"), "utf8").then(Boolean), true);
    const latestHtml = await readFile(path.join(output, "index.html"), "utf8");
    assert.match(latestHtml, /href="\.\/archive\/2026-07-19\/"/);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
