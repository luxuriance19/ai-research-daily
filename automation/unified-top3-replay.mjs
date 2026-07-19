#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HOUR_MS = 60 * 60 * 1000;
const MAX_AGE_HOURS = 48;
const FULL_FRESHNESS_HOURS = 36;
const MINIMUM_SCORE = 6;
const MECHANISM_PRIMARY_TRACK_SCORE = 5.5;
const MAX_SELECTED = 3;
const CURRENT_SOURCE_STATES = new Set(["fresh", "not-modified"]);
const MECHANISM_LAYERS = new Set(["B0", "M1", "M2", "M3", "M4"]);
const HARNESS_LAYERS = new Set(["H1", "E1"]);
const LAYER_TIE_PRIORITY = Object.freeze({ M1: 6, M4: 5, M3: 4, M2: 3, B0: 2, E1: 2, H1: 1 });
const SECTION_TIE_PRIORITY = Object.freeze({ "new-model": 4, mechanism: 3, "harness-eval": 2, "compute-system": 1 });

export const UNIFIED_TOP3_POLICY = Object.freeze({
  schema_version: 3,
  mode: "offline-unified-top3-replay",
  max_age_hours: MAX_AGE_HOURS,
  full_freshness_hours: FULL_FRESHNESS_HOURS,
  minimum_score: MINIMUM_SCORE,
  mechanism_primary_track: Object.freeze({
    minimum_score: MECHANISM_PRIMARY_TRACK_SCORE,
    required_primary_identity: 2,
    required_technical_delta: 3,
    minimum_freshness: 0.5,
    allowed_evidence_grades: Object.freeze(["G1", "G2", "G3", "G4"]),
    purpose: "admit fresh primary mechanism work without requiring community attention or a linked artifact",
  }),
  max_selected: MAX_SELECTED,
  max_per_primary_section: 1,
  max_per_organization: 2,
  score_components: Object.freeze({
    primary_identity: 2,
    technical_delta: 3,
    artifact: 2,
    independent_attention: 2,
    freshness: 1,
  }),
  notification_enabled: false,
  external_actions: Object.freeze([]),
});

const array = (value) => Array.isArray(value) ? value : [];
const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

function latestInputTime(mechanismAudit, techAudit, modelComputeAudit) {
  const values = [mechanismAudit?.generated_at, techAudit?.generated_at, modelComputeAudit?.generated_at].map(Date.parse).filter(Number.isFinite);
  if (!values.length) throw new Error("input audits must expose generated_at");
  return new Date(Math.max(...values));
}

function ageHours(publishedAt, now) {
  const value = Date.parse(publishedAt || "");
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - value) / HOUR_MS;
}

function primarySectionFromLayer(layer) {
  if (MECHANISM_LAYERS.has(layer)) return "mechanism";
  if (HARNESS_LAYERS.has(layer)) return "harness-eval";
  return null;
}

function primarySectionFromTech(item) {
  const sections = new Set(array(item?.daily_sections));
  if (sections.has("new-model")) return "new-model";
  if (sections.has("compute-chip")) return "compute-system";
  if (sections.has("mechanism")) return "mechanism";
  if (sections.has("evaluation") || sections.has("harness")) return "harness-eval";
  return null;
}

function layerFromTech(item, section) {
  const sections = new Set(array(item?.daily_sections));
  if (section === "new-model") return "model-release";
  if (section === "compute-system") return "C1-C4";
  if (section === "mechanism") return "M1-M4";
  if (sections.has("evaluation")) return "E1";
  return "H1";
}

function organizationFromTech(item) {
  const releaseRepo = item?.primary_identity_hint?.repository;
  if (releaseRepo) return String(releaseRepo).split("/")[0].toLowerCase();
  try {
    return new URL(item?.canonical_url || "").hostname.replace(/^www\./, "");
  } catch {
    return String(item?.independence_group || item?.source_id || "unknown");
  }
}

function organizationFromMechanism(record) {
  if (String(record?.canonical_id || "").startsWith("arxiv:")) return String(record.canonical_id);
  const officialSource = array(record?.sources).find((source) => source?.official === true);
  return String(officialSource?.id || array(record?.source_ids)[0] || record?.canonical_id || "unknown");
}

