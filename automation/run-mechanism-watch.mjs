#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { mechanismSources, publicRegistryView, publicSeedGraph } from "./mechanism-source-registry.mjs";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
const USER_AGENT = "frontier-signals-mechanism-watch/0.1";
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MINIMUM_SILENT_DAYS = 7;
const MINIMUM_CORE_SUCCESS_RATE = 0.95;
const AUDIT_TIME_ZONE = "Asia/Shanghai";
const IDENTITY_HISTORY_LIMIT = 5_000;
const DAILY_EDITORIAL_WINDOW_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;

const layerTerms = Object.freeze({
  B0: [
    "constitution", "model constitution", "claude constitution", "model spec", "system card", "safety framework",
    "preparedness framework", "frontier safety", "behavior specification", "authority rule",
  ],
  M1: [
    "looped language model", "recurrent transformer", "recurrent language model",
    "mixture of experts", "state space language model", "internal representation", "latent state", "parameter sharing",
  ],
  M2: [
    "training objective", "pretraining objective", "post-training objective", "post training objective",
    "post-training algorithm", "post training algorithm", "mid-training", "mid training", "midtraining",
    "rlvr", "reinforcement learning from",
    "reasoning distillation", "knowledge distillation", "reward model", "preference optimization",
    "synthetic training data", "curriculum learning", "entropy regularization", "constitutional classifier",
    "constitutional classifiers", "constitutional ai",
  ],
  M3: [
    "latent reasoning", "continuous thought", "test-time compute", "test time compute",
    "inference-time compute", "inference time compute", "recurrent depth", "dynamic depth",
    "early exit", "adaptive computation", "internalized reasoning", "looped inference",
  ],
  M4: [
    "mechanistic interpretability", "circuit tracing", "attribution graph", "sparse autoencoder",
    "transcoder", "dictionary learning", "activation steering", "causal intervention", "causal mediation",
    "feature ablation", "replacement model", "chain-of-thought faithfulness", "alignment faking",
  ],
  H1: [
    "agent harness", "agent loop", "tool routing", "tool orchestration", "computer use",
    "context compaction", "context policy", "handoff", "long-running agent", "planner evaluator",
    "agent memory architecture", "coding agent", "agent sdk",
  ],
  E1: [
    "evaluation harness", "eval harness", "llm benchmark", "agent benchmark", "grader", "scoring protocol",
    "benchmark harness", "evaluation awareness", "benchmark contamination", "reward hacking",
    "inspect ai", "lm-evaluation-harness", "helm", "capability evaluation",
  ],
});

const paperScopeTerms = Object.freeze([
  "large language model", "large language models", "language model", "language models", "llm", "llms",
  "reasoning model", "reasoning models", "natural-language", "natural language pretraining",
  "autoregressive decoding", "depth-recurrent transformer",
  "ai agent", "ai agents", "agentic model", "agentic models", "model weights", "neural language",
  "agent harness", "evaluation harness", "coding agent",
]);

const paperM2ContributionTitle = /\b(?:train(?:ing)?|learning|alignment|preference|rewards?|distillation|rlhf|rlvr|fine[- ]?tun(?:e|ing)|objective|constitutional)\b/i;
const paperSurveyTitle = /\b(?:survey|tutorial|review)\b/i;
const paperSurveyClaim = /\b(?:this (?:paper|work) (?:presents|provides) (?:an? )?(?:systematic |tutorial )?(?:survey|review)|we (?:survey|review)\b)/i;

