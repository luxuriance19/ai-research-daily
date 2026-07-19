#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { diligenceTopics } from "./source-diligence-contracts.mjs";
import { claimPacketFingerprint } from "./run-semantic-review-dossiers.mjs";
import {
  COMMON_REVIEW_CHECKS,
  SEMANTIC_REVIEW_MINIMUM_SILENT_DAYS,
  semanticReviewPackages,
  topicReviewGuidance,
} from "./semantic-review-contracts.mjs";

const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];

export function verifySemanticReviewDossier(dossier) {
  const errors = [];
  if (dossier?.schema_version !== 1) errors.push("schema_version must be 1");
  if (dossier?.mode !== "mechanism-semantic-review-dossier") errors.push("mode must be mechanism-semantic-review-dossier");
  if (dossier?.scope?.excludes_language_style_analysis !== true) errors.push("language-style analysis must stay out of scope");
  if (dossier?.scope?.includes_attention_as_evidence !== false) errors.push("attention cannot be evidence");
  if (dossier?.review_policy?.minimum_silent_days !== SEMANTIC_REVIEW_MINIMUM_SILENT_DAYS) errors.push("minimum silent days must remain seven");
  if (dossier?.review_policy?.packet_fingerprint_required !== true) errors.push("packet fingerprint must be required");
  if (dossier?.review_policy?.stale_human_decisions_invalid_after_source_change !== true) errors.push("source changes must invalidate old human decisions");
  if (dossier?.review_policy?.automation_constitutes_human_review !== false) errors.push("automation cannot constitute human review");
  if (dossier?.review_policy?.automation_can_write_human_decision !== false) errors.push("automation cannot write human decisions");
  if (!Array.isArray(dossier?.review_policy?.automatic_promotions) || dossier.review_policy.automatic_promotions.length) errors.push("automatic promotions must stay empty");
  if (dossier?.notification_policy?.enabled !== false || dossier?.notification_policy?.eligible !== false) errors.push("notifications must remain disabled");
  if (!Array.isArray(dossier?.notification_policy?.external_actions) || dossier.notification_policy.external_actions.length) errors.push("external actions must remain empty");

  const expectedPackageIds = semanticReviewPackages.map((item) => item.id);
  const observedPackages = array(dossier?.packages);
  if (JSON.stringify(observedPackages.map((item) => item.id)) !== JSON.stringify(expectedPackageIds)) errors.push("review package coverage or ordering mismatch");
  const expectedTopicIds = semanticReviewPackages.flatMap((item) => item.topic_ids);
  if (new Set(expectedTopicIds).size !== expectedTopicIds.length) errors.push("review contract topics must be unique");
  if (JSON.stringify(array(dossier?.scope?.topic_ids)) !== JSON.stringify(expectedTopicIds)) errors.push("dossier topic scope mismatch");

  const expectedTopicMap = new Map(diligenceTopics.map((topic) => [topic.id, topic]));
  const observedClaimKeys = [];
  for (let packageIndex = 0; packageIndex < observedPackages.length; packageIndex += 1) {
    const reviewPackage = observedPackages[packageIndex];
    const expectedPackage = semanticReviewPackages[packageIndex];
    if (!expectedPackage) continue;
    if (JSON.stringify(array(reviewPackage.topic_ids)) !== JSON.stringify(expectedPackage.topic_ids)) errors.push(`topic coverage mismatch: ${reviewPackage.id}`);
    if (reviewPackage?.metrics?.human_decisions_recorded !== 0) errors.push(`package human decisions must remain zero: ${reviewPackage.id}`);
    if (reviewPackage?.metrics?.notification_eligible_records !== 0) errors.push(`package notification records must remain zero: ${reviewPackage.id}`);
    if (reviewPackage?.readiness?.required_days !== SEMANTIC_REVIEW_MINIMUM_SILENT_DAYS) errors.push(`package silent-day gate mismatch: ${reviewPackage.id}`);

    for (const claim of array(reviewPackage.claims)) {
      const key = `${claim.topic_id}/${claim.claim_id}`;
      observedClaimKeys.push(key);
      const expectedTopic = expectedTopicMap.get(claim.topic_id);
      const expectedClaim = expectedTopic?.claims?.find((item) => item.id === claim.claim_id);
      if (!expectedClaim) errors.push(`unknown claim packet: ${key}`);
      if (!topicReviewGuidance[claim.topic_id]) errors.push(`missing topic guidance: ${claim.topic_id}`);
      if (claim.attention_used_as_evidence !== false) errors.push(`attention used as evidence: ${key}`);
      if (!["source-ready", "human-review-required", "evidence-gap"].includes(claim.source_status)) errors.push(`invalid source status: ${key}`);
      if (claim.coverage_status !== claim.source_status) errors.push(`coverage/source status mismatch: ${key}`);
      if (!["baseline", "no-event", "human-review-required", "blocked-source-anomaly", "blocked-regression"].includes(claim.event_status)) errors.push(`invalid event status: ${key}`);
      if (!["source-supported-with-ceiling", "pending-human-review", "not-established", "no-current-event"].includes(claim.claim_verdict)) errors.push(`invalid claim verdict: ${key}`);
      if (claim.packet_fingerprint !== claimPacketFingerprint(claim)) errors.push(`packet fingerprint mismatch: ${key}`);
      if (!Array.isArray(claim.review_checklist) || claim.review_checklist.length < COMMON_REVIEW_CHECKS.length + 1) errors.push(`review checklist incomplete: ${key}`);
      if (!Array.isArray(claim.prohibited_conclusions) || !claim.prohibited_conclusions.length) errors.push(`prohibited conclusions missing: ${key}`);
      if (!claim.permitted_summary) errors.push(`permitted summary missing: ${key}`);
      if (!claim.notification_ceiling_after_all_gates) errors.push(`notification ceiling missing: ${key}`);
      if (array(claim.evidence).some((source) => !source.observed_identity || source.observed_identity.startsWith("unavailable:"))) errors.push(`source identity missing: ${key}`);
      if (array(claim.evidence).some((source) => !["T3", "T4"].includes(source.authority_tier))) errors.push(`non-primary evidence entered claim packet: ${key}`);
      if (array(claim.evidence).some((source) => !["supporting", "counterevidence"].includes(source.evidence_role))) errors.push(`invalid evidence role: ${key}`);
      if (array(claim.evidence).some((source) => !source.result_independence_group)) errors.push(`result lineage missing: ${key}`);
      if (array(claim.counterevidence).some((source) => source.evidence_role !== "counterevidence")) errors.push(`counterevidence axis invalid: ${key}`);
      if (claim.counterevidence_available && !array(claim.counterevidence).some((source) => ["counter", "mixed"].includes(source.evidence_polarity))) errors.push(`counterevidence polarity missing: ${key}`);
      if (array(claim.supporting_evidence).some((source) => source.evidence_role !== "supporting")) errors.push(`supporting evidence axis invalid: ${key}`);

      const human = claim.human_review || {};
      if (human.prepared_by_automation !== true || human.constitutes_human_review !== false) errors.push(`automation/human boundary violated: ${key}`);
      if (human.human_reviewed !== false || human.decision !== null || human.reviewer !== null || human.reviewed_at !== null || human.reviewed_packet_fingerprint !== null) errors.push(`human decision must remain blank: ${key}`);
      if (!Array.isArray(human.notes) || human.notes.length) errors.push(`automation cannot write human notes: ${key}`);

      if (claim?.notification?.eligible !== false || claim?.notification?.priority !== null) errors.push(`claim notification must remain ineligible: ${key}`);
      const blockers = array(claim?.notification?.blockers);
      if (!blockers.includes("notification-policy-disabled")) errors.push(`notification disabled blocker missing: ${key}`);
      const noCurrentEvent = claim.event_required && ["baseline", "no-event"].includes(claim.event_status);
      if (noCurrentEvent) {
        if (!blockers.includes("no-change-observed")) errors.push(`no-change blocker missing: ${key}`);
        if (blockers.includes("human-semantic-review-not-completed")) errors.push(`no-change packet cannot imply a pending semantic delta: ${key}`);
      } else if (!blockers.includes("human-semantic-review-not-completed")) errors.push(`human review blocker missing: ${key}`);
      if (claim.source_status === "evidence-gap") {
        if (claim.disposition !== "hold-evidence-gap") errors.push(`evidence gap must stay held: ${key}`);
        if (!blockers.includes("claim-evidence-gap")) errors.push(`evidence gap blocker missing: ${key}`);
      } else if (noCurrentEvent) {
        if (claim.disposition !== "monitor-no-change") errors.push(`no-change claim must remain monitoring-only: ${key}`);
        if (claim.claim_verdict !== "no-current-event") errors.push(`no-change claim verdict mismatch: ${key}`);
      } else if (claim.event_status === "blocked-regression") {
        if (claim.disposition !== "hold-source-regression") errors.push(`regression claim must stay held: ${key}`);
      } else if (claim.event_status === "blocked-source-anomaly") {
        if (claim.disposition !== "hold-source-anomaly") errors.push(`source anomaly claim must stay held: ${key}`);
      } else if (claim?.stability_gate?.all_sources_meet_minimum_days) {
        if (claim.disposition !== "await-human-review") errors.push(`stable claim must await human review: ${key}`);
      } else if (claim.disposition !== "await-stability-and-human-review") {
        errors.push(`unstable claim must await stability and human review: ${key}`);
      }
      if (claim?.stability_gate?.applicable && claim.stability_gate.required_days !== SEMANTIC_REVIEW_MINIMUM_SILENT_DAYS) errors.push(`claim silent-day gate mismatch: ${key}`);
      if (!noCurrentEvent && claim?.stability_gate?.applicable && !claim.stability_gate.all_sources_meet_minimum_days && !blockers.includes("minimum-silent-days-not-met")) errors.push(`minimum-day blocker missing: ${key}`);
    }
  }

  const expectedClaimKeys = semanticReviewPackages.flatMap((reviewPackage) => reviewPackage.topic_ids.flatMap((topicId) => {
    const topic = expectedTopicMap.get(topicId);
    return array(topic?.claims).map((claim) => `${topicId}/${claim.id}`);
  }));
  if (JSON.stringify(observedClaimKeys) !== JSON.stringify(expectedClaimKeys)) errors.push("claim packet coverage or ordering mismatch");
  if (new Set(observedClaimKeys).size !== observedClaimKeys.length) errors.push("claim packets must be unique");

  const claims = observedPackages.flatMap((reviewPackage) => array(reviewPackage.claims));
  const expectedMetrics = {
    review_packages: observedPackages.length,
    topics: observedPackages.reduce((count, reviewPackage) => count + array(reviewPackage.topic_ids).length, 0),
    claims: claims.length,
    source_ready_claims: claims.filter((claim) => claim.source_status === "source-ready").length,
    human_review_required_claims: claims.filter((claim) => claim.source_status === "human-review-required").length,
    evidence_gap_claims: claims.filter((claim) => claim.source_status === "evidence-gap").length,
    no_change_claims: claims.filter((claim) => claim.event_required && ["baseline", "no-event"].includes(claim.event_status)).length,
    current_event_candidates: claims.filter((claim) => claim.event_status === "human-review-required").length,
    claims_with_counterevidence: claims.filter((claim) => claim.counterevidence_available).length,
    claims_waiting_for_stability: claims.filter((claim) => claim?.stability_gate?.applicable && !claim.stability_gate.all_sources_meet_minimum_days).length,
    human_decisions_recorded: 0,
    notification_eligible_records: 0,
  };
  for (const [key, value] of Object.entries(expectedMetrics)) {
    if (dossier?.metrics?.[key] !== value) errors.push(`metric mismatch: ${key}`);
  }
  if (dossier?.metrics?.human_decisions_recorded !== 0) errors.push("human decisions metric must remain zero");
  if (dossier?.metrics?.notification_eligible_records !== 0) errors.push("notification eligible metric must remain zero");
  return { ok: errors.length === 0, errors };
}

async function main() {
  const path = process.argv[2] || "work/semantic-review-dossiers/dossier.json";
  const dossier = JSON.parse(await readFile(path, "utf8"));
  const result = verifySemanticReviewDossier(dossier);
  if (!result.ok) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, mode: dossier.mode, status: dossier.status, ...dossier.metrics }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