function canonicalUrlIdentity(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    let pathname = url.pathname.replace(/\/{2,}/g, "/");
    if (hostname === "kimi.com") pathname = pathname.replace(/^\/en\/blog\//, "/blog/");
    pathname = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
    return `url:${hostname}${pathname}`.toLowerCase();
  } catch {
    return "";
  }
}

function canonicalStoryIdentity(candidate) {
  if (candidate?.normalized_event_identity) return `event:${String(candidate.normalized_event_identity).toLowerCase()}`;
  return canonicalUrlIdentity(candidate?.canonical_url) || `identity:${String(candidate?.story_id || "unknown").toLowerCase()}`;
}

function officialAnnouncementIdentityFromUrl(value) {
  const normalized = canonicalUrlIdentity(value).replace(/^url:/, "");
  return normalized ? `official-announcement:${normalized}` : "";
}

function normalizedArtifactEventIdentity(identity, url) {
  const value = String(identity || "");
  if (value.startsWith("official-article:")) return officialAnnouncementIdentityFromUrl(url);
  if (value.startsWith("github-release:")) return `git-release:${value.slice("github-release:".length).toLowerCase()}`;
  if (value.startsWith("github-commit:")) return `git-commit:${value.slice("github-commit:".length).toLowerCase()}`;
  return "";
}

function officialTechArtifactUrl(item) {
  const fingerprint = String(item?.normalized_event_fingerprint || "").toLowerCase();
  if (!fingerprint.startsWith("official-announcement:")) return "";
  return String(array(item?.artifact_links).find((link) =>
    officialAnnouncementIdentityFromUrl(link?.url) === fingerprint)?.url || "");
}

function currentMechanismSourceIds(mechanismAudit) {
  return new Set(array(mechanismAudit?.source_events)
    .filter((event) => CURRENT_SOURCE_STATES.has(event?.status))
    .map((event) => event.source_id));
}

function mechanismIdentityReady(record) {
  const id = String(record?.canonical_id || "");
  if (/^(?:arxiv|github-release|github-commit|doi|openreview|huggingface):/i.test(id)) return true;
  return array(record?.sources).some((source) => source?.official === true
    && ["official-article", "versioned-policy", "versioned-policy-text", "official-code", "official-model"].includes(source?.artifact_type));
}

function mechanismArtifactScore(record) {
  const types = new Set(array(record?.artifact_types));
  if ([...types].some((type) => !["paper", "official-article", "discovery-signal"].includes(type))) return 2;
  if (types.has("official-article")) return 1;
  return 0;
}

function mechanismAttentionScore(record) {
  return array(record?.source_ids).includes("huggingface-daily") ? 1 : 0;
}

function techAttentionScore(item) {
  const groups = new Set(array(item?.source_records)
    .filter((record) => record?.source_id !== "official-github-releases-existing-snapshots")
    .map((record) => record?.independence_group)
    .filter(Boolean));
  if (groups.size >= 3) return 2;
  if (groups.size === 2) return 1.5;
  if (groups.size === 1) return 1;
  return 0;
}

function techIdentityReady(item) {
  if (item?.editorial_identity_ready !== true || item?.editorial_bridge_eligible !== true) return false;
  if (["canonical-official-announcement", "artifact-official-announcement"].includes(item?.normalized_event_identity_basis)) return true;
  return /^(?:git-release|git-commit|arxiv|openreview|doi|huggingface):/i.test(String(item?.normalized_event_fingerprint || ""));
}

function techTechnicalScore(item, section) {
  if (section === "new-model" && ["canonical-official-announcement", "artifact-official-announcement"].includes(item?.normalized_event_identity_basis)) return 3;
  if (item?.release_semantic_review?.has_semantic_delta_cue === true) return 2;
  if (section === "mechanism" || section === "compute-system") return 2;
  return 1;
}