const layerOrder = ["B0", "M1", "M2", "M3", "M4", "H1", "E1"];
const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const cleanText = (value, limit = 5000) => xmlText(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const parseDate = (value) => Number.isFinite(Date.parse(value ?? "")) ? new Date(value).toISOString() : "";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function termMatches(haystack, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`).test(haystack);
}

function normalizeDocument(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n").trimEnd();
}

function hasBoundPolicyTextDelta(metadata) {
  const diff = metadata?.line_diff;
  return diff?.status === "changed"
    && diff.changed === true
    && diff.requires_human_semantic_review === true
    && SHA256_PATTERN.test(diff.previous_sha256 || "")
    && SHA256_PATTERN.test(diff.current_sha256 || "")
    && diff.previous_sha256 !== diff.current_sha256
    && metadata?.content_sha256 === diff.current_sha256;
}

export function boundedLineDiff(previousBody, currentBody, { maxExcerptLines = 24 } = {}) {
  const current = normalizeDocument(currentBody);
  if (previousBody == null) {
    return {
      status: "baseline",
      changed: false,
      previous_sha256: null,
      current_sha256: hash(current),
      first_changed_line: null,
      removed_line_count: 0,
      added_line_count: 0,
      before_excerpt: [],
      after_excerpt: [],
      excerpt_truncated: false,
      requires_human_semantic_review: true,
    };
  }
  const previous = normalizeDocument(previousBody);
  if (previous === current) {
    return {
      status: "unchanged",
      changed: false,
      previous_sha256: hash(previous),
      current_sha256: hash(current),
      first_changed_line: null,
      removed_line_count: 0,
      added_line_count: 0,
      before_excerpt: [],
      after_excerpt: [],
      excerpt_truncated: false,
      requires_human_semantic_review: true,
    };
  }
  const before = previous.split("\n");
  const after = current.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  return {
    status: "changed",
    changed: true,
    previous_sha256: hash(previous),
    current_sha256: hash(current),
    first_changed_line: prefix + 1,
    removed_line_count: removed.length,
    added_line_count: added.length,
    before_excerpt: removed.slice(0, maxExcerptLines),
    after_excerpt: added.slice(0, maxExcerptLines),
    excerpt_truncated: removed.length > maxExcerptLines || added.length > maxExcerptLines,
    requires_human_semantic_review: true,
  };
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: AUDIT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function consecutiveDayCount(dateKeys) {
  const dates = [...new Set(dateKeys.filter(Boolean))].sort();
  if (!dates.length) return 0;
  let count = 1;
  for (let index = dates.length - 1; index > 0; index -= 1) {
    const current = Date.parse(`${dates[index]}T00:00:00.000Z`);
    const previous = Date.parse(`${dates[index - 1]}T00:00:00.000Z`);
    if (current - previous !== 24 * 60 * 60 * 1000) break;
    count += 1;
  }
  return count;
}

function observedSilentDates(previousAudit, now) {
  const previousDates = previousAudit?.notification_gate?.observed_silent_dates
    || (previousAudit?.mode === "silent-audit" ? [localDateKey(previousAudit.generated_at)] : []);
  return [...new Set([...previousDates, localDateKey(now)].filter(Boolean))].sort().slice(-31);
}

export function createDailyQualityReview(records, dateKey, { perLayer = 2 } = {}) {
  const eligible = array(records).filter((record) => record.concrete_mechanism_delta && layerOrder.includes(record.primary_layer));
  const samples = [];
  for (const layer of layerOrder) {
    const layerRecords = eligible.filter((record) => record.primary_layer === layer)
      .sort((left, right) => hash(`${dateKey}:${left.canonical_id}`).localeCompare(hash(`${dateKey}:${right.canonical_id}`))
        || left.canonical_id.localeCompare(right.canonical_id))
      .slice(0, perLayer);
    samples.push(...layerRecords.map((record) => ({
      canonical_id: record.canonical_id,
      canonical_url: record.canonical_url,
      title: record.title,
      primary_layer: record.primary_layer,
      evidence_grade: record.evidence_grade,
      change: record.change,
      source_ids: [...record.source_ids],
      matched_terms: [...record.matched_terms],
      selection_hash: hash(`${dateKey}:${record.canonical_id}`),
      human_reviewed: false,
      human_decision: null,
    })));
  }
  return {
    date: dateKey,
    selection: "deterministic-daily-stratified-by-primary-layer",
    per_layer_target: perLayer,
    eligible_records: eligible.length,
    sampled_records: samples.length,
    dimensions: ["false-positive", "wrong-layer", "primary-traceability", "duplicate-mechanism"],
    human_reviewed: false,
    can_satisfy_human_gate: false,
    human_decisions: [],
    samples,
  };
}

function xmlText(value) {
  if (value == null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.map(xmlText).join(" ");
  if (typeof value === "object") {
    if (value["#text"] != null) return xmlText(value["#text"]);
    if (value.__cdata != null) return xmlText(value.__cdata);
    return Object.entries(value).filter(([key]) => !["href", "rel", "type"].includes(key)).map(([, item]) => xmlText(item)).join(" ");
  }
  return "";
}

function linkValue(value) {
  if (typeof value === "string") return value;
  const links = array(value);
  return links.find((item) => item?.rel === "alternate")?.href
    || links.find((item) => item?.href)?.href
    || cleanText(links[0], 1000);
}

function arxivMetadata(...values) {
  const joined = values.map((value) => xmlText(value)).join(" ");
  const match = joined.match(/(?:arxiv\.org\/(?:abs|pdf)\/|oai:arxiv\.org:|arxiv:)?(\d{4}\.\d{4,5})(?:v(\d+))?/i);
  if (!match) return {};
  const versionMatch = joined.match(new RegExp(`${match[1].replace(".", "\\.")}v(\\d+)`, "i"));
  return {
    arxiv_id: match[1],
    ...(versionMatch ? { arxiv_version: Number(versionMatch[1]) } : {}),
  };
}

function slugTitle(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/\/$/, "").split("/").pop() || "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  } catch {
    return "";
  }
}

export function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|campaign$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
}

export function canonicalId(item) {
  const joined = `${item.id || ""} ${item.url || ""}`;
  const arxiv = joined.match(/(?:arxiv\.org\/(?:abs|pdf)\/|^|\s)(\d{4}\.\d{4,5})(?:v\d+)?/i);
  if (arxiv) return `arxiv:${arxiv[1]}`;
  try {
    const url = new URL(item.url);
    const release = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/tag\/([^/]+)\/?$/i);
    if (url.hostname === "github.com" && release) return `github-release:${release[1].toLowerCase()}/${release[2].toLowerCase()}:${decodeURIComponent(release[3]).toLowerCase()}`;
    const commit = url.pathname.match(/^\/([^/]+)\/([^/]+)\/commit\/([a-f0-9]+)/i);
    if (url.hostname === "github.com" && commit) return `github-commit:${commit[1].toLowerCase()}/${commit[2].toLowerCase()}:${commit[3].toLowerCase()}`;
  } catch {
    // Fall through to normalized URL identity.
  }
  return `url:${normalizeUrl(item.url || item.id)}`;
}

export function classifyCandidate(item, source = {}) {
  const haystack = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  const title = String(item.title || "");
  const inPaperScope = paperScopeTerms.some((term) => termMatches(haystack, term));
  const isPaper = source.artifactType === "paper";
  const isSurvey = isPaper && (paperSurveyTitle.test(title) || paperSurveyClaim.test(String(item.summary || "")));
  if (isPaper && (!inPaperScope || isSurvey)) {
    return {
      primary_layer: null,
      secondary_layers: [],
      layer_scores: {},
      matched_terms: [],
      concrete_mechanism_delta: false,
      exclusion_reason: isSurvey ? "paper-survey-not-mechanism-delta" : "paper-outside-language-model-scope",
    };
  }
  const scores = {};
  const termsByLayer = {};
  for (const layer of layerOrder) {
    const titleContributionRequired = isPaper && layer === "M2" && !paperM2ContributionTitle.test(title);
    const matched = titleContributionRequired ? [] : layerTerms[layer].filter((term) => termMatches(haystack, term));
    termsByLayer[layer] = matched;
    scores[layer] = matched.length;
  }
  if (source.defaultLayer) scores[source.defaultLayer] = (scores[source.defaultLayer] || 0) + 2;
  const ranked = layerOrder
    .map((layer, index) => ({ layer, score: scores[layer] || 0, index }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score
      || Number(right.layer === source.defaultLayer) - Number(left.layer === source.defaultLayer)
      || left.index - right.index);
  const matchedTerms = [...new Set(ranked.flatMap(({ layer }) => termsByLayer[layer]))];
  let concreteMechanismDelta = matchedTerms.length > 0;
  let exclusionReason = concreteMechanismDelta ? null : "no-concrete-mechanism-delta";
  if (source.artifactType === "versioned-policy") {
    concreteMechanismDelta = false;
    exclusionReason = "versioned-policy-commit-occurrence-only";
  } else if (source.artifactType === "versioned-policy-text") {
    concreteMechanismDelta = source.official === true && hasBoundPolicyTextDelta(item.metadata);
    exclusionReason = concreteMechanismDelta
      ? null
      : source.official === true
        ? "no-bound-policy-text-diff"
        : "versioned-policy-text-not-official";
  }
  return {
    primary_layer: ranked[0]?.layer || null,
    secondary_layers: ranked.slice(1).map(({ layer }) => layer),
    layer_scores: Object.fromEntries(ranked.map(({ layer, score }) => [layer, score])),
    matched_terms: matchedTerms,
    concrete_mechanism_delta: concreteMechanismDelta,
    exclusion_reason: exclusionReason,
  };
}

function parseFeed(document) {
  const feed = document.feed;
  if (feed) {
    return array(feed.entry).map((entry) => ({
      id: cleanText(entry.id, 1000),
      title: cleanText(entry.title, 500),
      summary: cleanText(entry.summary || entry.content, 5000),
      url: linkValue(entry.link) || cleanText(entry.id, 1000),
      published_at: parseDate(entry.published || entry.updated),
      metadata: arxivMetadata(entry.id, entry.link, entry.title, entry.summary || entry.content),
    }));
  }
  const channel = document.rss?.channel;
  return array(channel?.item).map((item) => ({
    id: cleanText(item.guid, 1000),
    title: cleanText(item.title, 500),
    summary: cleanText(item.description || item["content:encoded"], 5000),
    url: linkValue(item.link),
    published_at: parseDate(item.pubDate || item.updated || item.date),
    metadata: {
      ...arxivMetadata(item.guid, item.link, item.title, item.description),
      ...(item["arxiv:announce_type"] ? { arxiv_announce_type: cleanText(item["arxiv:announce_type"], 100) } : {}),
    },
  }));
}

export function parseSource(source, body, { previousBody = null } = {}) {
  if (source.format === "huggingface-json") {
    return array(JSON.parse(body)).map((row) => row.paper || row).filter((paper) => paper.id).map((paper) => ({
      id: paper.id,
      title: cleanText(paper.title, 500),
      summary: cleanText(paper.summary, 5000),
      url: `https://arxiv.org/abs/${String(paper.id).replace(/v\d+$/, "")}`,
      published_at: parseDate(paper.publishedAt || paper.submittedOnDailyAt),
      metadata: {
        ...arxivMetadata(paper.id),
        upvotes: Number(paper.upvotes || 0),
        code_url: paper.githubRepo || "",
      },
    }));
  }
  if (source.format === "huggingface-model") {
    const model = JSON.parse(body);
    const tags = array(model.tags).map((tag) => cleanText(tag, 200));
    return [{
      id: model.id,
      title: cleanText(model.id, 500),
      summary: tags.map((tag) => tag.replace(/[-_]+/g, " ")).join(" "),
      url: `https://huggingface.co/${model.id}`,
      published_at: parseDate(model.lastModified),
      metadata: {
        revision_sha: cleanText(model.sha, 100),
        last_modified: parseDate(model.lastModified),
        files: array(model.siblings).map((file) => cleanText(file?.rfilename, 500)).filter(Boolean).sort(),
      },
    }];
  }
  if (source.format === "raw-document") {
    const normalized = normalizeDocument(body);
    const lineDiff = boundedLineDiff(previousBody, normalized);
    return [{
      id: source.canonicalUrl || source.url,
      title: source.documentTitle || slugTitle(source.canonicalUrl || source.url),
      summary: cleanText(normalized, 5000),
      url: source.canonicalUrl || source.url,
      published_at: parseDate(source.publishedAt),
      metadata: {
        content_sha256: hash(normalized),
        content_bytes: Buffer.byteLength(normalized, "utf8"),
        line_count: normalized ? normalized.split("\n").length : 0,
        line_diff: lineDiff,
      },
    }];
  }
  if (source.format === "github-repositories") {
    return array(JSON.parse(body)).filter((repo) => !repo.archived && !repo.fork).map((repo) => ({
      id: repo.full_name,
      title: cleanText(repo.name, 500),
      summary: cleanText(repo.description, 5000),
      url: repo.html_url,
      published_at: parseDate(repo.pushed_at || repo.updated_at),
      metadata: { activity_only: true },
    }));
  }
  const document = parser.parse(body);
  if (source.format === "sitemap") {
    return array(document.urlset?.url).map((entry) => ({
      id: cleanText(entry.loc, 1000),
      title: slugTitle(cleanText(entry.loc, 1000)),
      summary: "",
      url: cleanText(entry.loc, 1000),
      published_at: parseDate(entry.lastmod),
      metadata: { sitemap_lastmod_only: true },
    })).filter((item) => {
      if (!source.includePath) return true;
      try { return source.includePath.test(new URL(item.url).pathname); } catch { return false; }
    });
  }
  return parseFeed(document);
}

