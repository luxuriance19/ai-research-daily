#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { candidateSources } from "./candidate-source-registry.mjs";
import { mechanismSources } from "./mechanism-source-registry.mjs";

const AUDIT_TIME_ZONE = "Asia/Shanghai";
const MINIMUM_OBSERVATION_DAYS = 7;
const NETWORK_SUCCESS = new Set(["fresh", "not-modified"]);
const RELEASE_BODY_EXCERPT_CHARS = 1000;
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

function localDateKey(value) {
  const date = new Date(value);
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

function consecutiveDayCount(dateKeys, expectedLatestDate) {
  if (!dateKeys.length || dateKeys.at(-1) !== expectedLatestDate) return 0;
  let count = 1;
  for (let index = dateKeys.length - 1; index > 0; index -= 1) {
    if (dateKeyEpoch(dateKeys[index]) - dateKeyEpoch(dateKeys[index - 1]) !== 86_400_000) break;
    count += 1;
  }
  return count;
}

function validateDateSeries(value, label, sourceId, auditDate, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array for ${sourceId}`);
    return [];
  }
  const legal = value.every((date) => dateKeyEpoch(date) != null);
  if (!legal) errors.push(`${label} contains an invalid date for ${sourceId}`);
  const normalized = [...new Set(value)].sort();
  if (JSON.stringify(value) !== JSON.stringify(normalized)) errors.push(`${label} must be unique and sorted for ${sourceId}`);
  const auditEpoch = dateKeyEpoch(auditDate);
  if (value.some((date) => dateKeyEpoch(date) != null && dateKeyEpoch(date) > auditEpoch)) errors.push(`${label} contains a future date for ${sourceId}`);
  return legal ? value : [];
}

export function verifyCandidateSourceProbe(audit) {
  const errors = [];
  const auditDate = localDateKey(audit?.generated_at);
  if (!auditDate || dateKeyEpoch(auditDate) == null) errors.push("generated_at must be a valid timestamp");
  if (audit?.schema_version !== 1) errors.push("schema_version must be 1");
  if (audit?.mode !== "shadow-source-probe") errors.push("mode must be shadow-source-probe");
  if (audit?.scope !== "candidate-sources-only") errors.push("scope must remain candidate-sources-only");
  if (audit?.notification_policy?.enabled !== false || audit?.notification_policy?.eligible !== false) errors.push("notifications must remain disabled and ineligible");
  if (!Array.isArray(audit?.notification_policy?.external_actions) || audit.notification_policy.external_actions.length) errors.push("external_actions must be empty");
  if (audit?.metrics?.notification_eligible_records !== 0) errors.push("notification_eligible_records must be zero");

  const isolation = audit?.isolation_policy || {};
  for (const field of ["affects_production_registry", "affects_production_core_health", "classifies_or_ranks_content", "writes_production_collector_state"]) {
    if (isolation[field] !== false) errors.push(`${field} must be false`);
  }
  if (!Array.isArray(isolation.automatic_promotions) || isolation.automatic_promotions.length) errors.push("automatic_promotions must be empty");

  const dependencies = audit?.dependency_policy || {};
  for (const field of ["credentials_required", "github_token_required", "gemini_required", "google_oauth_required", "openai_membership_required", "cloudflare_credentials_required"]) {
    if (dependencies[field] !== false) errors.push(`${field} must be false`);
  }

  const expectedIds = candidateSources.map((source) => source.id).sort();
  const registryIds = (audit?.source_registry || []).map((source) => source.id).sort();
  const eventIds = (audit?.source_events || []).map((event) => event.source_id).sort();
  const historyIds = (audit?.source_history || []).map((history) => history.source_id).sort();
  if (JSON.stringify(registryIds) !== JSON.stringify(expectedIds)) errors.push("audit registry must exactly match candidate registry");
  if (JSON.stringify(eventIds) !== JSON.stringify(expectedIds)) errors.push("source events must cover every candidate exactly once");
  if (JSON.stringify(historyIds) !== JSON.stringify(expectedIds)) errors.push("source history must cover every candidate exactly once");
  if ((audit?.source_registry || []).some((source) => source.authentication !== "public")) errors.push("all candidates must be public");
  if ((audit?.source_history || []).some((history) => history.automatically_promoted !== false)) errors.push("no source may be automatically promoted");

  for (const event of audit?.source_events || []) {
    for (const release of event?.snapshot?.releases || []) {
      const excerpt = String(release.body_excerpt ?? "");
      if (excerpt.length > RELEASE_BODY_EXCERPT_CHARS) errors.push(`release body excerpt exceeds bounded contract: ${event.source_id}:${release.id || release.tag_name}`);
      if (release.body_excerpt_sha256 !== sha256(excerpt)) errors.push(`release body excerpt hash mismatch: ${event.source_id}:${release.id || release.tag_name}`);
      if (!Number.isInteger(release.body_chars) || release.body_chars < 0) errors.push(`release body character count is invalid: ${event.source_id}:${release.id || release.tag_name}`);
      if (release.body_excerpt_truncated !== (release.body_chars > RELEASE_BODY_EXCERPT_CHARS)) errors.push(`release body excerpt truncation flag mismatch: ${event.source_id}:${release.id || release.tag_name}`);
    }
    if (event.observation_state == null) continue;
    const eventFlags = Array.isArray(event.event_review_flags) ? event.event_review_flags : [];
    const sourceFlags = Array.isArray(event.source_review_flags) ? event.source_review_flags : [];
    const combined = [...new Set([...eventFlags, ...sourceFlags])].sort();
    const legacyCombined = [...new Set(Array.isArray(event.review_flags) ? event.review_flags : [])].sort();
    if (JSON.stringify(combined) !== JSON.stringify(legacyCombined)) errors.push(`review flag tracks diverged for ${event.source_id}`);
    if (event.observation_state === "baseline" && (event.event_candidate || eventFlags.length)) errors.push(`baseline source cannot contain event review flags: ${event.source_id}`);
    if (event.observation_state === "unchanged" && event.event_candidate) errors.push(`unchanged source cannot be an event candidate: ${event.source_id}`);
    if (event.event_candidate && (!Array.isArray(event.change_events) || !event.change_events.length)) errors.push(`event candidate requires structured change_events: ${event.source_id}`);
    if (event.observation_state === "regressed" && event.event_candidate) errors.push(`regressed source cannot be an event candidate: ${event.source_id}`);
  }

  const productionIds = new Set(mechanismSources.map((source) => source.id));
  if (expectedIds.some((id) => productionIds.has(id))) errors.push("candidate source ids must remain disjoint from production registry ids");

  const eventById = new Map((audit?.source_events || []).map((event) => [event.source_id, event]));
  let computedReady = 0;
  for (const history of audit?.source_history || []) {
    const sourceId = history.source_id;
    const networkDates = validateDateSeries(history.observed_network_success_dates, "network-success dates", sourceId, auditDate, errors);
    const semanticDates = validateDateSeries(history.observed_semantic_healthy_dates, "semantic-healthy dates", sourceId, auditDate, errors);
    const expectedNetworkDays = consecutiveDayCount(networkDates, auditDate);
    const expectedSemanticDays = consecutiveDayCount(semanticDates, auditDate);
    const expectedStableDays = Math.min(expectedNetworkDays, expectedSemanticDays);
    if (history.consecutive_network_success_days !== expectedNetworkDays) errors.push(`network day count mismatch for ${sourceId}`);
    if (history.consecutive_semantic_healthy_days !== expectedSemanticDays) errors.push(`semantic day count mismatch for ${sourceId}`);
    if (history.consecutive_source_stable_days !== expectedStableDays) errors.push(`source-stable day count mismatch for ${sourceId}`);

    const minimum = history?.criteria?.minimum_observation_days || {};
    if (minimum.required !== MINIMUM_OBSERVATION_DAYS || minimum.observed !== expectedStableDays || minimum.passed !== (expectedStableDays >= MINIMUM_OBSERVATION_DAYS)) errors.push(`day criterion mismatch for ${sourceId}`);
    const network = history?.criteria?.network_stability || {};
    if (network.required_days !== MINIMUM_OBSERVATION_DAYS || network.observed_days !== expectedNetworkDays || network.passed !== (expectedNetworkDays >= MINIMUM_OBSERVATION_DAYS)) errors.push(`network stability criterion mismatch for ${sourceId}`);
    const semantic = history?.criteria?.semantic_stability || {};
    if (semantic.required_days !== MINIMUM_OBSERVATION_DAYS || semantic.observed_days !== expectedSemanticDays || semantic.passed !== (expectedSemanticDays >= MINIMUM_OBSERVATION_DAYS)) errors.push(`semantic stability criterion mismatch for ${sourceId}`);
    const blockers = Array.isArray(history.semantic_blockers) ? history.semantic_blockers : [];
    const semanticHealth = history?.criteria?.semantic_health || {};
    if (semanticHealth.required_blockers !== 0 || semanticHealth.observed_blockers !== blockers.length || semanticHealth.passed !== (blockers.length === 0)) errors.push(`semantic health criterion mismatch for ${sourceId}`);
    const humanReview = history?.criteria?.human_source_review || {};
    if (humanReview.required !== true || humanReview.observed !== false || humanReview.passed !== false) errors.push(`human review must remain false for ${sourceId}`);

    const event = eventById.get(sourceId);
    if (event && history.current_status !== event.status) errors.push(`history/event status mismatch for ${sourceId}`);
    const cleanToday = NETWORK_SUCCESS.has(history.current_status)
      && blockers.length === 0
      && !["blocked", "regressed"].includes(history.observation_state);
    if (expectedStableDays > 0 && !cleanToday) errors.push(`stable streak includes an unhealthy current day for ${sourceId}`);
    const expectedReady = expectedStableDays >= MINIMUM_OBSERVATION_DAYS && cleanToday;
    if (history.ready_for_human_review !== expectedReady) errors.push(`review readiness mismatch for ${sourceId}`);
    if (expectedReady) computedReady += 1;
  }
  if (audit?.metrics?.ready_for_human_review !== computedReady) errors.push("ready_for_human_review metric mismatch");

  return { ok: errors.length === 0, errors };
}

async function main() {
  const path = process.argv[2] || "work/candidate-source-probe/audit.json";
  const audit = JSON.parse(await readFile(path, "utf8"));
  const result = verifyCandidateSourceProbe(audit);
  if (!result.ok) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    mode: audit.mode,
    candidate_sources: audit.metrics.registered_candidate_sources,
    network_fresh_rate: audit.metrics.network_fresh_rate,
    ready_for_human_review: audit.metrics.ready_for_human_review,
    notification_eligible_records: audit.metrics.notification_eligible_records,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
