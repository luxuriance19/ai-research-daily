#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { candidateSources } from "./candidate-source-registry.mjs";
import { observedSourceIdentity } from "./source-identity.mjs";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
const USER_AGENT = "ai-research-daily-shadow-source-probe/0.1";
const GITHUB_API_VERSION = "2022-11-28";
const AUDIT_TIME_ZONE = "Asia/Shanghai";
const MINIMUM_OBSERVATION_DAYS = 7;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RELEASE_BODY_EXCERPT_CHARS = 1000;
const NETWORK_SUCCESS = new Set(["fresh", "not-modified"]);
const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function normalizedReleaseText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

function githubRepository(source) {
  if (source.project_key) return source.project_key;
  return String(source.url || "").match(/api\.github\.com\/repos\/([^/]+\/[^/]+)\//)?.[1] || "unknown/unknown";
}

function normalizeDeclaredMonth(value) {
  const months = new Map([
    ["january", "01"], ["february", "02"], ["march", "03"], ["april", "04"],
    ["may", "05"], ["june", "06"], ["july", "07"], ["august", "08"],
    ["september", "09"], ["october", "10"], ["november", "11"], ["december", "12"],
  ]);
  const match = cleanText(value, 100).match(/^([A-Za-z]+)\s+(\d{4})$/);
  const month = months.get(String(match?.[1] || "").toLowerCase());
  return match && month ? `${match[2]}-${month}` : cleanText(value, 100);
}

function cleanText(value, limit = 1000) {
  if (value == null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  if (Array.isArray(value)) return cleanText(value.map((item) => cleanText(item, limit)).join(" "), limit);
  if (typeof value === "object") return cleanText(value["#text"] ?? value.__cdata ?? Object.values(value), limit);
  return "";
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

function dateKeyEpoch(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const epoch = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) return null;
  return epoch;
}

function normalizedPastDateKeys(dateKeys, today) {
  const todayEpoch = dateKeyEpoch(today);
  return [...new Set(array(dateKeys).filter((value) => {
    const epoch = dateKeyEpoch(value);
    return epoch != null && todayEpoch != null && epoch <= todayEpoch;
  }))].sort();
}

function consecutiveDayCount(dateKeys, expectedLatestDate = "") {
  const dates = [...new Set(array(dateKeys).filter((value) => dateKeyEpoch(value) != null))].sort();
  if (!dates.length) return 0;
  if (expectedLatestDate && dates.at(-1) !== expectedLatestDate) return 0;
  let count = 1;
  for (let index = dates.length - 1; index > 0; index -= 1) {
    if (dateKeyEpoch(dates[index]) - dateKeyEpoch(dates[index - 1]) !== 86_400_000) break;
    count += 1;
  }
  return count;
}

function linkValue(value) {
  if (typeof value === "string") return value;
  const links = array(value);
  return links.find((item) => item?.rel === "alternate")?.href || links.find((item) => item?.href)?.href || "";
}

const ARTIFACT_DOMAINS = new Map([
  ["arxiv.org", "scholarly-paper-candidate"],
  ["export.arxiv.org", "scholarly-paper-candidate"],
  ["doi.org", "scholarly-identifier-candidate"],
  ["openreview.net", "scholarly-venue-candidate"],
  ["github.com", "code-or-release-candidate"],
  ["huggingface.co", "model-code-or-paper-candidate"],
  ["transformer-circuits.pub", "primary-research-page-candidate"],
  ["anthropic.com", "official-article-candidate"],
  ["www.anthropic.com", "official-article-candidate"],
  ["openai.com", "official-article-candidate"],
  ["www.openai.com", "official-article-candidate"],
  ["deepmind.google", "official-article-candidate"],
  ["ai.google.dev", "official-artifact-candidate"],
  ["research.google", "official-research-candidate"],
  ["seed.bytedance.com", "official-research-candidate"],
  ["kimi.com", "official-article-candidate"],
  ["www.kimi.com", "official-article-candidate"],
  ["moonshot.ai", "official-article-candidate"],
  ["ai.meta.com", "official-research-candidate"],
  ["metr.org", "evaluation-research-candidate"],
]);

function collectUrls(value, result = []) {
  if (value == null || result.length >= 500) return result;
  if (typeof value === "string") {
    const decoded = decodeHtmlEntities(value);
    const anchorPattern = new RegExp("<a\\b[^>]*href=[\\\"\\x27]([^\\\"\\x27]+)[\\\"\\x27][^>]*>([^]*?)<\\/a>", "gi");
    const hrefPattern = new RegExp("href=[\\\"\\x27]([^\\\"\\x27]+)[\\\"\\x27]", "gi");
    const markdownPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
    const plainPattern = /https?:\/\/[^\s<>"']+/gi;
    for (const match of decoded.matchAll(anchorPattern)) {
      result.push({ value: match[1], context: cleanText(match[2], 240) });
      if (result.length >= 500) return result;
    }
    for (const match of decoded.matchAll(markdownPattern)) {
      result.push({ value: match[2], context: cleanText(match[1], 240) });
      if (result.length >= 500) return result;
    }
    for (const match of decoded.matchAll(hrefPattern)) {
      result.push({ value: match[1], context: "" });
      if (result.length >= 500) return result;
    }
    for (const match of decoded.matchAll(plainPattern)) {
      result.push({ value: match[0], context: "" });
      if (result.length >= 500) return result;
    }
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, result);
    return result;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key.toLowerCase() === "href" && typeof item === "string") result.push({ value: item, context: cleanText(value, 240) });
      else collectUrls(item, result);
      if (result.length >= 500) return result;
    }
  }
  return result;
}

function normalizeArtifactLink(candidate) {
  try {
    const url = new URL(decodeHtmlEntities(candidate.value).replace(/[),.;]+$/, ""));
    const type = ARTIFACT_DOMAINS.get(url.hostname.toLowerCase());
    if (!type) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || ["ref", "source", "si", "s"].includes(key.toLowerCase())) url.searchParams.delete(key);
    }
    return {
      url: url.toString(),
      candidate_type: type,
      link_context: cleanText(candidate.context, 240),
      authority_verified: false,
      requires_primary_verification: true,
    };
  } catch {
    return null;
  }
}

function extractArtifactLinks(entry) {
  const values = [entry.summary, entry.description, entry.content, entry["content:encoded"]];
  const links = collectUrls(values).map(normalizeArtifactLink).filter(Boolean);
  const unique = new Map();
  for (const link of links) {
    const previous = unique.get(link.url);
    if (!previous || link.link_context.length > previous.link_context.length) unique.set(link.url, link);
  }
  return [...unique.values()].slice(0, 32);
}