function gradeEvidence(record) {
  const types = new Set(record.artifact_types);
  if (types.has("discovery-signal") || types.has("repository-activity")) {
    if (types.size === 1) return "G0";
  }
  if (types.has("paper") && [...record.sources].some((source) => source.official && source.artifact_type !== "paper")) return "G2";
  return "G1";
}

function provisionalAlert(record) {
  let priority = "none";
  const blockers = ["silent-run-notification-disabled"];
  const hasPolicyTextDelta = record.sources
    .filter((source) => source.official === true && source.artifact_type === "versioned-policy-text")
    .some((source) => record.source_metadata.some((metadata) => metadata.source_id === source.id && hasBoundPolicyTextDelta(metadata)));
  if (!record.concrete_mechanism_delta) blockers.push("no-concrete-mechanism-delta");
  if (record.artifact_types.includes("versioned-policy") && !hasPolicyTextDelta) blockers.push("versioned-policy-commit-occurrence-only");
  if (record.artifact_types.includes("versioned-policy-text") && !hasPolicyTextDelta) blockers.push("no-bound-policy-text-diff");
  if (record.change === "baseline") {
    blockers.push("no-prior-baseline");
    return { provisional_priority: priority, notification_eligible: false, blockers: [...new Set(blockers)] };
  }
  if (record.change === "unchanged") {
    blockers.push("no-content-change");
    return { provisional_priority: priority, notification_eligible: false, blockers: [...new Set(blockers)] };
  }
  if (record.change === "enriched") {
    blockers.push("source-enrichment-only");
    return { provisional_priority: priority, notification_eligible: false, blockers: [...new Set(blockers)] };
  }
  if (record.change === "source-regressed") {
    blockers.push("source-version-regressed");
    return { provisional_priority: priority, notification_eligible: false, blockers: [...new Set(blockers)] };
  }
  if (record.primary_layer === "B0" && record.concrete_mechanism_delta && hasPolicyTextDelta) {
    priority = "P0";
    blockers.push("human-semantic-diff-required");
  } else if (["M1", "M2", "M3", "M4", "H1"].includes(record.primary_layer) && record.concrete_mechanism_delta) {
    priority = record.evidence_grade >= "G2" ? "P1" : "P2";
    if (priority === "P1") blockers.push("human-review-required");
  } else if (record.concrete_mechanism_delta) {
    priority = "P2";
  }
  if (record.evidence_grade === "G0") blockers.push("discovery-signal-only");
  return { provisional_priority: priority, notification_eligible: false, blockers: [...new Set(blockers)] };
}

