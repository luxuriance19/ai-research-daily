#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";
import {
  MODEL_COMPUTE_SHADOW_POLICY,
  modelComputeShadowSources,
  validateModelComputeShadowRegistry,
} from "./model-compute-source-registry.mjs";
import { classifyComputeRelease } from "./replay-model-compute-source-policy.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_CACHE_TTL_MS = 7 * DAY_MS;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SOURCE_TIMEOUT_MS = 35_000;
const DEFAULT_RUN_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const RELEASE_BODY_EXCERPT_CHARS = 1_000;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const CURRENT_STATUSES = new Set(["fresh", "not-modified"]);
const COMPUTE_CONTEXT = /\b(?:ai|artificial intelligence|machine learning|llm|model|inference|training|agent)\b/i;
const COMPUTE_OBJECT = /\b(?:gpu|accelerator|chip|cuda|kernel|tensor|inference|training|runtime|compiler|precision|memory|interconnect|network|rack|server|data ?center|bluefield|rocm|instinct|gemm|attention|moe)\b/i;
const DERIVATIVE_MODEL = /\b(?:adapter|lora|qlora|awq|gguf|gptq|quantiz(?:e|ed|ation)|tokenizer|finetune|fine-tune)\b/i;
const MODEL_RELEASE_CUE = /\b(?:model|kimi\s+k\d|inkling|qwen|deepseek|mistral|mixtral|ministral|codestral|pixtral|magistral|devstral)\b/i;
const EVENT_OCCURRENCE_CUE = /\b(?:launch(?:es|ed)?|introduc(?:e|es|ed)|unveil(?:s|ed)?|announce(?:s|d)|release(?:s|d)|now available|general availability)\b/i;

const array = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");
const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const safeDate = (value) => Number.isFinite(Date.parse(value || "")) ? new Date(value).toISOString() : null;