function techArtifactScore(item) {
  if (item?.discovery_kind === "github-release" && item?.release_semantic_review?.has_semantic_delta_cue === true) return 2;
  if (["canonical-official-announcement", "artifact-official-announcement"].includes(item?.normalized_event_identity_basis)) return 1;
  if (/^(?:git-release|git-commit|arxiv|openreview|doi|huggingface):/i.test(String(item?.normalized_event_fingerprint || ""))) return 2;
  return 0;
}

function freshnessScore(age) {
  if (age <= FULL_FRESHNESS_HOURS) return 1;
  if (age <= MAX_AGE_HOURS) return 0.5;
  return 0;
}

function scoreCandidate({ identity, technical, artifact, attention, freshness, penalty = 0 }) {
  const total = round(identity + technical + artifact + attention + freshness + penalty);
  return { primary_identity: identity, technical_delta: technical, artifact, independent_attention: attention, freshness, penalty, total };
}

function mechanismLimitations(record, artifactScore) {
  const limitations = [];
  if (record?.evidence_grade === "G1") limitations.push("author-reported-preprint-or-official-claim-no-independent-reproduction");
  if (artifactScore === 0) limitations.push("no-verified-linked-artifact-in-current-snapshot");
  if (record?.primary_layer === "E1") limitations.push("score-comparability-not-proven");
  if (record?.primary_layer === "H1") limitations.push("harness-capability-uplift-not-proven");
  if (record?.daily_window_state === "retained-from-prior-snapshot") limitations.push("retained-editorial-snapshot-not-fresh-change-evidence");
  return limitations;
}

function techLimitations(item, layer) {
  const limitations = [];
  if (item?.primary_verified !== true) limitations.push("primary-claim-not-yet-verified");
  if (item?.discovery_kind === "github-release") limitations.push("release-occurrence-does-not-prove-capability-uplift");
  if (layer === "E1") limitations.push("score-comparability-not-proven");
  if (item?.release_semantic_review?.human_semantic_review_required === true) limitations.push("human-semantic-review-required");
  if (item?.daily_snapshot_state === "contains-retained-network-verified-cache") limitations.push("retained-network-verified-cache-not-fresh-change-evidence");
  return limitations;
}

function modelComputeLimitations(item, source) {
  const limitations = ["primary-claim-not-yet-verified"];
  if (source?.lane === "new-model") limitations.push("announcement-does-not-prove-weights-code-license-or-independent-performance");
  if (["official-compute-release", "official-compute-prerelease"].includes(item?.kind)) limitations.push("release-occurrence-does-not-prove-capability-uplift");
  if (item?.metadata?.vendor_claim_only === true) limitations.push("vendor-claim-configuration-and-baseline-not-yet-verified");
  if (item?.metadata?.semantic_review?.human_semantic_review_required === true) limitations.push("human-semantic-review-required");
  return limitations;
}

function modelComputeTechnicalScore(item, source) {
  if (source?.lane === "new-model" && item?.kind === "official-model-announcement-index-item") return 3;
  if (["official-compute-release", "official-compute-prerelease"].includes(item?.kind)) return 2;
  if (source?.lane === "compute-system") return 2;
  return 1;
}

function modelComputeArtifactScore(item) {
  if (["official-compute-release", "official-compute-prerelease"].includes(item?.kind)) return 2;
  if (/^(?:github-release|huggingface):/i.test(String(item?.identity || ""))) return 2;
  if (String(item?.identity || "").startsWith("official-article:")) return 1;
  return 0;
}

