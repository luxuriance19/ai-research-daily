#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
const events = [];
const warnings = [];
const UA = "frontier-signals-daily/1.0";

const endpoints = {
  hf: "https://huggingface.co/api/daily_papers?limit=100",
  arxiv: "https://export.arxiv.org/api/query",
  semanticScholar: "https://api.semanticscholar.org/graph/v1/paper/batch",
  openai: "https://openai.com/news/rss.xml",
  anthropic: "https://www.anthropic.com/sitemap.xml",
  deepmind: "https://deepmind.google/blog/rss.xml",
  deepseek: "https://api.github.com/orgs/deepseek-ai/repos?sort=pushed&direction=desc&per_page=30",
};

const directions = {
  "智能体": ["agent", "computer use", "tool use", "multi-agent"],
  "安全与对齐": ["safety", "alignment", "red team", "risk", "trust"],
  "多模态": ["multimodal", "vision", "audio", "video", "image", "ocr"],
  "推理与评测": ["reasoning", "evaluation", "benchmark", "eval", "math"],
  "AI for Science": ["science", "biology", "chemistry", "medical", "genome"],
  "代码与软件工程": ["code", "coding", "software", "swe"],
  "效率与系统": ["efficient", "inference", "training", "memory", "diffusion"],
  "具身智能与机器人": ["robot", "embodied", "planning"],
};

const list = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value, limit = 1200) => String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
const dateValue = (value) => Number.isFinite(Date.parse(value ?? "")) ? Date.parse(value) : 0;
const compact = (value, fallback = "") => text(value, 260) || fallback;
const tagsFor = (...values) => {
  const haystack = values.join(" ").toLowerCase();
  const result = Object.entries(directions).filter(([, words]) => words.some((word) => haystack.includes(word))).map(([name]) => name);
  return result.slice(0, 3).length ? result.slice(0, 3) : ["基础模型与能力演进"];
};

async function fetchRetry(source, url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: { "user-agent": UA, accept: "*/*", ...(options.headers || {}) },
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      events.push({ source, status: "fresh", fetched_at: new Date().toISOString() });
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
  events.push({ source, status: "failed", fetched_at: new Date().toISOString(), error: String(lastError).slice(0, 300) });
  throw new Error(`${source} unavailable: ${lastError}`);
}

async function papers() {
  const source = await (await fetchRetry("huggingface-daily", endpoints.hf)).json();
  const dated = source.map((item) => item.paper || item).filter((paper) => paper.id && paper.submittedOnDailyAt);
  const latestMs = Math.max(...dated.map((paper) => dateValue(paper.submittedOnDailyAt)));
  const latest = new Date(latestMs).toISOString().slice(0, 10);
  const unique = new Map();
  for (const paper of dated.filter((paper) => paper.submittedOnDailyAt.slice(0, 10) === latest)) unique.set(paper.id, paper);
  const selected = [...unique.values()].sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0)).slice(0, 5).map((paper) => ({
    id: paper.id,
    title: text(paper.title, 300),
    summary: text(paper.summary, 1600),
    authors: list(paper.authors).map((author) => text(author.name, 80)).filter(Boolean),
    upvotes: Number(paper.upvotes || 0),
    published_at: paper.publishedAt || "",
    daily_at: paper.submittedOnDailyAt,
    arxiv_url: `https://arxiv.org/abs/${paper.id}`,
    hf_url: `https://huggingface.co/papers/${paper.id}`,
    github_url: paper.githubRepo || "",
    categories: [],
  }));
  if (selected.length !== 5 || new Set(selected.map((paper) => paper.id)).size !== 5) throw new Error("latest batch does not contain five unique papers");

  const query = new URLSearchParams({ id_list: selected.map((paper) => paper.id).join(","), max_results: "5" });
  try {
    const xml = await (await fetchRetry("arxiv", `${endpoints.arxiv}?${query}`)).text();
    const feed = parser.parse(xml).feed;
    const byId = new Map(list(feed.entry).map((entry) => [String(entry.id).split("/").pop().replace(/v\d+$/, ""), entry]));
    for (const paper of selected) {
      const entry = byId.get(paper.id);
      if (!entry) continue;
      paper.title = text(entry.title, 300) || paper.title;
      paper.summary = text(entry.summary, 1600) || paper.summary;
      paper.categories = list(entry.category).map((category) => category.term).filter(Boolean);
      paper.arxiv_published_at = entry.published || "";
    }
  } catch (error) {
    warnings.push(`arXiv 元数据核验失败，保留 Hugging Face 数据：${String(error).slice(0, 160)}`);
  }
  return { date: latest, selected };
}