function decodeHtml(value) {
  return normalize(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function canonicalUrl(value, base) {
  try {
    const url = new URL(decodeHtml(value), base);
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function titleFromSlug(value) {
  const slug = String(value || "").split("/").filter(Boolean).at(-1) || "";
  return slug.split("-").filter(Boolean).map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() || ""}${part.slice(1)}`).join(" ");
}

function shadowItem({ source, identity, title, url, publishedAt = null, updatedAt = null, kind, metadata = {} }) {
  return {
    source_id: source.id,
    identity,
    title: normalize(title) || identity,
    url: canonicalUrl(url, source.canonical_url),
    published_at: safeDate(publishedAt),
    updated_at: safeDate(updatedAt),
    kind,
    metadata,
    manual_review_only: true,
    primary_verification_required: true,
    claim_evidence_allowed: false,
    can_raise_evidence_grade: false,
    can_change_availability_state: false,
    notification_eligible: false,
  };
}

function uniqueItems(items, maxItems) {
  const byIdentity = new Map();
  for (const item of items) {
    if (!item?.identity) continue;
    const previous = byIdentity.get(item.identity);
    if (!previous) {
      byIdentity.set(item.identity, item);
      continue;
    }
    const previousCompleteness = Number(Boolean(previous.published_at)) + Number(Boolean(previous.updated_at)) + Number(previous.title !== previous.identity);
    const currentCompleteness = Number(Boolean(item.published_at)) + Number(Boolean(item.updated_at)) + Number(item.title !== item.identity);
    if (currentCompleteness > previousCompleteness) byIdentity.set(item.identity, { ...previous, ...item, metadata: { ...previous.metadata, ...item.metadata } });
  }
  return [...byIdentity.values()].slice(0, maxItems);
}

function parseKimiIndex(source, body) {
  const matches = [];
  for (const match of body.matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0];
    const rawHref = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!rawHref || !/\/blog\/[a-z0-9-]+/i.test(rawHref)) continue;
    const ariaLabel = tag.match(/aria-label=["']([^"']+)["']/i)?.[1];
    const window = body.slice(match.index, match.index + 5_000);
    const title = ariaLabel || window.match(/<h[1-6][^>]*class=["'][^"']*card-title[^"']*["'][^>]*>([^<]+)</i)?.[1] || titleFromSlug(rawHref);
    const rawDate = window.match(/class=["'][^"']*card-date[^"']*["'][^>]*>(\d{4}[/-]\d{2}[/-]\d{2})</i)?.[1];
    const publishedAt = rawDate ? `${rawDate.replaceAll("/", "-")}T00:00:00+08:00` : null;
    const url = canonicalUrl(rawHref, source.endpoint).replace("/en/blog/", "/blog/");
    matches.push(shadowItem({
      source,
      identity: `official-article:${url}`,
      title: decodeHtml(title),
      url,
      publishedAt,
      kind: "official-model-announcement-index-item",
      metadata: rawDate ? { source_date: rawDate.replaceAll("/", "-"), source_timezone: "Asia/Shanghai" } : {},
    }));
  }
  return uniqueItems(matches, source.limits.max_items);
}

function parseHtmlLinkIndex(source, body, pathPattern, kind) {
  const items = [];
  for (const match of body.matchAll(/href=["']([^"']+)["']/gi)) {
    const url = canonicalUrl(match[1], source.endpoint);
    if (!pathPattern.test(new URL(url).pathname)) continue;
    const window = body.slice(match.index, match.index + 3_500);
    const title = window.match(/<(?:h[1-6]|span)[^>]*>([^<]{3,180})<\//i)?.[1] || titleFromSlug(url);
    const dateValue = window.match(/(20\d{2})[-/]([01]\d)[-/]([0-3]\d)/)?.slice(1, 4);
    const publishedAt = dateValue ? `${dateValue.join("-")}T00:00:00Z` : null;
    items.push(shadowItem({ source, identity: `official-article:${url}`, title: decodeHtml(title), url, publishedAt, kind }));
  }
  return uniqueItems(items, source.limits.max_items);
}

function xmlParser() {
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true, parseTagValue: false });
}

function parseSitemap(source, body) {
  const parsed = xmlParser().parse(body);
  const nodes = array(parsed?.urlset?.url);
  return uniqueItems(nodes.map((node) => {
    const url = canonicalUrl(node?.loc, source.endpoint);
    return shadowItem({
      source,
      identity: `official-article:${url}`,
      title: titleFromSlug(url),
      url,
      updatedAt: node?.lastmod,
      kind: "official-sitemap-item",
      metadata: { sitemap_lastmod_is_publication_date: false },
    });
  }).filter((item) => item.url && /\/news\//.test(new URL(item.url).pathname)), source.limits.max_items);
}

function parseHuggingFaceModels(source, body) {
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error("hugging-face-response-is-not-an-array");
  return uniqueItems(parsed.map((model) => {
    const id = normalize(model?.modelId || model?.id);
    const tags = array(model?.tags).map(String);
    const derivative = DERIVATIVE_MODEL.test(`${id} ${tags.join(" ")}`);
    return shadowItem({
      source,
      identity: `huggingface:${id}@${normalize(model?.sha) || "mutable-head"}`,
      title: id,
      url: `https://huggingface.co/${id}`,
      publishedAt: model?.createdAt,
      updatedAt: model?.lastModified,
      kind: source.role === "attention-fallback-only" ? "model-attention-signal" : "official-namespace-model-artifact",
      metadata: {
        model_id: id,
        revision: normalize(model?.sha),
        pipeline_tag: normalize(model?.pipeline_tag),
        tags,
        likes: Number(model?.likes || 0),
        downloads: Number(model?.downloads || 0),
        derivative_model_cue: derivative,
        official_identity_binding_status: source.identity_binding,
      },
    });
  }).filter((item) => item.metadata.model_id), source.limits.max_items);
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return normalize(value["#text"] || value.__cdata || value["@_href"]);
  return "";
}

function feedLink(node) {
  for (const link of array(node?.link)) {
    if (typeof link === "string") return link;
    if (link?.["@_rel"] === "alternate" && link?.["@_href"]) return link["@_href"];
    if (link?.["@_href"]) return link["@_href"];
  }
  return textValue(node?.guid);
}

