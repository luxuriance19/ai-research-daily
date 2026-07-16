#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const digestPath = process.argv[2] || "data/latest.json";
const outputDir = path.resolve(root, process.argv[3] || "public-pages");
const companyOrder = ["OpenAI", "Anthropic", "Google DeepMind", "DeepSeek"];

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const list = (value) => Array.isArray(value) ? value : [];
const formatDate = (value) => new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "Asia/Shanghai",
}).format(new Date(`${value}T00:00:00+08:00`));

async function readDigest() {
  try {
    return JSON.parse(await readFile(path.resolve(root, digestPath), "utf8"));
  } catch {
    return JSON.parse(await readFile(path.resolve(root, "data/seed.json"), "utf8"));
  }
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
  return `<article class="paper-card">
    <div class="paper-rank" aria-label="排名 ${index + 1}">${String(index + 1).padStart(2, "0")}</div>
    <div class="paper-body">
      <div class="paper-kicker">
        <span>${esc(list(paper.categories).slice(0, 3).join(" · ") || "AI Research")}</span>
        <span>${esc(paper.upvotes)} HF 赞</span>
      </div>
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
      <div class="vote-track" aria-label="${esc(paper.upvotes)} 个 Hugging Face 赞"><span style="width:${voteWidth}%"></span></div>
      <div class="paper-footer">
        <span>${esc(list(paper.authors).slice(0, 3).join("、"))}${list(paper.authors).length > 3 ? " 等" : ""}</span>
        <nav aria-label="${esc(titleOf(paper))} 的来源">
          <a href="${esc(paper.hf_url)}" target="_blank" rel="noreferrer">HF</a>
          <a href="${esc(paper.arxiv_url)}" target="_blank" rel="noreferrer">arXiv</a>
          ${paper.github_url ? `<a href="${esc(paper.github_url)}" target="_blank" rel="noreferrer">Code</a>` : ""}
        </nav>
      </div>
    </div>
  </article>`;
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

function render(digest) {
  const maxVotes = Math.max(...digest.papers.map((paper) => Number(paper.upvotes || 0)), 1);
  const fresh = list(digest.fetch_events).filter((event) => event.status === "fresh").length;
  const totalSignals = Object.values(digest.companies || {}).reduce((count, items) => count + list(items).length, 0);
  const totalVotes = digest.papers.reduce((count, paper) => count + Number(paper.upvotes || 0), 0);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>前沿信号｜AI 研究日报</title>
  <meta name="description" content="每天筛选 5 篇热门 AI 论文，并追踪四家前沿实验室的官方研究信号。">
  <meta property="og:title" content="前沿信号｜AI 研究日报">
  <meta property="og:description" content="每天筛选 5 篇热门 AI 论文，并追踪四家前沿实验室的官方研究信号。">
  <meta property="og:image" content="./og.png">
  <link rel="icon" href="./favicon.svg">
  <link rel="stylesheet" href="./assets/site.css">
</head>
<body>
  <main>
    <header class="site-header">
      <a class="brand" href="./" aria-label="前沿信号首页"><span class="brand-mark">F</span><span><strong>前沿信号</strong><small>FRONTIER SIGNALS</small></span></a>
      <div class="header-note">每日 AI 研究筛选与官方信号追踪</div>
    </header>
    <div class="page-shell">
      <aside class="archive-panel">
        <p class="eyebrow">STATIC MIRROR</p>
        <h2>独立发布版</h2>
        <nav aria-label="日报日期"><a class="active" href="./"><span>${esc(formatDate(digest.date))}</span><em>最新</em></a></nav>
        <div class="method-note"><span>筛选公式</span><div class="formula">S<sub>paper</sub> = U<sub>HF</sub> + S<sub>aux</sub></div><p>HF 用于当天社区热度，arXiv 与 Semantic Scholar 用于元数据和学术信号补充。</p></div>
      </aside>
      <div class="content-column">
        <section class="hero">
          <div>
            <p class="eyebrow">AI RESEARCH DAILY · ${esc(digest.date)}</p>
            <h1>每日 AI 研究情报台</h1>
            <p class="hero-copy">从 Hugging Face 热度、arXiv 元数据、Semantic Scholar 辅助信号和前沿实验室官方渠道中，提炼当天最值得进入公众号排版的研究信号。</p>
            <div class="status-strip" aria-label="数据源状态"><span class="status-live"></span><strong>静态独立发布</strong><span>${fresh}/${list(digest.fetch_events).length} 个来源为最新响应</span><span class="status-separator"></span><span>生成于 ${esc(new Date(digest.generated_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))}</span></div>
          </div>
          <div class="metric-rail" aria-label="本期摘要指标">
            <div><span>TOP</span><strong>5</strong><em>热门论文</em></div>
            <div><span>HF</span><strong>${esc(totalVotes)}</strong><em>社区赞数</em></div>
            <div><span>LAB</span><strong>${esc(totalSignals)}</strong><em>官方信号</em></div>
          </div>
        </section>
        <section class="section-block" id="papers">
          <div class="section-title"><div><p class="eyebrow">TODAY'S TOP FIVE</p><h2>热门论文</h2></div><p>批次日期 ${esc(formatDate(digest.date))}<br>热度来自社区投票与辅助信号。</p></div>
          <div class="paper-list">${digest.papers.map((paper, index) => paperCard(paper, index, maxVotes)).join("")}</div>
        </section>
        <section class="section-block" id="companies">
          <div class="section-title"><div><p class="eyebrow">LAB RADAR</p><h2>公司研究雷达</h2></div><p>追踪官方 RSS、研究站点地图<br>和官方 GitHub 组织。</p></div>
          <div class="company-grid">${companyOrder.map((company) => companyCard(company, list(digest.companies?.[company]))).join("")}</div>
        </section>
        ${list(digest.warnings).length ? `<section class="warning-block"><strong>运行披露</strong>${digest.warnings.map((warning) => `<p>${esc(warning)}</p>`).join("")}</section>` : ""}
        <footer><div><strong>前沿信号</strong><span>GitHub Pages / Cloudflare Pages 静态镜像。</span></div><p>数据源：Hugging Face、arXiv、Semantic Scholar、OpenAI、Anthropic、Google DeepMind、DeepSeek。辅助信号只用于排序和编辑提示，不替代人工阅读。</p></footer>
      </div>
    </div>
  </main>
</body>
</html>`;
}

async function main() {
  const digest = await readDigest();
  await mkdir(path.join(outputDir, "assets"), { recursive: true });
  await writeFile(path.join(outputDir, "index.html"), render(digest));
  await writeFile(path.join(outputDir, "digests.json"), `${JSON.stringify({ digests: [digest] }, null, 2)}\n`);
  const css = await readFile(path.resolve(root, "app/globals.css"), "utf8");
  await writeFile(path.join(outputDir, "assets/site.css"), css.replace(/^@import "tailwindcss";\n\n/, ""));
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
