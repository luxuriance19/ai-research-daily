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
const companyOrder = ["OpenAI", "Anthropic", "Google DeepMind", "DeepSeek"];
const sectionLabels = {
  "new-model": "新模型",
  mechanism: "底层机制",
  "harness-eval": "Harness / Eval",
  "compute-system": "算力系统",
};
const sourceLanes = [
  { label: "论文与机制", count: 21, detail: "arXiv · Hugging Face · Semantic Scholar · 官方论文与代码页" },
  { label: "模型与算力", count: 16, detail: "官方模型页 · 芯片厂商 · 研究实验室 · GitHub Releases" },
  { label: "技术与社区", count: 11, detail: "GitHub Trending · Latent Space · Hacker News · 权威科技媒体" },
];

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
  timeZone: "Asia/Shanghai",
});
const formatDigestDate = (value) => dateFormatter.format(new Date(`${value}T00:00:00+08:00`));
const formatReportDate = (value) => dateFormatter.format(new Date(value));
const shanghaiDateKey = (value) => new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Shanghai",
}).format(new Date(value));

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
      // A partial or legacy directory is not admitted to archive navigation.
    }
  }
  return entries.sort((left, right) => right.date.localeCompare(left.date));
}

async function readDigest() {
  try {
    return JSON.parse(await readFile(path.resolve(root, digestPath), "utf8"));
  } catch {
    return JSON.parse(await readFile(path.resolve(root, "data/seed.json"), "utf8"));
  }
}

async function readTop3() {
  return JSON.parse(await readFile(path.resolve(root, top3Path), "utf8"));
}

async function readMechanismRadar() {
  return JSON.parse(await readFile(path.resolve(root, mechanismRadarPath), "utf8"));
}

async function readSourceQuality() {
  return JSON.parse(await readFile(path.resolve(root, sourceQualityPath), "utf8"));
}

async function readFormulaAssets() {
  return JSON.parse(await readFile(path.resolve(root, formulaAssetsPath), "utf8"));
}

function titleOf(paper) {
  return paper.title_zh || paper.title;
}

function summaryOf(paper) {
  return paper.summary_zh || paper.summary;
}

function paperCard(paper, index, maxVotes) {
  const voteWidth = Math.max(8, Math.round((Number(paper.upvotes || 0) / Math.max(maxVotes, 1)) * 100));
  const points = list(paper.key_points_zh).slice(0, 4);
  const signals = list(paper.source_signals).slice(0, 4);
  return `<details class="paper-card">
    <summary>
      <span class="paper-rank" aria-label="补充排名 ${index + 1}">${String(index + 1).padStart(2, "0")}</span>
      <span class="paper-body paper-body-preview">
        <span class="paper-kicker"><span>${esc(list(paper.categories).slice(0, 3).join(" · ") || "AI Research")}</span><span>${esc(paper.upvotes)} HF 赞</span></span>
        <strong class="paper-preview-title">${esc(titleOf(paper))}</strong>
        <span class="paper-preview-reason">${esc(paper.why_zh || "社区热度补充，只在展开后显示详细分析。")}</span>
        <span class="vote-track" aria-label="${esc(paper.upvotes)} 个 Hugging Face 赞"><span style="width:${voteWidth}%"></span></span>
      </span>
      <span class="paper-expand" aria-hidden="true"></span>
    </summary>
    <div class="paper-expanded">
      <div class="paper-kicker"><span>补充雷达 · 非 Top 3</span><span>展开内容不代表入选</span></div>
      <h3>${esc(titleOf(paper))}</h3>
      ${paper.title_zh && paper.title_zh !== paper.title ? `<p class="original-title">${esc(paper.title)}</p>` : ""}
      <p class="paper-summary">${esc(summaryOf(paper))}</p>
      <p class="paper-why"><strong>关注理由</strong>${esc(paper.why_zh || "当日社区关注度较高，值得进一步阅读原文。")}</p>
      <div class="paper-deep-dive">
        <div><span>研究问题</span><p>${esc(paper.problem_zh || "需要阅读全文后补充更精确的问题定义。")}</p></div>
        <div><span>核心方法</span><p>${esc(paper.method_zh || "来源摘要未提供足够方法细节，建议进入论文核验。")}</p></div>
        ${points.length ? `<div class="wide"><span>关键点</span><ul>${points.map((point) => `<li>${esc(point)}</li>`).join("")}</ul></div>` : ""}
        <div><span>局限与风险</span><p>${esc(paper.limitations_zh || "当前自动摘要未识别明确局限，发布前建议人工复核实验设置。")}</p></div>
        <div><span>公众号角度</span><p>${esc(paper.pub_angle_zh || "可作为当日热点论文观察，需结合代码、实验和应用场景再定标题。")}</p></div>
      </div>
      ${signals.length ? `<div class="signal-list" aria-label="辅助热度信号">${signals.map((signal) => `<span>${esc(signal)}</span>`).join("")}</div>` : ""}
      <div class="paper-footer">
        <span>${esc(list(paper.authors).slice(0, 3).join("、"))}${list(paper.authors).length > 3 ? " 等" : ""}</span>
        <nav aria-label="${esc(titleOf(paper))} 的来源">
          <a href="${esc(paper.hf_url)}" target="_blank" rel="noreferrer">HF</a>
          <a href="${esc(paper.arxiv_url)}" target="_blank" rel="noreferrer">arXiv</a>
          ${paper.github_url ? `<a href="${esc(paper.github_url)}" target="_blank" rel="noreferrer">Code</a>` : ""}
        </nav>
      </div>
    </div>
  </details>`;
}

