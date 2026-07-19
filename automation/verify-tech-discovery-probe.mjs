#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  TECH_DISCOVERY_POLICY,
  scoreTechDiscoverySignal,
  techDiscoverySources,
  validateTechDiscoveryRegistry,
} from "./tech-discovery-registry.mjs";
import { analyzeReleaseSemanticDelta } from "./release-semantic-policy.mjs";

const EXPECTED_SECTIONS = [
  "new-model",
  "compute-chip",
  "mechanism",
  "harness",
  "evaluation",
  "company-direction",
];
const DAILY_EDITORIAL_MAX_AGE_HOURS = 48;
const RETAINED_EDITORIAL_CACHE_MAX_AGE_HOURS = 24;

const sameValues = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const array = (value) => Array.isArray(value) ? value : [];
const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");

function immutableEditorialIdentity(item) {
  if (["canonical-official-announcement", "artifact-official-announcement"].includes(item?.normalized_event_identity_basis)) return true;
  const identity = String(item?.normalized_event_fingerprint || "");
  return /^(?:git-release|git-commit|arxiv|openreview|doi):/i.test(identity)
    || /^huggingface:.+@[^@]+$/i.test(identity);
}

function editorialExclusionReason(items) {
  if (items.some((item) => item?.discovery_kind === "github-release")
    && !items.some((item) => item?.release_semantic_review?.has_semantic_delta_cue === true)
    && new Set(items.map((item) => item?.independence_group)).size < 2) {
    return "release-without-semantic-delta";
  }
  const identities = items.map((item) => String(item?.normalized_event_fingerprint || ""));
  const bases = items.map((item) => item?.normalized_event_identity_basis);
  if (identities.some((identity) => /^git-repository:/i.test(identity))) return "single-source-bare-repository";
  if (identities.some((identity) => /^huggingface:/i.test(identity) && !/@[^@]+$/i.test(identity))) {
    return "single-source-unversioned-huggingface";
  }
  if (bases.every((basis) => ["normalized-title", "canonical-url-fallback"].includes(basis))) return "single-source-title-or-url-only";
  return "single-source-unverified-primary-identity";
}