function stableSourceRevisions(record) {
  return (record.source_metadata || [])
    .filter((metadata) => metadata.revision_sha || metadata.content_sha256)
    .map((metadata) => metadata.revision_sha
      ? { source_id: metadata.source_id, revision_sha: metadata.revision_sha, files: metadata.files || [] }
      : { source_id: metadata.source_id, content_sha256: metadata.content_sha256 });
}

function observedArxivVersion(record) {
  if (!String(record?.canonical_id || "").startsWith("arxiv:")) return null;
  const metadataVersions = array(record?.source_metadata)
    .map((metadata) => Number(metadata?.arxiv_version))
    .filter((version) => Number.isInteger(version) && version > 0);
  const text = [record?.id, record?.url, record?.canonical_url, record?.title, record?.summary].filter(Boolean).join(" ");
  const textVersions = [...text.matchAll(/\b\d{4}\.\d{4,5}v(\d+)\b/gi)]
    .map((match) => Number(match[1]))
    .filter((version) => Number.isInteger(version) && version > 0);
  return [...metadataVersions, ...textVersions].sort((left, right) => right - left)[0] || null;
}

function sourceContentHash(record) {
  if (String(record.canonical_id || "").startsWith("arxiv:")) {
    return hash(JSON.stringify({
      canonical_id: record.canonical_id,
      arxiv_version: record.arxiv_version || observedArxivVersion(record),
    }));
  }
  const payload = {
    title: record.title,
    summary: record.summary,
    canonical_url: record.canonical_url,
  };
  const revisions = stableSourceRevisions(record);
  if (revisions.length) payload.stable_source_revisions = revisions;
  return hash(JSON.stringify(payload));
}

export function dedupeCandidates(candidates, previousRecords = [], { baselineSourceIds = [], identityHistory = [] } = {}) {
  const previous = new Map(previousRecords.map((record) => [record.canonical_id, record]));
  const history = new Map(identityHistory.map((record) => [record.canonical_id, record]));
  const hasPreviousBaseline = previousRecords.length > 0 || identityHistory.length > 0;
  const baselineSources = new Set(baselineSourceIds);
  const grouped = new Map();
  for (const candidate of candidates) {
    const id = canonicalId(candidate);
    const classified = classifyCandidate(candidate, candidate.source);
    if (!classified.primary_layer) continue;
    const existing = grouped.get(id) || {
      canonical_id: id,
      canonical_url: normalizeUrl(candidate.url),
      title: candidate.title,
      summary: candidate.summary,
      published_at: candidate.published_at,
      source_ids: [],
      sources: [],
      artifact_types: [],
      matched_terms: [],
      primary_layer: classified.primary_layer,
      secondary_layers: [],
      concrete_mechanism_delta: false,
      source_metadata: [],
      seed_ids: [],
    };
    if ((candidate.summary || "").length > (existing.summary || "").length) existing.summary = candidate.summary;
    if ((candidate.title || "").length > (existing.title || "").length) existing.title = candidate.title;
    if (candidate.published_at > existing.published_at) existing.published_at = candidate.published_at;
    existing.source_ids.push(candidate.source.id);
    existing.sources.push({ id: candidate.source.id, official: candidate.source.official, artifact_type: candidate.source.artifactType });
    existing.artifact_types.push(candidate.source.artifactType);
    existing.matched_terms.push(...classified.matched_terms);
    existing.secondary_layers.push(...classified.secondary_layers);
    existing.concrete_mechanism_delta ||= classified.concrete_mechanism_delta;
    existing.source_metadata.push({
      ...(candidate.metadata || {}),
      source_id: candidate.source.id,
      source_artifact_type: candidate.source.artifactType,
      source_concrete_mechanism_delta: classified.concrete_mechanism_delta,
    });
    if (candidate.source.seedId) existing.seed_ids.push(candidate.source.seedId);
    grouped.set(id, existing);
  }

  return [...grouped.values()].map((record) => {
    record.source_ids = [...new Set(record.source_ids)].sort();
    record.artifact_types = [...new Set(record.artifact_types)].sort();
    record.matched_terms = [...new Set(record.matched_terms)].sort();
    record.secondary_layers = [...new Set(record.secondary_layers)].filter((layer) => layer !== record.primary_layer).sort();
    record.seed_ids = [...new Set(record.seed_ids)].sort();
    record.evidence_grade = gradeEvidence(record);
    const prior = previous.get(record.canonical_id) || history.get(record.canonical_id);
    const priorArxivVersion = observedArxivVersion(prior) || Number(prior?.arxiv_version) || null;
    const currentArxivVersion = observedArxivVersion(record);
    if (record.canonical_id.startsWith("arxiv:")) {
      record.arxiv_version_observed = currentArxivVersion;
      record.arxiv_version = Math.max(priorArxivVersion || 0, currentArxivVersion || 0) || null;
    }
    const revisions = stableSourceRevisions(record);
    const hashPayload = {
      title: record.title,
      summary: record.summary,
      canonical_url: record.canonical_url,
      artifact_types: record.artifact_types,
    };
    if (revisions.length) hashPayload.stable_source_revisions = revisions;
    record.source_content_hash = sourceContentHash(record);
    record.record_hash = hash(JSON.stringify(hashPayload));
    const priorSourceContentHash = prior?.source_content_hash || (prior?.title && prior?.canonical_url ? sourceContentHash(prior) : prior?.record_hash);
    const onlyOnboardingSources = record.source_ids.length > 0 && record.source_ids.every((sourceId) => baselineSources.has(sourceId));
    if (!prior) {
      record.change = hasPreviousBaseline && !onlyOnboardingSources ? "new" : "baseline";
    } else if (record.canonical_id.startsWith("arxiv:")) {
      record.change = currentArxivVersion && priorArxivVersion && currentArxivVersion < priorArxivVersion
        ? "source-regressed"
        : currentArxivVersion && priorArxivVersion && currentArxivVersion > priorArxivVersion
          ? "revision"
          : currentArxivVersion && !priorArxivVersion
            ? "enriched"
            : "unchanged";
    } else {
      record.change = priorSourceContentHash === record.source_content_hash ? "unchanged" : "updated";
    }
    const policyTextSources = new Map(record.sources
      .filter((source) => source.artifact_type === "versioned-policy-text")
      .map((source) => [source.id, source]));
    if (record.artifact_types.some((artifactType) => ["versioned-policy", "versioned-policy-text"].includes(artifactType))) {
      const eligiblePolicyTextDelta = record.change === "updated" && record.source_metadata.some((metadata) => {
        const source = policyTextSources.get(metadata.source_id);
        return source?.official === true && hasBoundPolicyTextDelta(metadata);
      });
      for (const metadata of record.source_metadata) {
        if (metadata.source_artifact_type === "versioned-policy") metadata.source_concrete_mechanism_delta = false;
        if (metadata.source_artifact_type === "versioned-policy-text") {
          const source = policyTextSources.get(metadata.source_id);
          metadata.source_concrete_mechanism_delta = record.change === "updated"
            && source?.official === true
            && hasBoundPolicyTextDelta(metadata);
        }
      }
      record.concrete_mechanism_delta = eligiblePolicyTextDelta;
    }
    record.first_seen_at = prior?.first_seen_at || null;
    Object.assign(record, provisionalAlert(record));
    return record;
  }).sort((left, right) => (right.published_at || "").localeCompare(left.published_at || "") || left.canonical_id.localeCompare(right.canonical_id));
}