function companyCard(company, items) {
  return `<section class="company-card">
    <div class="company-heading"><span class="company-dot"></span><h3>${esc(company)}</h3><span>${items.length} 条信号</span></div>
    <div class="company-list">
      ${items.map((item) => `<article>
        <div class="signal-meta"><time>${esc((item.published_at || "").slice(0, 10) || "日期待确认")}</time><span>${esc(list(item.directions)[0] || "研究动态")}</span></div>
        <h4><a href="${esc(item.url)}" target="_blank" rel="noreferrer">${esc(item.title_zh || item.title)}</a></h4>
        <p>${esc(item.summary_zh || item.summary || "官方来源未提供摘要，请阅读原文。")}</p>
        <div class="direction-tags">${list(item.directions).slice(0, 3).map((direction) => `<span>${esc(direction)}</span>`).join("")}</div>
      </article>`).join("")}
    </div>
  </section>`;
}

function top3Card(dossier, formulas, assetPrefix) {
  return `<article class="brief-card brief-card-${esc(dossier.primary_section)}">
    <div class="brief-rank"><span>NO.</span><strong>${String(dossier.rank).padStart(2, "0")}</strong><em>${Number(dossier.selection_score).toFixed(1)}</em></div>
    <div class="brief-content">
      <div class="brief-meta"><span>${esc(sectionLabels[dossier.primary_section] || dossier.primary_section)}</span><span>${dossier.evidence_status === "source-audited-manual-review" ? "来源已审计" : "证据待补"}</span></div>
      <h3><a href="${esc(dossier.canonical_url)}" target="_blank" rel="noreferrer">${esc(dossier.title)}</a></h3>
      <div class="mechanism-points">
        ${list(dossier.key_points).map((point) => {
          const formula = list(formulas).find((item) => item.scope === "research-source-exact" && item.story_id === dossier.story_id && item.point_topic === point.topic);
          return `<section>
            <div class="point-heading"><span>${esc(point.mechanism_layer)}</span><strong>${esc(String(point.topic).replaceAll("-", " "))}</strong></div>
            <p>${esc(point.statement_zh)}</p>
            ${formula ? `<figure class="research-formula"><figcaption>${esc(formula.label_zh)} · 一手原式</figcaption><img src="${esc(`${assetPrefix}formulas/${formula.asset_file}`)}" alt="${esc(formula.alt_zh)}"><small>只显示一手摘录中逐字出现的公式，不由摘要反推。</small></figure>` : ""}
            <div class="point-boundary"><span>证据边界</span>${esc(point.boundary)}</div>
            <div class="point-source"><span>${esc(point.evidence_ceiling)}</span><a href="${esc(point.source_url)}" target="_blank" rel="noreferrer">查看一手来源 ↗</a></div>
          </section>`;
        }).join("")}
      </div>
      <details class="evidence-gaps"><summary>仍缺少的证据 · ${list(dossier.evidence_gaps).length}</summary><ul>${list(dossier.evidence_gaps).map((gap) => `<li>${esc(String(gap).replaceAll("-", " "))}</li>`).join("")}</ul></details>
    </div>
  </article>`;
}