function mechanismCandidate(record, now, freshSources) {
  const age = ageHours(record?.published_at, now);
  const reasons = [];
  if (!(age >= 0 && age <= MAX_AGE_HOURS)) reasons.push("outside-48-hour-window");
  if (record?.concrete_mechanism_delta !== true) reasons.push("no-concrete-technical-delta");
  if (!/^G[1-4]$/.test(String(record?.evidence_grade || ""))) reasons.push("insufficient-primary-evidence");
  if (!mechanismIdentityReady(record)) reasons.push("no-primary-identity");
  const isDailyWindowProjection = ["current-source", "retained-from-prior-snapshot"].includes(record?.daily_window_state);
  if (isDailyWindowProjection) {
    if (record?.manual_review_only !== true || record?.claim_evidence_allowed !== false || record?.notification_eligible !== false) reasons.push("unsafe-editorial-window-projection");
  } else if (!array(record?.source_ids).some((sourceId) => freshSources.has(sourceId))) {
    reasons.push("no-current-source-snapshot");
  }
  const section = primarySectionFromLayer(record?.primary_layer);
  if (!section) reasons.push("outside-four-stream-taxonomy");
  if (reasons.length) return { candidate: null, reasons };

  const artifact = mechanismArtifactScore(record);
  const scores = scoreCandidate({
    identity: 2,
    technical: 3,
    artifact,
    attention: mechanismAttentionScore(record),
    freshness: freshnessScore(age),
  });
  return {
    candidate: {
      story_id: String(record.canonical_id),
      source_lane: "mechanism-watch",
      primary_section: section,
      mechanism_layer: record.primary_layer,
      organization: organizationFromMechanism(record),
      title: record.title,
      canonical_url: record.canonical_url,
      published_at: record.published_at,
      age_hours: round(age),
      evidence_grade: record.evidence_grade,
      source_ids: array(record.source_ids),
      change_state: record.change,
      score: scores,
      limitations: mechanismLimitations(record, artifact),
      primary_verification_required: true,
      manual_review_only: true,
      claim_evidence_allowed: false,
      notification_eligible: false,
    },
    reasons: [],
  };
}

function techCandidate(item, now, officialEventAnchors = new Map()) {
  const eventIdentity = String(item?.normalized_event_fingerprint || "").toLowerCase();
  const officialAnchor = officialEventAnchors.get(eventIdentity);
  const eventPublishedAt = officialAnchor?.published_at || item?.published_at;
  const age = ageHours(eventPublishedAt, now);
  const reasons = [];
  const section = primarySectionFromTech(item);
  if (!(age >= 0 && age <= MAX_AGE_HOURS)) reasons.push("outside-48-hour-window");
  if (!section) reasons.push("outside-four-stream-taxonomy");
  if (!techIdentityReady(item)) reasons.push("no-primary-identity-bridge");
  if (item?.performance_claim === true && item?.performance_configuration_complete !== true) reasons.push("vendor-performance-config-incomplete");
  if (item?.discovery_kind === "github-release" && item?.release_semantic_review?.has_semantic_delta_cue !== true) reasons.push("release-without-semantic-delta");
  if (reasons.length) return { candidate: null, reasons };

  const layer = layerFromTech(item, section);
  const scores = scoreCandidate({
    identity: 2,
    technical: techTechnicalScore(item, section),
    artifact: techArtifactScore(item),
    attention: techAttentionScore(item),
    freshness: freshnessScore(age),
  });
  const officialArtifactUrl = officialTechArtifactUrl(item);
  return {
    candidate: {
      story_id: String(item.canonical_story_key),
      source_lane: "tech-discovery",
      primary_section: section,
      mechanism_layer: layer,
      organization: officialAnchor?.organization || organizationFromTech(item),
      title: officialAnchor?.title || item.title,
      canonical_url: officialArtifactUrl || item.canonical_url,
      normalized_event_identity: String(item.normalized_event_fingerprint || ""),
      published_at: eventPublishedAt,
      discovery_published_at: item.published_at,
      age_hours: round(age),
      evidence_grade: "discovery-only",
      source_ids: [...new Set(array(item.source_records).map((record) => record.source_id).filter(Boolean))],
      change_state: item.change_candidate ? "new-change" : "current-window",
      score: scores,
      limitations: techLimitations(item, layer),
      primary_verification_required: true,
      manual_review_only: true,
      claim_evidence_allowed: false,
      notification_eligible: false,
    },
    reasons: [],
  };
}

