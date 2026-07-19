#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  MODEL_COMPUTE_SHADOW_POLICY,
  modelComputeShadowSources,
  validateModelComputeShadowRegistry,
} from "./model-compute-source-registry.mjs";
import { evaluateDailyEditorialItem } from "./run-model-compute-source-probe.mjs";

const ALLOWED_STATUSES = new Set(["fresh", "not-modified", "stale-cache", "failed", "failed-semantic", "skipped-rate-budget"]);
const CURRENT_STATUSES = new Set(["fresh", "not-modified"]);
const array = (value) => Array.isArray(value) ? value : [];
const DAY_MS = 24 * 60 * 60 * 1000;
const RELEASE_BODY_EXCERPT_CHARS = 1_000;
const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");

function shanghaiDate(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function expectedConsecutiveDays(dates, generatedAt) {
  const values = new Set(dates);
  let cursor = new Date(`${shanghaiDate(new Date(generatedAt))}T00:00:00.000Z`);
  let count = 0;
  while (count < 7) {
    if (!values.has(cursor.toISOString().slice(0, 10))) break;
    count += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return count;
}

function verifyItem(item, sourceId, errors, label) {
  if (item?.source_id !== sourceId) errors.push(`${label}-source-mismatch: ${sourceId}`);
  if (!item?.identity || !item?.title || !item?.url) errors.push(`${label}-missing-identity-title-or-url: ${sourceId}`);
  try {
    if (new URL(item?.url).protocol !== "https:") errors.push(`${label}-non-https-url: ${sourceId}:${item?.identity}`);
  } catch {
    errors.push(`${label}-invalid-url: ${sourceId}:${item?.identity}`);
  }
  if (item?.manual_review_only !== true || item?.primary_verification_required !== true) errors.push(`${label}-escaped-human-review: ${sourceId}:${item?.identity}`);
  if (item?.claim_evidence_allowed !== false || item?.can_raise_evidence_grade !== false || item?.can_change_availability_state !== false || item?.notification_eligible !== false) errors.push(`${label}-crossed-safety-boundary: ${sourceId}:${item?.identity}`);
  if (["official-compute-release", "official-compute-prerelease"].includes(item?.kind)) {
    const metadata = item?.metadata || {};
    const excerpt = String(metadata.release_body_excerpt ?? "");
    if (!/^[a-f0-9]{64}$/.test(String(metadata.release_body_hash || ""))) errors.push(`${label}-invalid-release-body-hash: ${sourceId}:${item?.identity}`);
    if (!Number.isInteger(metadata.release_body_chars) || metadata.release_body_chars < excerpt.length) errors.push(`${label}-invalid-release-body-length: ${sourceId}:${item?.identity}`);
    if (excerpt.length > RELEASE_BODY_EXCERPT_CHARS || metadata.release_body_excerpt_sha256 !== sha256(excerpt)) errors.push(`${label}-release-body-excerpt-hash-mismatch: ${sourceId}:${item?.identity}`);
    if (metadata.release_body_excerpt_truncated !== (metadata.release_body_chars > RELEASE_BODY_EXCERPT_CHARS)) errors.push(`${label}-release-body-excerpt-truncation-mismatch: ${sourceId}:${item?.identity}`);
  }
}

export function verifyModelComputeSourceProbe(audit, sources = modelComputeShadowSources) {
  const errors = [];
  const registry = validateModelComputeShadowRegistry(sources);
  if (!registry.ok) errors.push(...registry.errors.map((error) => `requested-registry: ${error}`));
  if (audit?.schema_version !== 1 || audit?.mode !== "isolated-model-compute-network-shadow") errors.push("unexpected-audit-schema-or-mode");
  if (!isDeepStrictEqual(audit?.policy, MODEL_COMPUTE_SHADOW_POLICY)) errors.push("audit-policy-does-not-match-shadow-contract");
  if (!isDeepStrictEqual(audit?.source_registry, sources)) errors.push("source-registry-does-not-exactly-match-requested-registry");
  const events = array(audit?.source_events);
  if (events.length !== sources.length) errors.push("source-event-count-does-not-match-registry");
  if (new Set(events.map((event) => event.source_id)).size !== events.length) errors.push("duplicate-source-event");
  const eventById = new Map(events.map((event) => [event.source_id, event]));
  for (const source of sources) {
    const event = eventById.get(source.id);
    if (!event) {
      errors.push(`missing-source-event: ${source.id}`);
      continue;
    }
    if (event.lane !== source.lane) errors.push(`source-event-lane-mismatch: ${source.id}`);
    if (!ALLOWED_STATUSES.has(event.status)) errors.push(`invalid-source-status: ${source.id}`);
    if (!Number.isInteger(event.response_bytes) || event.response_bytes < 0 || event.response_bytes > source.limits.max_bytes) errors.push(`response-size-contract-violated: ${source.id}`);
    if (event.response_hash && !/^[a-f0-9]{64}$/.test(event.response_hash)) errors.push(`invalid-response-hash: ${source.id}`);
    if (array(event.attempts).length > 2 || event.retry_count !== Math.max(0, array(event.attempts).length - 1)) errors.push(`request-attempt-budget-violated: ${source.id}`);
    if (array(event.items).length > source.limits.max_items) errors.push(`item-count-contract-violated: ${source.id}`);
    if (event.notification_eligible !== false || !isDeepStrictEqual(event.external_actions, [])) errors.push(`source-event-notification-boundary-violated: ${source.id}`);
    const identities = new Set();
    for (const item of array(event.items)) {
      verifyItem(item, source.id, errors, "raw-item");
      if (identities.has(item.identity)) errors.push(`duplicate-item-identity: ${source.id}:${item.identity}`);
      identities.add(item.identity);
    }
    for (const item of array(event.new_items)) {
      verifyItem(item, source.id, errors, "new-item");
      if (!identities.has(item.identity)) errors.push(`new-item-not-present-in-source-items: ${source.id}:${item.identity}`);
    }
    for (const item of array(event.current_window_items)) {
      verifyItem(item, source.id, errors, "current-window-item");
      if (!identities.has(item.identity)) errors.push(`current-window-item-not-present-in-source-items: ${source.id}:${item.identity}`);
      const timestamp = Date.parse(item.published_at || "");
      const ageHours = (Date.parse(audit?.generated_at || "") - timestamp) / (60 * 60 * 1000);
      if (!Number.isFinite(timestamp) || ageHours < 0 || ageHours > 72) errors.push(`current-window-item-outside-72-hours: ${source.id}:${item.identity}`);
    }
    if (event.onboarding_baseline === true && (array(event.new_items).length || array(event.change_candidates).length)) errors.push(`onboarding-created-change-candidate: ${source.id}`);
    if (!CURRENT_STATUSES.has(event.status) && (array(event.new_items).length || array(event.current_window_items).length || array(event.change_candidates).length)) errors.push(`non-current-source-created-editorial-item: ${source.id}`);
    for (const item of array(event.change_candidates)) {
      verifyItem(item, source.id, errors, "change-candidate");
      if (!array(event.new_items).some((candidate) => candidate.identity === item.identity)) errors.push(`change-candidate-not-new: ${source.id}:${item.identity}`);
      if (item?.change_state !== "new-identity-after-onboarding") errors.push(`invalid-change-state: ${source.id}:${item.identity}`);
    }
    if (event.status === "skipped-rate-budget") {
      if (source.format !== "github-rest-releases-json" || array(event.attempts).length || event.response_bytes !== 0) errors.push(`invalid-rate-budget-skip: ${source.id}`);
      if (!(event.rate_limit_remaining < MODEL_COMPUTE_SHADOW_POLICY.github_rate_limit_stop_remaining)) errors.push(`rate-budget-skip-above-threshold: ${source.id}`);
    }
  }
  const histories = array(audit?.source_histories);
  if (histories.length !== sources.length || new Set(histories.map((history) => history.source_id)).size !== histories.length) errors.push("source-history-coverage-invalid");
  for (const history of histories) {
    if (!eventById.has(history.source_id)) errors.push(`history-without-source-event: ${history.source_id}`);
    if (history?.automatically_promoted !== false || history?.notification_eligible !== false) errors.push(`source-history-crossed-promotion-boundary: ${history.source_id}`);
    if (history?.baseline_semantics_version !== 2 || typeof history?.baseline_complete !== "boolean") errors.push(`source-history-missing-baseline-state: ${history.source_id}`);
    if (history?.baseline_complete !== true && (array(history?.seen_identities).length || array(history?.network_verified_dates).length || history?.onboarding_at)) errors.push(`incomplete-baseline-advanced-history: ${history.source_id}`);
    if (!Array.isArray(history?.seen_identities) || !Array.isArray(history?.network_verified_dates)) errors.push(`invalid-source-history-shape: ${history.source_id}`);
    if (history?.consecutive_clean_days !== expectedConsecutiveDays(history?.network_verified_dates, audit?.generated_at)) errors.push(`clean-day-count-mismatch: ${history.source_id}`);
  }
  const allItems = events.flatMap((event) => event.items);
  const currentItems = events.flatMap((event) => event.current_window_items);
  const changes = events.flatMap((event) => event.change_candidates);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const expectedCandidates = [];
  const expectedExclusions = [];
  for (const item of currentItems) {
    const decision = evaluateDailyEditorialItem(item, sourceById.get(item.source_id));
    if (decision.eligible) expectedCandidates.push({ ...item, editorial_gate: decision });
    else expectedExclusions.push({
      source_id: item.source_id,
      identity: item.identity,
      title: item.title,
      url: item.url,
      exclusion_reasons: decision.reasons,
      manual_review_only: true,
      claim_evidence_allowed: false,
      notification_eligible: false,
    });
  }
  if (!isDeepStrictEqual(audit?.raw_items, allItems)) errors.push("raw-item-projection-mismatch");
  if (!isDeepStrictEqual(audit?.daily_current_window_review, currentItems)) errors.push("current-window-projection-mismatch");
  if (!isDeepStrictEqual(audit?.daily_editorial_candidates, expectedCandidates)) errors.push("editorial-candidate-projection-mismatch");
  if (!isDeepStrictEqual(audit?.daily_editorial_exclusions, expectedExclusions)) errors.push("editorial-exclusion-projection-mismatch");
  if (!isDeepStrictEqual(audit?.human_change_review_queue, changes)) errors.push("change-review-projection-mismatch");
  for (const item of [...array(audit?.daily_editorial_candidates), ...array(audit?.daily_editorial_exclusions)]) {
    if (item?.manual_review_only !== true || item?.claim_evidence_allowed !== false || item?.notification_eligible !== false) errors.push(`editorial-projection-crossed-safety-boundary: ${item?.source_id}:${item?.identity}`);
  }
  const isolation = audit?.isolation || {};
  for (const field of ["production_registry_changed", "production_state_written", "existing_source_health_affected"]) {
    if (isolation[field] !== false) errors.push(`isolation-boundary-violated: ${field}`);
  }
  for (const field of ["evidence_grade_changes", "availability_state_changes", "automatic_promotions"]) {
    if (!isDeepStrictEqual(isolation[field], [])) errors.push(`isolation-list-must-be-empty: ${field}`);
  }
  if (audit?.notification_policy?.enabled !== false || audit?.notification_policy?.eligible_records !== 0) errors.push("notification-boundary-violated");
  if (!isDeepStrictEqual(audit?.external_actions, [])) errors.push("external-actions-must-remain-empty");
  return { ok: errors.length === 0, errors };
}

async function main() {
  const auditPath = resolve(process.argv[2] || process.env.MODEL_COMPUTE_PROBE_OUTPUT_PATH || "work/model-compute-source-probe/audit.json");
  const audit = JSON.parse(await readFile(auditPath, "utf8"));
  const result = verifyModelComputeSourceProbe(audit);
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("model/compute source probe verified\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