function mechanismRadarCard(card) {
  const observation = card.source_observation || {};
  const stateLabel = observation.state === "degraded"
    ? "来源降级"
    : `静默 ${observation.observed_days}/${observation.required_days}`;
  return `<article class="mechanism-radar-card">
    <div class="radar-card-head"><span>${esc(card.layer)}</span><em class="radar-state radar-state-${esc(observation.state)}">${esc(stateLabel)}</em></div>
    <h3><a href="${esc(card.primary_url)}" target="_blank" rel="noreferrer">${esc(card.title)}</a></h3>
    <p class="radar-thesis">${esc(card.thesis_zh)}</p>
    <div class="radar-boundary"><span>不能越过的结论</span><p>${esc(card.boundary_zh)}</p></div>
    <div class="radar-metrics">
      <span><strong>${esc(card.claim_metrics?.source_ready || 0)}</strong>窄 claim 可追溯</span>
      <span><strong>${esc(card.claim_metrics?.evidence_gap || 0)}</strong>证据缺口</span>
      <span><strong>${esc(card.attention_level || "A0")}</strong>关注层</span>
    </div>
  </article>`;
}

function mechanismRadarSection(radar) {
  return `<section class="section-block mechanism-radar-section" id="mechanism-radar">
    <div class="section-title"><div><p class="eyebrow">MECHANISM WATCH · LONG-RUN</p><h2>底层机制雷达</h2></div><p>不是当天新闻，也不是语言风格分析。<br>持续核对模型计算路径与证据缺口。</p></div>
    <div class="radar-disclosure"><div><span class="${radar.status === "degraded" ? "status-warning" : "status-live"}"></span><strong>长期尽调 · 本轮新事件 ${esc(radar.current_event_candidates || 0)}</strong></div><p>来源稳定性与 claim 完整性分开显示；达到 7 天也仍需人工来源复核。</p></div>
    <div class="mechanism-radar-grid">${list(radar.cards).map(mechanismRadarCard).join("")}</div>
  </section>`;
}

function sourceQualityConsole(scorecard) {
  const sources = list(scorecard.sources);
  const selected = sources.filter((source) => Number(source.today?.selected_top3_attributions || 0) > 0);
  const noisy = sources
    .filter((source) => Number(source.today?.editorial_exclusion_attributions || 0) > 0)
    .sort((left, right) => Number(right.today.editorial_exclusion_attributions) - Number(left.today.editorial_exclusion_attributions))
    .slice(0, 3);
  return `<div class="source-quality-console">
    <div class="source-quality-head"><div><span class="${scorecard.status === "ok" ? "status-live" : "status-warning"}"></span><strong>当日来源质量账本</strong></div><p>单日只记录，不自动删源；连续 7 个自然日后才进入人工角色复核。</p></div>
    <div class="source-quality-metrics">
      <div><strong>${esc(scorecard.summary.healthy_sources)}/${esc(scorecard.summary.registered_sources)}</strong><span>当日健康</span></div>
      <div><strong>${esc(scorecard.summary.selected_top3_contributors)}</strong><span>Top 贡献源</span></div>
      <div><strong>${esc(scorecard.summary.editorial_exclusion_endpoint_attributions)}</strong><span>排除归因</span></div>
      <div><strong>${esc(scorecard.summary.ready_for_human_role_review)}</strong><span>可人审调级</span></div>
    </div>
    <div class="source-quality-columns">
      <section><span>今日高信号贡献</span>${selected.map((source) => `<div><strong>${esc(source.label)}</strong><em>${esc(String(source.quality_role || "").replaceAll("-", " "))} · Top ${esc(source.today.selected_top3_attributions)}</em></div>`).join("")}</section>
      <section><span>噪声观察（不代表删源）</span>${noisy.map((source) => `<div><strong>${esc(source.label)}</strong><em>排除归因 ${esc(source.today.editorial_exclusion_attributions)} · 观察 ${esc(source.observation.scorecard_consecutive_healthy_days)}/7</em></div>`).join("")}</section>
    </div>
  </div>`;
}