function buildIdentityHistory({ previousIdentityHistory = [], previousRecords = [], records = [], generatedAt, previousGeneratedAt = "" }) {
  const history = new Map();
  for (const record of previousIdentityHistory) {
    if (!record?.canonical_id) continue;
    const arxivVersion = observedArxivVersion(record) || Number(record.arxiv_version) || null;
    history.set(record.canonical_id, {
      canonical_id: record.canonical_id,
      first_seen_at: record.first_seen_at || record.last_seen_at || generatedAt,
      last_seen_at: record.last_seen_at || record.first_seen_at || generatedAt,
      source_content_hash: record.source_content_hash || (record.title && record.canonical_url ? sourceContentHash({ ...record, arxiv_version: arxivVersion }) : record.record_hash),
      record_hash: record.record_hash || null,
      ...(arxivVersion ? { arxiv_version: arxivVersion } : {}),
    });
  }
  for (const record of previousRecords) {
    if (!record?.canonical_id) continue;
    const prior = history.get(record.canonical_id);
    const arxivVersion = observedArxivVersion(record) || Number(record.arxiv_version) || Number(prior?.arxiv_version) || null;
    history.set(record.canonical_id, {
      canonical_id: record.canonical_id,
      first_seen_at: prior?.first_seen_at || record.first_seen_at || previousGeneratedAt || generatedAt,
      last_seen_at: record.last_seen_at || previousGeneratedAt || prior?.last_seen_at || record.first_seen_at || generatedAt,
      source_content_hash: record.source_content_hash || (record.title && record.canonical_url ? sourceContentHash({ ...record, arxiv_version: arxivVersion }) : record.record_hash),
      record_hash: record.record_hash || prior?.record_hash || null,
      ...(arxivVersion ? { arxiv_version: arxivVersion } : {}),
    });
  }
  for (const record of records) {
    const prior = history.get(record.canonical_id);
    history.set(record.canonical_id, {
      canonical_id: record.canonical_id,
      first_seen_at: prior?.first_seen_at || record.first_seen_at || generatedAt,
      last_seen_at: generatedAt,
      source_content_hash: record.source_content_hash,
      record_hash: record.record_hash,
      ...(record.arxiv_version ? { arxiv_version: record.arxiv_version } : {}),
    });
  }
  return [...history.values()]
    .sort((left, right) => (right.last_seen_at || "").localeCompare(left.last_seen_at || "") || left.canonical_id.localeCompare(right.canonical_id))
    .slice(0, IDENTITY_HISTORY_LIMIT);
}

function withinDailyEditorialWindow(record, now) {
  const publishedAt = Date.parse(record?.published_at || "");
  if (!Number.isFinite(publishedAt)) return false;
  const ageHours = (now.getTime() - publishedAt) / HOUR_MS;
  return ageHours >= 0 && ageHours <= DAILY_EDITORIAL_WINDOW_HOURS;
}

function baseDailyWindowRecord(record) {
  const value = { ...record };
  delete value.daily_window_state;
  delete value.fresh_for_change_detection;
  delete value.daily_change_candidate;
  delete value.retained_from_generated_at;
  delete value.manual_review_only;
  delete value.claim_evidence_allowed;
  delete value.primary_verification_required;
  return value;
}

function projectDailyWindowRecord(record, { state, retainedFromGeneratedAt = null } = {}) {
  const freshForChangeDetection = state === "current-source";
  return {
    ...baseDailyWindowRecord(record),
    daily_window_state: state,
    fresh_for_change_detection: freshForChangeDetection,
    daily_change_candidate: freshForChangeDetection && ["new", "updated", "revision"].includes(record.change),
    ...(retainedFromGeneratedAt ? { retained_from_generated_at: retainedFromGeneratedAt } : {}),
    primary_verification_required: true,
    manual_review_only: true,
    claim_evidence_allowed: false,
    notification_eligible: false,
  };
}

export function createDailyCurrentWindowRecords({ now = new Date(), records = [], sourceEvents = [], previousAudit = null } = {}) {
  const observedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(observedAt.getTime())) throw new Error("invalid daily editorial window time");
  const freshSourceIds = new Set(array(sourceEvents).filter((event) => event?.status === "fresh").map((event) => event.source_id));
  const previousById = new Map();
  for (const record of [...array(previousAudit?.records), ...array(previousAudit?.daily_current_window_records)]) {
    if (record?.canonical_id) previousById.set(record.canonical_id, baseDailyWindowRecord(record));
  }

  const projected = new Map();
  for (const record of array(records)) {
    if (!record?.canonical_id || !withinDailyEditorialWindow(record, observedAt)) continue;
    if (record.concrete_mechanism_delta !== true || !/^G[1-4]$/.test(String(record.evidence_grade || ""))) continue;
    if (array(record.source_ids).some((sourceId) => freshSourceIds.has(sourceId))) {
      projected.set(record.canonical_id, projectDailyWindowRecord(record, { state: "current-source" }));
    }
  }

  for (const record of previousById.values()) {
    if (projected.has(record.canonical_id) || !withinDailyEditorialWindow(record, observedAt)) continue;
    if (record.concrete_mechanism_delta !== true || !/^G[1-4]$/.test(String(record.evidence_grade || ""))) continue;
    projected.set(record.canonical_id, projectDailyWindowRecord(record, {
      state: "retained-from-prior-snapshot",
      retainedFromGeneratedAt: previousAudit?.generated_at || record.first_seen_at || null,
    }));
  }

  return [...projected.values()].sort((left, right) => (right.published_at || "").localeCompare(left.published_at || "")
    || left.canonical_id.localeCompare(right.canonical_id));
}