async function enrichPaperSignals(paperList) {
  for (const paper of paperList) {
    paper.source_signals = [
      `HF ${paper.upvotes} 赞`,
      paper.categories.length ? `arXiv ${paper.categories.slice(0, 2).join("/")}` : "arXiv 已核验",
    ];
    if (paper.github_url) paper.source_signals.push("代码仓库可见");
  }

  try {
    const fields = "title,citationCount,influentialCitationCount,publicationDate,fieldsOfStudy,s2FieldsOfStudy,externalIds,url";
    const response = await fetchRetry("semantic-scholar", `${endpoints.semanticScholar}?fields=${encodeURIComponent(fields)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: paperList.map((paper) => `ARXIV:${paper.id}`) }),
    });
    const rows = await response.json();
    const byArxiv = new Map(
      list(rows)
        .filter(Boolean)
        .map((row) => [String(row.externalIds?.ArXiv || "").replace(/v\d+$/, ""), row]),
    );
    for (const paper of paperList) {
      const row = byArxiv.get(paper.id);
      if (!row) continue;
      if (Number.isFinite(row.citationCount)) paper.source_signals.push(`S2 引用 ${row.citationCount}`);
      if (Number.isFinite(row.influentialCitationCount) && row.influentialCitationCount > 0) {
        paper.source_signals.push(`影响引用 ${row.influentialCitationCount}`);
      }
      const fields = list(row.s2FieldsOfStudy).map((field) => field.category).filter(Boolean);
      if (fields.length) paper.source_signals.push(`S2 ${fields.slice(0, 2).join("/")}`);
    }
  } catch (error) {
    warnings.push(`Semantic Scholar 辅助信号失败：${String(error).slice(0, 140)}`);
  }
}

function rssItems(xml) {
  const channel = parser.parse(xml).rss?.channel;
  return list(channel?.item).map((item) => ({
    title: text(item.title, 300),
    url: String(item.link || ""),
    published_at: new Date(item.pubDate || 0).toISOString(),
    summary: text(item.description || item["content:encoded"], 700),
    categories: list(item.category).map((category) => text(category, 80)),
  }));
}

async function companies() {
  const result = { OpenAI: [], "Google DeepMind": [], Anthropic: [], DeepSeek: [] };
  try {
    const items = rssItems(await (await fetchRetry("openai-rss", endpoints.openai)).text());
    result.OpenAI = items.filter((item) => item.categories.some((category) => ["research", "safety"].includes(category.toLowerCase()))).slice(0, 3);
  } catch (error) { warnings.push(`OpenAI 官方源失败：${String(error).slice(0, 120)}`); }

  try {
    const items = rssItems(await (await fetchRetry("deepmind-rss", endpoints.deepmind)).text()).slice(0, 30);
    result["Google DeepMind"] = items.map((item, index) => ({ item, score: (tagsFor(item.title, item.summary)[0] === "基础模型与能力演进" ? 0 : tagsFor(item.title, item.summary).length * 10) - index })).sort((a, b) => b.score - a.score).slice(0, 3).map(({ item }) => item);
  } catch (error) { warnings.push(`Google DeepMind 官方源失败：${String(error).slice(0, 120)}`); }

  try {
    const xml = await (await fetchRetry("anthropic-sitemap", endpoints.anthropic)).text();
    const urls = list(parser.parse(xml).urlset?.url).filter((entry) => String(entry.loc).includes("/research/") && !String(entry.loc).includes("/research/team/"));
    result.Anthropic = urls.sort((a, b) => dateValue(b.lastmod) - dateValue(a.lastmod)).slice(0, 3).map((entry) => ({
      title: String(entry.loc).replace(/\/$/, "").split("/").pop().replaceAll("-", " ").replace(/\b\w/g, (char) => char.toUpperCase()),
      url: entry.loc,
      published_at: entry.lastmod || "",
      summary: "",
      categories: ["Research"],
    }));
  } catch (error) { warnings.push(`Anthropic 官方源失败：${String(error).slice(0, 120)}`); }

  try {
    const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
    const repos = await (await fetchRetry("deepseek-github", endpoints.deepseek, { headers })).json();
    result.DeepSeek = repos.filter((repo) => !repo.archived && !repo.fork).slice(0, 3).map((repo) => ({
      title: repo.name,
      url: repo.html_url,
      published_at: repo.pushed_at || repo.updated_at || "",
      summary: text(repo.description, 700),
      categories: ["Official GitHub activity"],
    }));
  } catch (error) { warnings.push(`DeepSeek 官方 GitHub 失败：${String(error).slice(0, 120)}`); }

  for (const items of Object.values(result)) for (const item of items) item.directions = tagsFor(item.title, item.summary);
  return result;
}

async function rewriteChinese(paperList, companyMap) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { warnings.push("未配置 Gemini，使用规则生成论文关键点占位"); return; }
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const source = {
    papers: paperList.map((paper) => ({ id: paper.id, title: paper.title, summary: paper.summary.slice(0, 1000) })),
    companies: Object.fromEntries(Object.entries(companyMap).map(([company, items]) => [company, items.map((item) => ({ url: item.url, title: item.title, summary: item.summary.slice(0, 500) }))])),
  };
  const prompt = `你是严谨的 AI 研究编辑。仅依据给定 JSON 改写，不添加事实。返回 JSON：papers 按 id 映射到 title_zh、summary_zh、why_zh、problem_zh、method_zh、key_points_zh、limitations_zh、pub_angle_zh；key_points_zh 为 3-4 条短句。companies 按公司名映射到数组，每项原样保留 url，并给出 title_zh、summary_zh。摘要 60-110 个汉字。limitations_zh 在来源不足时明确写“来源摘要未披露”。不要输出 Markdown。\n${JSON.stringify(source)}`;
  try {
    const response = await fetchRetry("gemini-rewrite", `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: "application/json" } }),
    });
    const body = await response.json();
    const rewritten = JSON.parse(body.candidates[0].content.parts[0].text);
    for (const paper of paperList) Object.assign(paper, rewritten.papers?.[paper.id] || {});
    for (const [company, items] of Object.entries(companyMap)) {
      const byUrl = new Map(list(rewritten.companies?.[company]).map((item) => [item.url, item]));
      for (const item of items) Object.assign(item, byUrl.get(item.url) || {});
    }
  } catch (error) { warnings.push(`Gemini 中文改写失败，保留来源文本：${String(error).slice(0, 140)}`); }
}

