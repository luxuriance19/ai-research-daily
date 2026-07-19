#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { diligenceSourceProfiles, diligenceTopics } from "./source-diligence-contracts.mjs";

export function verifySourceDiligence(audit) {
  const errors = [];
  if (audit?.schema_version !== 1) errors.push("schema_version must be 1");
  if (audit?.mode !== "source-diligence-audit") errors.push("mode must be source-diligence-audit");
  if (audit?.status !== audit?.coverage_status) errors.push("status must remain a backward-compatible alias of coverage_status");
  if (!["evidence-gaps-present", "review-required"].includes(audit?.coverage_status)) errors.push("invalid aggregate coverage_status");
  if (!["baseline", "no-event", "human-review-required", "blocked-source-anomaly", "blocked-regression"].includes(audit?.event_status)) errors.push("invalid aggregate event_status");
  if (audit?.axis_policy?.authority_attention_merged !== false) errors.push("authority and attention must remain separate");
  if (audit?.axis_policy?.attention_can_raise_evidence_grade !== false) errors.push("attention must not raise evidence grade");
  if (audit?.axis_policy?.attention_can_satisfy_claim_requirement !== false) errors.push("attention must not satisfy claim requirements");
  if (audit?.axis_policy?.coverage_event_verdict_merged !== false) errors.push("coverage, event, and verdict axes must remain separate");
  if (audit?.axis_policy?.healthy_coverage_is_current_event !== false) errors.push("healthy source coverage must not imply a current event");
  if (audit?.axis_policy?.counterevidence_can_satisfy_supporting_requirement !== false) errors.push("counterevidence must not satisfy supporting requirements");
  if (audit?.axis_policy?.scientific_independence_uses_result_lineage !== true) errors.push("scientific independence must use result lineage");
  if (audit?.notification_policy?.enabled !== false || audit?.notification_policy?.eligible !== false) errors.push("notifications must remain disabled");
  if (!Array.isArray(audit?.notification_policy?.external_actions) || audit.notification_policy.external_actions.length) errors.push("external_actions must be empty");
  if (audit?.isolation_policy?.writes_production_state !== false || audit?.isolation_policy?.changes_production_registry !== false || audit?.isolation_policy?.changes_ranking !== false) errors.push("production state, registry, and ranking must remain untouched");
  if (!Array.isArray(audit?.isolation_policy?.automatic_promotions) || audit.isolation_policy.automatic_promotions.length) errors.push("automatic promotions must be empty");
  if (audit?.metrics?.notification_eligible_records !== 0) errors.push("notification eligible records must remain zero");

  const expectedTopicIds = diligenceTopics.map((topic) => topic.id).sort();
  const observedTopicIds = (audit?.topics || []).map((topic) => topic.id).sort();
  if (JSON.stringify(expectedTopicIds) !== JSON.stringify(observedTopicIds)) errors.push("topic coverage must match contracts");
  const expectedRefs = diligenceSourceProfiles.map((source) => source.ref).sort();
  const observedRefs = (audit?.source_profiles || []).map((source) => source.ref).sort();
  if (JSON.stringify(expectedRefs) !== JSON.stringify(observedRefs)) errors.push("source profile coverage must match contracts");
  if ((audit?.source_profiles || []).some((source) => !source.observed_identity)) errors.push("every source profile must expose an observed identity or explicit unavailable marker");
  if ((audit?.source_profiles || []).some((source) => !["supporting", "mixed", "counter"].includes(source.evidence_polarity))) errors.push("every source profile must expose a valid evidence polarity");
  if ((audit?.source_profiles || []).some((source) => !source.result_independence_group)) errors.push("every source profile must expose a scientific result lineage");

  const sourceReviewQueue = audit?.source_review_queue || [];
  if (!Array.isArray(sourceReviewQueue)) errors.push("source review queue must be an array");
  if (audit?.metrics?.source_review_queue_records !== sourceReviewQueue.length) errors.push("source review queue metric mismatch");
  for (const item of sourceReviewQueue) {
    if (item.affects_claim_status_automatically !== false) errors.push(`source review item cannot change claim status automatically: ${item.ref}`);
    if (item.notification_eligible !== false) errors.push(`source review item cannot notify: ${item.ref}`);
    if (!item.observed_identity) errors.push(`source review item identity missing: ${item.ref}`);
  }

  for (const topic of audit?.topics || []) {
    if (topic.notification_eligible !== false) errors.push(`topic notification must be false: ${topic.id}`);
    if (topic?.attention?.affects_evidence_grade !== false || topic?.attention?.affects_claim_status !== false) errors.push(`attention boundary violated: ${topic.id}`);
    if (!/^A[0-3]$/.test(topic?.attention?.level || "")) errors.push(`invalid attention level: ${topic.id}`);
    for (const claim of topic.claims || []) {
      if (claim.notification_eligible !== false) errors.push(`claim notification must be false: ${topic.id}/${claim.id}`);
      if (claim.attention_used_for_status !== false) errors.push(`attention used for claim status: ${topic.id}/${claim.id}`);
      if (!["source-ready", "human-review-required", "evidence-gap"].includes(claim.status)) errors.push(`invalid claim status: ${topic.id}/${claim.id}`);
      if (claim.status !== claim.coverage_status) errors.push(`claim status must alias coverage_status: ${topic.id}/${claim.id}`);
      if (!["baseline", "no-event", "human-review-required", "blocked-source-anomaly", "blocked-regression"].includes(claim.event_status)) errors.push(`invalid event status: ${topic.id}/${claim.id}`);
      if (!["source-supported-with-ceiling", "pending-human-review", "not-established", "no-current-event"].includes(claim.claim_verdict)) errors.push(`invalid claim verdict: ${topic.id}/${claim.id}`);
      const passed = (claim.requirements || []).every((requirement) => requirement.passed);
      if (passed !== claim.requirements_passed) errors.push(`requirement aggregate mismatch: ${topic.id}/${claim.id}`);
      if (passed !== claim.supporting_requirements_passed) errors.push(`supporting requirement aggregate mismatch: ${topic.id}/${claim.id}`);
      if (JSON.stringify(claim.requirements) !== JSON.stringify(claim.supporting_requirements)) errors.push(`supporting requirements alias mismatch: ${topic.id}/${claim.id}`);
      if (!passed && claim.status !== "evidence-gap") errors.push(`unmet requirement must be evidence gap: ${topic.id}/${claim.id}`);
      if (!passed && claim.claim_verdict !== "not-established") errors.push(`unmet requirement verdict must be not-established: ${topic.id}/${claim.id}`);
      if (claim.event_required && passed && ["baseline", "no-event"].includes(claim.event_status) && claim.claim_verdict !== "no-current-event") errors.push(`event-scoped baseline cannot assert a current claim: ${topic.id}/${claim.id}`);
      if (["baseline", "no-event"].includes(claim.event_status) && (claim.event_evidence || []).length) errors.push(`baseline/no-event claim cannot expose current event evidence: ${topic.id}/${claim.id}`);
      if (claim.event_status === "human-review-required" && !(claim.event_evidence || []).length) errors.push(`event candidate must expose event evidence: ${topic.id}/${claim.id}`);
      for (const requirement of claim.requirements || []) {
        if (requirement.evidence_role !== "supporting") errors.push(`positive requirement has non-supporting role: ${topic.id}/${claim.id}/${requirement.id}`);
        if ((requirement.source_statuses || []).some((source) => source.eligible_for_requirement && source.evidence_polarity !== "supporting")) errors.push(`counter/mixed source counted as supporting: ${topic.id}/${claim.id}/${requirement.id}`);
        if (requirement.scientific_result_lineage_count !== (requirement.observed_result_independence_groups || []).length) errors.push(`scientific lineage count mismatch: ${topic.id}/${claim.id}/${requirement.id}`);
        if ((requirement.alternative_source_sets || []).length && requirement.passed && !(requirement.matching_alternative_source_sets || []).length) errors.push(`alternative source set passed without a complete same-project set: ${topic.id}/${claim.id}/${requirement.id}`);
      }
      for (const counterevidence of claim.counterevidence_requirements || []) {
        if (counterevidence.evidence_role !== "counterevidence") errors.push(`counterevidence role missing: ${topic.id}/${claim.id}/${counterevidence.id}`);
        if (counterevidence.passed && counterevidence.counter_polarity_observed !== true) errors.push(`counterevidence package lacks counter/mixed source: ${topic.id}/${claim.id}/${counterevidence.id}`);
      }
      const counterevidenceAvailable = (claim.counterevidence_requirements || []).some((requirement) => requirement.passed);
      if (counterevidenceAvailable !== claim.counterevidence_available) errors.push(`counterevidence aggregate mismatch: ${topic.id}/${claim.id}`);
      if (claim.causal_claim && claim.status === "source-ready" && claim.human_review_required) errors.push(`causal human-review claim cannot be source-ready: ${topic.id}/${claim.id}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

async function main() {
  const path = process.argv[2] || "work/source-diligence/coverage.json";
  const audit = JSON.parse(await readFile(path, "utf8"));
  const result = verifySourceDiligence(audit);
  if (!result.ok) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, mode: audit.mode, ...audit.metrics }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