function appendRegistryErrors(errors, label, sources) {
  try {
    const result = validateTechDiscoveryRegistry(sources, TECH_DISCOVERY_POLICY);
    for (const error of result.errors) errors.push(`${label}: ${error}`);
  } catch (error) {
    errors.push(`${label}: registry validation threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function verifyTechDiscoveryProbe(audit, sources = techDiscoverySources) {
  const errors = [];
  appendRegistryErrors(errors, "requested registry", sources);
  if (audit?.schema_version !== 2) errors.push("schema_version must be 2");
  if (audit?.mode !== "shadow-tech-discovery-probe") errors.push("mode must be shadow-tech-discovery-probe");
  if (audit?.scope !== "technology-community-attention-only") errors.push("scope must remain attention-only");
  if (!sameValues(array(audit?.daily_section_taxonomy), EXPECTED_SECTIONS)) errors.push("daily section taxonomy must contain exactly the six approved sections");

  const isolation = audit?.isolation_policy || {};
  for (const field of [
    "changes_production_ranking",
    "writes_production_state",
    "affects_production_source_health",
    "satisfies_claim_requirements",
    "raises_evidence_grade",
  ]) {
    if (isolation[field] !== false) errors.push(`${field} must be false`);
  }
  if (array(isolation.automatic_promotions).length) errors.push("automatic_promotions must be empty");

  const dependencies = audit?.dependency_policy || {};
  for (const field of [
    "credentials_required",
    "github_token_required",
    "google_login_required",
    "gemini_required",
    "openai_membership_required",
    "cloudflare_credentials_required",
  ]) {
    if (dependencies[field] !== false) errors.push(`${field} must be false`);
  }

  if (audit?.notification_policy?.enabled !== false || audit?.notification_policy?.eligible !== false) {
    errors.push("notification policy must remain disabled and ineligible");
  }
  if (array(audit?.notification_policy?.records).length) errors.push("notification records must be empty");
  if (array(audit?.notification_policy?.external_actions).length || array(audit?.external_actions).length) {
    errors.push("external actions must be empty");
  }
  if (audit?.metrics?.notification_eligible_records !== 0) errors.push("notification_eligible_records must be zero");

  const cache = audit?.cache_policy || {};
  if (cache.stale_fallback_allowed !== true) errors.push("bounded stale fallback must be explicit");
  if (cache.stale_fallback_counts_as_fresh !== false) errors.push("stale fallback cannot count as fresh");
  if (cache.stale_fallback_can_create_candidates !== false) errors.push("stale fallback cannot create candidates");
  if (cache.stale_fallback_can_retain_current_window_editorial !== true) errors.push("bounded stale editorial retention must be explicit");
  if (cache.retained_editorial_max_age_hours !== RETAINED_EDITORIAL_CACHE_MAX_AGE_HOURS) errors.push("retained editorial cache window mismatch");
  if (!Number.isFinite(cache.ttl_hours) || cache.ttl_hours <= 0) errors.push("cache TTL must be positive and explicit");

  const network = audit?.network_execution_policy || {};
  for (const field of [
    "per_request_abort_signal",
    "transient_errors_only_retried",
    "request_attempts_include_retries",
    "retries_consume_source_request_budget",
    "exponential_backoff",
    "bounded_jitter",
    "source_deadline_enforced",
    "run_deadline_enforced",
  ]) {
    if (network[field] !== true) errors.push(`${field} must be explicitly enabled`);
  }
  for (const field of ["request_timeout_ms", "source_timeout_ms", "run_timeout_ms"]) {
    if (!Number.isFinite(network[field]) || network[field] <= 0) errors.push(`${field} must be positive and explicit`);
  }
  if (!Number.isInteger(network.max_retries_per_request) || network.max_retries_per_request < 0 || network.max_retries_per_request > 2) {
    errors.push("max_retries_per_request must remain between zero and two");
  }
  if (!Number.isFinite(network.retry_base_delay_ms) || network.retry_base_delay_ms < 0) errors.push("retry_base_delay_ms must be non-negative");
  if (!Number.isFinite(network.retry_max_delay_ms) || network.retry_max_delay_ms < network.retry_base_delay_ms) errors.push("retry_max_delay_ms must bound exponential backoff");
  if (!Number.isFinite(network.retry_jitter_ratio) || network.retry_jitter_ratio < 0 || network.retry_jitter_ratio > 1) errors.push("retry_jitter_ratio must be between zero and one");

  const requestedRegistry = array(sources);
  const auditRegistry = array(audit?.source_registry);
  appendRegistryErrors(errors, "audit registry", auditRegistry);
  const expectedIds = requestedRegistry.map((source) => source.id);
  const registryIds = auditRegistry.map((source) => source.id);
  const eventIds = array(audit?.source_events).map((event) => event.source_id);
  const historyIds = array(audit?.source_history).map((history) => history.source_id);
  if (!sameValues(registryIds, expectedIds) || registryIds.length !== expectedIds.length) errors.push("source_registry must exactly match the requested registry");
  if (!isDeepStrictEqual(auditRegistry, requestedRegistry)) errors.push("source_registry fields must exactly match the requested registry");
  if (!sameValues(eventIds, expectedIds) || eventIds.length !== expectedIds.length) errors.push("source_events must cover each requested source exactly once");
  if (!sameValues(historyIds, expectedIds) || historyIds.length !== expectedIds.length) errors.push("source_history must cover each requested source exactly once");
  if (audit?.metrics?.registered_sources !== expectedIds.length) errors.push("registered source metric mismatch");

  const sourceMap = new Map(requestedRegistry.map((source) => [source.id, source]));
  const allItemsBySourceStory = new Map(array(audit?.source_events).flatMap((event) => (
    array(event.items).map((item) => [`${item.source_id}:${item.source_story_key}`, item])
  )));
  const candidateKeys = new Set();
  const dailyCurrentItemMap = new Map();
  const dailyCurrentStoryKeys = new Set();
  const dailyCurrentStoryItems = new Map();
  let computedCandidateCount = 0;
  let computedDailyCurrentCandidateCount = 0;
  for (const event of array(audit?.source_events)) {
    const source = sourceMap.get(event.source_id);
    if (!source) continue;
    const limits = source.limits || {};
    if (event.request_budget !== limits.request_budget) errors.push(`request budget mismatch: ${event.source_id}`);
    if (!Number.isInteger(event.requests_made) || event.requests_made < 0 || event.requests_made > limits.request_budget) {
      errors.push(`request count exceeds bounded contract: ${event.source_id}`);
    }
    if (!Number.isInteger(event.retries_made) || event.retries_made < 0 || event.retries_made > Math.max(0, event.requests_made - 1)) {
      errors.push(`retry count exceeds observed attempts: ${event.source_id}`);
    }
    if (array(event.retry_delays_ms).length !== event.retries_made || array(event.transient_errors).length !== event.retries_made) {
      errors.push(`retry diagnostics mismatch: ${event.source_id}`);
    }
    if (array(event.retry_delays_ms).some((delay) => !Number.isFinite(delay) || delay < 0)) errors.push(`invalid retry delay: ${event.source_id}`);
    if (event.response_bytes > limits.max_bytes && limits.max_bytes > 0) errors.push(`response bytes exceed bounded contract: ${event.source_id}`);
    if (String(source.fetch_mode || "").startsWith("reference-existing")) {
      if (event.requests_made !== 0) errors.push(`existing snapshot source must not refetch: ${event.source_id}`);
      if (event.network_fresh !== false) errors.push(`existing snapshot source cannot claim its own network freshness: ${event.source_id}`);
    }
    if (event.source_id === "hacker-news-topstories" && event.requests_made > 41) errors.push("Hacker News fanout must remain at most 41 requests");
    if (event.items_parsed !== array(event.items).length) errors.push(`items_parsed mismatch: ${event.source_id}`);
    if (event.new_items !== array(event.queue_candidates).length) errors.push(`new_items mismatch: ${event.source_id}`);
    if (event.onboarding_baseline && (event.new_items !== 0 || array(event.queue_candidates).length)) {
      errors.push(`onboarding baseline cannot be news: ${event.source_id}`);
    }
    if (event.status === "stale-cache") {
      if (event.network_fresh || event.fresh_for_change_detection) errors.push(`stale cache masquerades as fresh: ${event.source_id}`);
      if (event.new_items || array(event.queue_candidates).length) errors.push(`stale cache created change candidates: ${event.source_id}`);
      if (!event.cache_fallback_used) errors.push(`stale cache must disclose fallback use: ${event.source_id}`);
    }
    const expectedEditorialCacheUsable = event.status === "stale-cache"
      && event.cache_fallback_used === true
      && Number.isFinite(event.cache_age_hours)
      && event.cache_age_hours >= 0
      && event.cache_age_hours <= RETAINED_EDITORIAL_CACHE_MAX_AGE_HOURS;
    if (event.editorial_cache_usable !== expectedEditorialCacheUsable) errors.push(`editorial cache usability mismatch: ${event.source_id}`);
    if (!event.fresh_for_change_detection && array(event.queue_candidates).length) {
      errors.push(`non-fresh source created candidates: ${event.source_id}`);
    }

    const itemKeys = new Set(array(event.items).map((item) => item.source_story_key));
    for (const item of array(event.items)) {
      if (!item.source_story_key || !item.canonical_story_key) errors.push(`item lacks stable story identity: ${event.source_id}`);
      if (!item.normalized_event_identity_basis || !item.normalized_event_fingerprint) errors.push(`item lacks cross-publication event identity: ${event.source_id}:${item.source_story_key}`);
      if (item.normalized_event_identity_basis === "canonical-url-cross-source-bridge") {
        const bridge = item.identity_bridge || {};
        const sourceItem = allItemsBySourceStory.get(`${bridge.source_id}:${bridge.source_story_key}`);
        if (!sourceItem || bridge.via_canonical_url !== item.canonical_url || sourceItem.canonical_url !== item.canonical_url
          || sourceItem.canonical_story_key !== item.canonical_story_key
          || sourceItem.normalized_event_fingerprint !== item.normalized_event_fingerprint
          || bridge.source_identity_fingerprint !== sourceItem.normalized_event_fingerprint
          || bridge.source_identity_basis !== sourceItem.normalized_event_identity_basis) {
          errors.push(`item has an invalid cross-source identity bridge: ${event.source_id}:${item.source_story_key}`);
        }
      } else if (item.identity_bridge != null) {
        errors.push(`item has an unexpected cross-source identity bridge: ${event.source_id}:${item.source_story_key}`);
      }
      if (item.primary_verification_required !== true || item.requires_primary_verification !== true) {
        errors.push(`item lacks mandatory primary verification: ${event.source_id}:${item.source_story_key}`);
      }
      if (item.primary_verified !== false) errors.push(`item must explicitly remain primary-unverified: ${event.source_id}:${item.source_story_key}`);
      if (item.primary_bridge_state !== "unverified-primary-required") errors.push(`item escaped the unverified primary bridge: ${event.source_id}:${item.source_story_key}`);
      if (item.manual_review_only !== true || item.automatic_promotion !== false) errors.push(`item escaped manual-only queue: ${event.source_id}:${item.source_story_key}`);
      if (item.claim_evidence_allowed !== false || item.claim_evidence_delta !== 0 || item.notification_eligible !== false) {
        errors.push(`item crossed discovery-only evidence boundary: ${event.source_id}:${item.source_story_key}`);
      }
      if (array(item.daily_sections).some((section) => !EXPECTED_SECTIONS.includes(section))) errors.push(`unknown daily section: ${event.source_id}:${item.source_story_key}`);
      if (item.discovery_kind === "github-release") {
        const expectedSemanticReview = analyzeReleaseSemanticDelta(`${item.title || ""} ${item.summary_for_discovery_only || ""}`);
        if (!isDeepStrictEqual(item.release_semantic_review, expectedSemanticReview)) {
          errors.push(`release semantic review projection mismatch: ${event.source_id}:${item.source_story_key}`);
        }
        if (array(item.daily_sections).includes("new-model")) errors.push(`Harness release misclassified as a new model: ${event.source_id}:${item.source_story_key}`);
        if (item.primary_identity_hint?.body_excerpt_sha256 !== sha256(item.summary_for_discovery_only || "")) {
          errors.push(`release excerpt identity mismatch: ${event.source_id}:${item.source_story_key}`);
        }
      } else if (item.release_semantic_review != null) {
        errors.push(`non-release item has release semantic review: ${event.source_id}:${item.source_story_key}`);
      }
      if (item.is_new && (!item.within_source_window || !item.ai_relevant || array(item.daily_sections).length === 0)) {
        errors.push(`new candidate is stale or outside AI taxonomy: ${event.source_id}:${item.source_story_key}`);
      }
      if (item.discovery_kind === "github-project" && item.is_new && item.queue_state !== "pending-human-primary-verification") {
        errors.push(`new GitHub project must remain in the human queue: ${item.source_story_key}`);
      }
      const dailyAttentionScore = scoreTechDiscoverySignal({
        sourceId: item.source_id,
        observedAttention: item.observed_attention,
        ageHours: item.age_hours || 0,
      });
      if ((event.fresh_for_change_detection || event.editorial_cache_usable) && item.within_source_window
        && item.age_hours <= DAILY_EDITORIAL_MAX_AGE_HOURS && item.ai_relevant
        && array(item.daily_sections).length > 0 && dailyAttentionScore.eligible_for_review_queue) {
        const expectedSnapshotState = event.editorial_cache_usable
          ? "retained-network-verified-cache"
          : "current-verified-snapshot";
        const projected = { ...item, daily_snapshot_state: expectedSnapshotState };
        const key = `${item.source_id}:${item.source_story_key}`;
        dailyCurrentItemMap.set(key, projected);
        dailyCurrentStoryKeys.add(item.canonical_story_key);
        const storyItems = dailyCurrentStoryItems.get(item.canonical_story_key) || [];
        storyItems.push(projected);
        dailyCurrentStoryItems.set(item.canonical_story_key, storyItems);
        computedDailyCurrentCandidateCount += 1;
      }
    }
    for (const item of array(event.queue_candidates)) {
      computedCandidateCount += 1;
      candidateKeys.add(`${item.source_id}:${item.source_story_key}`);
      if (!itemKeys.has(item.source_story_key) || item.is_new !== true) errors.push(`queue candidate is not a new parsed item: ${event.source_id}`);
    }
  }

  const queue = array(audit?.human_review_queue);
  if (queue.length > TECH_DISCOVERY_POLICY.max_selected_signals || queue.length > 5) errors.push("human review queue exceeds five items");
  if (new Set(queue.map((item) => item.independence_group)).size !== queue.length) errors.push("human review queue repeats an independence group");
  if (new Set(queue.map((item) => item.canonical_story_key)).size !== queue.length) errors.push("human review queue repeats a normalized story");
  queue.forEach((item, index) => {
    if (item.queue_rank !== index + 1) errors.push("human review queue rank must be contiguous");
    if (!candidateKeys.has(`${item.source_id}:${item.source_story_key}`)) errors.push(`selected item is not a source candidate: ${item.source_story_key}`);
    if (item.primary_verification_required !== true || item.requires_primary_verification !== true) errors.push(`selected item must require primary verification: ${item.source_story_key}`);
    if (item.primary_verified !== false) errors.push(`selected item must remain primary-unverified: ${item.source_story_key}`);
    if (item.primary_bridge_state !== "unverified-primary-required") errors.push(`selected item escaped the unverified primary bridge: ${item.source_story_key}`);
    if (item.queue_state !== "pending-human-primary-verification") errors.push(`selected item escaped pending human queue: ${item.source_story_key}`);
    if (item.manual_review_only !== true) errors.push(`selected item must remain manual-review-only: ${item.source_story_key}`);
    if (item.automatic_promotion !== false) errors.push(`selected item enabled automatic promotion: ${item.source_story_key}`);
    if (item.claim_evidence_allowed !== false || item.claim_evidence_delta !== 0) errors.push(`selected item crossed claim-evidence boundary: ${item.source_story_key}`);
    if (item.notification_eligible !== false) errors.push(`selected item enabled notification: ${item.source_story_key}`);
    if (item.queue_score?.score_purpose !== "human-review-queue-priority-only" || item.queue_score?.claim_evidence_delta !== 0) {
      errors.push(`selected score is not attention-only: ${item.source_story_key}`);
    }
    if (item.queue_score?.notification_eligible !== false) errors.push(`selected score enabled notification: ${item.source_story_key}`);
  });

  const dailyReview = array(audit?.daily_current_window_review);
  if (!Array.isArray(audit?.daily_current_window_review)) errors.push("daily_current_window_review must be an array");
  if (dailyReview.length > TECH_DISCOVERY_POLICY.max_selected_signals || dailyReview.length > 5) {
    errors.push("daily current-window review exceeds five stories");
  }
  if (new Set(dailyReview.map((item) => item.canonical_story_key)).size !== dailyReview.length) {
    errors.push("daily current-window review repeats a normalized story");
  }
  dailyReview.forEach((item, index) => {
    if (item.daily_review_rank !== index + 1) errors.push("daily current-window review rank must be contiguous");
    if (item.daily_review_state !== "current-window-manual-review") errors.push(`daily story escaped current-window manual review: ${item.canonical_story_key}`);
    if (item.primary_verification_required !== true || item.requires_primary_verification !== true) {
      errors.push(`daily story must require primary verification: ${item.canonical_story_key}`);
    }
    if (item.primary_verified !== false || item.primary_bridge_state !== "unverified-primary-required") {
      errors.push(`daily story escaped the unverified primary bridge: ${item.canonical_story_key}`);
    }
    if (item.manual_review_only !== true || item.automatic_promotion !== false) {
      errors.push(`daily story escaped manual-only review: ${item.canonical_story_key}`);
    }
    if (item.claim_evidence_allowed !== false || item.claim_evidence_delta !== 0 || item.notification_eligible !== false) {
      errors.push(`daily story crossed discovery-only evidence boundary: ${item.canonical_story_key}`);
    }
    if (item.daily_review_score?.score_purpose !== "daily-current-window-editorial-attention-only"
      || item.daily_review_score?.claim_evidence_delta !== 0
      || item.daily_review_score?.notification_eligible !== false) {
      errors.push(`daily story score is not attention-only: ${item.canonical_story_key}`);
    }
    const records = array(item.source_records);
    if (!records.length) errors.push(`daily story lacks source records: ${item.canonical_story_key}`);
    const recordGroups = [...new Set(records.map((record) => record.independence_group))].sort();
    if (!isDeepStrictEqual(recordGroups, [...array(item.independence_groups)].sort())) {
      errors.push(`daily story independence groups mismatch: ${item.canonical_story_key}`);
    }
    if (item.independent_attention_groups !== recordGroups.length
      || item.daily_review_score?.independent_attention_groups !== recordGroups.length) {
      errors.push(`daily story independent attention count mismatch: ${item.canonical_story_key}`);
    }
    const underlying = records.map((record) => dailyCurrentItemMap.get(`${record.source_id}:${record.source_story_key}`));
    if (underlying.some((record) => !record)) errors.push(`daily story includes a non-current source record: ${item.canonical_story_key}`);
    if (underlying.some((record) => record?.canonical_story_key !== item.canonical_story_key)) {
      errors.push(`daily story merged mismatched event identities: ${item.canonical_story_key}`);
    }
    if (records.some((record, recordIndex) => (
      record.normalized_event_identity_basis !== underlying[recordIndex]?.normalized_event_identity_basis
      || record.normalized_event_fingerprint !== underlying[recordIndex]?.normalized_event_fingerprint
      || record.daily_snapshot_state !== underlying[recordIndex]?.daily_snapshot_state
    ))) {
      errors.push(`daily story source identity projection mismatch: ${item.canonical_story_key}`);
    }
    const editorialIdentityReady = underlying.some((record) => immutableEditorialIdentity(record));
    const multiSourceAttentionReady = recordGroups.length >= 2;
    const releaseSemanticDeltaReady = underlying.some((record) => (
      record?.discovery_kind === "github-release"
        && record?.release_semantic_review?.has_semantic_delta_cue === true
    ));
    if (item.editorial_identity_ready !== editorialIdentityReady
      || item.multi_source_attention_ready !== multiSourceAttentionReady) {
      errors.push(`daily story editorial bridge flags mismatch: ${item.canonical_story_key}`);
    }
    if (item.release_semantic_delta_ready !== releaseSemanticDeltaReady) {
      errors.push(`daily story release semantic flag mismatch: ${item.canonical_story_key}`);
    }
    if (item.editorial_bridge_eligible !== true) errors.push(`daily story is not editorial-bridge eligible: ${item.canonical_story_key}`);
    if (!editorialIdentityReady && !multiSourceAttentionReady) {
      errors.push(`daily story lacks an editorial identity or independent corroboration bridge: ${item.canonical_story_key}`);
    }
    if (underlying.some((record) => record?.discovery_kind === "github-release")
      && !releaseSemanticDeltaReady && !multiSourceAttentionReady) {
      errors.push(`daily release story lacks a semantic delta or independent attention: ${item.canonical_story_key}`);
    }
    if (item.change_candidate !== underlying.some((record) => record?.is_new === true)) {
      errors.push(`daily story change-candidate flag mismatch: ${item.canonical_story_key}`);
    }
    const expectedDailySnapshotState = underlying.some((record) => record?.daily_snapshot_state === "retained-network-verified-cache")
      ? "contains-retained-network-verified-cache"
      : "current-verified-snapshots-only";
    if (item.daily_snapshot_state !== expectedDailySnapshotState) errors.push(`daily story snapshot state mismatch: ${item.canonical_story_key}`);
    if (expectedDailySnapshotState === "contains-retained-network-verified-cache" && item.change_candidate) {
      errors.push(`retained cache became a change candidate: ${item.canonical_story_key}`);
    }
    if (item.onboarding_observed !== underlying.some((record) => record?.onboarding_baseline === true)) {
      errors.push(`daily story onboarding flag mismatch: ${item.canonical_story_key}`);
    }
  });

  const exclusions = array(audit?.daily_editorial_exclusions);
  if (!Array.isArray(audit?.daily_editorial_exclusions)) errors.push("daily_editorial_exclusions must be an array");
  if (new Set(exclusions.map((item) => item.canonical_story_key)).size !== exclusions.length) {
    errors.push("daily editorial exclusions repeat a normalized story");
  }
  const selectedStoryKeys = new Set(dailyReview.map((item) => item.canonical_story_key));
  const expectedExcludedStories = new Map([...dailyCurrentStoryItems.entries()].filter(([, items]) => (
    (items.some((item) => item.discovery_kind === "github-release")
      && !items.some((item) => item.release_semantic_review?.has_semantic_delta_cue === true)
      && new Set(items.map((item) => item.independence_group)).size < 2)
    || (!items.some((item) => immutableEditorialIdentity(item))
      && new Set(items.map((item) => item.independence_group)).size < 2)
  )));
  if (!sameValues(exclusions.map((item) => item.canonical_story_key), [...expectedExcludedStories.keys()])) {
    errors.push("daily editorial exclusions must exactly cover unbridged current-window stories");
  }
  for (const item of exclusions) {
    const underlying = expectedExcludedStories.get(item.canonical_story_key) || [];
    if (selectedStoryKeys.has(item.canonical_story_key)) errors.push(`excluded daily story was also selected: ${item.canonical_story_key}`);
    if (item.exclusion_reason !== editorialExclusionReason(underlying)) errors.push(`daily editorial exclusion reason mismatch: ${item.canonical_story_key}`);
    if (!sameValues(array(item.source_ids), underlying.map((record) => record.source_id))) {
      errors.push(`daily editorial exclusion source projection mismatch: ${item.canonical_story_key}`);
    }
    if (!sameValues(array(item.independence_groups), underlying.map((record) => record.independence_group))) {
      errors.push(`daily editorial exclusion independence projection mismatch: ${item.canonical_story_key}`);
    }
    if (item.manual_review_only !== true || item.claim_evidence_allowed !== false || item.notification_eligible !== false) {
      errors.push(`daily editorial exclusion crossed discovery-only boundary: ${item.canonical_story_key}`);
    }
  }

  for (const history of array(audit?.source_history)) {
    if (history.automatically_promoted !== false) errors.push(`source history auto-promoted: ${history.source_id}`);
    if (history?.criteria?.human_source_review?.passed !== false) errors.push(`human source review must remain pending: ${history.source_id}`);
  }

  if (audit?.metrics?.new_discovery_candidates !== computedCandidateCount) errors.push("new discovery candidate metric mismatch");
  if (audit?.metrics?.selected_for_human_review !== queue.length) errors.push("selected human review metric mismatch");
  if (audit?.metrics?.daily_current_window_candidates !== computedDailyCurrentCandidateCount) errors.push("daily current-window candidate metric mismatch");
  if (audit?.metrics?.daily_current_window_story_groups !== dailyCurrentStoryKeys.size) errors.push("daily current-window story-group metric mismatch");
  const dailyEditorialBridgeReadyStoryGroups = [...dailyCurrentStoryItems.values()].filter((items) => (
    (items.some((item) => item.discovery_kind === "github-release")
      ? items.some((item) => item.release_semantic_review?.has_semantic_delta_cue === true)
        || new Set(items.map((item) => item.independence_group)).size >= 2
      : items.some((item) => immutableEditorialIdentity(item))
        || new Set(items.map((item) => item.independence_group)).size >= 2)
  )).length;
  if (audit?.metrics?.daily_editorial_bridge_ready_story_groups !== dailyEditorialBridgeReadyStoryGroups) {
    errors.push("daily editorial bridge-ready story-group metric mismatch");
  }
  if (audit?.metrics?.daily_editorial_excluded_story_groups !== exclusions.length) errors.push("daily editorial excluded story-group metric mismatch");
  if (audit?.metrics?.daily_current_window_selected !== dailyReview.length) errors.push("daily current-window selected metric mismatch");
  return { ok: errors.length === 0, errors };
}

async function main() {
  const path = process.argv[2] || "work/tech-discovery-probe/audit.json";
  const audit = JSON.parse(await readFile(path, "utf8"));
  const result = verifyTechDiscoveryProbe(audit);
  if (!result.ok) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    mode: audit.mode,
    registered_sources: audit.metrics.registered_sources,
    selected_for_human_review: audit.metrics.selected_for_human_review,
    notification_eligible_records: audit.metrics.notification_eligible_records,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