function sourceArchitecture(sourceQuality) {
  return `<section class="section-block source-section" id="sources">
    <div class="section-title"><div><p class="eyebrow">SOURCE PIPELINE</p><h2>来源不是越多越好</h2></div><p>发现与举证分开运行。只有进入 Top 3 的事件，才触发逐论点证据抓取。</p></div>
    <div class="pipeline-summary">
      <div class="pipeline-number"><strong>48</strong><span>注册发现源</span></div><div class="pipeline-arrow">→</div>
      <div class="pipeline-number"><strong>10</strong><span>采集器分组</span></div><div class="pipeline-arrow">→</div>
      <div class="pipeline-number featured"><strong>3</strong><span>最多入选</span></div><div class="pipeline-arrow">→</div>
      <div class="pipeline-number"><strong>64</strong><span>按需证据端点</span></div>
    </div>
    <div class="source-lanes">${sourceLanes.map((lane) => `<article><div><span>${String(lane.count).padStart(2, "0")}</span><i></i></div><h3>${esc(lane.label)}</h3><p>${esc(lane.detail)}</p></article>`).join("")}</div>
    ${sourceQualityConsole(sourceQuality)}
    <div class="rule-console">
      <div><span>准入</span><code>一手身份 + 明确技术增量 + 48h 时效</code></div>
      <div><span>排序</span><code>I(0–2) + Δtech(0–3) + Artifact(0–2) + Heat(0–2) + Freshness(0–1)</code></div>
      <div><span>输出</span><code>score ≥ 6 · 每类最多 1 条 · 不足则留空</code></div>
    </div>
  </section>`;
}