function parseFeed(source, body) {
  const parsed = xmlParser().parse(body);
  const nodes = parsed?.rss?.channel?.item ? array(parsed.rss.channel.item) : array(parsed?.feed?.entry);
  const items = [];
  for (const node of nodes) {
    const title = decodeHtml(textValue(node?.title));
    const summary = decodeHtml(textValue(node?.description || node?.summary || node?.content));
    const scope = `${title} ${summary}`;
    if (!COMPUTE_CONTEXT.test(scope) || !COMPUTE_OBJECT.test(scope)) continue;
    const url = canonicalUrl(feedLink(node), source.endpoint);
    const publishedAt = textValue(node?.pubDate || node?.published || node?.updated || node?.["dc:date"]);
    items.push(shadowItem({
      source,
      identity: `official-article:${url}`,
      title,
      url,
      publishedAt,
      kind: source.id === "nvidia-newsroom-press-xml" ? "official-compute-product-announcement" : "official-compute-technical-article",
      metadata: { vendor_claim_only: true, performance_verified: false },
    }));
  }
  return uniqueItems(items, source.limits.max_items);
}

function parseRocmHistory(source, body) {
  const items = [];
  for (const match of body.matchAll(/ROCm\s+(\d+\.\d+(?:\.\d+)?)/gi)) {
    const version = match[1];
    const window = body.slice(match.index, match.index + 1_500);
    const dateMatch = window.match(/(20\d{2})[-/]([01]\d)[-/]([0-3]\d)/);
    const publishedAt = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00Z` : null;
    items.push(shadowItem({
      source,
      identity: `official-release:rocm@${version}`,
      title: `ROCm ${version}`,
      url: `${source.canonical_url}#rocm-${version.replaceAll(".", "-")}`,
      publishedAt,
      kind: "official-compute-release-index-item",
      metadata: { release_notes_required_for_semantic_delta: true },
    }));
  }
  return uniqueItems(items, source.limits.max_items);
}

function parseGitHubReleases(source, body) {
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error("github-releases-response-is-not-an-array");
  return uniqueItems(parsed.map((release) => {
    const tag = normalize(release?.tag_name);
    const normalizedBody = normalize(release?.body || "");
    const repository = new URL(source.canonical_url).pathname.split("/").filter(Boolean).slice(0, 2).join("/");
    const semantic = classifyComputeRelease({
      id: `${repository}@${tag}`,
      source_id: source.id,
      version_identity: `${repository}@${tag}`,
      title: release?.name || tag,
      body: release?.body || "",
      release_kind: release?.prerelease ? "prerelease" : "stable",
    });
    return shadowItem({
      source,
      identity: `github-release:${repository}@${tag}`,
      title: release?.name || tag,
      url: release?.html_url,
      publishedAt: release?.published_at || release?.created_at,
      updatedAt: release?.updated_at,
      kind: release?.prerelease ? "official-compute-prerelease" : "official-compute-release",
      metadata: {
        tag,
        prerelease: release?.prerelease === true,
        draft: release?.draft === true,
        release_body_hash: sha256(release?.body || ""),
        release_body_chars: normalizedBody.length,
        release_body_excerpt: normalizedBody.slice(0, RELEASE_BODY_EXCERPT_CHARS),
        release_body_excerpt_sha256: sha256(normalizedBody.slice(0, RELEASE_BODY_EXCERPT_CHARS)),
        release_body_excerpt_truncated: normalizedBody.length > RELEASE_BODY_EXCERPT_CHARS,
        semantic_review: semantic,
      },
    });
  }).filter((item) => item.metadata.tag && !item.metadata.draft), source.limits.max_items);
}

export function parseModelComputeSource(source, body) {
  switch (source.format) {
    case "bounded-html-index":
      return source.id === "kimi-research-index"
        ? parseKimiIndex(source, body)
        : parseHtmlLinkIndex(source, body, /^\/news\/[a-z0-9-]+\/?$/i, "official-model-announcement-index-item");
    case "sitemap-xml": return parseSitemap(source, body);
    case "huggingface-model-list-json": return parseHuggingFaceModels(source, body);
    case "rss-or-atom": return parseFeed(source, body);
    case "bounded-html-release-index": return parseRocmHistory(source, body);
    case "github-rest-releases-json": return parseGitHubReleases(source, body);
    default: throw new Error(`unsupported-source-format: ${source.format}`);
  }
}

async function atomicWrite(path, content) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    try { await unlink(temporary); } catch {}
    throw error;
  }
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

function cachePath(cacheDir, sourceId) {
  return resolve(cacheDir, `${sourceId}.json`);
}

async function readCache(cacheDir, sourceId) {
  return readJson(cachePath(cacheDir, sourceId));
}

