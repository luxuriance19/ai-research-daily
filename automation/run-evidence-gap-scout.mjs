#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { diligenceTopics } from "./source-diligence-contracts.mjs";
import { evidenceGapScoutSources, evidenceGapSourceDecisions } from "./evidence-gap-scout-registry.mjs";

const AUDIT_TIME_ZONE = "Asia/Shanghai";
const MINIMUM_OBSERVATION_DAYS = 7;
const CACHE_MAX_AGE_MS = 7 * 86_400_000;
const NETWORK_SUCCESS = new Set(["fresh", "not-modified"]);
const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: AUDIT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function consecutiveDayCount(dateKeys) {
  const dates = [...new Set(array(dateKeys).filter(Boolean))].sort();
  if (!dates.length) return 0;
  let count = 1;
  for (let index = dates.length - 1; index > 0; index -= 1) {
    if (Date.parse(`${dates[index]}T00:00:00Z`) - Date.parse(`${dates[index - 1]}T00:00:00Z`) !== 86_400_000) break;
    count += 1;
  }
  return count;
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error(`response-body-too-large:${declared}>${maxBytes}`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response-body-too-large:${total}>${maxBytes}`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function isRetryableScoutError(error) {
  return error?.status === 429
    || error?.status >= 500
    || error?.name === "TimeoutError"
    || error instanceof TypeError;
}

async function fetchScoutSource(source, cacheDir, fetchImpl, delayImpl) {
  const cachePath = join(cacheDir, `${source.id}.json`);
  const cached = await readJson(cachePath, null);
  let lastError;
  let attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attempts = attempt;
    try {
      const headers = {
        accept: "application/json",
        "user-agent": "ai-research-daily-evidence-gap-scout/0.1",
      };
      if (cached?.etag) headers["if-none-match"] = cached.etag;
      const response = await fetchImpl(source.url, { headers, signal: AbortSignal.timeout(30_000) });
      if (response.status === 304 && cached?.body != null) {
        return {
          body: cached.body,
          source_id: source.id,
          status: "not-modified",
          http_status: 304,
          attempts: attempt,
          fetched_at: new Date().toISOString(),
          response_bytes: Buffer.byteLength(cached.body, "utf8"),
          network_verified: true,
        };
      }
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }
      const body = await readBoundedText(response, source.max_bytes);
      const fetchedAt = new Date().toISOString();
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, `${JSON.stringify({ fetched_at: fetchedAt, etag: response.headers.get("etag") || "", body }, null, 2)}\n`);
      return {
        body,
        source_id: source.id,
        status: "fresh",
        http_status: response.status,
        attempts: attempt,
        fetched_at: fetchedAt,
        response_bytes: Buffer.byteLength(body, "utf8"),
        network_verified: true,
      };
    } catch (error) {
      lastError = error;
      const retryable = isRetryableScoutError(error);
      if (!retryable || attempt === 3) break;
      await delayImpl(4_000 * 2 ** (attempt - 1));
    }
  }
  const cacheAge = cached?.fetched_at ? Date.now() - Date.parse(cached.fetched_at) : Infinity;
  if (cached?.body != null && cacheAge <= CACHE_MAX_AGE_MS) {
    return {
      body: cached.body,
      source_id: source.id,
      status: "stale-cache",
      http_status: null,
      attempts,
      fetched_at: cached.fetched_at,
      response_bytes: Buffer.byteLength(cached.body, "utf8"),
      network_verified: false,
      error: String(lastError),
    };
  }
  return {
    body: null,
    source_id: source.id,
    status: "failed",
    http_status: null,
    attempts,
    fetched_at: new Date().toISOString(),
    response_bytes: 0,
    network_verified: false,
    error: String(lastError),
  };
}

function citationIdentity(paper) {
  return paper?.externalIds?.ArXiv ? `arxiv:${paper.externalIds.ArXiv}` : paper?.paperId ? `s2:${paper.paperId}` : "";
}

function titleScopeMatch(source, title) {
  return array(source.review_patterns).some((pattern) => new RegExp(pattern, "i").test(title || ""));
}

export function parseCitationGraph(source, body) {
  const document = JSON.parse(body);
  const warnings = [];
  if (document.next != null) warnings.push("citation-window-non-exhaustive");
  const leads = [];
  const seen = new Set();
  for (const item of array(document.data)) {
    const paper = item?.citingPaper;
    const identity = citationIdentity(paper);
    if (!identity || seen.has(identity) || !paper?.title) continue;
    seen.add(identity);
    const arxivId = paper.externalIds?.ArXiv || "";
    leads.push({
      identity,
      source_id: source.id,
      seed_id: source.seed_id,
      seed_scope: source.seed_scope,
      topic_id: source.topic_id,
      relation: "cites-seed-according-to-semantic-scholar",
      title: paper.title,
      title_scope_match: titleScopeMatch(source, paper.title),
      review_hint_only: true,
      publication_date: paper.publicationDate || "",
      authors: array(paper.authors).map((author) => author.name).filter(Boolean),
      arxiv_id: arxivId,
      primary_candidate_url: arxivId ? `https://arxiv.org/abs/${arxivId}` : "",
      semantic_scholar_url: paper.url || "",
      citation_count: paper.citationCount ?? null,
      reference_count: paper.referenceCount ?? null,
      open_access_pdf_url: paper.openAccessPdf?.url || "",
      authority_tier: "T1",
      discovery_only: true,
      source_window_exhaustive: document.next == null,
      primary_verified: false,
      claim_status_changed: false,
      notification_eligible: false,
    });
  }
  return {
    items_parsed: leads.length,
    next_offset: document.next ?? null,
    warnings,
    leads: leads.sort((left, right) => (right.publication_date || "").localeCompare(left.publication_date || "")),
  };
}