function modelComputeCandidate(item, now, sourceById, eventBySourceId) {
  const source = sourceById.get(item?.source_id);
  const event = eventBySourceId.get(item?.source_id);
  const age = ageHours(item?.published_at, now);
  const reasons = [];
  if (!source || !new Set(["new-model", "compute-system"]).has(source?.lane)) reasons.push("unknown-model-compute-source");
  if (!event || !CURRENT_SOURCE_STATES.has(event?.status)) reasons.push("no-current-model-compute-source-snapshot");
  if (!array(event?.current_window_items).some((record) => record?.identity === item?.identity)) reasons.push("candidate-not-in-current-source-window");
  if (!(age >= 0 && age <= MAX_AGE_HOURS)) reasons.push("outside-48-hour-window");
  if (item?.editorial_gate?.eligible !== true || array(item?.editorial_gate?.reasons).length) reasons.push("model-compute-editorial-gate-not-passed");
  if (item?.manual_review_only !== true || item?.primary_verification_required !== true
    || item?.claim_evidence_allowed !== false || item?.notification_eligible !== false) reasons.push("unsafe-model-compute-projection");
  if (source?.role === "official-organization-artifact-discovery" && source?.identity_binding !== "human-approved-official-organization") reasons.push("official-organization-identity-binding-pending-human-signoff");
  if (reasons.length) return { candidate: null, reasons };

  const section = source.lane;
  const artifact = modelComputeArtifactScore(item);
  const scores = scoreCandidate({
    identity: 2,
    technical: modelComputeTechnicalScore(item, source),
    artifact,
    attention: 0,
    freshness: freshnessScore(age),
  });
  const normalizedEventIdentity = normalizedArtifactEventIdentity(item?.identity, item?.url);
  return {
    candidate: {
      story_id: String(item.identity),
      source_lane: "model-compute-shadow",
      primary_section: section,
      mechanism_layer: section === "new-model" ? "model-release" : "C1-C4",
      organization: String(source.independence_group || source.id || "unknown").toLowerCase(),
      title: item.title,
      canonical_url: item.url,
      normalized_event_identity: normalizedEventIdentity,
      published_at: item.published_at,
      age_hours: round(age),
      evidence_grade: "discovery-only",
      source_ids: [item.source_id],
      change_state: "current-window",
      score: scores,
      limitations: modelComputeLimitations(item, source),
      primary_verification_required: true,
      manual_review_only: true,
      claim_evidence_allowed: false,
      notification_eligible: false,
    },
    reasons: [],
  };
}

function compareCandidates(left, right) {
  return right.score.total - left.score.total
    || right.score.primary_identity - left.score.primary_identity
    || right.score.technical_delta - left.score.technical_delta
    || right.score.artifact - left.score.artifact
    || right.score.independent_attention - left.score.independent_attention
    || (LAYER_TIE_PRIORITY[right.mechanism_layer] || 0) - (LAYER_TIE_PRIORITY[left.mechanism_layer] || 0)
    || (SECTION_TIE_PRIORITY[right.primary_section] || 0) - (SECTION_TIE_PRIORITY[left.primary_section] || 0)
    || Date.parse(right.published_at) - Date.parse(left.published_at)
    || String(left.title).localeCompare(String(right.title), "en");
}

function primaryRepresentativePriority(candidate) {
  if (candidate.source_lane === "model-compute-shadow") return 3;
  if (candidate.source_lane === "mechanism-watch") return 2;
  return 1;
}

function mergedScore(primary, supplemental) {
  return scoreCandidate({
    identity: primary.score.primary_identity,
    technical: primary.score.technical_delta,
    artifact: primary.score.artifact,
    attention: Math.max(primary.score.independent_attention, supplemental.score.independent_attention),
    freshness: primary.score.freshness,
    penalty: primary.score.penalty || 0,
  });
}

function deduplicateCandidates(candidates) {
  const byStory = new Map();
  for (const candidate of candidates) {
    const identity = canonicalStoryIdentity(candidate);
    const projected = {
      ...candidate,
      story_id: identity,
      canonical_story_identity: identity,
      story_aliases: [candidate.story_id],
      source_lanes: [candidate.source_lane],
    };
    const existing = byStory.get(identity);
    if (!existing) {
      byStory.set(identity, projected);
      continue;
    }
    const projectedPriority = primaryRepresentativePriority(projected);
    const existingPriority = primaryRepresentativePriority(existing);
    const winner = projectedPriority !== existingPriority
      ? projectedPriority > existingPriority ? projected : existing
      : compareCandidates(projected, existing) < 0 ? projected : existing;
    const loser = winner === projected ? existing : projected;
    byStory.set(identity, {
      ...winner,
      score: mergedScore(winner, loser),
      representative_source_lane: winner.source_lane,
      story_aliases: [...new Set([...array(winner.story_aliases), ...array(loser.story_aliases)])].sort(),
      source_ids: [...new Set([...array(winner.source_ids), ...array(loser.source_ids)])].sort(),
      source_lanes: [...new Set([...array(winner.source_lanes), ...array(loser.source_lanes)])].sort(),
      limitations: [...new Set([...array(winner.limitations), ...array(loser.limitations)])].sort(),
    });
  }
  return [...byStory.values()];
}