function renderWechatDraft(top3, formulaAssets, { assetPrefix = "./" } = {}) {
  const dossiers = list(top3.dossiers);
  const rankingFormula = list(formulaAssets.formulas).find((formula) => formula.id === "editorial-ranking-score-v1");
  if (!rankingFormula) throw new Error("WeChat draft is missing the editorial ranking formula");
  const researchFormula = (dossier, point) => list(formulaAssets.formulas)
    .find((item) => item.scope === "research-source-exact" && item.story_id === dossier.story_id && item.point_topic === point.topic);
  const cards = dossiers.map((dossier) => `<section style="margin:26px 0;padding:18px 16px;border:1px solid #d8dee8;border-radius:12px;background:#ffffff;">
    <p style="margin:0 0 8px;color:#5b6b82;font-size:12px;letter-spacing:.08em;">NO.${String(dossier.rank).padStart(2, "0")} · ${esc(sectionLabels[dossier.primary_section] || dossier.primary_section)} · ${Number(dossier.selection_score).toFixed(1)} 分</p>
    <h2 style="margin:0 0 14px;color:#12233f;font-size:21px;line-height:1.45;"><a style="color:#12233f;text-decoration:none;" href="${esc(dossier.canonical_url)}">${esc(dossier.title)}</a></h2>
    ${list(dossier.key_points).map((point) => {
      const formula = researchFormula(dossier, point);
      return `<div style="margin:14px 0;padding-top:14px;border-top:1px solid #edf0f5;">
        <p style="margin:0 0 8px;color:#2563eb;font-size:12px;font-weight:700;">${esc(point.mechanism_layer)} · ${esc(String(point.topic).replaceAll("-", " "))}</p>
        <p style="margin:0 0 10px;color:#26364f;font-size:16px;line-height:1.8;">${esc(point.statement_zh)}</p>
        ${formula ? `<p style="margin:12px 0 6px;color:#5b6b82;font-size:12px;">${esc(formula.label_zh)} · 一手原式</p><img src="${esc(`${assetPrefix}formulas/${formula.asset_file}`)}" alt="${esc(formula.alt_zh)}" style="display:block;max-width:92%;height:auto;margin:10px auto;"><p style="margin:0 0 10px;color:#78869a;font-size:11px;">只显示一手摘录中逐字出现的公式，不由摘要反推。</p>` : ""}
        <blockquote style="margin:10px 0;padding:10px 12px;border-left:3px solid #f97316;background:#fff7ed;color:#704429;font-size:13px;line-height:1.7;"><strong>证据边界：</strong>${esc(point.boundary)}</blockquote>
        <p style="margin:8px 0 0;font-size:12px;"><a style="color:#2563eb;text-decoration:none;" href="${esc(point.source_url)}">查看一手来源 ↗</a></p>
      </div>`;
    }).join("")}
  </section>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>前沿信号 AI 日报</title></head><body style="margin:0;background:#eef2f7;padding:20px 0;"><section id="article" style="box-sizing:border-box;max-width:760px;margin:0 auto;padding:24px 18px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;">
    <p style="margin:0 0 8px;color:#2563eb;font-size:12px;font-weight:700;letter-spacing:.12em;">AI SIGNAL STUDIO · ${esc(shanghaiDateKey(top3.generated_at))}</p>
    <h1 style="margin:0 0 14px;color:#12233f;font-size:28px;line-height:1.35;">今天真正值得理解的 ${dossiers.length} 个 AI 技术信号</h1>
    <p style="margin:0 0 18px;color:#52637b;font-size:15px;line-height:1.8;">新模型、底层机制、算力系统与 Harness / Eval 在同一个候选池竞争。最多三条，不足不补位。</p>
    <aside style="margin:18px 0;padding:14px;border-radius:10px;background:#eaf1ff;"><p style="margin:0 0 8px;color:#35506f;font-size:12px;font-weight:700;">筛选公式</p><img src="${esc(`${assetPrefix}formulas/${rankingFormula.asset_file}`)}" alt="${esc(rankingFormula.alt_zh)}" style="display:block;max-width:92%;height:auto;margin:8px auto;"><p style="margin:8px 0 0;color:#52637b;font-size:12px;line-height:1.7;">一手身份与技术增量决定准入，热度只负责发现和排序。</p></aside>
    ${cards || '<p style="padding:20px;background:#fff;color:#52637b;">今天没有达到门槛的代表事件，系统不会用普通更新硬凑 Top 3。</p>'}
    <p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #d8dee8;color:#78869a;font-size:12px;line-height:1.7;">本页是本地人工审阅稿，不代表自动通知或公众号发布。公式均为本地 PNG，上传草稿时可替换为微信素材 URL。</p>
  </section></body></html>`;
}

function render(digest, top3, mechanismRadar, sourceQuality, formulaAssets, {
  archiveEntries = [],
  assetPrefix = "./",
  homeHref = "./",
  archivePrefix = "./archive/",
  archived = false,
} = {}) {
  const papers = list(digest.papers);
  const dossiers = list(top3.dossiers);
  const maxVotes = Math.max(...papers.map((paper) => Number(paper.upvotes || 0)), 1);
  const reportDate = formatReportDate(top3.generated_at);
  const digestDate = formatDigestDate(digest.date);
  const reportDateKey = shanghaiDateKey(top3.generated_at);
  const top3Generated = new Date(top3.generated_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const rankingFormula = list(formulaAssets.formulas).find((formula) => formula.id === "editorial-ranking-score-v1");
  if (!rankingFormula) throw new Error("formula manifest is missing the editorial ranking formula");
  const archiveLinks = archiveEntries.slice(0, 7).map((entry, index) => {
    const current = entry.date === reportDateKey;
    const href = current && archived ? "./" : current ? homeHref : `${archivePrefix}${entry.date}/`;
    return `<a class="${current ? "active" : ""}" href="${esc(href)}"><span>${esc(formatDigestDate(entry.date))}</span>${index === 0 ? "<em>最新</em>" : ""}</a>`;
  }).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>前沿信号｜少而精的 AI 机制日报</title>
  <meta name="description" content="每天从新模型、底层机制、算力系统与 Harness 中筛选三条代表事件，并标明一手证据、机制要点和结论边界。">
  <meta property="og:title" content="前沿信号｜少而精的 AI 机制日报">
  <meta property="og:description" content="每天从新模型、底层机制、算力系统与 Harness 中筛选三条代表事件，并标明一手证据、机制要点和结论边界。">
  <meta property="og:image" content="${esc(assetPrefix)}og.png">
  <link rel="icon" href="${esc(assetPrefix)}favicon.svg">
  <link rel="stylesheet" href="${esc(assetPrefix)}assets/site.css">
</head>
<body>
  <main class="studio-shell">
    <aside class="studio-rail" aria-label="页面导航"><a class="rail-logo" href="#overview" aria-label="前沿信号顶部">FS</a><nav><a class="active" href="#overview"><span>01</span><em>概览</em></a><a href="#top3"><span>02</span><em>Top 3</em></a><a href="#mechanism-radar"><span>03</span><em>机制</em></a><a href="#sources"><span>04</span><em>来源</em></a><a href="#papers"><span>05</span><em>论文</em></a><a href="#companies"><span>06</span><em>实验室</em></a></nav><div class="rail-state"><i></i>静默审阅</div></aside>
    <div class="studio-main">
    <header class="site-header"><a class="brand" href="${esc(homeHref)}" aria-label="前沿信号首页"><span><strong>AI Signal Studio</strong><small>前沿信号 · DAILY RESEARCH CONSOLE</small></span></a><nav class="header-actions" aria-label="快捷导航"><a href="#sources">48 个发现源</a><a href="#top3">今日 Top ${esc(dossiers.length)}</a><span><i></i>人工审阅模式</span></nav></header>
    <div class="page-shell">
      <aside class="archive-panel">
        <p class="eyebrow">DAILY ARCHIVE</p>
        <h2>日报归档</h2>
        <nav aria-label="日报日期">${archiveLinks || `<a class="active" href="${esc(homeHref)}"><span>${esc(reportDate)}</span><em>最新</em></a>`}</nav>
        <p class="archive-batch">论文热榜批次：${esc(digestDate)}</p>
        <div class="method-note"><span>筛选公式</span><div class="formula"><img src="${esc(`${assetPrefix}formulas/${rankingFormula.asset_file}`)}" alt="${esc(rankingFormula.alt_zh)}"></div><p>一手身份与技术增量决定准入，社区热度只负责排序；入选后才拉取 claim-specific 证据。</p></div>
      </aside>
      <div class="content-column">
        <section class="hero" id="overview">
          <div>
            <p class="eyebrow">DAILY MECHANISM BRIEF · ${esc(reportDate)}</p>
            <h1>今天真正值得理解的<br><span>${esc(top3.metrics.dossiers_created)} 个 AI 技术信号</span></h1>
            <p class="hero-copy">新模型、芯片与算力、底层机制、Harness / Eval 在同一个候选池竞争。社区热度负责发现，一手证据决定结论能写到哪里。</p>
            <div class="command-bar"><div><span class="command-dot"></span><strong>48 个注册源完成发现</strong><small>→ 已收敛为 ${esc(top3.metrics.dossiers_created)} 条审阅候选</small></div><a href="#top3">打开今日简报 <span>↗</span></a></div>
            <div class="status-strip" aria-label="Top 3 审阅状态"><span class="status-review"></span><strong>一手证据已整理，等待人工审阅</strong><span>${esc(top3.metrics.dossiers_created)} 条 / ${esc(top3.metrics.key_points_extracted)} 个要点</span><span class="status-separator"></span><span>更新于 ${esc(top3Generated)}</span></div>
          </div>
          <div class="metric-rail" aria-label="本期摘要指标">
            <div><span>TOP</span><strong>${esc(top3.metrics.dossiers_created)}</strong><em>代表事件</em></div>
            <div><span>POINT</span><strong>${esc(top3.metrics.key_points_extracted)}</strong><em>机制要点</em></div>
            <div><span>ACTION</span><strong>0</strong><em>自动发布</em></div>
          </div>
        </section>
        <section class="section-block top3-section" id="top3"><div class="section-title"><div><p class="eyebrow">TODAY'S TOP SIGNALS</p><h2>今日 ${esc(dossiers.length)} 条</h2></div><p>最多三条，不足不补位。每条都保留<br>机制层、证据上限和反推边界。</p></div><div class="brief-list">${dossiers.length ? dossiers.map((dossier) => top3Card(dossier, formulaAssets.formulas, assetPrefix)).join("") : '<div class="brief-empty"><strong>今天没有达到门槛的代表事件</strong><p>系统不会用普通更新或单一热搜硬凑 Top 3。</p></div>'}</div></section>
        ${mechanismRadarSection(mechanismRadar)}
        ${sourceArchitecture(sourceQuality)}
        <section class="section-block" id="papers">
          <div class="section-title"><div><p class="eyebrow">SECONDARY PAPER RADAR</p><h2>未入选论文补充</h2></div><p>默认折叠，不与 Top 3 混排。<br>批次 ${esc(digestDate)} · 热度不等于证据。</p></div>
          <div class="paper-list">${papers.length ? papers.map((paper, index) => paperCard(paper, index, maxVotes)).join("") : '<div class="brief-empty"><strong>论文热榜批次暂不可用</strong><p>Top 信号与论文补充相互独立，缺失时不会阻断整页。</p></div>'}</div>
        </section>
        <section class="section-block" id="companies">
          <div class="section-title"><div><p class="eyebrow">LAB RADAR</p><h2>公司研究雷达</h2></div><p>追踪官方 RSS、研究站点地图<br>和官方 GitHub 组织。</p></div>
          <div class="company-grid">${companyOrder.map((company) => companyCard(company, list(digest.companies?.[company]))).join("")}</div>
        </section>
        ${list(digest.warnings).length ? `<section class="warning-block"><strong>运行披露</strong>${digest.warnings.map((warning) => `<p>${esc(warning)}</p>`).join("")}</section>` : ""}
        <footer><div><strong>前沿信号</strong><span>可验证、可追溯、不过度推断。</span></div><p>数据源：Hugging Face、arXiv、OpenAI、Anthropic、Google DeepMind、DeepSeek。DeepSeek 仓库更新时间仅作为工程方向信号。</p></footer>
      </div>
    </div>
    </div>
  </main>
</body>
</html>`;
}

async function main() {
  const [digest, top3, mechanismRadar, sourceQuality, formulaAssets] = await Promise.all([readDigest(), readTop3(), readMechanismRadar(), readSourceQuality(), readFormulaAssets()]);
  if (top3.manual_review_only !== true || top3.notification_enabled !== false || top3.publishing_enabled !== false) {
    throw new Error("Top 3 public snapshot must remain manual-review-only with notification and publishing disabled");
  }
  if (list(top3.dossiers).length > 3) throw new Error("Top 3 snapshot contains more than three dossiers");
  if (mechanismRadar.manual_review_only !== true || mechanismRadar.notification_enabled !== false || mechanismRadar.publishing_enabled !== false || list(mechanismRadar.cards).length !== 4) {
    throw new Error("Mechanism radar snapshot crossed the review boundary or lost an audited track");
  }
  if (sourceQuality.policy?.authority_and_attention_separate !== true || sourceQuality.policy?.automatic_pruning_enabled !== false || sourceQuality.policy?.automatic_promotion_enabled !== false || sourceQuality.policy?.ranking_impact !== "none" || sourceQuality.policy?.notification_enabled !== false || sourceQuality.policy?.publishing_enabled !== false || list(sourceQuality.sources).length !== 48) {
    throw new Error("Source quality snapshot crossed its role, ranking, notification, or publishing boundary");
  }
  if (formulaAssets.mode !== "verified-formula-site-manifest" || formulaAssets.manual_review_only !== true || formulaAssets.notification_enabled !== false || formulaAssets.publishing_enabled !== false || formulaAssets.policy?.inferred_or_reconstructed_formulas_allowed !== false || formulaAssets.policy?.wechat_raster_assets !== true) {
    throw new Error("Formula manifest crossed its provenance, review, or raster boundary");
  }
  if (formulaAssets.generated_at !== top3.generated_at) throw new Error("Formula manifest does not match the current Top 3 snapshot");
  const topStoryIds = list(top3.dossiers).map((dossier) => dossier.story_id).sort();
  if (JSON.stringify(list(sourceQuality.summary?.selected_story_ids).sort()) !== JSON.stringify(topStoryIds)) {
    throw new Error("Source quality snapshot does not match the verified Top 3 story set");
  }
  const reportDate = shanghaiDateKey(top3.generated_at);
  const archiveRoot = path.join(outputDir, "archive");
  const archiveDir = path.join(archiveRoot, reportDate);
  const previousEntries = await readArchiveEntries(archiveRoot);
  const currentEntry = {
    date: reportDate,
    generated_at: top3.generated_at,
    top_count: list(top3.dossiers).length,
    top_story_ids: topStoryIds,
    top3_fingerprint: top3.source_report_fingerprint,
    source_quality_fingerprint: sourceQuality.report_fingerprint,
    path: `./${reportDate}/`,
  };
  const archiveEntries = [currentEntry, ...previousEntries.filter((entry) => entry.date !== reportDate)]
    .sort((left, right) => right.date.localeCompare(left.date));
  const payload = { digests: [digest], top3, mechanism_radar: mechanismRadar, source_quality: sourceQuality, formula_assets: formulaAssets };
  const currentHtml = render(digest, top3, mechanismRadar, sourceQuality, formulaAssets, { archiveEntries });
  const archivedHtml = render(digest, top3, mechanismRadar, sourceQuality, formulaAssets, {
    archiveEntries,
    assetPrefix: "../../",
    homeHref: "../../",
    archivePrefix: "../",
    archived: true,
  });
  const wechatHtml = renderWechatDraft(top3, formulaAssets);
  const archivedWechatHtml = renderWechatDraft(top3, formulaAssets, { assetPrefix: "../../" });
  await mkdir(path.join(outputDir, "assets"), { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  await writeFile(path.join(outputDir, "index.html"), currentHtml);
  await writeFile(path.join(outputDir, "article.html"), currentHtml);
  await writeFile(path.join(outputDir, "wechat.html"), wechatHtml);
  await writeFile(path.join(outputDir, "digests.json"), `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(path.join(archiveDir, "index.html"), archivedHtml);
  await writeFile(path.join(archiveDir, "article.html"), archivedHtml);
  await writeFile(path.join(archiveDir, "wechat.html"), archivedWechatHtml);
  await writeFile(path.join(archiveDir, "digests.json"), `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(path.join(archiveDir, "metadata.json"), `${JSON.stringify(currentEntry, null, 2)}\n`);
  await writeFile(path.join(archiveRoot, "index.json"), `${JSON.stringify({ schema_version: 1, latest: reportDate, entries: archiveEntries }, null, 2)}\n`);
  const css = await readFile(path.resolve(root, "app/globals.css"), "utf8");
  await writeFile(path.join(outputDir, "assets/site.css"), css.replace(/^@import "tailwindcss";\n\n/, ""));
  await cp(path.resolve(root, "public", "formulas"), path.join(outputDir, "formulas"), { recursive: true, force: true });
  for (const asset of ["favicon.svg", "og.png", "file.svg", "globe.svg", "window.svg"]) {
    try {
      await cp(path.resolve(root, "public", asset), path.join(outputDir, asset), { force: true });
    } catch {
      // Optional starter assets are not required for the static mirror.
    }
  }
  console.log(`static site exported to ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