function fillPaperInsights(paperList) {
  for (const paper of paperList) {
    paper.why_zh = compact(paper.why_zh, "当日社区关注度较高，值得进一步阅读原文。");
    paper.problem_zh = compact(paper.problem_zh, "从摘要看，论文关注 AI 模型能力、训练或应用中的具体瓶颈。");
    paper.method_zh = compact(paper.method_zh, "摘要未完整披露方法细节，建议打开论文核验模型、数据和训练设置。");
    paper.limitations_zh = compact(paper.limitations_zh, "来源摘要未披露，发布前需人工复核实验范围和失败案例。");
    paper.pub_angle_zh = compact(paper.pub_angle_zh, `${tagsFor(paper.title, paper.summary)[0]}方向的当天热点论文，可结合方法与实验做选题。`);
    const points = list(paper.key_points_zh).map((point) => compact(point)).filter(Boolean);
    paper.key_points_zh = points.length ? points.slice(0, 4) : [
      "保留 Hugging Face、arXiv 与辅助学术信号，方便回溯来源。",
      "优先阅读摘要、实验设置和结果表，确认是否值得公众号展开。",
      "若存在代码仓库或 benchmark，可作为工程落地判断依据。",
    ];
    paper.source_signals = [...new Set(list(paper.source_signals).map((signal) => compact(signal, "")).filter(Boolean))].slice(0, 6);
  }
}

async function main() {
  const { date, selected } = await papers();
  await enrichPaperSignals(selected);
  const companyMap = await companies();
  await rewriteChinese(selected, companyMap);
  fillPaperInsights(selected);
  const digest = { date, generated_at: new Date().toISOString(), papers: selected, companies: companyMap, warnings, fetch_events: events };
  if (digest.papers.length !== 5 || new Set(digest.papers.map((paper) => paper.id)).size !== 5) throw new Error("digest validation failed");
  if (process.env.OUTPUT_PATH) await writeFile(process.env.OUTPUT_PATH, `${JSON.stringify(digest, null, 2)}\n`);

  if (process.env.SKIP_INGEST === "1") {
    console.log(`generated ${date}: ${selected.map((paper) => paper.id).join(", ")}`);
    return;
  }

  const ingestUrl = process.env.SITE_INGEST_URL;
  const token = process.env.SITE_INGEST_TOKEN;
  if (!ingestUrl || !token) throw new Error("SITE_INGEST_URL and SITE_INGEST_TOKEN are required");
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  if (process.env.OAI_SITES_BYPASS_TOKEN) headers["OAI-Sites-Authorization"] = `Bearer ${process.env.OAI_SITES_BYPASS_TOKEN}`;
  const response = await fetch(ingestUrl, { method: "POST", headers, body: JSON.stringify(digest), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`site ingest failed: ${response.status} ${await response.text()}`);
  console.log(`published ${date}: ${selected.map((paper) => paper.id).join(", ")}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