function selectionRule(candidate) {
  if (candidate.score.total >= MINIMUM_SCORE) return "standard-six-point-threshold";
  const primaryTrack = UNIFIED_TOP3_POLICY.mechanism_primary_track;
  if (candidate.primary_section === "mechanism"
    && candidate.score.total >= primaryTrack.minimum_score
    && candidate.score.primary_identity === primaryTrack.required_primary_identity
    && candidate.score.technical_delta === primaryTrack.required_technical_delta
    && candidate.score.freshness >= primaryTrack.minimum_freshness
    && primaryTrack.allowed_evidence_grades.includes(candidate.evidence_grade)) return "mechanism-primary-track";
  return "";
}

function selectTopThree(candidates) {
  const selected = [];
  const sectionCounts = new Map();
  const organizationCounts = new Map();
  for (const candidate of [...candidates].sort(compareCandidates)) {
    const rule = selectionRule(candidate);
    if (!rule) continue;
    if ((sectionCounts.get(candidate.primary_section) || 0) >= 1) continue;
    if ((organizationCounts.get(candidate.organization) || 0) >= 2) continue;
    selected.push({ ...candidate, rank: selected.length + 1, selection_rule: rule });
    sectionCounts.set(candidate.primary_section, (sectionCounts.get(candidate.primary_section) || 0) + 1);
    organizationCounts.set(candidate.organization, (organizationCounts.get(candidate.organization) || 0) + 1);
    if (selected.length === MAX_SELECTED) break;
  }
  return selected;
}

function incrementReasons(target, reasons) {
  for (const reason of reasons) target[reason] = (target[reason] || 0) + 1;
}