function parseFeedItems(body) {
  const document = parser.parse(body);
  if (document.feed) {
    return array(document.feed.entry).map((entry) => ({
      id: cleanText(entry.id, 1000),
      title: cleanText(entry.title, 500),
      url: linkValue(entry.link) || cleanText(entry.id, 1000),
      published_at: parseDate(entry.published || entry.updated),
      updated_at: parseDate(entry.updated || entry.published),
      artifact_links: extractArtifactLinks(entry),
    }));
  }
  const channel = document.rss?.channel;
  return array(channel?.item).map((item) => ({
    id: cleanText(item.guid, 1000) || cleanText(item.link, 1000),
    title: cleanText(item.title, 500),
    url: linkValue(item.link) || cleanText(item.link, 1000),
    published_at: parseDate(item.pubDate || item.updated || item.date),
    updated_at: parseDate(item.updated || item.pubDate || item.date),
    artifact_links: extractArtifactLinks(item),
  }));
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

function normalizedHtmlText(body) {
  return decodeHtmlEntities(String(body || "")
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)\b[^>]*>[^]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function temporalSummary(items) {
  const sorted = items.filter((item) => item.published_at).sort((left, right) => right.published_at.localeCompare(left.published_at));
  const latest = sorted[0] || null;
  const oldest = sorted.at(-1) || null;
  const windowHours = latest && oldest ? Number(((Date.parse(latest.published_at) - Date.parse(oldest.published_at)) / 3_600_000).toFixed(2)) : 0;
  return {
    latest_item_at: latest?.published_at || "",
    latest_item_title: latest?.title || "",
    oldest_item_at: oldest?.published_at || "",
    window_hours: windowHours,
  };
}

function githubReleaseStream(tag) {
  const value = String(tag || "").toLowerCase();
  if (value.startsWith("python-")) return "python";
  if (value.startsWith("dotnet-")) return "dotnet";
  if (value.startsWith("rust-")) return "rust";
  return "core";
}

function githubReleaseVersionKey(tag) {
  const match = String(tag || "").match(/(?:^|[-_/])v?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?)/i);
  return match?.[1] || "";
}

function arxivIdentity(value) {
  const match = String(value || "").match(/(\d{4}\.\d{4,5})(?:v(\d+))?/);
  return match ? { id: match[1], version: Number(match[2] || 1) } : null;
}

export function parseCandidateSource(source, body, { responseHeaders = {}, previousSnapshot = null, now = new Date(), latestRelease = null, companionStatus = "not-required" } = {}) {
  const semanticBlockers = [];
  const warnings = [];
  const eventReviewFlags = [];
  const sourceReviewFlags = [];
  const eventKinds = new Set();
  const eventVersionKeys = new Set();
  const changeEvents = [];
  const markEvent = (flag, kind, versionKeys = [], changeEvent = null) => {
    eventReviewFlags.push(flag);
    if (kind) eventKinds.add(kind);
    for (const version of array(versionKeys)) if (version) eventVersionKeys.add(String(version));
    if (changeEvent) changeEvents.push({
      source_id: source.id,
      kind: changeEvent.kind || kind,
      ...changeEvent,
      requires_human_semantic_review: changeEvent.requires_human_semantic_review !== false,
    });
  };
  const markSourceReview = (flag) => sourceReviewFlags.push(flag);
  let details;

  if (source.format === "github-tree") {
    const document = JSON.parse(body);
    const files = array(document.tree).filter((item) => item.type === "blob").map((item) => ({ path: item.path, sha: item.sha })).sort((a, b) => a.path.localeCompare(b.path));
    const datedFiles = files.filter((item) => /^\d{8}-constitution\.md$/.test(item.path));
    const tracked = files.find((item) => item.path === source.tracked_path);
    const previousDatedFiles = new Map(array(previousSnapshot?.dated_files).map((item) => [item.path, item.sha]));
    const previousDatedPaths = new Set(previousDatedFiles.keys());
    const addedDatedFiles = datedFiles.filter((item) => !previousDatedPaths.has(item.path));
    const currentDatedPaths = new Set(datedFiles.map((item) => item.path));
    const removedDatedFiles = previousSnapshot
      ? array(previousSnapshot?.dated_files).filter((item) => !currentDatedPaths.has(item.path))
      : [];
    const changedDatedFiles = previousSnapshot
      ? datedFiles.filter((item) => previousDatedFiles.has(item.path) && previousDatedFiles.get(item.path) !== item.sha)
      : [];
    if (document.truncated) semanticBlockers.push("github-tree-truncated");
    if (!tracked) semanticBlockers.push("tracked-canonical-path-missing");
    if (!datedFiles.length) semanticBlockers.push("no-dated-constitution-file");
    if (previousSnapshot?.tracked_sha && tracked?.sha && previousSnapshot.tracked_sha !== tracked.sha) {
      markEvent("tracked-canonical-document-changed-human-semantic-review", "versioned-document-change", [], {
        kind: "canonical-blob-changed",
        path: source.tracked_path,
        previous_identity: `git-blob:${previousSnapshot.tracked_sha}`,
        current_identity: `git-blob:${tracked.sha}`,
      });
    }
    if (previousSnapshot && addedDatedFiles.length) {
      markEvent("new-dated-constitution-human-canonical-review", "versioned-document-change", [], {
        kind: "dated-policy-file-added",
        paths: addedDatedFiles.map((item) => item.path),
        previous_identity: "missing",
        current_identity: addedDatedFiles.map((item) => `git-blob:${item.sha}`).join(","),
      });
    }
    if (removedDatedFiles.length) {
      markEvent(`dated-constitution-files-removed-human-canonical-review:${removedDatedFiles.length}`, "versioned-document-change", [], {
        kind: "dated-policy-file-removed",
        paths: removedDatedFiles.map((item) => item.path),
        previous_identity: removedDatedFiles.map((item) => `git-blob:${item.sha}`).join(","),
        current_identity: "missing",
      });
    }
    if (changedDatedFiles.length) {
      markEvent(`dated-constitution-files-changed-human-semantic-review:${changedDatedFiles.length}`, "versioned-document-change", [], {
        kind: "dated-policy-file-changed",
        paths: changedDatedFiles.map((item) => item.path),
        previous_identity: changedDatedFiles.map((item) => `git-blob:${previousDatedFiles.get(item.path)}`).join(","),
        current_identity: changedDatedFiles.map((item) => `git-blob:${item.sha}`).join(","),
      });
    }
    details = {
      items_parsed: files.length,
      latest_item_at: "",
      latest_item_title: addedDatedFiles.at(-1)?.path || tracked?.path || "",
      oldest_item_at: "",
      window_hours: 0,
      snapshot: {
        head_sha: document.sha || "",
        truncated: Boolean(document.truncated),
        tracked_path: source.tracked_path,
        tracked_sha: tracked?.sha || "",
        dated_files: datedFiles,
      },
    };
  } else if (source.format === "github-artifact-tree") {
    const document = JSON.parse(body);
    const files = array(document.tree)
      .filter((item) => item.type === "blob")
      .map((item) => ({ path: cleanText(item.path, 1000), sha: cleanText(item.sha, 100) }))
      .filter((item) => item.path && item.sha)
      .sort((left, right) => left.path.localeCompare(right.path));
    const fileMap = new Map(files.map((file) => [file.path, file]));
    const requiredFiles = array(source.required_paths_all).map((path) => ({
      path,
      sha: fileMap.get(path)?.sha || "",
      present: fileMap.has(path),
    }));
    let versionedFiles = [];
    if (source.versioned_path_pattern) {
      const pattern = new RegExp(source.versioned_path_pattern);
      versionedFiles = files.filter((file) => pattern.test(file.path));
    }
    if (document.truncated) semanticBlockers.push("github-artifact-tree-truncated");
    if (!document.sha) semanticBlockers.push("github-artifact-tree-sha-missing");
    for (const file of requiredFiles) if (!file.present) semanticBlockers.push(`github-required-path-missing:${file.path}`);
    if (versionedFiles.length < (source.minimum_versioned_files || 0)) semanticBlockers.push("github-versioned-file-index-empty");

    const previousRequired = new Map(array(previousSnapshot?.tracked_files).map((file) => [file.path, file.sha]));
    const changedRequired = previousSnapshot
      ? requiredFiles.filter((file) => file.present && previousRequired.has(file.path) && previousRequired.get(file.path) !== file.sha)
      : [];
    const previousVersioned = new Map(array(previousSnapshot?.versioned_files).map((file) => [file.path, file.sha]));
    const currentVersioned = new Map(versionedFiles.map((file) => [file.path, file.sha]));
    const addedVersioned = previousSnapshot ? versionedFiles.filter((file) => !previousVersioned.has(file.path)) : [];
    const removedVersioned = previousSnapshot
      ? [...previousVersioned.keys()].filter((path) => !currentVersioned.has(path)).map((path) => ({ path, sha: previousVersioned.get(path) }))
      : [];
    const changedVersioned = previousSnapshot
      ? versionedFiles.filter((file) => previousVersioned.has(file.path) && previousVersioned.get(file.path) !== file.sha)
      : [];
    if (changedRequired.length) {
      markEvent(`github-tracked-files-changed-human-artifact-review:${changedRequired.length}`, "versioned-document-change", [], {
        kind: "tracked-policy-files-changed",
        paths: changedRequired.map((file) => file.path),
        previous_identity: changedRequired.map((file) => `git-blob:${previousRequired.get(file.path)}`).join(","),
        current_identity: changedRequired.map((file) => `git-blob:${file.sha}`).join(","),
      });
    }
    if (addedVersioned.length || removedVersioned.length || changedVersioned.length) {
      markEvent(source.versioned_review_flag || "versioned-files-changed-human-canonical-review", "versioned-document-change", [], {
        kind: "version-index-changed",
        paths: [...addedVersioned, ...removedVersioned, ...changedVersioned].map((file) => file.path),
        previous_identity: previousSnapshot?.head_sha ? `git-tree:${previousSnapshot.head_sha}` : "unknown",
        current_identity: document.sha ? `git-tree:${document.sha}` : "unknown",
      });
    }
    const changedPaths = [...changedRequired, ...addedVersioned, ...removedVersioned, ...changedVersioned].map((file) => file.path);
    details = {
      items_parsed: files.length,
      latest_item_at: "",
      latest_item_title: changedPaths[0] || requiredFiles[0]?.path || "",
      oldest_item_at: "",
      window_hours: 0,
      snapshot: {
        head_sha: document.sha || "",
        branch_ref: source.branch_ref || "",
        truncated: Boolean(document.truncated),
        tracked_files: requiredFiles,
        versioned_files: versionedFiles,
      },
    };
  } else if (source.format === "arxiv-id-list") {
    const entries = parseFeedItems(body).map((item) => ({ ...item, published_at: item.updated_at || item.published_at, ...arxivIdentity(item.id) })).filter((item) => item.id && item.version);
    const expected = new Set(source.expected_ids);
    const observed = new Set(entries.map((item) => item.id));
    for (const id of expected) if (!observed.has(id)) semanticBlockers.push(`missing-arxiv-id:${id}`);
    const previousVersions = new Map(array(previousSnapshot?.papers).map((paper) => [paper.id, paper.version]));
    for (const paper of entries) {
      if (previousVersions.has(paper.id) && paper.version < previousVersions.get(paper.id)) semanticBlockers.push(`arxiv-version-regressed:${paper.id}`);
      if (previousVersions.has(paper.id) && paper.version > previousVersions.get(paper.id)) {
        markEvent(`arxiv-version-updated:${paper.id}:v${paper.version}`, "arxiv-version-update", [`${paper.id}v${paper.version}`], {
          kind: "arxiv-version-update",
          artifact_id: paper.id,
          previous_identity: `arxiv:${paper.id}v${previousVersions.get(paper.id)}`,
          current_identity: `arxiv:${paper.id}v${paper.version}`,
        });
      }
    }
    const temporal = temporalSummary(entries);
    details = {
      items_parsed: entries.length,
      ...temporal,
      snapshot: {
        papers: entries.map((item) => ({ id: item.id, version: item.version, updated_at: item.published_at, title: item.title })).sort((a, b) => a.id.localeCompare(b.id)),
      },
    };
  } else if (source.format === "arxiv-abs-page") {
    const expectedId = String(source.expected_id || "");
    const title = decodeHtmlEntities(body.match(/<title\b[^>]*>([^]*?)<\/title>/i)?.[1] || "")
      .replace(/^\[[^\]]+\]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    const versionPattern = new RegExp(`${expectedId.replace(".", "\\.")}v(\\d+)`, "g");
    const versions = [...body.matchAll(versionPattern)].map((match) => Number(match[1])).filter(Number.isFinite);
    const version = versions.length ? Math.max(...versions) : 0;
    const previousPaper = array(previousSnapshot?.papers).find((paper) => paper.id === expectedId);
    if (!expectedId || !body.includes(expectedId)) semanticBlockers.push(`missing-arxiv-id:${expectedId || "unspecified"}`);
    if (!version) semanticBlockers.push("explicit-arxiv-version-missing");
    if (source.expected_title && !title.includes(source.expected_title)) semanticBlockers.push("unexpected-document-title");
    if (previousPaper?.version && version < previousPaper.version) semanticBlockers.push(`arxiv-version-regressed:${expectedId}`);
    if (previousPaper?.version && version > previousPaper.version) {
      markEvent(`arxiv-version-updated:${expectedId}:v${version}`, "arxiv-version-update", [`${expectedId}v${version}`], {
        kind: "arxiv-version-update",
        artifact_id: expectedId,
        previous_identity: `arxiv:${expectedId}v${previousPaper.version}`,
        current_identity: `arxiv:${expectedId}v${version}`,
      });
    }
    details = {
      items_parsed: version ? 1 : 0,
      latest_item_at: "",
      latest_item_title: title,
      oldest_item_at: "",
      window_hours: 0,
      snapshot: {
        papers: version ? [{ id: expectedId, version, updated_at: "", title }] : [],
      },
    };
  } else if (source.format === "raw-html") {
    const title = decodeHtmlEntities(body.match(/<title\b[^>]*>([^]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
    const canonicalUrl = decodeHtmlEntities(body.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i)?.[1]
      || body.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i)?.[1]
      || source.canonical_url);
    const text = normalizedHtmlText(body);
    const textHash = hash(text);
    if (!title) semanticBlockers.push("html-title-missing");
    if (source.expected_title && !title.includes(source.expected_title)) semanticBlockers.push("unexpected-document-title");
    if (text.length < (source.minimum_text_chars || 1_000)) semanticBlockers.push("document-text-too-short");
    if (previousSnapshot?.normalized_text_sha256 && previousSnapshot.normalized_text_sha256 !== textHash) {
      markEvent("primary-document-content-changed-human-semantic-review", "versioned-document-change", [], {
        kind: "primary-document-content-changed",
        artifact_id: canonicalUrl,
        previous_identity: `document-sha256:${previousSnapshot.normalized_text_sha256}`,
        current_identity: `document-sha256:${textHash}`,
      });
    }
    details = {
      items_parsed: 1,
      latest_item_at: parseDate(responseHeaders.last_modified),
      latest_item_title: title,
      oldest_item_at: "",
      window_hours: 0,
      snapshot: {
        title,
        canonical_url: canonicalUrl,
        normalized_text_sha256: textHash,
        normalized_text_chars: text.length,
      },
    };
  } else if (source.format === "huggingface-artifact") {
    const document = JSON.parse(body);
    const files = array(document.siblings).map((file) => cleanText(file?.rfilename, 500)).filter(Boolean).sort();
    const fileSet = new Set(files);
    const expectedFiles = array(source.expected_files_all);
    const reviewFiles = array(source.review_files_all);
    const trackedFiles = expectedFiles.map((path) => ({ path, present: fileSet.has(path) }));
    const revision = cleanText(document.sha, 100);
    const artifactId = cleanText(document.id, 500);
    const lastModified = parseDate(document.lastModified);
    const tags = array(document.tags).map((tag) => cleanText(tag, 300)).filter(Boolean).sort();
    const license = cleanText(document.cardData?.license, 200)
      || tags.find((tag) => tag.startsWith("license:"))?.slice("license:".length)
      || "";
    if (artifactId !== source.expected_artifact_id) semanticBlockers.push("huggingface-artifact-id-mismatch");
    if (!revision) semanticBlockers.push("huggingface-revision-missing");
    if (!lastModified) semanticBlockers.push("huggingface-last-modified-missing");
    if (document.private) semanticBlockers.push("huggingface-artifact-private");
    if (document.gated && document.gated !== false) semanticBlockers.push("huggingface-artifact-gated");
    if (document.disabled) semanticBlockers.push("huggingface-artifact-disabled");
    if (!files.length) semanticBlockers.push("huggingface-file-manifest-empty");
    for (const tracked of trackedFiles) if (!tracked.present) semanticBlockers.push(`huggingface-expected-file-missing:${tracked.path}`);
    for (const path of reviewFiles) if (!fileSet.has(path)) markSourceReview(`huggingface-review-file-missing:${path}`);
    if (previousSnapshot?.revision_sha && previousSnapshot.revision_sha !== revision) {
      markEvent(`huggingface-revision-changed-human-artifact-review:${revision}`, "artifact-revision-change", [], {
        kind: "artifact-revision-change",
        artifact_id: artifactId,
        previous_identity: `huggingface-revision:${previousSnapshot.revision_sha}`,
        current_identity: `huggingface-revision:${revision}`,
      });
    }
    details = {
      items_parsed: artifactId && revision ? 1 : 0,
      latest_item_at: lastModified,
      latest_item_title: artifactId,
      oldest_item_at: "",
      window_hours: 0,
      snapshot: {
        artifact_kind: source.artifact_kind,
        artifact_id: artifactId,
        revision_sha: revision,
        last_modified: lastModified,
        private: Boolean(document.private),
        gated: document.gated || false,
        disabled: Boolean(document.disabled),
        license,
        file_count: files.length,
        tracked_files: trackedFiles,
        review_files: reviewFiles.map((path) => ({ path, present: fileSet.has(path) })),
        tags,
      },
    };
  } else if (source.format === "github-file") {
    const document = JSON.parse(body);
    const encoded = String(document.content || "").replace(/\s+/g, "");
    const text = document.encoding === "base64" ? Buffer.from(encoded, "base64").toString("utf8") : "";
    const normalizedText = text.replace(/\r\n/g, "\n").trim();
    const normalizedHash = hash(normalizedText);
    const structuredFields = {};
    const headings = normalizedText.split("\n")
      .map((line) => line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim() || "")
      .filter(Boolean)
      .slice(0, 24);
    if (document.type !== "file") semanticBlockers.push("github-content-is-not-file");
    if (!document.sha) semanticBlockers.push("github-file-blob-sha-missing");
    if (source.expected_path && document.path !== source.expected_path) semanticBlockers.push("github-file-path-mismatch");
    if (document.encoding !== "base64") semanticBlockers.push("github-file-encoding-unsupported");
    if (normalizedText.length < (source.minimum_text_chars || 500)) semanticBlockers.push("github-file-text-too-short");
    const lowerText = normalizedText.toLowerCase();
    if (source.expected_terms_any?.length && !source.expected_terms_any.some((term) => lowerText.includes(term.toLowerCase()))) {
      semanticBlockers.push("github-file-expected-terms-missing");
    }
    if (source.json_fields?.length) {
      let structuredDocument = null;
      try {
        structuredDocument = JSON.parse(normalizedText);
      } catch {
        semanticBlockers.push("github-file-json-invalid");
      }
      for (const field of source.json_fields) {
        const value = structuredDocument?.[field];
        if (value == null || value === "") {
          semanticBlockers.push(`github-file-json-field-missing:${field}`);
          continue;
        }
        structuredFields[field] = cleanText(value, 500);
        const expectedPattern = source.json_field_patterns?.[field];
        if (expectedPattern && !(new RegExp(expectedPattern).test(structuredFields[field]))) {
          semanticBlockers.push(`github-file-json-field-invalid:${field}`);
        }
      }
    }
    for (const [field, patternText] of Object.entries(source.text_field_patterns || {})) {
      let pattern = null;
      try {
        pattern = new RegExp(patternText, "im");
      } catch {
        semanticBlockers.push(`github-file-text-pattern-invalid:${field}`);
      }
      if (!pattern) continue;
      const value = normalizedText.match(pattern)?.[1] || "";
      if (!value) {
        semanticBlockers.push(`github-file-text-field-missing:${field}`);
        continue;
      }
      structuredFields[field] = field === "declared_current_version" ? normalizeDeclaredMonth(value) : cleanText(value, 500);
    }
    const previousFields = previousSnapshot?.structured_fields || {};
    const changedTextFields = Object.keys(source.text_field_patterns || {}).filter((field) => (
      previousFields[field] && structuredFields[field] && previousFields[field] !== structuredFields[field]
    ));
    if (changedTextFields.includes("declared_current_version")) {
      markEvent("canonical-pointer-changed-human-semantic-review", "versioned-document-change", [structuredFields.declared_current_version], {
        kind: "canonical-pointer-changed",
        path: document.path || source.expected_path || "",
        previous_identity: `declared-current-version:${previousFields.declared_current_version}`,
        current_identity: `declared-current-version:${structuredFields.declared_current_version}`,
      });
    } else if (previousSnapshot?.blob_sha && previousSnapshot.blob_sha !== document.sha) {
      const change = {
        kind: "versioned-document-change",
        path: document.path || source.expected_path || "",
        previous_identity: `git-blob:${previousSnapshot.blob_sha}`,
        current_identity: `git-blob:${document.sha}`,
      };
      if (Object.keys(source.text_field_patterns || {}).length) markSourceReview("versioned-document-changed-human-semantic-review");
      else markEvent("versioned-document-changed-human-semantic-review", "versioned-document-change", [], change);
    }
    details = {
      items_parsed: document.type === "file" ? 1 : 0,
      latest_item_at: "",
      latest_item_title: Object.entries(structuredFields).map(([key, value]) => `${key}=${value}`).join(", ") || headings[0] || document.name || document.path || "",
      oldest_item_at: "",
      window_hours: 0,
      snapshot: {
        path: document.path || "",
        blob_sha: document.sha || "",
        html_url: document.html_url || source.canonical_url,
        normalized_text_sha256: normalizedHash,
        normalized_text_chars: normalizedText.length,
        line_count: normalizedText ? normalizedText.split("\n").length : 0,
        headings,
        structured_fields: structuredFields,
      },
    };
  } else if (source.format === "github-commits") {
    const commits = array(JSON.parse(body)).map((commit) => ({
      sha: String(commit.sha || ""),
      title: cleanText(commit.commit?.message, 500).split("\n")[0],
      url: commit.html_url || source.canonical_url,
      published_at: parseDate(commit.commit?.committer?.date || commit.commit?.author?.date),
    })).filter((commit) => commit.sha && commit.published_at);
    const temporal = temporalSummary(commits);
    const linkHasNext = /rel="next"/.test(responseHeaders.link || "");
    const previousShas = new Set(array(previousSnapshot?.commits).map((commit) => commit.sha));
    const newlyObserved = previousSnapshot ? commits.filter((commit) => !previousShas.has(commit.sha)) : [];
    const commitScope = source.commit_scope || (source.path_scope ? "path" : "");
    if (!commits.length) semanticBlockers.push("empty-commit-list");
    if (!(["path", "repository"].includes(commitScope))) semanticBlockers.push("github-commit-scope-missing");
    if (commitScope === "path" && !source.path_scope) semanticBlockers.push("github-commit-path-scope-missing");
    if (linkHasNext && temporal.window_hours < (source.minimum_window_hours || 48)) semanticBlockers.push("commit-window-too-short");
    if (linkHasNext) warnings.push("pagination-available");
    if (newlyObserved.length) {
      const prefix = commitScope === "repository" ? "repository-commits" : "path-scoped-commits";
      markEvent(`${prefix}-changed-human-diff-review:${newlyObserved.length}`, commitScope === "repository" ? "repository-commit-change" : "path-commit-change", [], {
        kind: commitScope === "repository" ? "repository-commit-change" : "path-commit-change",
        path: source.path_scope || "",
        previous_identity: array(previousSnapshot?.commits)[0]?.sha ? `git-commit:${array(previousSnapshot.commits)[0].sha}` : "unknown",
        current_identity: `git-commit:${newlyObserved[0].sha}`,
      });
    }
    details = {
      items_parsed: commits.length,
      ...temporal,
      pagination_next: linkHasNext,
      newly_observed_commits: newlyObserved.map((commit) => ({ sha: commit.sha, title: commit.title, published_at: commit.published_at })),
      snapshot: {
        commit_scope: commitScope,
        path_scope: source.path_scope,
        commits: commits.slice(0, 50),
      },
    };
  } else if (source.format === "github-releases") {
    const normalizeRelease = (release) => {
      const normalizedBody = normalizedReleaseText(release.body);
      const bodyExcerpt = cleanText(normalizedBody, RELEASE_BODY_EXCERPT_CHARS);
      const assets = array(release.assets).map((asset) => ({
        id: String(asset.id || ""),
        name: cleanText(asset.name, 500),
        size: Number(asset.size || 0),
        digest: cleanText(asset.digest, 200),
        state: cleanText(asset.state, 100),
      })).sort((left, right) => left.id.localeCompare(right.id));
      const repository = githubRepository(source);
      const normalized = {
        id: String(release.id || release.node_id || release.tag_name),
        node_id: cleanText(release.node_id, 300),
        repository,
        title: cleanText(release.name || release.tag_name, 500),
        tag_name: cleanText(release.tag_name, 300),
        url: release.html_url || source.canonical_url,
        published_at: parseDate(release.published_at || release.created_at),
        created_at: parseDate(release.created_at),
        updated_at: parseDate(release.updated_at),
        prerelease: Boolean(release.prerelease),
        immutable: release.immutable === true,
        target_commitish: cleanText(release.target_commitish, 300),
        body_sha256: hash(normalizedBody),
        body_chars: normalizedBody.length,
        body_excerpt: bodyExcerpt,
        body_excerpt_sha256: hash(bodyExcerpt),
        body_excerpt_truncated: normalizedBody.length > RELEASE_BODY_EXCERPT_CHARS,
        asset_manifest_sha256: hash(canonicalJson(assets)),
        assets,
        stream: githubReleaseStream(release.tag_name),
        version_key: githubReleaseVersionKey(release.tag_name),
      };
      normalized.semantic_payload_sha256 = hash(canonicalJson({
        name: normalized.title,
        body_sha256: normalized.body_sha256,
        asset_manifest_sha256: normalized.asset_manifest_sha256,
      }));
      normalized.release_snapshot_sha256 = hash(canonicalJson({
        release_id: normalized.id,
        node_id: normalized.node_id,
        repository: normalized.repository,
        tag_name: normalized.tag_name,
        target_commitish: normalized.target_commitish,
        name: normalized.title,
        published_at: normalized.published_at,
        updated_at: normalized.updated_at,
        prerelease: normalized.prerelease,
        upstream_immutable: normalized.immutable,
        semantic_payload_sha256: normalized.semantic_payload_sha256,
      }));
      return normalized;
    };
    const listReleases = array(JSON.parse(body)).filter((release) => !release.draft).map(normalizeRelease);
    const latestEndpointRelease = latestRelease && !latestRelease.draft ? normalizeRelease(latestRelease) : null;
    const releaseMap = new Map(listReleases.map((release) => [release.id, release]));
    if (latestEndpointRelease && !releaseMap.has(latestEndpointRelease.id)) releaseMap.set(latestEndpointRelease.id, latestEndpointRelease);
    const releases = [...releaseMap.values()].sort((left, right) => right.published_at.localeCompare(left.published_at));
    const stable = releases.filter((release) => !release.prerelease);
    const prerelease = releases.filter((release) => release.prerelease);
    const temporal = temporalSummary(releases);
    const linkHasNext = /rel="next"/.test(responseHeaders.link || "");
    if (!releases.length) semanticBlockers.push("empty-release-list");
    if (!stable.length) semanticBlockers.push("no-stable-release-in-window");
    if (source.latest_url && !latestEndpointRelease) semanticBlockers.push("latest-release-companion-unavailable");
    if (linkHasNext && temporal.window_hours < (source.minimum_window_hours || 48)) semanticBlockers.push("release-window-too-short");
    if (linkHasNext) warnings.push("pagination-available");
    const latestEndpointInList = latestEndpointRelease ? listReleases.some((release) => release.id === latestEndpointRelease.id) : null;
    if (latestEndpointRelease && !latestEndpointInList) {
      warnings.push("latest-endpoint-not-in-release-list");
      markSourceReview(`release-list-lags-latest-endpoint:${latestEndpointRelease.tag_name}`);
    }
    const previousReleases = new Map(array(previousSnapshot?.releases).map((release) => [String(release.id || ""), release]));
    const previousReleasesByTag = new Map(array(previousSnapshot?.releases).map((release) => [String(release.tag_name || ""), release]));
    const newlyObservedStable = previousSnapshot
      ? stable.filter((release) => !previousReleases.has(release.id) && !previousReleasesByTag.has(release.tag_name))
      : [];
    const newlyObservedPrerelease = previousSnapshot
      ? prerelease.filter((release) => !previousReleases.has(release.id) && !previousReleasesByTag.has(release.tag_name))
      : [];
    const recreatedReleases = previousSnapshot
      ? releases.filter((release) => {
        const previousWithTag = previousReleasesByTag.get(release.tag_name);
        return previousWithTag && String(previousWithTag.id) !== release.id;
      })
      : [];
    const renamedReleases = previousSnapshot
      ? releases.filter((release) => {
        const previousWithId = previousReleases.get(release.id);
        return previousWithId && String(previousWithId.tag_name) !== release.tag_name;
      })
      : [];
    const hasCompleteReleaseSemanticIdentity = (release) => [
      "body_sha256",
      "asset_manifest_sha256",
      "semantic_payload_sha256",
      "release_snapshot_sha256",
    ].every((field) => /^[a-f0-9]{64}$/.test(String(release?.[field] || "")));
    const identityMigrations = previousSnapshot
      ? releases.filter((release) => {
        const previous = previousReleases.get(release.id);
        return previous && String(previous.tag_name || "") === release.tag_name
          && !hasCompleteReleaseSemanticIdentity(previous);
      })
      : [];
    const editedReleases = previousSnapshot
      ? releases.filter((release) => {
        const previous = previousReleases.get(release.id);
        return previous && String(previous.tag_name || "") === release.tag_name
          && hasCompleteReleaseSemanticIdentity(previous)
          && ["body_sha256", "asset_manifest_sha256", "semantic_payload_sha256"]
            .some((field) => String(previous[field] ?? "") !== String(release[field] ?? ""));
      })
      : [];
    const metadataOnlyEdits = previousSnapshot
      ? releases.filter((release) => {
        const previous = previousReleases.get(release.id);
        if (!previous || editedReleases.some((item) => item.id === release.id) || identityMigrations.some((item) => item.id === release.id)) return false;
        return ["published_at", "updated_at", "immutable"]
          .some((field) => String(previous[field] ?? "") !== String(release[field] ?? ""));
      })
      : [];
    const targetChanges = previousSnapshot
      ? releases.filter((release) => {
        const previous = previousReleases.get(release.id);
        return previous && String(previous.target_commitish || "") !== release.target_commitish;
      })
      : [];
    if (newlyObservedStable.length) {
      markEvent(`github-stable-releases-changed-human-semantic-review:${newlyObservedStable.length}`, "new-stable-release", newlyObservedStable.map((release) => release.version_key), {
        kind: "new-stable-release",
        artifact_ids: newlyObservedStable.map((release) => `${release.repository}@${release.tag_name}`),
        previous_identity: "not-observed",
        current_identity: newlyObservedStable.map((release) => `github-release-snapshot:${release.repository}@${release.release_snapshot_sha256}`).join(","),
      });
    }
    if (newlyObservedPrerelease.length) {
      markEvent(`github-prerelease-releases-changed-human-semantic-review:${newlyObservedPrerelease.length}`, "new-prerelease", newlyObservedPrerelease.map((release) => release.version_key), {
        kind: "new-prerelease",
        artifact_ids: newlyObservedPrerelease.map((release) => `${release.repository}@${release.tag_name}`),
        previous_identity: "not-observed",
        current_identity: newlyObservedPrerelease.map((release) => `github-release-snapshot:${release.repository}@${release.release_snapshot_sha256}`).join(","),
      });
    }
    if (editedReleases.length) {
      markEvent(`github-release-content-edited-human-semantic-review:${editedReleases.length}`, "mutable-release-edit", editedReleases.map((release) => release.version_key), {
        kind: "mutable-release-edit",
        artifact_ids: editedReleases.map((release) => `${release.repository}@${release.tag_name}`),
        previous_identity: editedReleases.map((release) => `github-release-snapshot:${release.repository}@${previousReleases.get(release.id)?.release_snapshot_sha256 || "legacy"}`).join(","),
        current_identity: editedReleases.map((release) => `github-release-snapshot:${release.repository}@${release.release_snapshot_sha256}`).join(","),
      });
    }
    if (identityMigrations.length) markSourceReview(`github-release-identity-schema-migrated:${identityMigrations.length}`);
    if (metadataOnlyEdits.length) markSourceReview(`github-release-metadata-edited:${metadataOnlyEdits.length}`);
    if (recreatedReleases.length) semanticBlockers.push(`github-release-recreated:${recreatedReleases.map((release) => release.tag_name).join(",")}`);
    if (renamedReleases.length) semanticBlockers.push(`github-release-tag-renamed:${renamedReleases.map((release) => release.id).join(",")}`);
    if (targetChanges.length) markSourceReview(`github-release-target-changed-human-identity-review:${targetChanges.length}`);
    const releaseChangeFlags = [
      ...(newlyObservedStable.length ? ["release-new-stable"] : []),
      ...(newlyObservedPrerelease.length ? ["release-new-prerelease"] : []),
      ...(editedReleases.some((release) => {
        const previous = previousReleases.get(release.id);
        return previous?.body_sha256 !== release.body_sha256;
      }) ? ["release-body-edited"] : []),
      ...(editedReleases.some((release) => {
        const previous = previousReleases.get(release.id);
        return previous?.asset_manifest_sha256 !== release.asset_manifest_sha256;
      }) ? ["release-assets-edited"] : []),
      ...(metadataOnlyEdits.length ? ["release-metadata-edited"] : []),
      ...(targetChanges.length ? ["release-target-changed"] : []),
      ...(recreatedReleases.length ? ["release-recreated"] : []),
      ...(renamedReleases.length ? ["release-tag-renamed"] : []),
    ];
    const streamCounts = {};
    for (const release of releases) streamCounts[release.stream] = (streamCounts[release.stream] || 0) + 1;
    const latestStable = latestEndpointRelease && !latestEndpointRelease.prerelease
      ? latestEndpointRelease
      : stable[0] || null;
    if (latestStable) {
      markSourceReview(`release-tag-commit-not-resolved:${latestStable.tag_name}`);
      if (!latestStable.immutable) markSourceReview(`release-record-mutable-upstream:${latestStable.tag_name}`);
    }
    details = {
      items_parsed: releases.length,
      list_items_parsed: listReleases.length,
      ...temporal,
      stable_count: stable.length,
      prerelease_count: prerelease.length,
      latest_stable: latestStable ? {
        id: latestStable.id,
        node_id: latestStable.node_id,
        repository: latestStable.repository,
        tag_name: latestStable.tag_name,
        version_key: latestStable.version_key,
        published_at: latestStable.published_at,
        stream: latestStable.stream,
        immutable: latestStable.immutable,
        target_commitish: latestStable.target_commitish,
        tag_commit_resolution: "not-fetched",
        body_sha256: latestStable.body_sha256,
        body_chars: latestStable.body_chars,
        body_excerpt: latestStable.body_excerpt,
        body_excerpt_sha256: latestStable.body_excerpt_sha256,
        body_excerpt_truncated: latestStable.body_excerpt_truncated,
        asset_manifest_sha256: latestStable.asset_manifest_sha256,
        semantic_payload_sha256: latestStable.semantic_payload_sha256,
        release_snapshot_sha256: latestStable.release_snapshot_sha256,
      } : null,
      list_latest_stable: listReleases.filter((release) => !release.prerelease).sort((left, right) => right.published_at.localeCompare(left.published_at))[0]?.tag_name || "",
      latest_endpoint_tag: latestEndpointRelease?.tag_name || "",
      latest_endpoint_in_list: latestEndpointInList,
      latest_companion_status: companionStatus,
      release_stream_counts: streamCounts,
      release_change_state: !previousSnapshot
        ? "baseline"
        : recreatedReleases.length || renamedReleases.length
          ? "identity-regressed"
          : [newlyObservedStable.length, newlyObservedPrerelease.length, editedReleases.length].filter(Boolean).length > 1
            ? "mixed"
            : newlyObservedStable.length
              ? "new-stable-release"
              : newlyObservedPrerelease.length
                ? "new-prerelease-release"
                : editedReleases.length
                  ? "mutable-release-edited"
                  : identityMigrations.length
                    ? "identity-schema-migrated"
                  : "unchanged",
      release_change_flags: releaseChangeFlags,
      pagination_next: linkHasNext,
      newly_observed_stable_releases: newlyObservedStable.map((release) => ({ id: release.id, tag_name: release.tag_name, published_at: release.published_at, body_sha256: release.body_sha256 })),
      newly_observed_prerelease_releases: newlyObservedPrerelease.map((release) => ({ id: release.id, tag_name: release.tag_name, published_at: release.published_at, body_sha256: release.body_sha256 })),
      edited_release_snapshots: editedReleases.map((release) => ({ id: release.id, tag_name: release.tag_name, updated_at: release.updated_at, body_sha256: release.body_sha256, asset_manifest_sha256: release.asset_manifest_sha256 })),
      identity_migrated_release_snapshots: identityMigrations.map((release) => ({ id: release.id, tag_name: release.tag_name, release_snapshot_sha256: release.release_snapshot_sha256 })),
      mutated_release_snapshots: editedReleases.map((release) => ({ id: release.id, tag_name: release.tag_name, updated_at: release.updated_at, body_sha256: release.body_sha256 })),
      snapshot: {
        latest_stable: latestStable ? {
          id: latestStable.id,
          node_id: latestStable.node_id,
          repository: latestStable.repository,
          tag_name: latestStable.tag_name,
          version_key: latestStable.version_key,
          published_at: latestStable.published_at,
          prerelease: false,
          immutable: latestStable.immutable,
          target_commitish: latestStable.target_commitish,
          tag_commit_resolution: "not-fetched",
          body_sha256: latestStable.body_sha256,
          body_chars: latestStable.body_chars,
          body_excerpt: latestStable.body_excerpt,
          body_excerpt_sha256: latestStable.body_excerpt_sha256,
          body_excerpt_truncated: latestStable.body_excerpt_truncated,
          asset_manifest_sha256: latestStable.asset_manifest_sha256,
          semantic_payload_sha256: latestStable.semantic_payload_sha256,
          release_snapshot_sha256: latestStable.release_snapshot_sha256,
          updated_at: latestStable.updated_at,
        } : null,
        releases: releases.map((release) => ({
          id: release.id,
          node_id: release.node_id,
          repository: release.repository,
          tag_name: release.tag_name,
          version_key: release.version_key,
          published_at: release.published_at,
          created_at: release.created_at,
          updated_at: release.updated_at,
          prerelease: release.prerelease,
          immutable: release.immutable,
          target_commitish: release.target_commitish,
          title: release.title,
          body_sha256: release.body_sha256,
          body_chars: release.body_chars,
          body_excerpt: release.body_excerpt,
          body_excerpt_sha256: release.body_excerpt_sha256,
          body_excerpt_truncated: release.body_excerpt_truncated,
          asset_manifest_sha256: release.asset_manifest_sha256,
          semantic_payload_sha256: release.semantic_payload_sha256,
          release_snapshot_sha256: release.release_snapshot_sha256,
          stream: release.stream,
        })),
      },
    };
  } else if (source.format === "rss-or-atom") {
    const items = parseFeedItems(body).filter((item) => item.id || item.url || item.title);
    const temporal = temporalSummary(items);
    if (!items.length) semanticBlockers.push("empty-feed");
    if (!temporal.latest_item_at) semanticBlockers.push("feed-items-missing-dates");
    const ageDays = temporal.latest_item_at ? (now.getTime() - Date.parse(temporal.latest_item_at)) / 86_400_000 : Infinity;
    if (Number.isFinite(ageDays) && ageDays > source.stale_after_days) warnings.push(`latest-item-older-than-${source.stale_after_days}d`);
    details = {
      items_parsed: items.length,
      ...temporal,
      snapshot: {
        latest_id: items.sort((left, right) => right.published_at.localeCompare(left.published_at))[0]?.id || "",
        item_count: items.length,
        items: items.slice(0, 100).map((item) => ({
          id: item.id,
          title: item.title,
          url: item.url,
          published_at: item.published_at,
          artifact_links: item.artifact_links,
        })),
      },
    };
  } else {
    throw new Error(`unsupported candidate source format: ${source.format}`);
  }

  if (Buffer.byteLength(body, "utf8") > source.max_bytes * 0.8) warnings.push("payload-near-byte-limit");
  const uniqueEventFlags = [...new Set(eventReviewFlags)].sort();
  const uniqueSourceFlags = [...new Set(sourceReviewFlags)].sort();
  const regressionBlockers = [...new Set(semanticBlockers.filter((blocker) => /regressed|recreated|tag-renamed/.test(blocker)))].sort();
  const onboardingBaseline = !previousSnapshot;
  const observationState = onboardingBaseline
    ? "baseline"
    : regressionBlockers.length
      ? "regressed"
      : uniqueEventFlags.length
        ? "changed"
        : "unchanged";
  const eventKind = observationState === "regressed"
    ? "source-regression"
    : eventKinds.size === 0
      ? "none"
      : eventKinds.size === 1
        ? [...eventKinds][0]
        : "mixed";
  const eventCandidate = observationState === "changed" && semanticBlockers.length === 0;
  return {
    ...details,
    semantic_blockers: [...new Set(semanticBlockers)].sort(),
    warnings: [...new Set(warnings)].sort(),
    onboarding_baseline: onboardingBaseline,
    observation_state: observationState,
    event_kind: eventKind,
    event_version_keys: [...eventVersionKeys].sort(),
    event_candidate: eventCandidate,
    requires_semantic_review: eventCandidate,
    event_review_flags: uniqueEventFlags,
    source_review_flags: uniqueSourceFlags,
    event_blockers: regressionBlockers,
    change_events: changeEvents,
    review_flags: [...new Set([...uniqueEventFlags, ...uniqueSourceFlags])].sort(),
  };
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

function responseHeaderSnapshot(headers, fallback = {}) {
  return {
    content_type: headers.get("content-type") || fallback.content_type || "",
    etag: headers.get("etag") || fallback.etag || "",
    last_modified: headers.get("last-modified") || fallback.last_modified || "",
    link: headers.get("link") || fallback.link || "",
    github_rate_limit_remaining: headers.get("x-ratelimit-remaining") || fallback.github_rate_limit_remaining || "",
    github_rate_limit_reset: headers.get("x-ratelimit-reset") || fallback.github_rate_limit_reset || "",
  };
}

async function fetchCandidateSource(source, cacheDir, fetchImpl = fetch) {
  const startedAt = new Date().toISOString();
  const cachePath = join(cacheDir, `${source.id}.json`);
  const cached = await readJson(cachePath, null);
  let lastError;
  let attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attempts = attempt;
    try {
      const headers = { accept: "*/*", "user-agent": USER_AGENT };
      if (source.url.startsWith("https://api.github.com/")) {
        headers.accept = "application/vnd.github+json";
        headers["x-github-api-version"] = GITHUB_API_VERSION;
        if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      }
      if (cached?.response_headers?.etag) headers["if-none-match"] = cached.response_headers.etag;
      else if (cached?.response_headers?.last_modified) headers["if-modified-since"] = cached.response_headers.last_modified;
      const response = await fetchImpl(source.url, { headers, signal: AbortSignal.timeout(30_000) });
      if (response.status === 304 && cached?.body != null) {
        return {
          body: cached.body,
          responseHeaders: responseHeaderSnapshot(response.headers, cached.response_headers),
          event: {
            source_id: source.id,
            status: "not-modified",
            started_at: startedAt,
            fetched_at: new Date().toISOString(),
            attempts: attempt,
            http_status: 304,
            response_bytes: Buffer.byteLength(cached.body, "utf8"),
            content_sha256: hash(cached.body),
            network_verified: true,
          },
        };
      }
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }
      const body = await readBoundedText(response, source.max_bytes);
      const fetchedAt = new Date().toISOString();
      const responseHeaders = responseHeaderSnapshot(response.headers);
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, `${JSON.stringify({ fetched_at: fetchedAt, response_headers: responseHeaders, body }, null, 2)}\n`);
      return {
        body,
        responseHeaders,
        event: {
          source_id: source.id,
          status: "fresh",
          started_at: startedAt,
          fetched_at: fetchedAt,
          attempts: attempt,
          http_status: response.status,
          response_bytes: Buffer.byteLength(body, "utf8"),
          content_sha256: hash(body),
          network_verified: true,
        },
      };
    } catch (error) {
      lastError = error;
      const permanent = error?.status >= 400 && error?.status < 500 && ![408, 425, 429].includes(error.status);
      if (permanent) break;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  const cacheAge = cached?.fetched_at ? Date.now() - Date.parse(cached.fetched_at) : Infinity;
  if (cached?.body != null && cacheAge <= CACHE_MAX_AGE_MS) {
    return {
      body: cached.body,
      responseHeaders: cached.response_headers || {},
      event: {
        source_id: source.id,
        status: "stale-cache",
        started_at: startedAt,
        fetched_at: cached.fetched_at,
        attempts,
        http_status: null,
        response_bytes: Buffer.byteLength(cached.body, "utf8"),
        content_sha256: hash(cached.body),
        network_verified: false,
        error: String(lastError),
      },
    };
  }
  return {
    body: null,
    responseHeaders: {},
    event: {
      source_id: source.id,
      status: "failed",
      started_at: startedAt,
      fetched_at: new Date().toISOString(),
      attempts,
      http_status: null,
      response_bytes: 0,
      network_verified: false,
      error: String(lastError),
    },
  };
}

export function createCandidateSourceAudit({ now = new Date(), sources = candidateSources, sourceEvents = [], previousAudit = null } = {}) {
  const previousHistory = new Map(array(previousAudit?.source_history).map((history) => [history.source_id, history]));
  const today = localDateKey(now);
  const sourceHistory = sources.map((source) => {
    const event = sourceEvents.find((candidate) => candidate.source_id === source.id) || { source_id: source.id, status: "missing-event", semantic_blockers: ["missing-source-event"], warnings: [] };
    const previous = previousHistory.get(source.id);
    const previousDates = normalizedPastDateKeys(previous?.observed_network_success_dates, today).filter((date) => date !== today);
    const dates = NETWORK_SUCCESS.has(event.status) ? [...new Set([...previousDates, today])].sort().slice(-31) : previousDates;
    const consecutive = consecutiveDayCount(dates, today);
    const semanticBlockers = array(event.semantic_blockers);
    const observationState = event.observation_state || "blocked";
    const semanticHealthyToday = NETWORK_SUCCESS.has(event.status)
      && semanticBlockers.length === 0
      && !["blocked", "regressed"].includes(observationState);
    const previousSemanticHealthyDates = normalizedPastDateKeys(previous?.observed_semantic_healthy_dates, today).filter((date) => date !== today);
    const semanticHealthyDates = semanticHealthyToday
      ? [...new Set([...previousSemanticHealthyDates, today])].sort().slice(-31)
      : previousSemanticHealthyDates;
    const consecutiveSemanticHealthy = consecutiveDayCount(semanticHealthyDates, today);
    const consecutiveStable = Math.min(consecutive, consecutiveSemanticHealthy);
    const ready = consecutiveStable >= MINIMUM_OBSERVATION_DAYS;
    return {
      source_id: source.id,
      observed_network_success_dates: dates,
      consecutive_network_success_days: consecutive,
      observed_semantic_healthy_dates: semanticHealthyDates,
      consecutive_semantic_healthy_days: consecutiveSemanticHealthy,
      consecutive_source_stable_days: consecutiveStable,
      current_status: event.status,
      semantic_blockers: semanticBlockers,
      warnings: array(event.warnings),
      observation_state: observationState,
      event_kind: event.event_kind || "none",
      event_candidate: event.event_candidate === true,
      event_review_flags: array(event.event_review_flags),
      source_review_flags: array(event.source_review_flags),
      review_flags: array(event.review_flags),
      criteria: {
        minimum_observation_days: { required: MINIMUM_OBSERVATION_DAYS, observed: consecutiveStable, passed: consecutiveStable >= MINIMUM_OBSERVATION_DAYS },
        network_stability: { required_days: MINIMUM_OBSERVATION_DAYS, observed_days: consecutive, passed: consecutive >= MINIMUM_OBSERVATION_DAYS },
        semantic_health: { required_blockers: 0, observed_blockers: semanticBlockers.length, passed: semanticBlockers.length === 0 },
        semantic_stability: { required_days: MINIMUM_OBSERVATION_DAYS, observed_days: consecutiveSemanticHealthy, passed: consecutiveSemanticHealthy >= MINIMUM_OBSERVATION_DAYS },
        human_source_review: { required: true, observed: false, passed: false },
      },
      ready_for_human_review: ready,
      automatically_promoted: false,
    };
  });
  const networkFresh = sourceEvents.filter((event) => NETWORK_SUCCESS.has(event.status)).length;
  const hardFailures = sourceEvents.filter((event) => !NETWORK_SUCCESS.has(event.status) || array(event.semantic_blockers).length > 0);
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    mode: "shadow-source-probe",
    status: hardFailures.length ? "degraded" : "ok",
    scope: "candidate-sources-only",
    isolation_policy: {
      affects_production_registry: false,
      affects_production_core_health: false,
      classifies_or_ranks_content: false,
      writes_production_collector_state: false,
      automatic_promotions: [],
    },
    notification_policy: {
      enabled: false,
      eligible: false,
      external_actions: [],
      statement: "This shadow probe cannot publish, message, deploy, or create a WeChat draft.",
    },
    dependency_policy: {
      credentials_required: false,
      github_token_required: false,
      gemini_required: false,
      google_oauth_required: false,
      openai_membership_required: false,
      cloudflare_credentials_required: false,
    },
    metrics: {
      registered_candidate_sources: sources.length,
      network_fresh_sources: networkFresh,
      network_fresh_rate: sources.length ? Number((networkFresh / sources.length).toFixed(4)) : 0,
      semantic_blocked_sources: sourceEvents.filter((event) => array(event.semantic_blockers).length > 0).length,
      warning_sources: sourceEvents.filter((event) => array(event.warnings).length > 0).length,
      ready_for_human_review: sourceHistory.filter((history) => history.ready_for_human_review).length,
      notification_eligible_records: 0,
    },
    source_registry: sources.map((source) => ({ ...source })),
    source_events: sourceEvents,
    source_history: sourceHistory,
  };
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function renderCandidateSourceReview(audit) {
  const sourceMap = new Map(audit.source_registry.map((source) => [source.id, source]));
  const eventMap = new Map(audit.source_events.map((event) => [event.source_id, event]));
  const lines = [
    `# 候选机制来源 Shadow Probe · ${localDateKey(audit.generated_at)}`,
    "",
    "> 该任务只验证候选来源的真实抓取与变化语义；不进入正式 21 源健康率，不分类文章，不发送通知。",
    "",
    "## 摘要",
    "",
    `- 模式：\`${audit.mode}\`；状态：\`${audit.status}\``,
    `- 网络新鲜：${audit.metrics.network_fresh_sources}/${audit.metrics.registered_candidate_sources}（${(audit.metrics.network_fresh_rate * 100).toFixed(2)}%）`,
    `- 语义阻断来源：${audit.metrics.semantic_blocked_sources}`,
    `- 已满 7 天、可提交人工准入复核：${audit.metrics.ready_for_human_review}`,
    `- 通知资格：${audit.notification_policy.eligible ? "是" : "否"}；外部动作：${audit.notification_policy.external_actions.length}`,
    "",
    "## 来源状态",
    "",
    "| 来源 | 角色/权威 | 状态 | 不可变/快照身份 | 条目/字节 | 最新 | 连续稳定天数 | 语义阻断 / 警告 |",
    "|---|---|---|---|---:|---|---:|---|",
  ];
  for (const history of audit.source_history) {
    const source = sourceMap.get(history.source_id);
    const event = eventMap.get(history.source_id) || {};
    const issues = [...history.semantic_blockers.map((value) => `阻断:${value}`), ...history.warnings.map((value) => `警告:${value}`), ...history.review_flags.map((value) => `复核:${value}`)].join("；") || "无";
    lines.push(`| [${markdownCell(source.label)}](${source.canonical_url}) | ${source.role}/${source.authority_tier} | ${event.status || "missing"} | ${markdownCell(observedSourceIdentity(event))} | ${event.items_parsed ?? 0}/${event.response_bytes ?? 0} | ${markdownCell(event.latest_item_at || "-")} | ${history.consecutive_source_stable_days} | ${markdownCell(issues)} |`);
  }
  lines.push(
    "",
    "## 人工准入原则",
    "",
    "- 七个连续自然日必须同时满足真实网络成功、无语义阻断且身份未回退；通过后也只代表可提交人工复核，不会自动写入正式 registry。",
    "- `editorial-discovery` 只增加发现与关注信号，不能替代论文、代码、权重、release 或独立实验。",
    "- GitHub release 分页、arXiv 版本倒退、Constitution 路径变更均按 semantic failure 处理，即使 HTTP 为 200。",
    "- 任一 stale cache 只能维持审计可读性，不能计入当天网络成功，也不能形成通知。",
    "",
    "每日人工备注：",
    "",
    "- 不可变身份是否与 canonical upstream 一致（arXiv vN / Git commit、blob、tree / HF revision / response hash）：",
    "- 是否存在源身份、作者独立性或 license 变化：",
    "- 是否有窗口截断、schema 漂移、异常体量或 required-file 缺失：",
    "- 是否把 artifact availability 误写成 result reproduction 或 causal mechanism：",
    "- 是否建议继续 shadow probe：是（默认）",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export async function runCandidateSourceProbe({
  sources = candidateSources,
  outputPath = process.env.CANDIDATE_PROBE_OUTPUT_PATH || "work/candidate-source-probe/audit.json",
  statePath = process.env.CANDIDATE_PROBE_STATE_PATH || "work/candidate-source-probe/audit.json",
  cacheDir = process.env.CANDIDATE_PROBE_CACHE_DIR || "work/candidate-source-probe/cache",
  reviewPath = process.env.CANDIDATE_PROBE_REVIEW_PATH || "work/candidate-source-probe/review.md",
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  const previousAudit = await readJson(statePath, null);
  const previousEvents = new Map(array(previousAudit?.source_events).map((event) => [event.source_id, event]));
  const sourceEvents = [];
  for (const source of sources) {
    const fetched = await fetchCandidateSource(source, cacheDir, fetchImpl);
    const event = { ...fetched.event };
    let companion = null;
    if (source.latest_url) {
      companion = await fetchCandidateSource({
        ...source,
        id: `${source.id}--latest`,
        url: source.latest_url,
        max_bytes: 250_000,
      }, cacheDir, fetchImpl);
      event.companion_status = companion.event.status;
      event.companion_http_status = companion.event.http_status;
      event.companion_response_bytes = companion.event.response_bytes;
      event.response_bytes += companion.event.response_bytes;
      event.network_verified = event.network_verified && companion.event.network_verified;
      event.content_sha256 = hash(`${event.content_sha256 || ""}:${companion.event.content_sha256 || ""}`);
      if (!companion.body) event.status = "failed";
      else if (!NETWORK_SUCCESS.has(companion.event.status) || !NETWORK_SUCCESS.has(event.status)) event.status = "stale-cache";
      else event.status = event.status === "not-modified" && companion.event.status === "not-modified" ? "not-modified" : "fresh";
    }
    if (fetched.body != null) {
      try {
        const parsed = parseCandidateSource(source, fetched.body, {
          responseHeaders: fetched.responseHeaders,
          previousSnapshot: previousEvents.get(source.id)?.snapshot || null,
          now,
          latestRelease: companion?.body ? JSON.parse(companion.body) : null,
          companionStatus: companion?.event.status || "not-required",
        });
        const remaining = [fetched.responseHeaders.github_rate_limit_remaining, companion?.responseHeaders?.github_rate_limit_remaining]
          .filter((value) => value != null && String(value).trim() !== "")
          .map(Number).filter(Number.isFinite);
        Object.assign(event, parsed, {
          content_type: fetched.responseHeaders.content_type || "",
          etag_present: Boolean(fetched.responseHeaders.etag),
          last_modified_present: Boolean(fetched.responseHeaders.last_modified),
          github_rate_limit_remaining: remaining.length ? String(Math.min(...remaining)) : "",
        });
      } catch (error) {
        event.status = "parse-failed";
        event.error = String(error);
        event.semantic_blockers = ["parse-failed"];
        event.warnings = [];
        event.observation_state = "blocked";
        event.event_kind = "none";
        event.event_candidate = false;
        event.requires_semantic_review = false;
        event.event_review_flags = [];
        event.source_review_flags = [];
        event.review_flags = [];
        event.items_parsed = 0;
      }
    } else {
      event.semantic_blockers = ["fetch-failed"];
      event.warnings = [];
      event.observation_state = "blocked";
      event.event_kind = "none";
      event.event_candidate = false;
      event.requires_semantic_review = false;
      event.event_review_flags = [];
      event.source_review_flags = [];
      event.review_flags = [];
      event.items_parsed = 0;
    }
    sourceEvents.push(event);
  }
  const audit = createCandidateSourceAudit({ now, sources, sourceEvents, previousAudit });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
  await mkdir(dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, renderCandidateSourceReview(audit));
  return audit;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  runCandidateSourceProbe().then((audit) => {
    console.log(JSON.stringify({
      mode: audit.mode,
      status: audit.status,
      candidate_sources: audit.metrics.registered_candidate_sources,
      network_fresh_rate: audit.metrics.network_fresh_rate,
      semantic_blocked_sources: audit.metrics.semantic_blocked_sources,
      ready_for_human_review: audit.metrics.ready_for_human_review,
      notification_eligible_records: audit.metrics.notification_eligible_records,
    }));
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
