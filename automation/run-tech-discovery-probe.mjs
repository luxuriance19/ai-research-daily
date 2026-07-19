#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";
import {
  TECH_DISCOVERY_POLICY,
  scoreTechDiscoverySignal,
  techDiscoverySources,
} from "./tech-discovery-registry.mjs";
import { analyzeReleaseSemanticDelta } from "./release-semantic-policy.mjs";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
const USER_AGENT = "ai-research-daily-tech-discovery-shadow/0.1";
const AUDIT_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_SOURCE_TIMEOUT_MS = 45_000;
const DEFAULT_RUN_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 4_000;
const DEFAULT_RETRY_JITTER_RATIO = 0.20;
const MINIMUM_OBSERVATION_DAYS = 7;
const DAILY_EDITORIAL_MAX_AGE_HOURS = 48;
const RETAINED_EDITORIAL_CACHE_MAX_AGE_HOURS = 24;
const NETWORK_VERIFIED_STATUSES = new Set(["fresh", "not-modified"]);
const REUSED_VERIFIED_STATUS = "reused-fresh-snapshot";
const DAILY_SECTIONS = Object.freeze([
  "new-model",
  "compute-chip",
  "mechanism",
  "harness",
  "evaluation",
  "company-direction",
]);

const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const hash = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

function cleanText(value, limit = 1000) {
  if (value == null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) {
    return decodeHtmlEntities(String(value))
      .replace(/<(script|style|noscript|svg)\b[^>]*>[^]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit);
  }
  if (Array.isArray(value)) return cleanText(value.map((item) => cleanText(item, limit)).join(" "), limit);
  if (typeof value === "object") return cleanText(value["#text"] ?? value.__cdata ?? Object.values(value), limit);
  return "";
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function parseDate(value) {
  return Number.isFinite(Date.parse(value || "")) ? new Date(value).toISOString() : "";
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
  const dates = [...new Set(array(dateKeys).filter(Boolean))].sort();
  if (!dates.length) return 0;
  let count = 1;
  for (let index = dates.length - 1; index > 0; index -= 1) {
    if (Date.parse(`${dates[index]}T00:00:00Z`) - Date.parse(`${dates[index - 1]}T00:00:00Z`) !== 86_400_000) break;
    count += 1;
  }
  return count;
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!new Set(["http:", "https:"]).has(url.protocol)) return "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || ["ref", "source", "si", "s"].includes(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

function normalizedTitle(value) {
  const inflections = new Map([
    ["announced", "announce"],
    ["announces", "announce"],
    ["introduces", "introduce"],
    ["introducing", "introduce"],
    ["launched", "launch"],
    ["launches", "launch"],
    ["released", "release"],
    ["releases", "release"],
    ["unveiled", "unveil"],
    ["unveils", "unveil"],
  ]);
  const stopWords = new Set(["a", "an", "and", "by", "for", "from", "new", "of", "official", "on", "the", "to", "with"]);
  const tokens = cleanText(value, 500)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\s*\[[^\]]{1,80}\]\s*/u, "")
    .match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(tokens.map((token) => inflections.get(token) || token).filter((token) => !stopWords.has(token)))].sort().join(" ");
}