export function buildUnifiedTop3Replay({ mechanismAudit, techAudit, modelComputeAudit = null, now, inputFingerprints = {} }) {
  const observedAt = now ? new Date(now) : latestInputTime(mechanismAudit, techAudit, modelComputeAudit);
  if (!Number.isFinite(observedAt.getTime())) throw new Error("invalid replay time");
  const freshSources = currentMechanismSourceIds(mechanismAudit);
  const exclusionCounts = {};
  const candidates = [];
  const modelComputeSources = new Map(array(modelComputeAudit?.source_registry).map((source) => [source.id, source]));
  const officialEventAnchors = new Map(array(modelComputeAudit?.daily_editorial_candidates)
    .map((item) => ({ item, source: modelComputeSources.get(item?.source_id) }))
    .filter(({ item, source }) => source?.lane === "new-model" && item?.kind === "official-model-announcement-index-item")
    .map(({ item, source }) => [normalizedArtifactEventIdentity(item?.identity, item?.url), {
      title: item.title,
      published_at: item.published_at,
      organization: String(source.independence_group || source.id || "unknown").toLowerCase(),
    }]));
  const mechanismRecords = Array.isArray(mechanismAudit?.daily_current_window_records)
    ? mechanismAudit.daily_current_window_records
    : array(mechanismAudit?.records);

  for (const record of mechanismRecords) {
    const result = mechanismCandidate(record, observedAt, freshSources);
    if (result.candidate) candidates.push(result.candidate);
    else incrementReasons(exclusionCounts, result.reasons);
  }
  for (const item of array(techAudit?.daily_current_window_review)) {
    const result = techCandidate(item, observedAt, officialEventAnchors);
    if (result.candidate) candidates.push(result.candidate);
    else incrementReasons(exclusionCounts, result.reasons);
  }
  const modelComputeEvents = new Map(array(modelComputeAudit?.source_events).map((event) => [event.source_id, event]));
  for (const item of array(modelComputeAudit?.daily_editorial_candidates)) {
    const result = modelComputeCandidate(item, observedAt, modelComputeSources, modelComputeEvents);
    if (result.candidate) candidates.push(result.candidate);
    else incrementReasons(exclusionCounts, result.reasons);
  }

  const eligibleCandidates = deduplicateCandidates(candidates).sort(compareCandidates);
  const selected = selectTopThree(eligibleCandidates);
  const selectedSections = new Set(selected.map((item) => item.primary_section));
  const missingSections = ["new-model", "compute-system", "mechanism", "harness-eval"].filter((section) => !selectedSections.has(section));
  const inputSnapshot = {
    mechanism_generated_at: mechanismAudit?.generated_at || null,
    tech_discovery_generated_at: techAudit?.generated_at || null,
    model_compute_generated_at: modelComputeAudit?.generated_at || null,
    mechanism_fingerprint: inputFingerprints.mechanism || sha256(JSON.stringify(mechanismAudit)),
    tech_discovery_fingerprint: inputFingerprints.tech || sha256(JSON.stringify(techAudit)),
    model_compute_fingerprint: modelComputeAudit ? inputFingerprints.modelCompute || sha256(JSON.stringify(modelComputeAudit)) : null,
  };

  const audit = {
    schema_version: 3,
    generated_at: observedAt.toISOString(),
    mode: "offline-unified-top3-replay",
    status: selected.length > 0 ? "review-ready" : "no-qualified-stories",
    policy: UNIFIED_TOP3_POLICY,
    input_snapshots: inputSnapshot,
    metrics: {
      mechanism_records_read: mechanismRecords.length,
      mechanism_change_records_available: array(mechanismAudit?.records).length,
      tech_current_window_records_read: array(techAudit?.daily_current_window_review).length,
      model_compute_editorial_candidates_read: array(modelComputeAudit?.daily_editorial_candidates).length,
      eligible_candidates: eligibleCandidates.length,
      candidates_at_or_above_threshold: eligibleCandidates.filter((item) => item.score.total >= MINIMUM_SCORE).length,
      mechanism_primary_track_candidates: eligibleCandidates.filter((item) => selectionRule(item) === "mechanism-primary-track").length,
      candidates_passing_selection_gate: eligibleCandidates.filter((item) => Boolean(selectionRule(item))).length,
      selected: selected.length,
      selected_sections: [...selectedSections],
      missing_selected_sections: missingSections,
      exclusion_counts: Object.fromEntries(Object.entries(exclusionCounts).sort(([left], [right]) => left.localeCompare(right))),
    },
    notification_policy: {
      enabled: false,
      eligible_records: 0,
      statement: "This offline replay only prioritizes human primary-source review. It cannot publish, message, promote sources, or create a WeChat draft.",
    },
    external_actions: [],
    selected_top3: selected,
    eligible_candidates: eligibleCandidates,
  };
  audit.report_fingerprint = sha256(JSON.stringify(audit));
  return audit;
}

