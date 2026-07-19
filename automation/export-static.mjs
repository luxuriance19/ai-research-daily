#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const digestPath = process.argv[2] || "data/latest.json";
const outputDir = path.resolve(root, process.argv[3] || "public-pages");
const top3Path = process.env.TOP3_SITE_DATA_PATH || "data/top3-latest.json";
const mechanismRadarPath = process.env.MECHANISM_RADAR_SITE_DATA_PATH || "data/mechanism-radar-latest.json";
const sourceQualityPath = process.env.SOURCE_QUALITY_SITE_DATA_PATH || "data/source-quality-latest.json";
const formulaAssetsPath = process.env.FORMULA_SITE_DATA_PATH || "data/formula-assets-latest.json";
const editorialPath = process.env.EDITORIAL_SITE_DATA_PATH || "data/editorial-latest.json";

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
const list = (value) => Array.isArray(value) ? value : [];

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
  timeZone: "Asia/Shanghai",
});
const shortDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  timeZone: "Asia/Shanghai",
});
const formatDate = (value) => dateFormatter.format(new Date(`${value}T00:00:00+08:00`));
const formatStoryDate = (value) => value ? shortDateFormatter.format(new Date(value)) : "日期待确认";
const shanghaiDateKey = (value) => new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Shanghai",
}).format(new Date(value));

async function readJson(filename, fallback = null) {
  try {
    return JSON.parse(await readFile(path.resolve(root, filename), "utf8"));
  } catch (error) {
    if (fallback !== null) return fallback;
    throw error;
  }
}