async function readJson(path, fallback) {
  if (!path) return fallback;
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function cacheRead(cachePath) {
  const cached = await readJson(cachePath, null);
  if (!cached || Date.now() - Date.parse(cached.fetched_at) > CACHE_MAX_AGE_MS) return null;
  return cached;
}

async function fetchSource(source, cacheDir) {
  const started = new Date().toISOString();
  const cachePath = join(cacheDir, `${source.id}.json`);
  const previousCache = await readJson(cachePath, null);
  let lastError;
  let attempts = 0;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    attempts = attempt;
    try {
      const headers = { accept: "*/*", "user-agent": USER_AGENT };
      if (source.format === "github-repositories" && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const response = await fetch(source.url, { headers, signal: AbortSignal.timeout(45_000) });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        error.status = response.status;
        error.retryAfter = response.headers.get("retry-after") || "";
        throw error;
      }
      const body = await response.text();
      const fetchedAt = new Date().toISOString();
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, `${JSON.stringify({ fetched_at: fetchedAt, body }, null, 2)}\n`);
      return {
        body,
        previousBody: previousCache?.body ?? null,
        event: { source_id: source.id, tier: source.tier, status: "fresh", started_at: started, fetched_at: fetchedAt, attempts: attempt, content_sha256: hash(body) },
      };
    } catch (error) {
      lastError = error;
      if (error?.status === 429 || (error?.status >= 400 && error?.status < 500 && error?.status !== 408 && error?.status !== 425)) break;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  const cached = await cacheRead(cachePath);
  if (cached) {
    return {
      body: cached.body,
      previousBody: cached.body,
      event: { source_id: source.id, tier: source.tier, status: "stale-cache", started_at: started, fetched_at: cached.fetched_at, attempts, content_sha256: hash(cached.body), error: String(lastError) },
    };
  }
  return {
    body: null,
    previousBody: previousCache?.body ?? null,
    event: { source_id: source.id, tier: source.tier, status: "failed", started_at: started, fetched_at: new Date().toISOString(), attempts, error: String(lastError) },
  };
}

export function createAudit({ now = new Date(), sourceEvents = [], candidates = [], previousRecords = [], previousIdentityHistory = [], previousAudit = null, baselineSourceIds = [] } = {}) {
  const generatedAt = now.toISOString();
  const records = dedupeCandidates(candidates, previousRecords, { baselineSourceIds, identityHistory: previousIdentityHistory }).map((record) => ({
    ...record,
    first_seen_at: record.first_seen_at || generatedAt,
  }));
  const identityHistory = buildIdentityHistory({
    previousIdentityHistory,
    previousRecords,
    records,
    generatedAt,
    previousGeneratedAt: previousAudit?.generated_at || "",
  });
  const dailyCurrentWindowRecords = createDailyCurrentWindowRecords({
    now,
    records,
    sourceEvents,
    previousAudit,
  });
  const changeCounts = Object.fromEntries(
    ["baseline", "new", "unchanged", "updated", "enriched", "revision", "source-regressed"]
      .map((change) => [change, records.filter((record) => record.change === change).length]),
  );
  const core = sourceEvents.filter((event) => event.tier === "core");
  const coreSuccess = core.filter((event) => ["fresh", "stale-cache"].includes(event.status)).length;
  const coreFresh = core.filter((event) => event.status === "fresh").length;
  const unsuccessful = sourceEvents.filter((event) => !["fresh", "stale-cache"].includes(event.status)).length;
  const coreSuccessRate = core.length ? Number((coreSuccess / core.length).toFixed(4)) : 0;
  const coreFreshRate = core.length ? Number((coreFresh / core.length).toFixed(4)) : 0;
  const silentDates = observedSilentDates(previousAudit, now);
  const consecutiveSilentDays = consecutiveDayCount(silentDates);
  const gateCriteria = {
    minimum_silent_days: { required: MINIMUM_SILENT_DAYS, observed: consecutiveSilentDays, passed: consecutiveSilentDays >= MINIMUM_SILENT_DAYS },
    core_source_success_rate: { required: MINIMUM_CORE_SUCCESS_RATE, observed: coreSuccessRate, passed: coreSuccessRate >= MINIMUM_CORE_SUCCESS_RATE },
    human_review: { required: true, observed: false, passed: false },
  };
  const gateBlockers = Object.entries(gateCriteria).filter(([, criterion]) => !criterion.passed).map(([name]) => name);
  const seedGraph = publicSeedGraph();
  const sourceEventMap = new Map(sourceEvents.map((event) => [event.source_id, event]));
  const seedHealth = seedGraph.map((seed) => {
    const events = seed.monitored_source_ids.map((sourceId) => sourceEventMap.get(sourceId)).filter(Boolean);
    const failed = events.filter((event) => !["fresh", "stale-cache"].includes(event.status));
    const stale = events.filter((event) => event.status === "stale-cache");
    return {
      seed_id: seed.id,
      monitored_source_ids: seed.monitored_source_ids,
      status: !events.length ? "unmonitored" : failed.length ? "failed" : stale.length ? "stale" : "fresh",
      fresh_sources: events.filter((event) => event.status === "fresh").map((event) => event.source_id),
      stale_sources: stale.map((event) => event.source_id),
      failed_sources: failed.map((event) => event.source_id),
    };
  });
  const qualityReview = createDailyQualityReview(records, localDateKey(now));
  return {
    schema_version: 1,
    generated_at: generatedAt,
    mode: "silent-audit",
    status: unsuccessful ? "degraded" : "ok",
    onboarded_source_ids: [...baselineSourceIds].sort(),
    notification_policy: {
      enabled: false,
      minimum_silent_days: MINIMUM_SILENT_DAYS,
      external_actions: [],
      statement: "This collector cannot publish, message, or create a WeChat draft.",
    },
    notification_gate: {
      eligible: false,
      audit_time_zone: AUDIT_TIME_ZONE,
      observed_silent_dates: silentDates,
      consecutive_silent_days: consecutiveSilentDays,
      criteria: gateCriteria,
      blockers: gateBlockers,
      statement: "Human review is deliberately not writable by this collector.",
    },
    dependency_policy: {
      gemini_required: false,
      google_oauth_required: false,
      openai_membership_required: false,
      cloudflare_credentials_required: false,
    },
    metrics: {
      registered_sources: sourceEvents.length,
      core_sources: core.length,
      core_success_rate: coreSuccessRate,
      core_fresh_rate: coreFreshRate,
      classified_records: records.length,
      concrete_mechanism_records: records.filter((record) => record.concrete_mechanism_delta).length,
      notification_eligible_records: 0,
      seed_mechanisms: seedGraph.length,
      seed_monitored_sources: new Set(seedGraph.flatMap((seed) => seed.monitored_source_ids)).size,
      identity_history_records: identityHistory.length,
      daily_current_window_records: dailyCurrentWindowRecords.length,
      quality_review_sample_records: qualityReview.sampled_records,
      change_counts: changeCounts,
    },
    source_registry: publicRegistryView(),
    seed_graph: seedGraph,
    seed_health: seedHealth,
    source_events: sourceEvents,
    identity_history: identityHistory,
    daily_current_window_records: dailyCurrentWindowRecords,
    quality_review: qualityReview,
    records,
  };
}

const priorityRank = Object.freeze({ P0: 0, P1: 1, P2: 2, none: 3 });
const reviewLayerRank = Object.freeze({ B0: 0, M3: 1, M4: 2, H1: 3, M1: 4, M2: 5, E1: 6 });

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function renderMechanismReview(audit, { limit = 20 } = {}) {
  const gate = audit.notification_gate;
  const rankedCandidates = [...audit.records]
    .filter((record) => record.concrete_mechanism_delta && (["baseline", "source-regressed"].includes(record.change) || record.provisional_priority !== "none"))
    .sort((left, right) => {
      const changeRank = (value) => value === "updated" || value === "revision" ? 0 : value === "new" ? 1 : value === "source-regressed" ? 2 : value === "baseline" ? 3 : 4;
      return changeRank(left.change) - changeRank(right.change)
        || priorityRank[left.provisional_priority] - priorityRank[right.provisional_priority]
        || reviewLayerRank[left.primary_layer] - reviewLayerRank[right.primary_layer]
        || (right.published_at || "").localeCompare(left.published_at || "")
        || left.canonical_id.localeCompare(right.canonical_id);
    });
  const candidates = [];
  const baselineLayers = new Map();
  for (const record of rankedCandidates) {
    if (record.change === "baseline") {
      const count = baselineLayers.get(record.primary_layer) || 0;
      if (count >= 4) continue;
      baselineLayers.set(record.primary_layer, count + 1);
    }
    candidates.push(record);
    if (candidates.length >= limit) break;
  }
  const failedSources = audit.source_events.filter((event) => event.status !== "fresh");
  const lines = [
    `# 模型机制静默复核 · ${gate.observed_silent_dates.at(-1) || audit.generated_at.slice(0, 10)}`,
    "",
    "> 此文件由确定性采集器生成，只供人工尽调。它不会发送通知、创建公众号草稿或发布网站内容。",
    "",
    "## 运行摘要",
    "",
    "| 项目 | 结果 |",
    "|---|---:|",
    `| 模式 | ${markdownCell(audit.mode)} |`,
    `| 核心源成功率 | ${(audit.metrics.core_success_rate * 100).toFixed(2)}% |`,
    `| 核心源新鲜率 | ${(audit.metrics.core_fresh_rate * 100).toFixed(2)}% |`,
    `| 机制候选 | ${audit.metrics.concrete_mechanism_records} |`,
    `| 新身份 / 真实修订 | ${audit.metrics.change_counts.new} / ${audit.metrics.change_counts.revision} |`,
    `| 主源补全 / 源版本倒退 | ${audit.metrics.change_counts.enriched} / ${audit.metrics.change_counts["source-regressed"]} |`,
    `| 跨窗口身份历史 | ${audit.metrics.identity_history_records} / ${IDENTITY_HISTORY_LIMIT} |`,
    `| 48 小时编辑窗口 | ${audit.metrics.daily_current_window_records} |`,
    `| 连续静默天数 | ${gate.consecutive_silent_days} / ${audit.notification_policy.minimum_silent_days} |`,
    `| 通知资格 | ${gate.eligible ? "是" : "否"} |`,
    "",
    `门槛阻断：${gate.blockers.length ? gate.blockers.map((item) => `\`${item}\``).join("、") : "无"}。`,
    "",
    `本次首次建基线的来源：${audit.onboarded_source_ids.length ? audit.onboarded_source_ids.map((item) => `\`${item}\``).join("、") : "无"}。这些来源的历史记录不得视为当天新进展。`,
    "",
    "## 来源健康",
    "",
  ];
  if (!failedSources.length) {
    lines.push(`本次 ${audit.source_events.length} 个来源全部为 fresh。`, "");
  } else {
    lines.push("| 来源 | 状态 | 错误 |", "|---|---|---|", ...failedSources.map((event) => `| ${markdownCell(event.source_id)} | ${markdownCell(event.status)} | ${markdownCell(event.error)} |`), "");
  }
  lines.push(
    "## 种子证据链健康",
    "",
    "| 种子 | 专用来源 | 状态 |",
    "|---|---:|---|",
    ...audit.seed_health.map((seed) => `| ${markdownCell(seed.seed_id)} | ${seed.monitored_source_ids.length} | ${markdownCell(seed.status)} |`),
    "",
  );
  lines.push(
    "## 每日分层质量抽样",
    "",
    `> 即使当天没有新身份或 revision，也从 ${audit.quality_review.eligible_records} 条机制记录中按主层确定性抽样 ${audit.quality_review.sampled_records} 条。抽样结果只供人工标注误报、错层、主证据可追溯性和重复机制；采集器不会替人填写，也不能满足 human-review gate。`,
    "",
  );
  if (audit.quality_review.samples.length) {
    lines.push(
      "| 层 | 样本 | 证据/变化 | 来源 | 人工结论 |",
      "|---|---|---|---|---|",
      ...audit.quality_review.samples.map((sample) => `| ${sample.primary_layer} | [${markdownCell(sample.title)}](${sample.canonical_url}) | ${sample.evidence_grade}/${sample.change} | ${sample.source_ids.map(markdownCell).join("、")} | 待填写：正确 / 误报 / 错层 / 不可追溯 / 重复 |`),
      "",
      "抽样复核要求：逐条打开 canonical 主来源；记录错误类型和建议层；不能以标题、摘要或模型生成分析代替主证据。",
      "",
    );
  } else {
    lines.push("当前没有可抽样的 concrete mechanism record；人工必须复核过滤是否过严。", "");
  }
  lines.push(
    "## 待人工复核候选",
    "",
    "这里只展示优先级最高的一小批候选；原始记录和全部链接以 `audit.json` 为准。初始基线不是新进展，不能据此发通知。",
    "",
  );
  for (const [index, record] of candidates.entries()) {
    const summary = markdownCell(record.summary).slice(0, 900);
    const documentDiffLines = record.source_metadata.filter((metadata) => metadata.line_diff).flatMap((metadata) => {
      const diff = metadata.line_diff;
      const details = [
        `- 正文快照：\`${markdownCell(metadata.source_id)}\` 状态 \`${diff.status}\`，当前 SHA-256 \`${diff.current_sha256.slice(0, 16)}…\`，${metadata.line_count} 行`,
      ];
      if (diff.changed) {
        details.push(
          `- 行级差异：从第 ${diff.first_changed_line} 行开始，删除 ${diff.removed_line_count} 行，增加 ${diff.added_line_count} 行；${diff.excerpt_truncated ? "片段已截断" : "片段完整"}`,
          `- 变更前片段：${markdownCell(diff.before_excerpt.join(" ⏎ ")).slice(0, 700) || "空"}`,
          `- 变更后片段：${markdownCell(diff.after_excerpt.join(" ⏎ ")).slice(0, 700) || "空"}`,
        );
      }
      return details;
    });
    lines.push(
      `### ${index + 1}. [${markdownCell(record.title)}](${record.canonical_url})`,
      "",
      `- 分层：\`${record.primary_layer}\`；证据：\`${record.evidence_grade}\`；暂定优先级：\`${record.provisional_priority}\`；变化：\`${record.change}\``,
      `- 命中机制词：${record.matched_terms.map((term) => `\`${markdownCell(term)}\``).join("、") || "无"}`,
      `- 来源：${record.source_ids.map((sourceId) => `\`${markdownCell(sourceId)}\``).join("、")}`,
      `- 种子机制：${record.seed_ids.length ? record.seed_ids.map((seedId) => `\`${markdownCell(seedId)}\``).join("、") : "未关联"}`,
      `- 阻断：${record.blockers.map((blocker) => `\`${markdownCell(blocker)}\``).join("、")}`,
      `- 原始摘要：${summary || "无摘要；必须打开主来源核对。"}`,
      ...documentDiffLines,
      "",
      "复核清单：",
      "",
      "- [ ] 不是关键词误报：B0 确有行为规则变化，或 M/H/E 层确有计算图、表示、训练目标、推理分配、因果机制或 harness 行为变化",
      "- [ ] 分层正确；没有把行为规范、模型权重、Agent harness 和评测 harness 混为一层",
      "- [ ] 已打开主来源，区分作者主张与直接证据",
      "- [ ] 已核对代码、权重、数据、评测配置及复现状态",
      "- [ ] 已查找独立支持、反证和适用边界",
      "- [ ] 若为 P0/P1，已记录人工语义差异或可复现能力变化",
      "",
      "复核备注：",
      "",
      "---",
      "",
    );
  }
  if (!candidates.length) lines.push("本次没有进入人工复核队列的候选。", "");
  lines.push(
    "## 每日质量记录",
    "",
    "- 误报数 / 复核数：",
    "- 错误分层数 / 复核数：",
    "- 无法追溯到主证据的事实数：",
    "- 重复机制或重复通知候选数：",
    "- P0/P1 人工复核人及时间：",
    "- 是否建议继续静默：是（默认）",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export async function runMechanismWatch({
  outputPath = process.env.OUTPUT_PATH || "work/mechanism-watch/audit.json",
  statePath = process.env.STATE_PATH || "work/mechanism-watch/audit.json",
  cacheDir = process.env.CACHE_DIR || "work/mechanism-watch/cache",
  reviewPath = process.env.REVIEW_PATH || "work/mechanism-watch/review.md",
} = {}) {
  const previousAudit = await readJson(statePath, { records: [] });
  const previousSourceIds = new Set(array(previousAudit.source_registry).map((source) => source.id));
  const baselineSourceIds = previousAudit.generated_at
    ? mechanismSources.filter((source) => !previousSourceIds.has(source.id)).map((source) => source.id)
    : mechanismSources.map((source) => source.id);
  const sourceEvents = [];
  const candidates = [];

  for (const source of mechanismSources) {
    const fetched = await fetchSource(source, cacheDir);
    sourceEvents.push(fetched.event);
    if (!fetched.body) continue;
    try {
      const parsed = parseSource(source, fetched.body, { previousBody: fetched.previousBody })
        .map((item) => ({ ...item, url: normalizeUrl(item.url), source }))
        .filter((item) => item.url && classifyCandidate(item, source).primary_layer)
        .sort((left, right) => (right.published_at || "").localeCompare(left.published_at || ""))
        .slice(0, source.maxCandidates);
      candidates.push(...parsed);
      fetched.event.items_parsed = parsed.length;
    } catch (error) {
      fetched.event.status = "parse-failed";
      fetched.event.error = String(error);
      fetched.event.items_parsed = 0;
    }
  }

  const audit = createAudit({
    sourceEvents,
    candidates,
    previousRecords: previousAudit.records || [],
    previousIdentityHistory: previousAudit.identity_history || [],
    previousAudit,
    baselineSourceIds,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
  await mkdir(dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, renderMechanismReview(audit));
  return audit;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  runMechanismWatch().then((audit) => {
    console.log(JSON.stringify({
      mode: audit.mode,
      status: audit.status,
      core_success_rate: audit.metrics.core_success_rate,
      records: audit.metrics.classified_records,
      notification_eligible_records: audit.metrics.notification_eligible_records,
    }));
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