export function renderUnifiedTop3Review(audit) {
  const lines = [
    `# 统一 Top 3 离线回放 · ${String(audit.generated_at).slice(0, 10)}`,
    "",
    "> 只用于人工一手复核；不发布、不通知、不修改任何 collector state。",
    "",
    `- 状态：\`${audit.status}\`；统一候选：${audit.metrics.eligible_candidates}；通过选稿门：${audit.metrics.candidates_passing_selection_gate}（标准 6 分：${audit.metrics.candidates_at_or_above_threshold}；机制一手轨道：${audit.metrics.mechanism_primary_track_candidates}）；入选：${audit.metrics.selected}/3`,
    `- 输入：机制 ${audit.metrics.mechanism_records_read} 条；科技窗口 ${audit.metrics.tech_current_window_records_read} 条；新模型/算力 ${audit.metrics.model_compute_editorial_candidates_read} 条`,
    `- 未覆盖主栏：${audit.metrics.missing_selected_sections.length ? audit.metrics.missing_selected_sections.join("、") : "无"}`,
    "- 通知资格：否；外部动作：0",
    "",
    "## Top 3 人工复核队列",
    "",
    "| # | 主栏 | 分数 | 代表项 | 一手身份 | 技术增量 | Artifact | 关注 | 时效 | 主要边界 |",
    "|---:|---|---:|---|---:|---:|---:|---:|---:|---|",
  ];
  for (const item of array(audit.selected_top3)) {
    lines.push(`| ${item.rank} | ${item.primary_section} / ${item.mechanism_layer} | ${item.score.total.toFixed(1)} | [${String(item.title).replaceAll("|", "\\|")}](${item.canonical_url}) | ${item.score.primary_identity} | ${item.score.technical_delta} | ${item.score.artifact} | ${item.score.independent_attention} | ${item.score.freshness} | ${[item.selection_rule, ...item.limitations].join("；")} |`);
  }
  if (!audit.selected_top3.length) lines.push("| - | - | - | 今日无达到门槛的代表项 | - | - | - | - | - | - |");
  lines.push(
    "",
    "## 解释边界",
    "",
    "- 分数只决定先审哪一条，不改变 T/G 证据等级，也不把发现层条目写成事实。",
    "- 同一事件先按官方 URL 或版本身份合并；多路命中只增加可复核入口，不重复占位，也不叠加分数。",
    "- 同一主栏最多一条，因此 Harness/Eval 普通 release 不会挤掉模型底层机制论文。",
    "- 机制一手轨道只接纳仍在 48 小时内、身份分 2、技术增量分 3、证据等级 G1–G4 的机制项；它不要求媒体热度或已发布代码，并继续保留无 artifact/未独立复现边界。",
    "- `primary-claim-not-yet-verified` 的条目必须打开官方页面、论文、release 或 revision 后才能进入正文。",
    "- 缺失栏目保持为空，不使用融资、营销、普通 patch 或裸 Trending 仓库补位。",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function atomicWrite(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.${randomUUID()}.pending`;
  await writeFile(pending, body, "utf8");
  await rename(pending, path);
}

export async function runUnifiedTop3Replay({
  mechanismPath = resolve("work/mechanism-watch/audit.json"),
  techPath = resolve("work/tech-discovery-probe/audit.json"),
  modelComputePath = resolve("work/model-compute-source-probe/audit.json"),
  outputPath = resolve("work/unified-top3-replay/audit.json"),
  reviewPath = resolve("work/unified-top3-replay/review.md"),
} = {}) {
  const [mechanismBody, techBody, modelComputeBody] = await Promise.all([
    readFile(mechanismPath, "utf8"),
    readFile(techPath, "utf8"),
    readFile(modelComputePath, "utf8"),
  ]);
  const audit = buildUnifiedTop3Replay({
    mechanismAudit: JSON.parse(mechanismBody),
    techAudit: JSON.parse(techBody),
    modelComputeAudit: JSON.parse(modelComputeBody),
    inputFingerprints: { mechanism: sha256(mechanismBody), tech: sha256(techBody), modelCompute: sha256(modelComputeBody) },
  });
  await atomicWrite(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
  await atomicWrite(reviewPath, renderUnifiedTop3Review(audit));
  return audit;
}

async function main() {
  const audit = await runUnifiedTop3Replay({
    mechanismPath: resolve(process.env.UNIFIED_TOP3_MECHANISM_PATH || "work/mechanism-watch/audit.json"),
    techPath: resolve(process.env.UNIFIED_TOP3_TECH_PATH || "work/tech-discovery-probe/audit.json"),
    modelComputePath: resolve(process.env.UNIFIED_TOP3_MODEL_COMPUTE_PATH || "work/model-compute-source-probe/audit.json"),
    outputPath: resolve(process.env.UNIFIED_TOP3_OUTPUT_PATH || "work/unified-top3-replay/audit.json"),
    reviewPath: resolve(process.env.UNIFIED_TOP3_REVIEW_PATH || "work/unified-top3-replay/review.md"),
  });
  process.stdout.write(`${JSON.stringify({ status: audit.status, selected: audit.selected_top3.map((item) => ({ rank: item.rank, title: item.title, score: item.score.total })) }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