async function readArchiveEntries(archiveRoot) {
  let directories = [];
  try {
    directories = await readdir(archiveRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const directory of directories) {
    if (!directory.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(directory.name)) continue;
    try {
      const metadata = JSON.parse(await readFile(path.join(archiveRoot, directory.name, "metadata.json"), "utf8"));
      if (metadata.date === directory.name) entries.push(metadata);
    } catch {
      // Ignore partial or legacy archives.
    }
  }
  return entries.sort((left, right) => right.date.localeCompare(left.date));
}

function kindLabel(kind) {
  if (kind === "model-release") return "公司发布";
  if (kind === "harness-release") return "工程更新";
  if (kind === "hardware-system") return "芯片与系统";
  return "研究论文";
}

function storyHtml(story, featured = false, assetPrefix = "./") {
  const formula = story.formula;
  return `<article class="${featured ? "news-story news-story-featured" : "news-story"}">
    <div class="story-meta"><time>${esc(formatStoryDate(story.published_at))}</time><span>${esc(kindLabel(story.kind))}</span></div>
    <h3>${esc(story.title)}</h3>
    ${story.original_title && story.original_title !== story.title ? `<p class="original-title">${esc(story.original_title)}</p>` : ""}
    <p class="story-summary">${esc(story.summary)}</p>
    <div class="story-why"><strong>${esc(story.angle_label || "先看重点")}</strong><p>${esc(story.why_it_matters)}</p></div>
    <ul class="story-points">${list(story.key_points).map((point) => `<li>${esc(point)}</li>`).join("")}</ul>
    ${formula ? `<figure class="story-formula"><figcaption>${esc(formula.label)}</figcaption><img src="${esc(`${assetPrefix}formulas/${formula.asset_file}`)}" alt="${esc(formula.alt)}"></figure>` : ""}
    <div class="story-caveat"><strong>${esc(story.caveat_label || "还没确认")}</strong><p>${esc(story.caveat)}</p></div>
    <nav class="story-sources" aria-label="${esc(story.title)} 的一手来源">${list(story.sources).map((source) => `<a href="${esc(source.url)}" target="_blank" rel="noreferrer">${esc(source.label)} ↗</a>`).join("")}</nav>
  </article>`;
}

function sectionHtml(section, assetPrefix = "./") {
  const stories = list(section.stories);
  return `<section class="editorial-section editorial-section-${esc(section.id)}" id="${esc(section.id)}">
    <header class="section-heading"><span>${esc(section.number)}</span><div><h2>${esc(section.title)}</h2><p>${esc(section.description)}</p></div></header>
    ${section.status_note ? `<p class="section-status">${esc(section.status_note)}</p>` : ""}
    ${stories.length
      ? `<div class="story-list">${stories.map((story, index) => storyHtml(story, index === 0, assetPrefix)).join("")}</div>`
      : `<div class="honest-empty"><span>今天无大事</span><p>${esc(section.empty_message)}</p></div>`}
  </section>`;
}

function render(editorial, { archiveEntries = [], assetPrefix = "./", homeHref = "./", archivePrefix = "./archive/", archived = false } = {}) {
  const archiveLinks = archiveEntries.slice(0, 7).map((entry, index) => {
    const current = entry.date === editorial.date;
    const href = current && archived ? "./" : current ? homeHref : `${archivePrefix}${entry.date}/`;
    return `<a href="${esc(href)}">${esc(entry.date)}${index === 0 ? " · 最新" : ""}</a>`;
  }).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI 前沿日报｜模型、芯片、底层研究与 Harness</title>
  <meta name="description" content="每天只讲四件事：前沿模型公司、芯片与算力、模型规则与底层研究、Harness 进展。没有重要更新就留空。">
  <meta property="og:title" content="AI 前沿日报">
  <meta property="og:description" content="四条主线，通俗解释，一手来源。">
  <meta property="og:image" content="${esc(assetPrefix)}og.png">
  <link rel="icon" href="${esc(assetPrefix)}favicon.svg">
  <link rel="stylesheet" href="${esc(assetPrefix)}assets/site.css">
</head>
<body>
  <main class="daily-page">
    <header class="daily-header">
      <a class="wordmark" href="${esc(homeHref)}" aria-label="AI 前沿日报首页">Frontier Brief</a>
      <nav aria-label="四大栏目">${list(editorial.sections).map((section) => `<a href="#${esc(section.id)}">${esc(section.title)}</a>`).join("")}</nav>
    </header>
    <article class="daily-article" id="top">
      <section class="editorial-hero">
        <p class="edition-date">${esc(formatDate(editorial.date))} · 第 ${esc(editorial.date.replaceAll("-", ""))} 期</p>
        <h1>${esc(editorial.title)}</h1>
        <p class="hero-deck">${esc(editorial.deck)}</p>
        <div class="today-judgment"><span>编辑手记</span><p>${esc(editorial.lead)}</p></div>
        <div class="section-index" aria-label="本期栏目目录">${list(editorial.sections).map((section) => `<a href="#${esc(section.id)}"><span>${esc(section.number)}</span><strong>${esc(section.title)}</strong><em>${list(section.stories).length ? `${list(section.stories).length} 条` : "留空"}</em></a>`).join("")}</div>
      </section>
      ${list(editorial.sections).map((section) => sectionHtml(section, assetPrefix)).join("")}
      <footer class="daily-footer">
        <details><summary>编辑说明与来源边界</summary><p>论文热度批次为 ${esc(editorial.reading_notes?.paper_batch)}。社区热度只帮助发现，不替代官方发布、论文、代码或版本记录。</p>${editorial.reading_notes?.omitted_evaluation_patch ? `<p>${esc(editorial.reading_notes.note)}</p>` : ""}<nav class="archive-links" aria-label="日报归档">${archiveLinks}</nav></details>
        <p>资料由程序汇集，正文按证据整理。没到新闻门槛的内容不占版面。</p>
      </footer>
    </article>
  </main>
</body>
</html>`;
}

function inlineStory(story) {
  return `<section style="margin:22px 0;padding:22px 18px;border:1px solid #d8d2c5;background:#fff;">
    <p style="margin:0 0 10px;color:#777b74;font-size:12px;">${esc(formatStoryDate(story.published_at))} · ${esc(kindLabel(story.kind))}</p>
    <h3 style="margin:0;color:#171916;font-size:22px;line-height:1.45;">${esc(story.title)}</h3>
    ${story.original_title && story.original_title !== story.title ? `<p style="margin:8px 0 0;color:#777b74;font-size:11px;line-height:1.5;">${esc(story.original_title)}</p>` : ""}
    <p style="margin:16px 0;color:#4c514b;font-size:16px;line-height:1.9;">${esc(story.summary)}</p>
    <blockquote style="margin:16px 0;padding:14px 16px;border-left:4px solid #cc5a2d;background:#f3efe6;color:#373b36;font-size:14px;line-height:1.75;"><strong>${esc(story.angle_label || "先看重点")}：</strong>${esc(story.why_it_matters)}</blockquote>
    <ol style="margin:18px 0;padding-left:22px;color:#262925;font-size:15px;line-height:1.85;">${list(story.key_points).map((point) => `<li style="margin:8px 0;">${esc(point)}</li>`).join("")}</ol>
    <p style="margin:16px 0;padding:12px 14px;background:#f8f6f0;color:#5a5f58;font-size:13px;line-height:1.75;"><strong>${esc(story.caveat_label || "还没确认")}：</strong>${esc(story.caveat)}</p>
    <p style="margin:12px 0 0;font-size:12px;">${list(story.sources).map((source) => `<a style="margin-right:14px;color:#294c9b;" href="${esc(source.url)}">${esc(source.label)} ↗</a>`).join("")}</p>
  </section>`;
}

function renderWechat(editorial) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 前沿日报</title></head><body style="margin:0;background:#ece7dc;padding:20px 0;"><section id="article" style="box-sizing:border-box;max-width:760px;margin:0 auto;padding:28px 20px;background:#fbfaf6;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;">
    <p style="margin:0 0 14px;color:#294c9b;font-size:12px;font-weight:700;letter-spacing:.08em;">${esc(formatDate(editorial.date))}</p>
    <h1 style="margin:0;color:#171916;font-family:Georgia,'Songti SC',serif;font-size:36px;line-height:1.2;">${esc(editorial.title)}</h1>
    <p style="margin:18px 0;color:#4c514b;font-size:16px;line-height:1.85;">${esc(editorial.deck)}</p>
    <blockquote style="margin:24px 0;padding:18px;border-left:5px solid #cc5a2d;background:#f3efe6;color:#252824;font-size:17px;line-height:1.8;"><strong style="display:block;margin-bottom:6px;color:#cc5a2d;font-size:12px;">编辑手记</strong>${esc(editorial.lead)}</blockquote>
    ${list(editorial.sections).map((section) => `<section style="margin:36px 0 0;"><p style="margin:0;color:#294c9b;font-size:13px;font-weight:700;">${esc(section.number)}</p><h2 style="margin:6px 0 4px;color:#171916;font-size:27px;line-height:1.4;">${esc(section.title)}</h2><p style="margin:0 0 14px;color:#777b74;font-size:13px;line-height:1.7;">${esc(section.description)}</p>${section.status_note ? `<p style="padding:12px 14px;background:#e9eefb;color:#334466;font-size:13px;line-height:1.7;">${esc(section.status_note)}</p>` : ""}${list(section.stories).length ? list(section.stories).map(inlineStory).join("") : `<p style="padding:18px;border:1px dashed #aaa393;background:#f6f2e9;color:#4c514b;font-size:15px;line-height:1.75;">${esc(section.empty_message)}</p>`}</section>`).join("")}
    <p style="margin:34px 0 0;padding-top:18px;border-top:1px solid #d8d2c5;color:#777b74;font-size:12px;line-height:1.8;">资料由程序汇集，正文按证据整理。没到新闻门槛的内容不占版面。本页是公众号排版预览，不会自动发送。</p>
  </section></body></html>`;
}

async function main() {
  const [digest, top3, mechanismRadar, sourceQuality, formulaAssets, editorial] = await Promise.all([
    readJson(digestPath, readJson("data/seed.json")),
    readJson(top3Path),
    readJson(mechanismRadarPath),
    readJson(sourceQualityPath),
    readJson(formulaAssetsPath),
    readJson(editorialPath),
  ]);
  if (top3.manual_review_only !== true || top3.notification_enabled !== false || top3.publishing_enabled !== false) throw new Error("Top 3 snapshot crossed its review boundary");
  if (mechanismRadar.manual_review_only !== true || mechanismRadar.notification_enabled !== false || mechanismRadar.publishing_enabled !== false) throw new Error("Mechanism snapshot crossed its review boundary");
  if (sourceQuality.policy?.automatic_pruning_enabled !== false || sourceQuality.policy?.ranking_impact !== "none" || sourceQuality.policy?.notification_enabled !== false) throw new Error("Source quality snapshot crossed its audit boundary");
  if (formulaAssets.manual_review_only !== true || formulaAssets.notification_enabled !== false || formulaAssets.policy?.inferred_or_reconstructed_formulas_allowed !== false) throw new Error("Formula manifest crossed its provenance boundary");
  if (editorial.mode !== "reader-first-four-section-daily" || editorial.manual_review_only !== true || editorial.notification_enabled !== false || list(editorial.sections).length !== 4) throw new Error("Editorial snapshot must contain the four reader-facing sections");
  if (list(editorial.sections).flatMap((section) => list(section.stories)).some((story) => /inspect_evals/i.test(`${story.title} ${story.original_title || ""}`))) throw new Error("Low-level Inspect Evals audit must not become reader-facing news");

  const reportDate = editorial.date || shanghaiDateKey(editorial.generated_at);
  const archiveRoot = path.join(outputDir, "archive");
  const archiveDir = path.join(archiveRoot, reportDate);
  const previousEntries = await readArchiveEntries(archiveRoot);
  const currentEntry = {
    date: reportDate,
    generated_at: editorial.generated_at,
    sections: list(editorial.sections).map((section) => ({ id: section.id, story_count: list(section.stories).length })),
    top_count: list(top3.dossiers).length,
    top_story_ids: list(top3.dossiers).map((dossier) => dossier.story_id).sort(),
    path: `./${reportDate}/`,
  };
  const archiveEntries = [currentEntry, ...previousEntries.filter((entry) => entry.date !== reportDate)].sort((left, right) => right.date.localeCompare(left.date));
  const payload = { digests: [digest], editorial, top3, mechanism_radar: mechanismRadar, source_quality: sourceQuality, formula_assets: formulaAssets };
  const currentHtml = render(editorial, { archiveEntries });
  const archivedHtml = render(editorial, { archiveEntries, assetPrefix: "../../", homeHref: "../../", archivePrefix: "../", archived: true });
  const wechatHtml = renderWechat(editorial);

  await mkdir(path.join(outputDir, "assets"), { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  await writeFile(path.join(outputDir, "index.html"), currentHtml);
  await writeFile(path.join(outputDir, "article.html"), currentHtml);
  await writeFile(path.join(outputDir, "wechat.html"), wechatHtml);
  await writeFile(path.join(outputDir, "digests.json"), `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(path.join(archiveDir, "index.html"), archivedHtml);
  await writeFile(path.join(archiveDir, "article.html"), archivedHtml);
  await writeFile(path.join(archiveDir, "wechat.html"), wechatHtml);
  await writeFile(path.join(archiveDir, "digests.json"), `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(path.join(archiveDir, "metadata.json"), `${JSON.stringify(currentEntry, null, 2)}\n`);
  await writeFile(path.join(archiveRoot, "index.json"), `${JSON.stringify({ schema_version: 1, latest: reportDate, entries: archiveEntries }, null, 2)}\n`);
  const css = await readFile(path.resolve(root, "app/globals.css"), "utf8");
  await writeFile(path.join(outputDir, "assets/site.css"), css.replace(/^@import "tailwindcss";\n\n/, ""));
  await cp(path.resolve(root, "public", "formulas"), path.join(outputDir, "formulas"), { recursive: true, force: true });
  for (const asset of ["favicon.svg", "og.png"]) {
    try { await cp(path.resolve(root, "public", asset), path.join(outputDir, asset), { force: true }); } catch { /* optional */ }
  }
  process.stdout.write(`static site exported to ${outputDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