function primaryIdentityFromUrl(value) {
  const url = canonicalUrl(value);
  if (!url) return "";
  const githubRelease = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+)\/releases\/tag\/([^/?#]+)/i);
  if (githubRelease) return `git-release:${githubRelease[1].toLowerCase()}@${decodeURIComponent(githubRelease[2])}`;
  const githubCommit = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+)\/commit\/([0-9a-f]{7,64})/i);
  if (githubCommit) return `git-commit:${githubCommit[1].toLowerCase()}@${githubCommit[2].toLowerCase()}`;
  const githubRepository = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/?#]+)\/?$/i);
  if (githubRepository) return `git-repository:${githubRepository[1].toLowerCase()}`;
  const arxiv = url.match(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([^/?#]+?)(?:\.pdf)?$/i);
  if (arxiv) return `arxiv:${arxiv[1].toLowerCase()}`;
  const openReview = new URL(url).searchParams.get("id");
  if (/^https?:\/\/(?:www\.)?openreview\.net\/(?:forum|pdf)/i.test(url) && openReview) return `openreview:${openReview}`;
  const doi = url.match(/^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i);
  if (doi) return `doi:${doi[1].toLowerCase()}`;
  const huggingFace = url.match(/^https?:\/\/(?:www\.)?huggingface\.co\/([^/]+\/[^/?#]+)(?:\/(?:tree|resolve)\/([^/?#]+))?/i);
  if (huggingFace) return `huggingface:${huggingFace[1].toLowerCase()}${huggingFace[2] ? `@${huggingFace[2]}` : ""}`;
  return "";
}

// These rules identify a story object for cross-publication deduplication only.
// They do not authenticate a publisher or raise the authority of any claim.
const OFFICIAL_ANNOUNCEMENT_IDENTITY_RULES = Object.freeze([
  { hosts: ["kimi.com", "www.kimi.com"], path: /^\/blog\/[^/]+$/i },
  { hosts: ["openai.com", "www.openai.com"], path: /^\/(?:index|research)\/[^/]+$/i },
  { hosts: ["anthropic.com", "www.anthropic.com"], path: /^\/(?:news|research|engineering)\/[^/]+$/i },
  { hosts: ["deepmind.google", "www.deepmind.google"], path: /^\/(?:discover\/blog|blog)\/[^/]+$/i },
  { hosts: ["mistral.ai", "www.mistral.ai"], path: /^\/news\/[^/]+$/i },
  { hosts: ["ai.meta.com", "www.ai.meta.com"], path: /^\/blog\/[^/]+$/i },
]);

function officialAnnouncementIdentityFromUrl(value) {
  const normalized = canonicalUrl(value);
  if (!normalized) return "";
  const url = new URL(normalized);
  const rule = OFFICIAL_ANNOUNCEMENT_IDENTITY_RULES.find((candidate) => (
    candidate.hosts.includes(url.hostname.toLowerCase()) && candidate.path.test(url.pathname)
  ));
  if (!rule) return "";
  return `official-announcement:${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.toLowerCase()}`;
}

function officialAnnouncementAlignedWithTitle(value, title) {
  const normalized = canonicalUrl(value);
  if (!normalized) return false;
  const slug = new URL(normalized).pathname.split("/").filter(Boolean).at(-1) || "";
  const generic = new Set(["announce", "blog", "introduce", "launch", "model", "news", "release", "research", "update"]);
  const slugTokens = normalizedTitle(slug).split(" ").filter((token) => token && !generic.has(token));
  const titleTokens = new Set(normalizedTitle(title).split(" ").filter(Boolean));
  return slugTokens.length > 0 && slugTokens.some((token) => titleTokens.has(token));
}

function primaryIdentityFromHint(hint) {
  if (!hint || typeof hint !== "object") return "";
  if (hint.kind === "repository-candidate" && hint.repository) {
    return `git-repository:${String(hint.repository).toLowerCase()}`;
  }
  if (hint.kind === "git-release-or-commit-sha" && hint.repository) {
    const revision = hint.commit_sha || hint.tag_name || hint.release_id || hint.target_commitish;
    if (revision) return `git-release:${String(hint.repository).toLowerCase()}@${revision}`;
  }
  if ((hint.kind === "arxiv-version" || hint.arxiv_id) && (hint.arxiv_id || hint.id)) {
    return `arxiv:${String(hint.arxiv_id || hint.id).toLowerCase()}`;
  }
  if ((hint.kind === "huggingface-revision" || hint.repository) && hint.revision) {
    return `huggingface:${String(hint.repository || hint.model_id).toLowerCase()}@${hint.revision}`;
  }
  return "";
}

function primaryIdentityStrength(identity) {
  if (/^official-announcement:/i.test(identity)) return 6;
  if (/^(?:git-release|git-commit):/i.test(identity)) return 5;
  if (/^huggingface:.+@[^@]+$/i.test(identity)) return 5;
  if (/^(?:arxiv|openreview|doi):/i.test(identity)) return 4;
  if (/^huggingface:/i.test(identity)) return 2;
  if (/^git-repository:/i.test(identity)) return 1;
  return 0;
}

function normalizedIdentityStrength(item) {
  if (["canonical-official-announcement", "artifact-official-announcement"].includes(item.normalized_event_identity_basis)) return 6;
  return primaryIdentityStrength(item.normalized_event_fingerprint);
}

function reconcileCrossSourceIdentities(sourceEvents) {
  const strongestByCanonicalUrl = new Map();
  for (const event of sourceEvents) {
    for (const item of array(event.items)) {
      if (!item.canonical_url) continue;
      const current = strongestByCanonicalUrl.get(item.canonical_url);
      if (!current || normalizedIdentityStrength(item) > normalizedIdentityStrength(current)) {
        strongestByCanonicalUrl.set(item.canonical_url, item);
      }
    }
  }
  return sourceEvents.map((event) => {
    const reconciledItems = array(event.items).map((item) => {
      const bridge = strongestByCanonicalUrl.get(item.canonical_url);
      if (!bridge || bridge.canonical_story_key === item.canonical_story_key
        || normalizedIdentityStrength(bridge) <= normalizedIdentityStrength(item)) return item;
      return {
        ...item,
        canonical_story_key: bridge.canonical_story_key,
        normalized_event_identity_basis: "canonical-url-cross-source-bridge",
        normalized_event_fingerprint: bridge.normalized_event_fingerprint,
        identity_bridge: {
          via_canonical_url: item.canonical_url,
          source_id: bridge.source_id,
          source_story_key: bridge.source_story_key,
          source_identity_basis: bridge.normalized_event_identity_basis,
          source_identity_fingerprint: bridge.normalized_event_fingerprint,
        },
      };
    });
    const reconciledBySourceStory = new Map(reconciledItems.map((item) => [item.source_story_key, item]));
    return {
      ...event,
      items: reconciledItems,
      queue_candidates: array(event.queue_candidates).map((item) => reconciledBySourceStory.get(item.source_story_key) || item),
    };
  });
}

function bestPrimaryUrlIdentity(canonical, artifactLinks) {
  const candidates = [];
  const canonicalIdentity = primaryIdentityFromUrl(canonical);
  if (canonicalIdentity) candidates.push({
    identity: canonicalIdentity,
    basis: "canonical-primary-url",
    source_priority: 1,
    order: -1,
  });
  array(artifactLinks).forEach((link, index) => {
    const identity = primaryIdentityFromUrl(typeof link === "string" ? link : link?.url || link?.href);
    if (identity) candidates.push({
      identity,
      basis: "primary-artifact-link",
      source_priority: 0,
      order: index,
    });
  });
  return candidates.sort((left, right) => (
    primaryIdentityStrength(right.identity) - primaryIdentityStrength(left.identity)
    || right.source_priority - left.source_priority
    || left.order - right.order
  ))[0] || null;
}

function extractBoundedPrimaryArtifactLinks(value, limit = 8) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const candidates = decodeHtmlEntities(serialized).match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
  const seen = new Set();
  const links = [];
  for (const candidate of candidates) {
    const normalized = canonicalUrl(candidate.replace(/[),.;\]]+$/u, ""));
    if (!normalized || !(officialAnnouncementIdentityFromUrl(normalized) || primaryIdentityFromUrl(normalized)) || seen.has(normalized)) continue;
    seen.add(normalized);
    links.push(normalized);
    if (links.length >= limit) break;
  }
  return links;
}

/**
 * Cross-publication identity for queue deduplication only. It never establishes
 * that the hinted primary artifact is authentic or supports a claim.
 */
export function normalizedEventIdentity({
  title = "",
  canonical_url: url = "",
  kind = "",
  project = "",
  release_identity: releaseIdentity = "",
  primary_identity_hint: primaryIdentityHint = null,
  artifact_links: artifactLinks = [],
} = {}) {
  const hinted = primaryIdentityFromHint(primaryIdentityHint);
  const explicit = hinted || (kind === "github-release" && releaseIdentity
    ? `git-release:${String(releaseIdentity).toLowerCase()}`
    : kind === "github-project" && project
      ? `git-repository:${String(project).toLowerCase()}`
      : "");
  if (explicit) return { key: `event:${hash(explicit)}`, basis: "primary-identity-hint", fingerprint: explicit };

  const canonicalOfficialAnnouncement = officialAnnouncementIdentityFromUrl(url);
  if (canonicalOfficialAnnouncement) {
    return {
      key: `event:${hash(canonicalOfficialAnnouncement)}`,
      basis: "canonical-official-announcement",
      fingerprint: canonicalOfficialAnnouncement,
    };
  }

  for (const link of array(artifactLinks)) {
    const value = typeof link === "string" ? link : link?.url || link?.href;
    const identity = officialAnnouncementAlignedWithTitle(value, title) ? officialAnnouncementIdentityFromUrl(value) : "";
    if (identity) return { key: `event:${hash(identity)}`, basis: "artifact-official-announcement", fingerprint: identity };
  }

  const bestPrimaryIdentity = bestPrimaryUrlIdentity(url, artifactLinks);
  if (bestPrimaryIdentity) {
    return {
      key: `event:${hash(bestPrimaryIdentity.identity)}`,
      basis: bestPrimaryIdentity.basis,
      fingerprint: bestPrimaryIdentity.identity,
    };
  }

  const titleFingerprint = normalizedTitle(title);
  if (titleFingerprint) {
    const identity = `title:${titleFingerprint}`;
    return { key: `event:${hash(identity)}`, basis: "normalized-title", fingerprint: identity };
  }
  const fallback = `url:${canonicalUrl(url)}`;
  return { key: `event:${hash(fallback)}`, basis: "canonical-url-fallback", fingerprint: fallback };
}

function linkValue(value) {
  if (typeof value === "string") return value;
  return array(value).find((item) => item?.rel === "alternate")?.href
    || array(value).find((item) => item?.href)?.href
    || "";
}

function stableStoryKey({ canonical_url: url, title, kind, project, release_identity: releaseIdentity }) {
  if (kind === "github-project" && project) return `github-project:${project.toLowerCase()}`;
  if (kind === "github-release" && releaseIdentity) return `github-release:${releaseIdentity}`;
  if (url) return `url:${hash(url)}`;
  return `title:${hash(cleanText(title, 500).toLowerCase())}`;
}

function ageHours(value, now) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return Math.max(0, (now.getTime() - Date.parse(value)) / 3_600_000);
}

const SECTION_PATTERNS = Object.freeze({
  "new-model": [
    /\b(new|launch(?:es|ed)?|release[sd]?|introduc(?:e[sd]?|ing)|open[- ]source)\b[^.]{0,80}\b(model|llm|vlm|multimodal|reasoning)\b/i,
    /\b(model|llm|vlm)\b[^.]{0,80}\b(release[sd]?|launch(?:es|ed)?|weights?|checkpoint)\b/i,
    /\b(?:gpt|claude|gemini|llama|qwen|deepseek|kimi|mistral|grok|phi|nemotron)[\s-]+(?:[a-z][a-z0-9-]*\s+)?[a-z]?\d+(?:\.\d+)*\b/i,
  ],
  "compute-chip": [
    /\b(gpu|tpu|npu|accelerator|chip|semiconductor|hbm|cuda|rocm|nvlink|infiniband|wafer|asic|chiplet|tensor core|memory bandwidth)\b/i,
    /\b(inference|training|serving)\b[^.]{0,80}\b(kernel|throughput|latency|cluster|compute|memory|interconnect|quantization)\b/i,
    /\b(ai|llm|model training|model inference|accelerated computing|hpc|gpu|accelerator)\b[^.]{0,100}\b(cpu|server|rack|data[- ]?center|memory system|network fabric)\b/i,
    /\b(cpu|server|rack|data[- ]?center|memory system|network fabric)\b[^.]{0,100}\b(ai|llm|model training|model inference|accelerated computing|hpc|gpu|accelerator)\b/i,
  ],
  mechanism: [
    /\b(attention|mixture[- ]of[- ]experts|moe|routing|latent reasoning|latent cot|chain[- ]of[- ]thought|recurren(?:t|ce)|test[- ]time compute|architecture)\b/i,
    /\b(interpretability|circuit tracing|mechanistic|activation|representation|hidden state|reasoning mechanism|memory mechanism)\b/i,
    /\b(post[- ]training|rlhf|rlaif|distillation|knowledge distillation|preference optimization|direct preference optimization|dpo|grpo|reward model(?:ing)?|alignment training)\b/i,
  ],
  harness: [
    /\b(agent(?:ic|s)?|agent sdk|harness|tool[- ]use|orchestration|mcp|model context protocol|coding agent|computer use|workflow)\b/i,
  ],
  evaluation: [
    /\b(eval(?:uation|s)?|benchmark|leaderboard|scorer|metric|grading|red[- ]team|inspect evals|helm|lm[-_ ]eval)\b/i,
  ],
  "company-direction": [
    /\b(openai|anthropic|deepmind|deepseek|meta ai|microsoft ai|xai|moonshot ai|mistral ai|hugging face)\b[^.]{0,100}\b(strategy|roadmap|research|partnership|acqui(?:res|red|sition)|funding|investment|hires?|reorg|lab|direction)\b/i,
    /\b(ai|artificial intelligence)\b[^.]{0,80}\b(strategy|roadmap|partnership|acqui(?:res|red|sition)|funding|investment|research lab|reorg)\b/i,
  ],
});

export function classifyDailySections(value, { sourceId = "", kind = "" } = {}) {
  const text = cleanText(value, 4000);
  const matched = new Set();
  for (const section of DAILY_SECTIONS) {
    if (SECTION_PATTERNS[section].some((pattern) => pattern.test(text))) matched.add(section);
  }
  if (kind === "github-release") {
    // This reused release stream is scoped to Agent/Eval Harness repositories.
    // A product name such as "Claude" in an SDK version must not become a
    // model-launch signal.
    matched.delete("new-model");
    if (/helm|inspect[-_]evals/i.test(sourceId)) matched.add("evaluation");
    else matched.add("harness");
  }
  return DAILY_SECTIONS.filter((section) => matched.has(section));
}

function sourceIsAiSpecific(source) {
  return new Set([
    "ieee-spectrum-ai-feed",
    "latent-space-existing-snapshot",
    "official-github-releases-existing-snapshots",
  ]).has(source.id);
}

function shapeItem(source, raw, index, now) {
  const url = canonicalUrl(raw.url);
  const publishedAt = parseDate(raw.published_at);
  const summaryForDiscovery = raw.kind === "github-release"
    ? String(raw.summary || "").slice(0, 1000)
    : cleanText(raw.summary, 1000);
  const sections = classifyDailySections(`${raw.title || ""} ${raw.summary || ""}`, {
    sourceId: raw.existing_source_id || source.id,
    kind: raw.kind,
  });
  const age = raw.kind === "github-project" ? 0 : ageHours(publishedAt, now);
  const sourceStoryKey = raw.source_story_key || stableStoryKey({ ...raw, canonical_url: url });
  const independenceGroup = raw.independence_group || source.independence_group;
  const normalizedEvent = normalizedEventIdentity({ ...raw, canonical_url: url });
  const releaseSemanticReview = raw.kind === "github-release"
    ? analyzeReleaseSemanticDelta(`${raw.title || ""} ${summaryForDiscovery}`)
    : null;
  return {
    source_id: source.id,
    existing_source_id: raw.existing_source_id || "",
    source_story_key: sourceStoryKey,
    canonical_story_key: normalizedEvent.key,
    normalized_event_identity_basis: normalizedEvent.basis,
    normalized_event_fingerprint: normalizedEvent.fingerprint,
    independence_group: independenceGroup,
    discovery_kind: raw.kind || "editorial-story",
    title: cleanText(raw.title, 500),
    canonical_url: url,
    published_at: publishedAt,
    observed_at: now.toISOString(),
    age_hours: age == null ? null : Number(age.toFixed(3)),
    within_source_window: age != null && age <= source.limits.max_age_hours,
    observed_attention: clamp01(raw.observed_attention ?? Math.max(0.1, 1 - index / Math.max(1, source.limits.max_items))),
    daily_sections: sections,
    ai_relevant: sections.length > 0 || sourceIsAiSpecific(source),
    summary_for_discovery_only: summaryForDiscovery,
    release_semantic_review: releaseSemanticReview,
    artifact_links: array(raw.artifact_links).slice(0, 16),
    primary_identity_hint: raw.primary_identity_hint || null,
    primary_verified: false,
    primary_bridge_state: "unverified-primary-required",
    primary_verification_required: true,
    requires_primary_verification: true,
    manual_review_only: true,
    queue_state: "not-a-change-candidate",
    automatic_promotion: false,
    claim_evidence_allowed: false,
    claim_evidence_delta: 0,
    notification_eligible: false,
    is_new: false,
    onboarding_baseline: false,
  };
}

export function parseRssDiscovery(source, body, { now = new Date() } = {}) {
  const document = parser.parse(body);
  const entries = document.feed
    ? array(document.feed.entry)
    : array(document.rss?.channel?.item);
  return entries.slice(0, source.limits.max_items).map((entry, index) => {
    const url = linkValue(entry.link) || cleanText(entry.id || entry.guid, 1000);
    const rawSummary = entry.summary || entry.description || entry.content || entry["content:encoded"];
    const summary = cleanText(rawSummary, 2000);
    return shapeItem(source, {
      kind: "editorial-story",
      title: cleanText(entry.title, 500),
      url,
      summary,
      artifact_links: extractBoundedPrimaryArtifactLinks(rawSummary),
      published_at: entry.published || entry.updated || entry.pubDate || entry.date,
      observed_attention: Math.max(0.1, 1 - index / Math.max(1, source.limits.max_items)),
    }, index, now);
  });
}

function numericText(value) {
  const parsed = Number(String(value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseGitHubTrending(source, body, { now = new Date() } = {}) {
  const articles = [...String(body || "").matchAll(/<article\b[^>]*\bBox-row\b[^>]*>([^]*?)<\/article>/gi)]
    .slice(0, source.limits.max_items);
  const items = [];
  for (const [index, match] of articles.entries()) {
    const html = match[1];
    const repoMatch = html.match(/<h2\b[^>]*>[^]*?<a\b[^>]*href=["']\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)["']/i);
    if (!repoMatch) continue;
    const project = repoMatch[1];
    const todayStars = numericText(html.match(/([\d,.]+)\s+stars?\s+today/i)?.[1]);
    const totalStars = numericText(html.match(/href=["'][^"']*\/stargazers["'][^>]*>([^<]+)/i)?.[1]);
    const language = cleanText(html.match(/itemprop=["']programmingLanguage["'][^>]*>([^<]+)/i)?.[1], 100);
    const description = cleanText(html.match(/<p\b[^>]*>([^]*?)<\/p>/i)?.[1], 1000);
    items.push(shapeItem(source, {
      kind: "github-project",
      project,
      title: project,
      url: `https://github.com/${project}`,
      summary: `${description} ${language}`,
      observed_attention: Math.max(
        0.1,
        0.65 * (1 - index / Math.max(1, source.limits.max_items)) + 0.35 * Math.min(1, Math.log10(todayStars + 1) / 4),
      ),
      primary_identity_hint: {
        kind: "repository-candidate",
        repository: project,
        stars_today: todayStars,
        total_stars: totalStars,
        programming_language: language,
        owner_verified: false,
      },
    }, index, now));
  }
  return items;
}

function parseHackerNewsItems(source, payload, { now = new Date() } = {}) {
  return array(payload?.items).slice(0, source.limits.max_items).filter((item) => item && item.type === "story" && !item.deleted && !item.dead).map((item, index) => {
    const points = Math.max(0, Number(item.score) || 0);
    const comments = Math.max(0, Number(item.descendants) || 0);
    return shapeItem(source, {
      kind: "community-story",
      title: item.title,
      url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
      summary: `Hacker News points ${points}; comments ${comments}`,
      published_at: Number.isFinite(Number(item.time)) ? new Date(Number(item.time) * 1000).toISOString() : "",
      observed_attention: 1 - Math.exp(-(points + 2 * comments) / 350),
      primary_identity_hint: {
        kind: "community-discussion",
        hacker_news_id: String(item.id),
        points,
        comments,
      },
    }, index, now);
  });
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

export async function atomicWriteFile(path, content, {
  writeFileImpl = writeFile,
  renameImpl = rename,
  unlinkImpl = unlink,
  suffix = `${process.pid}.${randomUUID()}`,
} = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${suffix}.tmp`);
  try {
    await writeFileImpl(temporaryPath, content, { flag: "wx" });
    await renameImpl(temporaryPath, path);
  } catch (error) {
    await unlinkImpl(temporaryPath).catch(() => {});
    throw error;
  }
}

async function writeJson(path, value, atomicWriteImpl = atomicWriteFile) {
  await atomicWriteImpl(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response-exceeds-max-bytes:${declared}>${maxBytes}`);
  if (!response.body?.getReader) {
    const body = await response.text();
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > maxBytes) throw new Error(`response-exceeds-max-bytes:${bytes}>${maxBytes}`);
    return { body, bytes };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(`response-exceeds-max-bytes:${bytes}>${maxBytes}`);
    }
    chunks.push(Buffer.from(value));
  }
  return { body: Buffer.concat(chunks).toString("utf8"), bytes };
}

function requestHeaders(cached, accept) {
  const headers = { accept, "user-agent": USER_AGENT };
  if (cached?.etag) headers["if-none-match"] = cached.etag;
  else if (cached?.last_modified) headers["if-modified-since"] = cached.last_modified;
  return headers;
}

class ProbeTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label}-timeout-after-${timeoutMs}ms`);
    this.name = "ProbeTimeoutError";
    this.transient = true;
  }
}

class HttpStatusError extends Error {
  constructor(label, status) {
    super(`${label}-http-${status}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.transient = new Set([408, 425, 429, 500, 502, 503, 504]).has(status);
  }
}

function createRequestTracker(limit) {
  return {
    limit: Math.max(0, Number(limit) || 0),
    made: 0,
    retries: 0,
    retry_delays_ms: [],
    transient_errors: [],
    consume() {
      if (this.made >= this.limit) return false;
      this.made += 1;
      return true;
    },
    remaining() {
      return Math.max(0, this.limit - this.made);
    },
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("probe-aborted");
}

async function withAbortTimeout(task, { timeoutMs, label, parentSignal } = {}) {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const timeoutError = new ProbeTimeoutError(label || "operation", timeoutMs);
  let rejectTimeout;
  const timeoutPromise = new Promise((_resolve, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
    rejectTimeout(timeoutError);
  }, Math.max(1, timeoutMs));
  const onParentAbort = () => {
    const reason = parentSignal.reason instanceof Error ? parentSignal.reason : new Error("parent-probe-aborted");
    controller.abort(reason);
    rejectTimeout(reason);
  };
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function isTransientRequestError(error) {
  if (error?.transient === true) return true;
  if (error instanceof TypeError) return true;
  return new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ]).has(error?.code) || error?.name === "FetchError";
}

function retryDelay(retryIndex, { retryBaseDelayMs, retryMaxDelayMs, retryJitterRatio, randomImpl }) {
  const exponential = Math.min(retryMaxDelayMs, retryBaseDelayMs * (2 ** retryIndex));
  const jitter = 1 + retryJitterRatio * (2 * clamp01(randomImpl()) - 1);
  return Math.max(0, Math.round(exponential * jitter));
}

async function sleepWithAbort(ms, { sleepImpl, signal }) {
  if (ms <= 0) return;
  throwIfAborted(signal);
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason instanceof Error ? signal.reason : new Error("retry-sleep-aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([sleepImpl(ms), aborted]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function requestBoundedWithRetry(url, {
  fetchImpl,
  headers,
  maxBytes,
  label,
  signal,
  requestTracker,
  requestTimeoutMs,
  maxRetries,
  retryBaseDelayMs,
  retryMaxDelayMs,
  retryJitterRatio,
  randomImpl,
  sleepImpl,
}) {
  let retryIndex = 0;
  while (true) {
    throwIfAborted(signal);
    if (!requestTracker.consume()) throw new Error(`${label}-request-budget-exhausted`);
    try {
      return await withAbortTimeout(async (requestSignal) => {
        const response = await fetchImpl(url, {
          headers,
          redirect: "follow",
          signal: requestSignal,
        });
        if (response.status !== 304 && !response.ok) throw new HttpStatusError(label, response.status);
        if (response.status === 304) return { response, body: null, bytes: 0 };
        const bounded = await readBoundedBody(response, maxBytes);
        return { response, ...bounded };
      }, { timeoutMs: requestTimeoutMs, label, parentSignal: signal });
    } catch (error) {
      throwIfAborted(signal);
      const canRetry = isTransientRequestError(error)
        && retryIndex < maxRetries
        && requestTracker.remaining() > 0;
      if (!canRetry) throw error;
      const delay = retryDelay(retryIndex, { retryBaseDelayMs, retryMaxDelayMs, retryJitterRatio, randomImpl });
      requestTracker.retries += 1;
      requestTracker.retry_delays_ms.push(delay);
      requestTracker.transient_errors.push(String(error));
      retryIndex += 1;
      await sleepWithAbort(delay, { sleepImpl, signal });
    }
  }
}

function requestDiagnostics(requestTracker) {
  return {
    requests_made: requestTracker.made,
    retries_made: requestTracker.retries,
    retry_delays_ms: [...requestTracker.retry_delays_ms],
    transient_errors: [...requestTracker.transient_errors],
  };
}

function networkContext(options = {}) {
  return {
    fetchImpl: options.fetchImpl || fetch,
    cacheDir: options.cacheDir || "work/tech-discovery-probe/cache",
    cacheTtlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    now: options.now || new Date(),
    signal: options.signal,
    requestTracker: options.requestTracker,
    requestTimeoutMs: Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    maxRetries: Math.max(0, Math.trunc(options.maxRetries ?? DEFAULT_MAX_RETRIES)),
    retryBaseDelayMs: Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS),
    retryMaxDelayMs: Math.max(0, options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS),
    retryJitterRatio: clamp01(options.retryJitterRatio ?? DEFAULT_RETRY_JITTER_RATIO),
    randomImpl: options.randomImpl || Math.random,
    sleepImpl: options.sleepImpl || ((delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs))),
    atomicWriteImpl: options.atomicWriteImpl || atomicWriteFile,
  };
}

function cacheFallback(cached, { now, cacheTtlMs, requestTracker, error }) {
  const validatedAt = cached?.validated_at || cached?.fetched_at || "";
  const cacheAgeMs = Number.isFinite(Date.parse(validatedAt)) ? now.getTime() - Date.parse(validatedAt) : Infinity;
  if (cached?.body != null && cacheAgeMs >= 0 && cacheAgeMs <= cacheTtlMs) {
    return {
      body: cached.body,
      status: "stale-cache",
      network_fresh: false,
      fresh_for_change_detection: false,
      cache_fallback_used: true,
      cache_age_hours: Number((cacheAgeMs / 3_600_000).toFixed(3)),
      ...requestDiagnostics(requestTracker),
      response_bytes: cached.network_response_bytes ?? Buffer.byteLength(cached.body, "utf8"),
      content_sha256: hash(cached.body),
      error: String(error),
    };
  }
  return {
    body: null,
    status: "failed",
    network_fresh: false,
    fresh_for_change_detection: false,
    cache_fallback_used: false,
    cache_age_hours: null,
    ...requestDiagnostics(requestTracker),
    response_bytes: 0,
    content_sha256: "",
    error: String(error),
  };
}

async function fetchBoundedDocument(source, context) {
  const normalizedContext = networkContext(context);
  const { cacheDir, cacheTtlMs, now, signal, atomicWriteImpl } = normalizedContext;
  const requestTracker = normalizedContext.requestTracker || createRequestTracker(source.limits.request_budget);
  const cachePath = join(cacheDir, `${source.id}.json`);
  const cached = await readJson(cachePath, null);
  try {
    const { response, body, bytes } = await requestBoundedWithRetry(source.endpoint, {
      ...normalizedContext,
      headers: requestHeaders(cached, "application/atom+xml, application/rss+xml, text/html;q=0.9, */*;q=0.5"),
      maxBytes: source.limits.max_bytes,
      label: source.id,
      requestTracker,
    });
    if (response.status === 304 && cached?.body != null) {
      const updated = {
        ...cached,
        validated_at: now.toISOString(),
        etag: response.headers.get("etag") || cached.etag || "",
        last_modified: response.headers.get("last-modified") || cached.last_modified || "",
      };
      throwIfAborted(signal);
      await writeJson(cachePath, updated, atomicWriteImpl);
      return {
        body: cached.body,
        status: "not-modified",
        network_fresh: true,
        fresh_for_change_detection: true,
        cache_fallback_used: false,
        cache_age_hours: 0,
        ...requestDiagnostics(requestTracker),
        response_bytes: Buffer.byteLength(cached.body, "utf8"),
        content_sha256: hash(cached.body),
        error: "",
      };
    }
    if (response.status === 304) throw new Error("not-modified-without-valid-cache");
    throwIfAborted(signal);
    await writeJson(cachePath, {
      fetched_at: now.toISOString(),
      validated_at: now.toISOString(),
      etag: response.headers.get("etag") || "",
      last_modified: response.headers.get("last-modified") || "",
      content_type: response.headers.get("content-type") || "",
      network_response_bytes: bytes,
      body,
    }, atomicWriteImpl);
    return {
      body,
      status: "fresh",
      network_fresh: true,
      fresh_for_change_detection: true,
      cache_fallback_used: false,
      cache_age_hours: 0,
      ...requestDiagnostics(requestTracker),
      response_bytes: bytes,
      content_sha256: hash(body),
      error: "",
    };
  } catch (error) {
    throwIfAborted(signal);
    return cacheFallback(cached, { now, cacheTtlMs, requestTracker, error });
  }
}

export async function fetchHackerNews(source, options) {
  const context = networkContext(options);
  const { cacheDir, cacheTtlMs, now, signal, atomicWriteImpl } = context;
  const requestTracker = context.requestTracker || createRequestTracker(source.limits.request_budget);
  const cachePath = join(cacheDir, `${source.id}.json`);
  const cached = await readJson(cachePath, null);
  let responseBytes = 0;
  try {
    const topResponse = await requestBoundedWithRetry(source.endpoint, {
      ...context,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      maxBytes: source.limits.max_bytes,
      label: `${source.id}-topstories`,
      requestTracker,
    });
    const topBody = { body: topResponse.body, bytes: topResponse.bytes };
    responseBytes += topBody.bytes;
    const ids = array(JSON.parse(topBody.body))
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .slice(0, Math.min(source.limits.max_items, source.limits.request_budget - 1));
    const items = [];
    for (const id of ids) {
      if (requestTracker.remaining() <= 0) break;
      const remainingBytes = source.limits.max_bytes - responseBytes;
      if (remainingBytes <= 0) throw new Error("hacker-news-response-budget-exhausted");
      const itemResponse = await requestBoundedWithRetry(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
        ...context,
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        maxBytes: remainingBytes,
        label: `${source.id}-item-${id}`,
        requestTracker,
      });
      const itemBody = { body: itemResponse.body, bytes: itemResponse.bytes };
      responseBytes += itemBody.bytes;
      items.push(JSON.parse(itemBody.body));
    }
    const body = JSON.stringify({ top_story_ids: ids, items });
    throwIfAborted(signal);
    await writeJson(cachePath, {
      fetched_at: now.toISOString(),
      validated_at: now.toISOString(),
      content_type: "application/json",
      network_response_bytes: responseBytes,
      body,
    }, atomicWriteImpl);
    return {
      body,
      status: "fresh",
      network_fresh: true,
      fresh_for_change_detection: true,
      cache_fallback_used: false,
      cache_age_hours: 0,
      ...requestDiagnostics(requestTracker),
      response_bytes: responseBytes,
      content_sha256: hash(body),
      error: "",
    };
  } catch (error) {
    throwIfAborted(signal);
    return cacheFallback(cached, { now, cacheTtlMs, requestTracker, error });
  }
}

function githubHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

export async function fetchGitHubReleaseBundle(source, options) {
  const context = networkContext(options);
  const { cacheDir, cacheTtlMs, now, signal, atomicWriteImpl } = context;
  const requestTracker = context.requestTracker || createRequestTracker(source.limits.request_budget);
  const cachePath = join(cacheDir, `${source.id}.json`);
  const cached = await readJson(cachePath, null);
  const releases = [];
  const endpointErrors = [];
  let responseBytes = 0;
  for (const endpoint of array(source.endpoints)) {
    try {
      const response = await requestBoundedWithRetry(endpoint, {
        ...context,
        headers: githubHeaders(),
        maxBytes: Math.max(1, source.limits.max_bytes - responseBytes),
        label: `${source.id}-${hash(endpoint).slice(0, 10)}`,
        requestTracker,
      });
      responseBytes += response.bytes;
      const repository = githubRepositoryFromApi(endpoint);
      const owner = repository.split("/")[0] || repository;
      for (const release of array(JSON.parse(response.body)).filter((item) => !item?.draft && !item?.prerelease)) {
        const bodyExcerpt = cleanText(release.body, 1000);
        releases.push({
          kind: "github-release",
          existing_source_id: `direct:${repository.toLowerCase()}`,
          release_identity: `${repository}@${release.id || release.tag_name}`,
          source_story_key: `github-release:${repository}@${release.id || release.tag_name}`,
          independence_group: `github-owner:${owner.toLowerCase()}`,
          title: `${repository} ${cleanText(release.name || release.tag_name || release.id, 200)}`,
          url: release.html_url || (release.tag_name ? `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}` : ""),
          published_at: release.published_at || release.created_at,
          summary: bodyExcerpt,
          observed_attention: 0.65,
          primary_identity_hint: {
            kind: "git-release-or-commit-sha",
            repository,
            release_id: String(release.id || ""),
            tag_name: release.tag_name || "",
            body_sha256: hash(String(release.body || "")),
            body_excerpt_sha256: hash(bodyExcerpt),
            target_commitish: release.target_commitish || "",
            immutable: release.immutable === true,
          },
        });
      }
    } catch (error) {
      endpointErrors.push(`${endpoint}:${String(error)}`);
    }
  }
  if (!releases.length) return cacheFallback(cached, {
    now,
    cacheTtlMs,
    requestTracker,
    error: new Error(endpointErrors.join("; ") || "GitHub release bundle returned no releases"),
  });
  releases.sort((left, right) => String(right.published_at || "").localeCompare(String(left.published_at || "")));
  releases.splice(source.limits.max_items);
  const body = JSON.stringify(releases);
  throwIfAborted(signal);
  await writeJson(cachePath, {
    fetched_at: now.toISOString(),
    validated_at: now.toISOString(),
    content_type: "application/json",
    network_response_bytes: responseBytes,
    body,
  }, atomicWriteImpl);
  return {
    body,
    status: "fresh",
    network_fresh: true,
    fresh_for_change_detection: true,
    cache_fallback_used: false,
    cache_age_hours: 0,
    ...requestDiagnostics(requestTracker),
    transient_errors: [...requestTracker.transient_errors, ...endpointErrors],
    response_bytes: responseBytes,
    content_sha256: hash(body),
    error: endpointErrors.join("; "),
  };
}

function githubRepositoryFromApi(value) {
  return String(value || "").match(/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases/i)?.[1] || "";
}

function existingSnapshotFresh(candidateAudit, event, now, cacheTtlMs) {
  const generatedAt = candidateAudit?.generated_at || "";
  const age = Number.isFinite(Date.parse(generatedAt)) ? now.getTime() - Date.parse(generatedAt) : Infinity;
  return age >= 0
    && age <= cacheTtlMs
    && NETWORK_VERIFIED_STATUSES.has(event?.status)
    && event?.network_verified !== false;
}

export function reuseCandidateSnapshots(source, candidateAudit, { now = new Date(), cacheTtlMs = DEFAULT_CACHE_TTL_MS } = {}) {
  const events = new Map(array(candidateAudit?.source_events).map((event) => [event.source_id, event]));
  const definitions = new Map(array(candidateAudit?.source_registry).map((candidate) => [candidate.id, candidate]));
  const missing = source.existing_source_ids.filter((id) => !events.has(id));
  const stale = source.existing_source_ids.filter((id) => events.has(id) && !existingSnapshotFresh(candidateAudit, events.get(id), now, cacheTtlMs));
  if (missing.length || stale.length) {
    return {
      body: null,
      items: [],
      status: missing.length ? "missing-existing-snapshot" : "stale-existing-snapshot",
      network_fresh: false,
      upstream_snapshot_network_verified: false,
      fresh_for_change_detection: false,
      cache_fallback_used: false,
      cache_age_hours: Number.isFinite(Date.parse(candidateAudit?.generated_at || ""))
        ? Number(((now.getTime() - Date.parse(candidateAudit.generated_at)) / 3_600_000).toFixed(3))
        : null,
      requests_made: 0,
      response_bytes: 0,
      content_sha256: "",
      error: [...missing.map((id) => `missing:${id}`), ...stale.map((id) => `stale:${id}`)].join(","),
    };
  }

  const rawItems = [];
  if (source.format === "existing-shadow-snapshot") {
    for (const existingSourceId of source.existing_source_ids) {
      const event = events.get(existingSourceId);
      for (const item of array(event?.snapshot?.items)) {
        rawItems.push({
          kind: "editorial-story",
          existing_source_id: event.source_id,
          title: item.title,
          url: item.url,
          published_at: item.published_at,
          artifact_links: item.artifact_links,
          summary: array(item.artifact_links).map((link) => link.link_context).join(" "),
        });
      }
    }
    rawItems.splice(source.limits.max_items);
    rawItems.forEach((item, index) => {
      item.observed_attention = Math.max(0.1, 1 - index / Math.max(1, source.limits.max_items));
    });
  } else {
    for (const existingSourceId of source.existing_source_ids) {
      const event = events.get(existingSourceId);
      const definition = definitions.get(existingSourceId);
      const repository = githubRepositoryFromApi(definition?.url);
      const owner = repository.split("/")[0] || existingSourceId;
      for (const release of array(event?.snapshot?.releases).filter((item) => !item.prerelease && !item.draft)) {
        const identity = `${repository || existingSourceId}@${release.id || release.tag_name}`;
        // Candidate snapshots already bind and bound this excerpt. Preserve the
        // exact normalized string so a downstream HTML/entity pass cannot
        // silently change the evidence identity.
        const bodyExcerpt = String(release.body_excerpt || "").slice(0, 1000);
        rawItems.push({
          kind: "github-release",
          existing_source_id: existingSourceId,
          release_identity: identity,
          source_story_key: `github-release:${identity}`,
          independence_group: `github-owner:${owner.toLowerCase()}`,
          title: `${repository || existingSourceId} ${release.title || release.name || release.tag_name || release.id}`,
          url: repository && release.tag_name
            ? `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}`
            : definition?.canonical_url || definition?.url || source.canonical_url,
          published_at: release.published_at || release.created_at,
          summary: bodyExcerpt,
          observed_attention: 0.65,
          primary_identity_hint: {
            kind: "git-release-or-commit-sha",
            repository,
            release_id: String(release.id || ""),
            tag_name: release.tag_name || "",
            body_sha256: release.body_sha256 || "",
            body_excerpt_sha256: release.body_excerpt_sha256 || hash(bodyExcerpt),
            target_commitish: release.target_commitish || "",
            immutable: release.immutable === true,
          },
        });
      }
    }
    rawItems.sort((left, right) => String(right.published_at || "").localeCompare(String(left.published_at || "")));
    rawItems.splice(source.limits.max_items);
  }
  const body = JSON.stringify(rawItems);
  return {
    body,
    items: rawItems.map((item, index) => shapeItem(source, item, index, now)),
    status: REUSED_VERIFIED_STATUS,
    network_fresh: false,
    upstream_snapshot_network_verified: true,
    fresh_for_change_detection: true,
    cache_fallback_used: false,
    cache_age_hours: Number(((now.getTime() - Date.parse(candidateAudit.generated_at)) / 3_600_000).toFixed(3)),
    requests_made: 0,
    response_bytes: 0,
    content_sha256: hash(body),
    error: "",
  };
}

function finalizeSourceEvent(source, collection, previousEvent) {
  const previousSeen = new Set(array(previousEvent?.snapshot?.seen_story_keys));
  const onboardingComplete = previousEvent?.snapshot?.onboarding_complete === true;
  const freshForChangeDetection = collection.fresh_for_change_detection === true;
  const editorialCacheUsable = collection.status === "stale-cache"
    && collection.cache_fallback_used === true
    && Number.isFinite(collection.cache_age_hours)
    && collection.cache_age_hours >= 0
    && collection.cache_age_hours <= RETAINED_EDITORIAL_CACHE_MAX_AGE_HOURS;
  const onboardingBaseline = freshForChangeDetection && !onboardingComplete;
  const onboardingPending = !freshForChangeDetection && !onboardingComplete;
  const seen = new Set(previousSeen);
  const currentKeys = [];
  const items = array(collection.items).map((item) => {
    currentKeys.push(item.source_story_key);
    const eligible = freshForChangeDetection
      && onboardingComplete
      && !previousSeen.has(item.source_story_key)
      && item.within_source_window
      && item.ai_relevant
      && item.daily_sections.length > 0;
    if (freshForChangeDetection) seen.add(item.source_story_key);
    return {
      ...item,
      is_new: eligible,
      onboarding_baseline: onboardingBaseline,
      queue_state: eligible ? "pending-human-primary-verification" : onboardingBaseline
        ? "onboarding-baseline-not-news"
        : collection.status === "stale-cache"
          ? "stale-cache-not-fresh"
          : "not-a-change-candidate",
    };
  });
  const queueCandidates = items.filter((item) => item.is_new);
  const observationState = onboardingBaseline
    ? "onboarding-baseline"
    : onboardingPending
      ? "onboarding-pending"
      : collection.status === "stale-cache"
        ? "stale-cache"
        : !freshForChangeDetection
          ? "blocked"
          : queueCandidates.length
            ? "new-discovery-candidates"
            : "unchanged";
  return {
    source_id: source.id,
    fetch_mode: source.fetch_mode,
    status: collection.status,
    observation_state: observationState,
    network_fresh: collection.network_fresh === true,
    upstream_snapshot_network_verified: collection.upstream_snapshot_network_verified === true,
    fresh_for_change_detection: freshForChangeDetection,
    editorial_cache_usable: editorialCacheUsable,
    cache_fallback_used: collection.cache_fallback_used === true,
    cache_age_hours: collection.cache_age_hours ?? null,
    requests_made: collection.requests_made || 0,
    retries_made: collection.retries_made || 0,
    retry_delays_ms: array(collection.retry_delays_ms),
    transient_errors: array(collection.transient_errors),
    request_budget: source.limits.request_budget,
    response_bytes: collection.response_bytes || 0,
    max_bytes: source.limits.max_bytes,
    content_sha256: collection.content_sha256 || "",
    error: collection.error || "",
    onboarding_baseline: onboardingBaseline,
    onboarding_pending: onboardingPending,
    items_parsed: items.length,
    ai_items: items.filter((item) => item.ai_relevant && item.daily_sections.length > 0).length,
    new_items: queueCandidates.length,
    queue_candidates: queueCandidates,
    items,
    semantic_blockers: freshForChangeDetection ? [] : [collection.status],
    warnings: collection.status === "stale-cache" ? [
      "ttl-cache-fallback-is-not-fresh-and-cannot-create-change-candidates",
      ...(editorialCacheUsable ? ["bounded-cache-may-retain-current-window-editorial-review-only"] : []),
    ] : [],
    snapshot: {
      onboarding_complete: onboardingComplete || onboardingBaseline,
      current_story_keys: currentKeys,
      seen_story_keys: [...seen].sort(),
    },
  };
}

function scoreQueueItem(item) {
  const base = scoreTechDiscoverySignal({
    sourceId: item.source_id,
    observedAttention: item.observed_attention,
    ageHours: item.age_hours || 0,
  });
  return {
    ...base,
    independence_group: item.independence_group,
  };
}

export function selectHumanReviewQueue(sourceEvents, { limit = TECH_DISCOVERY_POLICY.max_selected_signals } = {}) {
  const candidates = sourceEvents.flatMap((event) => event.queue_candidates).map((item) => ({
    ...item,
    queue_score: scoreQueueItem(item),
  })).filter((item) => item.queue_score.eligible_for_review_queue)
    .sort((left, right) => right.queue_score.queue_priority - left.queue_score.queue_priority
      || left.source_id.localeCompare(right.source_id)
      || left.source_story_key.localeCompare(right.source_story_key));
  const selected = [];
  const usedGroups = new Set();
  const usedStories = new Set();
  for (const item of candidates) {
    if (usedGroups.has(item.independence_group) || usedStories.has(item.canonical_story_key)) continue;
    usedGroups.add(item.independence_group);
    usedStories.add(item.canonical_story_key);
    selected.push({ ...item, queue_rank: selected.length + 1 });
    if (selected.length >= limit) break;
  }
  return selected;
}

const DAILY_REPRESENTATIVE_BASIS_PRIORITY = Object.freeze({
  "canonical-official-announcement": 4,
  "artifact-official-announcement": 3,
  "primary-identity-hint": 2,
  "canonical-primary-url": 2,
  "primary-artifact-link": 1,
});

function dailyCurrentWindowCandidates(sourceEvents) {
  return sourceEvents.flatMap((event) => {
    if (event.fresh_for_change_detection !== true && event.editorial_cache_usable !== true) return [];
    return array(event.items).filter((item) => (
      item.within_source_window
      && item.age_hours <= DAILY_EDITORIAL_MAX_AGE_HOURS
      && item.ai_relevant
      && array(item.daily_sections).length > 0
    )).map((item) => ({
      ...item,
      daily_snapshot_state: event.editorial_cache_usable
        ? "retained-network-verified-cache"
        : "current-verified-snapshot",
      daily_attention_score: scoreQueueItem(item),
    }));
  }).filter((item) => item.daily_attention_score.eligible_for_review_queue);
}

function immutableEditorialIdentity(item) {
  if (["canonical-official-announcement", "artifact-official-announcement"].includes(item.normalized_event_identity_basis)) return true;
  return primaryIdentityStrength(item.normalized_event_fingerprint) >= 4;
}

function editorialBridgeDecision(records) {
  const independenceGroups = [...new Set(records.map((item) => item.independence_group))].sort();
  const editorialIdentityReady = records.some((item) => immutableEditorialIdentity(item));
  const multiSourceAttentionReady = independenceGroups.length >= 2;
  const containsRelease = records.some((item) => item.discovery_kind === "github-release");
  const releaseSemanticDeltaReady = records.some((item) => (
    item.discovery_kind === "github-release"
      && item.release_semantic_review?.has_semantic_delta_cue === true
  ));
  if (containsRelease && !releaseSemanticDeltaReady && !multiSourceAttentionReady) {
    return {
      eligible: false,
      reason: "release-without-semantic-delta",
      editorialIdentityReady,
      multiSourceAttentionReady,
      releaseSemanticDeltaReady,
      independenceGroups,
    };
  }
  if (editorialIdentityReady || multiSourceAttentionReady) {
    return { eligible: true, reason: "bridge-ready", editorialIdentityReady, multiSourceAttentionReady, releaseSemanticDeltaReady, independenceGroups };
  }
  const identities = records.map((item) => String(item.normalized_event_fingerprint || ""));
  const bases = records.map((item) => item.normalized_event_identity_basis);
  const reason = identities.some((identity) => /^git-repository:/i.test(identity))
    ? "single-source-bare-repository"
    : identities.some((identity) => /^huggingface:/i.test(identity) && !/@[^@]+$/i.test(identity))
      ? "single-source-unversioned-huggingface"
      : bases.every((basis) => ["normalized-title", "canonical-url-fallback"].includes(basis))
        ? "single-source-title-or-url-only"
        : "single-source-unverified-primary-identity";
  return { eligible: false, reason, editorialIdentityReady, multiSourceAttentionReady, releaseSemanticDeltaReady, independenceGroups };
}

function groupDailyCurrentWindowCandidates(sourceEvents) {
  const groups = new Map();
  for (const item of dailyCurrentWindowCandidates(sourceEvents)) {
    const records = groups.get(item.canonical_story_key) || [];
    records.push(item);
    groups.set(item.canonical_story_key, records);
  }
  return groups;
}

function dailyEditorialExclusions(sourceEvents) {
  return [...groupDailyCurrentWindowCandidates(sourceEvents).entries()].flatMap(([canonicalStoryKey, records]) => {
    const decision = editorialBridgeDecision(records);
    if (decision.eligible) return [];
    const representative = [...records].sort((left, right) => (
      right.daily_attention_score.queue_priority - left.daily_attention_score.queue_priority
      || left.source_id.localeCompare(right.source_id)
    ))[0];
    return [{
      canonical_story_key: canonicalStoryKey,
      title: representative.title,
      canonical_url: representative.canonical_url,
      daily_sections: DAILY_SECTIONS.filter((section) => records.some((item) => item.daily_sections.includes(section))),
      source_ids: [...new Set(records.map((item) => item.source_id))].sort(),
      independence_groups: decision.independenceGroups,
      exclusion_reason: decision.reason,
      review_priority: Math.max(...records.map((item) => item.daily_attention_score.queue_priority)),
      manual_review_only: true,
      claim_evidence_allowed: false,
      notification_eligible: false,
    }];
  }).sort((left, right) => right.review_priority - left.review_priority || left.canonical_story_key.localeCompare(right.canonical_story_key));
}

/**
 * Current-window editorial attention lane. Unlike the change queue, this lane
 * intentionally includes onboarding and already-seen records while they remain
 * inside the source window. It is still manual-only and cannot notify, promote,
 * or satisfy a claim.
 */
export function selectDailyCurrentWindowReview(sourceEvents, { limit = TECH_DISCOVERY_POLICY.max_selected_signals } = {}) {
  const groups = groupDailyCurrentWindowCandidates(sourceEvents);

  const stories = [...groups.values()].map((records) => {
    const ranked = [...records].sort((left, right) => (
      (DAILY_REPRESENTATIVE_BASIS_PRIORITY[right.normalized_event_identity_basis] || 0)
        - (DAILY_REPRESENTATIVE_BASIS_PRIORITY[left.normalized_event_identity_basis] || 0)
      || right.daily_attention_score.queue_priority - left.daily_attention_score.queue_priority
      || left.source_id.localeCompare(right.source_id)
    ));
    const representative = ranked[0];
    const bridge = editorialBridgeDecision(records);
    const independenceGroups = bridge.independenceGroups;
    const sections = DAILY_SECTIONS.filter((section) => records.some((item) => item.daily_sections.includes(section)));
    const attentionPriority = Math.max(...records.map((item) => item.daily_attention_score.queue_priority));
    const coverageBonus = Math.min(10, Math.max(0, independenceGroups.length - 1) * 5);
    return {
      ...representative,
      daily_sections: sections,
      daily_review_state: "current-window-manual-review",
      daily_review_score: {
        score_purpose: "daily-current-window-editorial-attention-only",
        attention_priority: attentionPriority,
        independent_attention_groups: independenceGroups.length,
        independent_coverage_bonus: coverageBonus,
        review_priority: Math.round((attentionPriority + coverageBonus) * 10) / 10,
        claim_evidence_delta: 0,
        notification_eligible: false,
      },
      source_records: records.map((item) => ({
        source_id: item.source_id,
        source_story_key: item.source_story_key,
        independence_group: item.independence_group,
        title: item.title,
        canonical_url: item.canonical_url,
        published_at: item.published_at,
        normalized_event_identity_basis: item.normalized_event_identity_basis,
        normalized_event_fingerprint: item.normalized_event_fingerprint,
        daily_snapshot_state: item.daily_snapshot_state,
        attention_priority: item.daily_attention_score.queue_priority,
      })).sort((left, right) => right.attention_priority - left.attention_priority || left.source_id.localeCompare(right.source_id)),
      independence_groups: independenceGroups,
      independent_attention_groups: independenceGroups.length,
      editorial_identity_ready: bridge.editorialIdentityReady,
      multi_source_attention_ready: bridge.multiSourceAttentionReady,
      release_semantic_delta_ready: bridge.releaseSemanticDeltaReady,
      daily_snapshot_state: records.some((item) => item.daily_snapshot_state === "retained-network-verified-cache")
        ? "contains-retained-network-verified-cache"
        : "current-verified-snapshots-only",
      editorial_bridge_eligible: bridge.eligible,
      change_candidate: records.some((item) => item.is_new),
      onboarding_observed: records.some((item) => item.onboarding_baseline),
      manual_review_only: true,
      automatic_promotion: false,
      claim_evidence_allowed: false,
      claim_evidence_delta: 0,
      notification_eligible: false,
      primary_verified: false,
      primary_verification_required: true,
      requires_primary_verification: true,
      primary_bridge_state: "unverified-primary-required",
    };
  }).filter((story) => story.editorial_bridge_eligible)
    .sort((left, right) => (
    right.daily_review_score.review_priority - left.daily_review_score.review_priority
    || right.independent_attention_groups - left.independent_attention_groups
    || left.canonical_story_key.localeCompare(right.canonical_story_key)
  ));

  return stories.slice(0, limit).map((story, index) => ({ ...story, daily_review_rank: index + 1 }));
}

export function createTechDiscoveryAudit({ now = new Date(), sources = techDiscoverySources, sourceEvents = [], previousAudit = null } = {}) {
  const reconciledSourceEvents = reconcileCrossSourceIdentities(sourceEvents);
  const selected = selectHumanReviewQueue(reconciledSourceEvents);
  const dailyCandidates = dailyCurrentWindowCandidates(reconciledSourceEvents);
  const dailyCurrentWindowCandidatesCount = dailyCandidates.length;
  const dailyCurrentWindowStoryGroups = new Set(dailyCandidates.map((item) => item.canonical_story_key)).size;
  const dailyEditorialBridgeReadyStoryGroups = selectDailyCurrentWindowReview(reconciledSourceEvents, { limit: Number.MAX_SAFE_INTEGER }).length;
  const dailyCurrentWindowReview = selectDailyCurrentWindowReview(reconciledSourceEvents);
  const editorialExclusions = dailyEditorialExclusions(reconciledSourceEvents);
  const today = localDateKey(now);
  const previousHistory = new Map(array(previousAudit?.source_history).map((entry) => [entry.source_id, entry]));
  const sourceHistory = sources.map((source) => {
    const event = reconciledSourceEvents.find((candidate) => candidate.source_id === source.id);
    const priorDates = array(previousHistory.get(source.id)?.observed_fresh_dates);
    const dates = event?.fresh_for_change_detection ? [...new Set([...priorDates, today])].sort() : priorDates;
    const consecutive = consecutiveDayCount(dates);
    return {
      source_id: source.id,
      observed_fresh_dates: dates,
      consecutive_fresh_days: consecutive,
      criteria: {
        minimum_silent_days: { required: MINIMUM_OBSERVATION_DAYS, observed: consecutive, passed: consecutive >= MINIMUM_OBSERVATION_DAYS },
        human_source_review: { required: true, observed: false, passed: false },
      },
      ready_for_human_source_review: consecutive >= MINIMUM_OBSERVATION_DAYS,
      automatically_promoted: false,
    };
  });
  const blocked = reconciledSourceEvents.filter((event) => !event.fresh_for_change_detection).length;
  return {
    schema_version: 2,
    generated_at: now.toISOString(),
    mode: "shadow-tech-discovery-probe",
    scope: "technology-community-attention-only",
    status: blocked ? "degraded" : "ok",
    isolation_policy: {
      changes_production_ranking: false,
      writes_production_state: false,
      affects_production_source_health: false,
      satisfies_claim_requirements: false,
      raises_evidence_grade: false,
      automatic_promotions: [],
    },
    dependency_policy: {
      credentials_required: false,
      github_token_required: false,
      google_login_required: false,
      gemini_required: false,
      openai_membership_required: false,
      cloudflare_credentials_required: false,
    },
    cache_policy: {
      stale_fallback_allowed: true,
      stale_fallback_counts_as_fresh: false,
      stale_fallback_can_create_candidates: false,
      stale_fallback_can_retain_current_window_editorial: true,
      retained_editorial_max_age_hours: RETAINED_EDITORIAL_CACHE_MAX_AGE_HOURS,
      ttl_hours: DEFAULT_CACHE_TTL_MS / 3_600_000,
    },
    network_execution_policy: {
      per_request_abort_signal: true,
      transient_errors_only_retried: true,
      request_attempts_include_retries: true,
      retries_consume_source_request_budget: true,
      exponential_backoff: true,
      bounded_jitter: true,
      source_deadline_enforced: true,
      run_deadline_enforced: true,
    },
    notification_policy: {
      enabled: false,
      eligible: false,
      records: [],
      external_actions: [],
    },
    external_actions: [],
    daily_section_taxonomy: DAILY_SECTIONS,
    metrics: {
      registered_sources: sources.length,
      fresh_for_change_detection: reconciledSourceEvents.filter((event) => event.fresh_for_change_detection).length,
      own_network_fresh_sources: reconciledSourceEvents.filter((event) => event.network_fresh).length,
      reused_snapshot_sources: reconciledSourceEvents.filter((event) => event.upstream_snapshot_network_verified).length,
      onboarding_baselines: reconciledSourceEvents.filter((event) => event.onboarding_baseline).length,
      blocked_sources: blocked,
      daily_current_window_candidates: dailyCurrentWindowCandidatesCount,
      daily_current_window_story_groups: dailyCurrentWindowStoryGroups,
      daily_editorial_bridge_ready_story_groups: dailyEditorialBridgeReadyStoryGroups,
      daily_editorial_excluded_story_groups: editorialExclusions.length,
      daily_current_window_selected: dailyCurrentWindowReview.length,
      new_discovery_candidates: reconciledSourceEvents.reduce((total, event) => total + event.queue_candidates.length, 0),
      selected_for_human_review: selected.length,
      notification_eligible_records: 0,
    },
    source_registry: sources.map((source) => ({ ...source })),
    source_events: reconciledSourceEvents,
    source_history: sourceHistory,
    daily_current_window_review: dailyCurrentWindowReview,
    daily_editorial_exclusions: editorialExclusions,
    human_review_queue: selected,
  };
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function renderTechDiscoveryReview(audit) {
  const lines = [
    `# 科技热点 Shadow Probe · ${localDateKey(audit.generated_at)}`,
    "",
    "> 这里只排人工一手核验优先级；不写生产状态、不提高证据等级、不通知或发布。",
    "",
    `- 状态：\`${audit.status}\`；来源：${audit.metrics.registered_sources}`,
    `- 首次接入 baseline：${audit.metrics.onboarding_baselines}；当日编辑候选：${audit.metrics.daily_current_window_selected}/5；桥接不足：${audit.metrics.daily_editorial_excluded_story_groups}；变更队列：${audit.metrics.selected_for_human_review}/5`,
    `- 通知资格：否；外部动作：${audit.external_actions.length}`,
    "",
    "## 当日窗口人工编辑候选（不会通知）",
    "",
    "| # | 栏目 | 代表项 | 独立关注组 | 是否新变更 | 一手核验 |",
    "|---:|---|---|---:|---|---|",
  ];
  for (const item of audit.daily_current_window_review) {
    lines.push(`| ${item.daily_review_rank} | ${markdownCell(item.daily_sections.join(", "))} | [${markdownCell(item.title)}](${item.canonical_url}) | ${item.independent_attention_groups} | ${item.change_candidate ? "是" : "否"} | 必须 |`);
  }
  if (!audit.daily_current_window_review.length) lines.push("| - | - | 当前窗口无合格发现项 | - | - | - |");
  lines.push(
    "",
    "## 未进入编辑候选的注意力故事",
    "",
    "| 原因 | 栏目 | 来源 | 条目 |",
    "|---|---|---|---|",
  );
  for (const item of audit.daily_editorial_exclusions) {
    lines.push(`| ${markdownCell(item.exclusion_reason)} | ${markdownCell(item.daily_sections.join(", "))} | ${markdownCell(item.source_ids.join(", "))} | [${markdownCell(item.title)}](${item.canonical_url}) |`);
  }
  if (!audit.daily_editorial_exclusions.length) lines.push("| - | - | - | 当前没有被编辑桥接门槛排除的窗口内故事 |");
  lines.push(
    "",
    "## 自上次运行以来的新发现（不会通知）",
    "",
    "| # | 栏目 | 来源 | 发现项 | 独立组 | 一手核验 |",
    "|---:|---|---|---|---|---|",
  );
  for (const item of audit.human_review_queue) {
    lines.push(`| ${item.queue_rank} | ${markdownCell(item.daily_sections.join(", "))} | ${markdownCell(item.source_id)} | [${markdownCell(item.title)}](${item.canonical_url}) | ${markdownCell(item.independence_group)} | 必须 |`);
  }
  if (!audit.human_review_queue.length) lines.push("| - | - | - | 当前无非 baseline 的新发现 | - | - |");
  lines.push(
    "",
    "## 复核边界",
    "",
    "- GitHub Trending 新仓库只进入人工队列；仓库热度不证明发布、官方归属或研究结论。",
    "- HN、媒体和 Latent Space 的标题/摘要不能直接写成日报事实，必须回链版本化一手身份。",
    "- 24 小时内的 network-verified stale-cache 只能保留仍在 48 小时窗口内的编辑候选；不计 fresh、不产生 change candidate，并显式标为 retained cache。",
    "- 即使连续静默七天通过，也仍需人工来源审查，不会自动晋级。",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function collectNetworkSource(source, context) {
  const fetched = source.id === "hacker-news-topstories"
    ? await fetchHackerNews(source, context)
    : source.format === "github-release-bundle"
      ? await fetchGitHubReleaseBundle(source, context)
    : await fetchBoundedDocument(source, context);
  if (!fetched.body) return { ...fetched, items: [] };
  try {
    const items = source.id === "github-trending-daily"
      ? parseGitHubTrending(source, fetched.body, context)
      : source.id === "hacker-news-topstories"
        ? parseHackerNewsItems(source, JSON.parse(fetched.body), context)
        : source.format === "github-release-bundle"
          ? array(JSON.parse(fetched.body)).map((item, index) => shapeItem(source, item, index, context.now))
        : parseRssDiscovery(source, fetched.body, context);
    return { ...fetched, items };
  } catch (error) {
    return {
      ...fetched,
      status: "parse-failed",
      fresh_for_change_detection: false,
      items: [],
      error: String(error),
    };
  }
}

function blockedCollection(status, error, requestTracker = createRequestTracker(0)) {
  return {
    body: null,
    items: [],
    status,
    network_fresh: false,
    upstream_snapshot_network_verified: false,
    fresh_for_change_detection: false,
    cache_fallback_used: false,
    cache_age_hours: null,
    ...requestDiagnostics(requestTracker),
    response_bytes: 0,
    content_sha256: "",
    error: String(error || status),
  };
}

export async function runTechDiscoveryProbe({
  sources = techDiscoverySources,
  outputPath = process.env.TECH_DISCOVERY_OUTPUT_PATH || "work/tech-discovery-probe/audit.json",
  statePath = process.env.TECH_DISCOVERY_STATE_PATH || "work/tech-discovery-probe/audit.json",
  cacheDir = process.env.TECH_DISCOVERY_CACHE_DIR || "work/tech-discovery-probe/cache",
  reviewPath = process.env.TECH_DISCOVERY_REVIEW_PATH || "work/tech-discovery-probe/review.md",
  candidateAuditPath = process.env.CANDIDATE_PROBE_OUTPUT_PATH || "work/candidate-source-probe/audit.json",
  now = new Date(),
  fetchImpl = fetch,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sourceTimeoutMs = DEFAULT_SOURCE_TIMEOUT_MS,
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
  retryJitterRatio = DEFAULT_RETRY_JITTER_RATIO,
  randomImpl = Math.random,
  sleepImpl = (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
  atomicWriteImpl = atomicWriteFile,
  deferStateCommit = process.env.TECH_DISCOVERY_DEFER_STATE_COMMIT === "1",
} = {}) {
  const previousAudit = await readJson(statePath, null);
  const previousEvents = new Map(array(previousAudit?.source_events).map((event) => [event.source_id, event]));
  const candidateAudit = await readJson(candidateAuditPath, null);
  const sourceEvents = [];
  const runStartedAt = Date.now();
  for (const source of sources) {
    const requestTracker = createRequestTracker(source.limits.request_budget);
    const remainingRunMs = runTimeoutMs - (Date.now() - runStartedAt);
    let collection;
    if (remainingRunMs <= 0) {
      collection = blockedCollection("run-timeout", new ProbeTimeoutError("tech-discovery-run", runTimeoutMs), requestTracker);
    } else {
      const boundedSourceTimeoutMs = Math.max(1, Math.min(sourceTimeoutMs, remainingRunMs));
      const context = networkContext({
        fetchImpl,
        cacheDir,
        cacheTtlMs,
        now,
        requestTracker,
        requestTimeoutMs,
        maxRetries,
        retryBaseDelayMs,
        retryMaxDelayMs,
        retryJitterRatio,
        randomImpl,
        sleepImpl,
        atomicWriteImpl,
      });
      try {
        collection = await withAbortTimeout(async (sourceSignal) => {
          context.signal = sourceSignal;
          return source.fetch_mode.startsWith("reference-existing")
            ? reuseCandidateSnapshots(source, candidateAudit, { now, cacheTtlMs })
            : collectNetworkSource(source, context);
        }, {
          timeoutMs: boundedSourceTimeoutMs,
          label: `${source.id}-source`,
        });
      } catch (error) {
        collection = blockedCollection(error instanceof ProbeTimeoutError ? "source-timeout" : "failed", error, requestTracker);
      }
    }
    sourceEvents.push(finalizeSourceEvent(source, collection, previousEvents.get(source.id)));
  }
  const audit = createTechDiscoveryAudit({ now, sources, sourceEvents, previousAudit });
  audit.cache_policy.ttl_hours = cacheTtlMs / 3_600_000;
  audit.network_execution_policy = {
    ...audit.network_execution_policy,
    request_timeout_ms: requestTimeoutMs,
    source_timeout_ms: sourceTimeoutMs,
    run_timeout_ms: runTimeoutMs,
    max_retries_per_request: maxRetries,
    retry_base_delay_ms: retryBaseDelayMs,
    retry_max_delay_ms: retryMaxDelayMs,
    retry_jitter_ratio: retryJitterRatio,
  };
  const serializedAudit = `${JSON.stringify(audit, null, 2)}\n`;
  const auditTargets = [...new Set([
    resolve(outputPath),
    ...(deferStateCommit ? [] : [resolve(statePath)]),
  ])];
  for (const target of auditTargets) await atomicWriteImpl(target, serializedAudit);
  await atomicWriteImpl(resolve(reviewPath), renderTechDiscoveryReview(audit));
  return audit;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  runTechDiscoveryProbe().then((audit) => {
    console.log(JSON.stringify({
      mode: audit.mode,
      status: audit.status,
      registered_sources: audit.metrics.registered_sources,
      selected_for_human_review: audit.metrics.selected_for_human_review,
      onboarding_baselines: audit.metrics.onboarding_baselines,
      notification_eligible_records: audit.metrics.notification_eligible_records,
    }));
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