async function writeCache(cacheDir, sourceId, value) {
  await atomicWrite(cachePath(cacheDir, sourceId), `${JSON.stringify(value, null, 2)}\n`);
}

async function readResponseBounded(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error(`response-body-too-large:${declared}>${maxBytes}`);
  if (!response.body) return "";
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`response-body-too-large:${bytes}>${maxBytes}`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function timeoutPromise(milliseconds, controller, label) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      controller.abort(new Error(label));
      reject(new Error(label));
    }, milliseconds);
    timer.unref?.();
  });
}

async function fetchAttempt(source, cached, { fetchImpl, requestTimeoutMs }) {
  const headers = {
    accept: source.format.includes("json") ? "application/json" : "text/html, application/xml;q=0.9, application/rss+xml;q=0.9, application/atom+xml;q=0.9, */*;q=0.1",
    "user-agent": "ai-research-daily-shadow/0.1 (public-source health audit; no training or notification)",
  };
  if (source.endpoint.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  if (cached?.etag) headers["if-none-match"] = cached.etag;
  if (cached?.last_modified) headers["if-modified-since"] = cached.last_modified;
  const controller = new AbortController();
  const response = await Promise.race([
    fetchImpl(source.endpoint, { headers, signal: controller.signal, redirect: "follow" }),
    timeoutPromise(requestTimeoutMs, controller, `request-timeout:${source.id}`),
  ]);
  if (!(response instanceof Response) && typeof response?.status !== "number") throw new Error(`invalid-fetch-response:${source.id}`);
  if (response.status === 304) {
    if (!cached?.body_base64) throw new Error(`not-modified-without-cache:${source.id}`);
    return {
      status: "not-modified",
      httpStatus: 304,
      body: Buffer.from(cached.body_base64, "base64").toString("utf8"),
      etag: response.headers.get("etag") || cached.etag || "",
      lastModified: response.headers.get("last-modified") || cached.last_modified || "",
      rateRemaining: Number(response.headers.get("x-ratelimit-remaining") || cached.rate_limit_remaining),
      fromCache: true,
    };
  }
  if (!response.ok) {
    const error = new Error(`http-${response.status}:${source.id}`);
    error.httpStatus = response.status;
    error.retryAfter = response.headers.get("retry-after") || "";
    error.rateRemaining = Number(response.headers.get("x-ratelimit-remaining"));
    throw error;
  }
  const body = await readResponseBounded(response, source.limits.max_bytes);
  return {
    status: "fresh",
    httpStatus: response.status,
    body,
    etag: response.headers.get("etag") || "",
    lastModified: response.headers.get("last-modified") || "",
    rateRemaining: Number(response.headers.get("x-ratelimit-remaining")),
    fromCache: false,
  };
}

function retryable(error) {
  return TRANSIENT_STATUSES.has(error?.httpStatus) || /(?:timeout|fetch failed|network|socket|ECONN|EAI_AGAIN)/i.test(String(error?.message || error));
}

async function fetchSource(source, cacheDir, options) {
  const cached = await readCache(cacheDir, source.id);
  const attempts = [];
  let lastError = null;
  for (let index = 0; index <= options.maxRetries; index += 1) {
    const started = Date.now();
    try {
      const fetched = await fetchAttempt(source, cached, options);
      attempts.push({ attempt: index + 1, outcome: fetched.status, elapsed_ms: Date.now() - started });
      if (fetched.status === "fresh") {
        await writeCache(cacheDir, source.id, {
          source_id: source.id,
          fetched_at: options.now.toISOString(),
          etag: fetched.etag,
          last_modified: fetched.lastModified,
          rate_limit_remaining: Number.isFinite(fetched.rateRemaining) ? fetched.rateRemaining : null,
          body_hash: sha256(fetched.body),
          body_base64: Buffer.from(fetched.body, "utf8").toString("base64"),
        });
      }
      return { ...fetched, attempts, staleAgeHours: 0, error: null };
    } catch (error) {
      lastError = error;
      attempts.push({ attempt: index + 1, outcome: "error", elapsed_ms: Date.now() - started, error: String(error?.message || error) });
      if (index >= options.maxRetries || !retryable(error)) break;
      await options.sleepImpl(options.retryBaseDelayMs * (2 ** index));
    }
  }
  const cachedAt = Date.parse(cached?.fetched_at || "");
  const staleAgeMs = Number.isFinite(cachedAt) ? options.now.getTime() - cachedAt : Number.POSITIVE_INFINITY;
  if (cached?.body_base64 && staleAgeMs >= 0 && staleAgeMs <= options.cacheTtlMs) {
    return {
      status: "stale-cache",
      httpStatus: lastError?.httpStatus || 0,
      body: Buffer.from(cached.body_base64, "base64").toString("utf8"),
      etag: cached.etag || "",
      lastModified: cached.last_modified || "",
      rateRemaining: Number(cached.rate_limit_remaining),
      fromCache: true,
      attempts,
      staleAgeHours: Math.round(staleAgeMs / HOUR_MS * 100) / 100,
      error: String(lastError?.message || lastError || "unknown-fetch-error"),
    };
  }
  return {
    status: "failed",
    httpStatus: lastError?.httpStatus || 0,
    body: "",
    etag: cached?.etag || "",
    lastModified: cached?.last_modified || "",
    rateRemaining: Number(lastError?.rateRemaining),
    fromCache: false,
    attempts,
    staleAgeHours: null,
    error: String(lastError?.message || lastError || "unknown-fetch-error"),
  };
}

function shanghaiDate(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function consecutiveCleanDays(dates, today, maximum = 7) {
  const values = new Set(dates);
  let cursor = new Date(`${today}T00:00:00.000Z`);
  let count = 0;
  while (count < maximum) {
    const key = cursor.toISOString().slice(0, 10);
    if (!values.has(key)) break;
    count += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return count;
}

function previousHistory(previousAudit, sourceId) {
  return array(previousAudit?.source_histories).find((history) => history.source_id === sourceId) || null;
}

function projectEvent(source, fetched, previousAudit, now) {
  const history = previousHistory(previousAudit, source.id);
  let items = [];
  let parseError = null;
  if (fetched.body) {
    try { items = parseModelComputeSource(source, fetched.body); } catch (error) { parseError = String(error?.message || error); }
  }
  const effectiveStatus = parseError ? "failed-semantic" : fetched.status;
  const onboarding = history?.baseline_semantics_version !== 2 || history?.baseline_complete !== true;
  const seen = new Set(array(history?.seen_identities));
  const canChange = CURRENT_STATUSES.has(effectiveStatus) && !onboarding;
  const newItems = canChange ? items.filter((item) => !seen.has(item.identity)) : [];
  const currentWindowItems = CURRENT_STATUSES.has(effectiveStatus) ? items.filter((item) => {
    const timestamp = Date.parse(item.published_at || "");
    const ageHours = (now.getTime() - timestamp) / HOUR_MS;
    return Number.isFinite(timestamp) && ageHours >= 0 && ageHours <= 72;
  }) : [];
  return {
    source_id: source.id,
    lane: source.lane,
    status: effectiveStatus,
    onboarding_baseline: onboarding,
    response_origin: fetched.fromCache ? fetched.status === "not-modified" ? "conditional-cache" : "stale-cache" : "network",
    http_status: fetched.httpStatus,
    fetched_at: now.toISOString(),
    response_bytes: Buffer.byteLength(fetched.body || "", "utf8"),
    response_hash: fetched.body ? sha256(fetched.body) : "",
    etag: fetched.etag || "",
    last_modified: fetched.lastModified || "",
    rate_limit_remaining: Number.isFinite(fetched.rateRemaining) ? fetched.rateRemaining : null,
    attempts: fetched.attempts,
    retry_count: Math.max(0, fetched.attempts.length - 1),
    stale_age_hours: fetched.staleAgeHours,
    error: parseError || fetched.error,
    items,
    new_items: newItems,
    current_window_items: currentWindowItems,
    change_candidates: newItems.map((item) => ({
      ...item,
      change_state: "new-identity-after-onboarding",
      manual_review_only: true,
      claim_evidence_allowed: false,
      can_change_availability_state: false,
      notification_eligible: false,
    })),
    notification_eligible: false,
    external_actions: [],
  };
}

export function evaluateDailyEditorialItem(item, source) {
  const reasons = [];
  if (source.role === "attention-fallback-only") reasons.push("attention-source-cannot-create-editorial-candidate");
  if (item?.metadata?.derivative_model_cue === true) reasons.push("derivative-model-kind");
  if (source.role === "official-organization-artifact-discovery" && source.identity_binding !== "human-approved-official-organization") reasons.push("official-organization-identity-binding-pending-human-signoff");
  if (source.lane === "new-model" && item.kind === "official-model-announcement-index-item" && !MODEL_RELEASE_CUE.test(item.title)) reasons.push("outside-new-model-release-scope");
  if (source.lane === "new-model" && item.kind === "official-sitemap-item") reasons.push("sitemap-lastmod-is-not-publication-evidence");
  if (item.kind === "official-compute-technical-article" && !EVENT_OCCURRENCE_CUE.test(item.title)) reasons.push("article-lacks-new-event-identity");
  if (item.kind === "official-compute-release-index-item") reasons.push("release-notes-semantic-review-required");
  if (["official-compute-release", "official-compute-prerelease"].includes(item.kind)
    && item?.metadata?.semantic_review?.eligible_for_editorial_review !== true) reasons.push("release-without-compute-semantic-delta");
  return {
    eligible: reasons.length === 0,
    reasons,
    manual_review_only: true,
    claim_evidence_allowed: false,
    notification_eligible: false,
  };
}

function skippedRateEvent(source, now, rateRemaining, previousAudit) {
  return {
    source_id: source.id,
    lane: source.lane,
    status: "skipped-rate-budget",
    onboarding_baseline: previousHistory(previousAudit, source.id)?.baseline_semantics_version !== 2
      || previousHistory(previousAudit, source.id)?.baseline_complete !== true,
    response_origin: "none",
    http_status: 0,
    fetched_at: now.toISOString(),
    response_bytes: 0,
    response_hash: "",
    etag: "",
    last_modified: "",
    rate_limit_remaining: rateRemaining,
    attempts: [],
    retry_count: 0,
    stale_age_hours: null,
    error: "github-rate-limit-stop-threshold-reached",
    items: [],
    new_items: [],
    current_window_items: [],
    change_candidates: [],
    notification_eligible: false,
    external_actions: [],
  };
}

function buildHistories(sources, events, previousAudit, now) {
  return sources.map((source) => {
    const event = events.find((candidate) => candidate.source_id === source.id);
    const previous = previousHistory(previousAudit, source.id);
    const previousBaselineComplete = previous?.baseline_semantics_version === 2 && previous?.baseline_complete === true;
    const baselineComplete = previousBaselineComplete || CURRENT_STATUSES.has(event.status);
    const seen = new Set(previousBaselineComplete ? array(previous?.seen_identities) : []);
    if (CURRENT_STATUSES.has(event.status)) for (const item of event.items) seen.add(item.identity);
    const dates = new Set(previousBaselineComplete ? array(previous?.network_verified_dates) : []);
    if (CURRENT_STATUSES.has(event.status)) dates.add(shanghaiDate(now));
    const sortedDates = [...dates].sort().slice(-30);
    return {
      source_id: source.id,
      baseline_semantics_version: 2,
      onboarding_at: previousBaselineComplete ? previous.onboarding_at : CURRENT_STATUSES.has(event.status) ? now.toISOString() : null,
      baseline_complete: baselineComplete,
      last_observed_at: now.toISOString(),
      last_status: event.status,
      seen_identities: [...seen].sort(),
      network_verified_dates: sortedDates,
      consecutive_clean_days: consecutiveCleanDays(sortedDates, shanghaiDate(now)),
      human_identity_review_complete: source.identity_binding === "not-applicable" || source.identity_binding === "official-domain-index-reviewed",
      automatically_promoted: false,
      notification_eligible: false,
    };
  });
}

export function createModelComputeSourceAudit({ sources = modelComputeShadowSources, sourceEvents = [], previousAudit = null, now = new Date() } = {}) {
  const histories = buildHistories(sources, sourceEvents, previousAudit, now);
  const statusCounts = Object.fromEntries([...new Set(sourceEvents.map((event) => event.status))].sort().map((status) => [status, sourceEvents.filter((event) => event.status === status).length]));
  const rawItems = sourceEvents.flatMap((event) => event.items);
  const currentItems = sourceEvents.flatMap((event) => event.current_window_items);
  const changes = sourceEvents.flatMap((event) => event.change_candidates);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const editorialDecisions = currentItems.map((item) => ({ item, decision: evaluateDailyEditorialItem(item, sourceById.get(item.source_id)) }));
  const editorialCandidates = editorialDecisions.filter(({ decision }) => decision.eligible).map(({ item, decision }) => ({ ...item, editorial_gate: decision }));
  const editorialExclusions = editorialDecisions.filter(({ decision }) => !decision.eligible).map(({ item, decision }) => ({
    source_id: item.source_id,
    identity: item.identity,
    title: item.title,
    url: item.url,
    exclusion_reasons: decision.reasons,
    manual_review_only: true,
    claim_evidence_allowed: false,
    notification_eligible: false,
  }));
  return {
    schema_version: 1,
    mode: "isolated-model-compute-network-shadow",
    generated_at: now.toISOString(),
    policy: MODEL_COMPUTE_SHADOW_POLICY,
    source_registry: sources,
    source_events: sourceEvents,
    source_histories: histories,
    raw_items: rawItems,
    daily_current_window_review: currentItems,
    daily_editorial_candidates: editorialCandidates,
    daily_editorial_exclusions: editorialExclusions,
    human_change_review_queue: changes,
    metrics: {
      source_count: sources.length,
      status_counts: statusCounts,
      fresh_or_not_modified: sourceEvents.filter((event) => CURRENT_STATUSES.has(event.status)).length,
      raw_item_count: rawItems.length,
      current_window_item_count: currentItems.length,
      editorial_candidate_count: editorialCandidates.length,
      editorial_exclusion_count: editorialExclusions.length,
      change_candidate_count: changes.length,
      onboarding_source_count: sourceEvents.filter((event) => event.onboarding_baseline).length,
    },
    isolation: {
      production_registry_changed: false,
      production_state_written: false,
      existing_source_health_affected: false,
      evidence_grade_changes: [],
      availability_state_changes: [],
      automatic_promotions: [],
    },
    notification_policy: { enabled: false, eligible_records: 0 },
    external_actions: [],
  };
}

export function renderModelComputeReview(audit) {
  const lines = [
    "# Model / Compute Source Shadow Review",
    "",
    `Generated: ${audit.generated_at}`,
    `Sources: ${audit.metrics.source_count}; fresh/not-modified: ${audit.metrics.fresh_or_not_modified}; raw items: ${audit.metrics.raw_item_count}; current-window: ${audit.metrics.current_window_item_count}; editorial candidates: ${audit.metrics.editorial_candidate_count}; changes: ${audit.metrics.change_candidate_count}.`,
    "",
    "This is a baseline/change-detection audit only. It cannot promote evidence, availability, notifications, website content, or WeChat drafts.",
    "",
    "## Source health",
    "",
    "| Source | Lane | Status | Bytes | Items | New | Error |",
    "|---|---|---:|---:|---:|---:|---|",
  ];
  for (const event of audit.source_events) lines.push(`| ${event.source_id} | ${event.lane} | ${event.status} | ${event.response_bytes} | ${event.items.length} | ${event.new_items.length} | ${event.error || ""} |`);
  lines.push("", "## Hugging Face organization identity bindings", "");
  lines.push("These direct official-property links were source-verified, but `human_signoff` remains empty and organization records cannot enter the formal Top 3.", "");
  for (const source of audit.source_registry.filter((item) => item.role === "official-organization-artifact-discovery")) {
    const evidence = source.identity_binding_evidence;
    lines.push(`- **${evidence.namespace}** — [official source](${evidence.official_source_url}) → [HF target](${evidence.direct_hf_target_url}); snapshot \`${evidence.extracted_markdown_sha256}\`; status \`${source.identity_binding}\`; human signoff: unchecked.`);
  }
  lines.push("", "## Current 72-hour items", "");
  if (!audit.daily_current_window_review.length) lines.push("No source item with a trustworthy source date is currently inside the 72-hour shadow window.");
  for (const item of audit.daily_current_window_review) lines.push(`- [${item.title}](${item.url}) — ${item.source_id}; ${item.published_at || item.updated_at}; manual review only.`);
  lines.push("", "## Editorial candidates after the simple hard gate", "");
  if (!audit.daily_editorial_candidates.length) lines.push("None. The daily digest must not fill a slot.");
  for (const item of audit.daily_editorial_candidates) lines.push(`- [${item.title}](${item.url}) — ${item.identity}; manual verification required.`);
  lines.push("", "## Editorial exclusions", "");
  if (!audit.daily_editorial_exclusions.length) lines.push("None.");
  for (const item of audit.daily_editorial_exclusions) lines.push(`- [${item.title}](${item.url}) — ${item.exclusion_reasons.join(", ")}.`);
  lines.push("", "## New identities after onboarding", "");
  if (!audit.human_change_review_queue.length) lines.push("None. First-run items are onboarding baselines and never changes.");
  for (const item of audit.human_change_review_queue) lines.push(`- [${item.title}](${item.url}) — ${item.identity}; manual review only.`);
  return `${lines.join("\n")}\n`;
}

export async function runModelComputeSourceProbe({
  sources = modelComputeShadowSources,
  outputPath = process.env.MODEL_COMPUTE_PROBE_OUTPUT_PATH || "work/model-compute-source-probe/audit.json",
  statePath = process.env.MODEL_COMPUTE_PROBE_STATE_PATH || "work/model-compute-source-probe/audit.json",
  reviewPath = process.env.MODEL_COMPUTE_PROBE_REVIEW_PATH || "work/model-compute-source-probe/review.md",
  cacheDir = process.env.MODEL_COMPUTE_PROBE_CACHE_DIR || "work/model-compute-source-probe/cache",
  deferStateCommit = process.env.MODEL_COMPUTE_PROBE_DEFER_STATE_COMMIT === "1",
  fetchImpl = fetch,
  now = new Date(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sourceTimeoutMs = DEFAULT_SOURCE_TIMEOUT_MS,
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  sleepImpl = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
} = {}) {
  const validation = validateModelComputeShadowRegistry(sources);
  if (!validation.ok) throw new Error(`invalid-model-compute-registry: ${validation.errors.join(", ")}`);
  const previousAudit = await readJson(statePath);
  const sourceEvents = [];
  const runStarted = Date.now();
  let githubRateRemaining = Number.POSITIVE_INFINITY;
  for (const source of sources) {
    if (Date.now() - runStarted > runTimeoutMs) throw new Error("model-compute-probe-run-deadline-exceeded");
    const isGitHub = source.format === "github-rest-releases-json";
    if (isGitHub && githubRateRemaining < MODEL_COMPUTE_SHADOW_POLICY.github_rate_limit_stop_remaining) {
      sourceEvents.push(skippedRateEvent(source, now, githubRateRemaining, previousAudit));
      continue;
    }
    const fetched = await Promise.race([
      fetchSource(source, cacheDir, { fetchImpl, now, cacheTtlMs, requestTimeoutMs, maxRetries, retryBaseDelayMs, sleepImpl }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`source-deadline:${source.id}`)), sourceTimeoutMs);
        timer.unref?.();
      }),
    ]).catch((error) => ({
      status: "failed",
      httpStatus: 0,
      body: "",
      etag: "",
      lastModified: "",
      rateRemaining: Number.NaN,
      fromCache: false,
      attempts: [{ attempt: 1, outcome: "error", elapsed_ms: sourceTimeoutMs, error: String(error?.message || error) }],
      staleAgeHours: null,
      error: String(error?.message || error),
    }));
    if (isGitHub && Number.isFinite(fetched.rateRemaining)) githubRateRemaining = fetched.rateRemaining;
    sourceEvents.push(projectEvent(source, fetched, previousAudit, now));
  }
  const audit = createModelComputeSourceAudit({ sources, sourceEvents, previousAudit, now });
  const auditBody = `${JSON.stringify(audit, null, 2)}\n`;
  await atomicWrite(outputPath, auditBody);
  await atomicWrite(reviewPath, renderModelComputeReview(audit));
  if (!deferStateCommit && resolve(statePath) !== resolve(outputPath)) await atomicWrite(statePath, auditBody);
  return audit;
}

async function main() {
  const audit = await runModelComputeSourceProbe();
  process.stdout.write(`model/compute shadow probe: ${audit.metrics.fresh_or_not_modified}/${audit.metrics.source_count} fresh/not-modified, ${audit.metrics.current_window_item_count} current-window, ${audit.metrics.change_candidate_count} changes, notifications 0\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