function linkMatchesTopic(link, topic) {
  const haystack = `${link.url || ""} ${link.link_context || ""}`;
  return topic.attention_patterns.some((pattern) => new RegExp(pattern, "i").test(haystack));
}

function editorialArtifactLeads(candidateAudit) {
  const sourceMap = new Map(array(candidateAudit?.source_registry).map((source) => [source.id, source]));
  const leads = [];
  let scannedLinks = 0;
  let matchedArticles = 0;
  for (const event of array(candidateAudit?.source_events)) {
    const source = sourceMap.get(event.source_id);
    if (source?.role !== "editorial-discovery" || !NETWORK_SUCCESS.has(event.status)) continue;
    for (const item of array(event.snapshot?.items)) {
      const candidateTopics = diligenceTopics.filter((topic) => topic.attention_patterns.some((pattern) => new RegExp(pattern, "i").test(item.title || "")));
      if (!candidateTopics.length) continue;
      matchedArticles += 1;
      for (const link of array(item.artifact_links)) {
        scannedLinks += 1;
        const topicIds = candidateTopics.filter((topic) => linkMatchesTopic(link, topic)).map((topic) => topic.id);
        if (!topicIds.length) continue;
        leads.push({
          identity: hash(`${event.source_id}:${item.id}:${link.url}`).slice(0, 24),
          editorial_source_id: event.source_id,
          editorial_independence_group: source.independence_group,
          editorial_title: item.title,
          editorial_url: item.url,
          editorial_published_at: item.published_at,
          topic_ids: topicIds,
          artifact_candidate_url: link.url,
          artifact_candidate_type: link.candidate_type,
          artifact_link_context: link.link_context || "",
          authority_tier: "T2",
          artifact_authority_verified: false,
          claim_status_changed: false,
          notification_eligible: false,
        });
      }
    }
  }
  return { leads, scanned_links: scannedLinks, matched_articles: matchedArticles };
}

export function createEvidenceGapScoutAudit({ now = new Date(), sourceEvents, candidateAudit, previousAudit = null, sources = evidenceGapScoutSources }) {
  const priorLeadKeys = new Set(array(previousAudit?.citation_leads).map((lead) => `${lead.source_id}:${lead.identity}`));
  const previouslyObservedSourceIds = new Set(array(previousAudit?.source_registry).map((source) => source.id));
  const today = localDateKey(now);
  const citationLeads = sourceEvents.flatMap((event) => array(event.leads)).map((lead) => {
    const futurePublicationDate = Boolean(lead.publication_date && lead.publication_date > today);
    return {
      ...lead,
      future_publication_date: futurePublicationDate,
      review_queue_priority: futurePublicationDate ? "metadata-anomaly" : lead.title_scope_match && lead.primary_candidate_url ? "high" : lead.title_scope_match ? "medium" : "citation-only",
      baseline_only: !previouslyObservedSourceIds.has(lead.source_id),
      new_since_previous: !futurePublicationDate && previouslyObservedSourceIds.has(lead.source_id) && !priorLeadKeys.has(`${lead.source_id}:${lead.identity}`),
    };
  });
  const previousHistory = new Map(array(previousAudit?.source_history).map((history) => [history.source_id, history]));
  const sourceHistory = sources.map((source) => {
    const event = sourceEvents.find((candidate) => candidate.source_id === source.id) || { status: "missing" };
    const previousDates = array(previousHistory.get(source.id)?.observed_network_success_dates);
    const dates = NETWORK_SUCCESS.has(event.status) ? [...new Set([...previousDates, today])].sort().slice(-31) : previousDates;
    const consecutive = consecutiveDayCount(dates);
    return {
      source_id: source.id,
      observed_network_success_dates: dates,
      consecutive_network_success_days: consecutive,
      current_status: event.status,
      warnings: array(event.warnings),
      ready_for_human_review: consecutive >= MINIMUM_OBSERVATION_DAYS,
      human_review_passed: false,
      automatically_promoted: false,
    };
  });
  const editorial = editorialArtifactLeads(candidateAudit);
  const networkFresh = sourceEvents.filter((event) => NETWORK_SUCCESS.has(event.status)).length;
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    mode: "evidence-gap-scout",
    status: networkFresh === sources.length ? "ok" : "degraded",
    scope: "discovery-leads-only",
    input_snapshots: { candidate_generated_at: candidateAudit?.generated_at || "" },
    authority_policy: {
      semantic_scholar_tier: "T1 metadata discovery",
      editorial_tier: "T2 attention/discovery",
      primary_verification_required: true,
      can_change_claim_status: false,
      can_raise_evidence_grade: false,
    },
    isolation_policy: {
      affects_production_registry: false,
      affects_production_health: false,
      affects_source_diligence_claim_status: false,
      writes_other_audit_state: false,
      automatic_promotions: [],
    },
    notification_policy: {
      enabled: false,
      eligible: false,
      external_actions: [],
      statement: "Discovery leads require primary-source and human verification and cannot notify.",
    },
    dependency_policy: {
      credentials_required: false,
      semantic_scholar_key_required: false,
      openalex_key_required: false,
      cloudflare_credentials_required: false,
      openai_membership_required: false,
    },
    source_decisions: evidenceGapSourceDecisions,
    source_registry: sources,
    source_events: sourceEvents,
    source_history: sourceHistory,
    citation_leads: citationLeads,
    editorial_artifact_leads: editorial.leads,
    metrics: {
      registered_scout_sources: sources.length,
      network_fresh_sources: networkFresh,
      network_fresh_rate: sources.length ? Number((networkFresh / sources.length).toFixed(4)) : 0,
      citation_leads: citationLeads.length,
      new_citation_leads: citationLeads.filter((lead) => lead.new_since_previous).length,
      future_dated_citation_leads: citationLeads.filter((lead) => lead.future_publication_date).length,
      title_scope_matched_citation_leads: citationLeads.filter((lead) => lead.title_scope_match).length,
      high_priority_review_leads: citationLeads.filter((lead) => lead.review_queue_priority === "high").length,
      citation_only_leads: citationLeads.filter((lead) => lead.review_queue_priority === "citation-only").length,
      editorial_topic_matched_articles: editorial.matched_articles,
      editorial_artifact_links_scanned: editorial.scanned_links,
      editorial_artifact_leads: editorial.leads.length,
      ready_for_human_review: sourceHistory.filter((history) => history.ready_for_human_review).length,
      claim_status_changes: 0,
      notification_eligible_records: 0,
    },
  };
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function renderEvidenceGapScoutReview(audit) {
  const lines = [
    `# 底层证据缺口 Scout · ${localDateKey(audit.generated_at)}`,
    "",
    "> 只产生待核验线索。Semantic Scholar 引文关系和 T2 编辑外链都不能改变 claim 状态、证据等级或通知资格。",
    "",
    "## 摘要",
    "",
    `- Scout 来源：${audit.metrics.network_fresh_sources}/${audit.metrics.registered_scout_sources} 网络成功`,
    `- Citation leads：${audit.metrics.citation_leads}；本轮新增：${audit.metrics.new_citation_leads}`,
    `- 未来日期元数据异常：${audit.metrics.future_dated_citation_leads}（保留核验，不计当天新增）`,
    `- 标题范围命中：${audit.metrics.title_scope_matched_citation_leads}；高优先人工核验：${audit.metrics.high_priority_review_leads}；citation-only：${audit.metrics.citation_only_leads}`,
    `- T2 topic 文章：${audit.metrics.editorial_topic_matched_articles}；扫描 artifact 外链：${audit.metrics.editorial_artifact_links_scanned}；topic 对齐 leads：${audit.metrics.editorial_artifact_leads}`,
    `- Claim 状态变化：${audit.metrics.claim_status_changes}；通知资格：${audit.metrics.notification_eligible_records}`,
    "",
    "## 来源准入决定",
    "",
    "| 来源 | 决定 | 原因/边界 |",
    "|---|---|---|",
  ];
  for (const decision of audit.source_decisions) lines.push(`| [${decision.id}](${decision.official_docs}) | ${decision.decision} | ${markdownCell(`${decision.authentication}; ${decision.blockers}; ${decision.allowed_use}`)} |`);
  lines.push(
    "",
    "## Citation 种子边界",
    "",
    "| 种子 | 主题 | 一手论文 | 关联 artifact / 复现边界 | 本轮线索 | 标题范围命中 | 可证明范围 |",
    "|---|---|---|---|---:|---:|---|",
  );
  for (const source of audit.source_registry) {
    const count = audit.citation_leads.filter((lead) => lead.source_id === source.id).length;
    const matched = audit.citation_leads.filter((lead) => lead.source_id === source.id && lead.title_scope_match).length;
    const artifact = source.seed_artifact;
    const artifactCell = artifact
      ? `[${markdownCell(artifact.role)} @ ${markdownCell(artifact.revision.slice(0, 12))}](${artifact.url}) · ${markdownCell(artifact.license)} · ${markdownCell(artifact.reproduction_status)}`
      : "-";
    lines.push(`| ${markdownCell(source.label)} | ${source.topic_id} | [${source.seed_paper_id}](${source.primary_seed_url}) | ${artifactCell} | ${count} | ${matched} | ${markdownCell(source.seed_scope)} |`);
  }
  lines.push(
    "",
    "## Citation leads（全部需要回到 primary source）",
    "",
  );
  for (const source of audit.source_registry) {
    lines.push(`### ${source.label}`, "", "| 日期 | 论文 | arXiv | 状态 |", "|---|---|---|---|");
    const sourceLeads = audit.citation_leads
      .filter((lead) => lead.source_id === source.id)
      .sort((left, right) => {
        const order = { high: 0, medium: 1, "citation-only": 2, "metadata-anomaly": 3 };
        return order[left.review_queue_priority] - order[right.review_queue_priority] || (right.publication_date || "").localeCompare(left.publication_date || "");
      })
      .slice(0, 12);
    for (const lead of sourceLeads) {
      const title = lead.primary_candidate_url ? `[${markdownCell(lead.title)}](${lead.primary_candidate_url})` : markdownCell(lead.title);
      const observation = lead.baseline_only ? "onboarding baseline" : lead.new_since_previous ? "new lead" : "seen";
      const status = lead.future_publication_date ? "future-date metadata anomaly" : `${lead.review_queue_priority} · ${observation}`;
      lines.push(`| ${lead.publication_date || "-"} | ${title} | ${lead.arxiv_id || "-"} | ${status} |`);
    }
    if (!sourceLeads.length) lines.push("| - | 暂无线索 | - | - |");
    lines.push("");
  }
  lines.push(
    "## T2 编辑文章中的 artifact 候选",
    "",
    "| 编辑源 | 文章 | topic | artifact candidate |",
    "|---|---|---|---|",
  );
  for (const lead of audit.editorial_artifact_leads.slice(0, 60)) {
    lines.push(`| ${lead.editorial_source_id} | [${markdownCell(lead.editorial_title)}](${lead.editorial_url}) | ${lead.topic_ids.join(", ")} | [${lead.artifact_candidate_type}](${lead.artifact_candidate_url}) |`);
  }
  lines.push(
    "",
    "## 人工核验要求",
    "",
    "- 引文图窗口不是穷尽列表，排序也不作为热门程度证据。",
    "- title scope match 只按种子专属词表调整人工核验顺序；它不是语义相关性、权威度、关注度或证据等级。",
    "- 晚于审计日的 publicationDate 可能是会议/正式出版日期，也可能是元数据错误；只保留核验，不计当天新增。",
    "- arXiv ID 必须回查题目、摘要、版本、作者和 artifact；无 arXiv/DOI 的 S2 记录只保留为弱线索。",
    "- 编辑文章中的 GitHub/Hugging Face/公司域名链接仍需核验组织身份和内容类型。",
    "- 每个新接入种子的首次运行都是 onboarding baseline，即使 Scout 已有历史，也不能称为今日新进展。",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export async function runEvidenceGapScout({
  sources = evidenceGapScoutSources,
  candidatePath = process.env.CANDIDATE_PROBE_OUTPUT_PATH || "work/candidate-source-probe/audit.json",
  outputPath = process.env.EVIDENCE_SCOUT_OUTPUT_PATH || "work/evidence-gap-scout/audit.json",
  statePath = process.env.EVIDENCE_SCOUT_STATE_PATH || "work/evidence-gap-scout/audit.json",
  reviewPath = process.env.EVIDENCE_SCOUT_REVIEW_PATH || "work/evidence-gap-scout/review.md",
  cacheDir = process.env.EVIDENCE_SCOUT_CACHE_DIR || "work/evidence-gap-scout/cache",
  now = new Date(),
  fetchImpl = fetch,
  delayImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  requestDelayMs = 4_000,
} = {}) {
  const [candidateAudit, previousAudit] = await Promise.all([readJson(candidatePath), readJson(statePath)]);
  if (!candidateAudit) throw new Error(`candidate audit missing: ${candidatePath}`);
  const sourceEvents = [];
  for (let index = 0; index < sources.length; index += 1) {
    if (index > 0 && requestDelayMs > 0) await delayImpl(requestDelayMs);
    const fetched = await fetchScoutSource(sources[index], cacheDir, fetchImpl, delayImpl);
    const event = { ...fetched, content_sha256: fetched.body ? hash(fetched.body) : "", warnings: [], leads: [] };
    if (fetched.body) {
      try { Object.assign(event, parseCitationGraph(sources[index], fetched.body)); }
      catch (error) {
        event.status = "parse-failed";
        event.error = String(error);
        event.warnings = ["parse-failed"];
      }
    }
    sourceEvents.push(event);
  }
  const audit = createEvidenceGapScoutAudit({ now, sourceEvents, candidateAudit, previousAudit, sources });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
  await mkdir(dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, renderEvidenceGapScoutReview(audit));
  return audit;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  runEvidenceGapScout().then((audit) => console.log(JSON.stringify({ mode: audit.mode, status: audit.status, ...audit.metrics }))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
