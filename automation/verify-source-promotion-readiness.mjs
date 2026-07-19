#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  bundleFingerprint,
  canonicalJson,
  createSourcePromotionReadiness,
  reportFingerprint,
  sourceFingerprint,
} from "./run-source-promotion-readiness.mjs";

const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];

export function verifySourcePromotionReadiness(report, { productionAudit, candidateAudit, sourceDiligence, semanticDossier }) {
  const errors = [];
  if (report?.schema_version !== 1) errors.push("schema_version must be 1");
  if (report?.mode !== "source-promotion-readiness") errors.push("mode must be source-promotion-readiness");
  if (report?.scope?.claim_specific_source_selection !== true) errors.push("source selection must remain claim-specific");
  if (report?.scope?.separates_endpoints_from_artifact_bindings !== true) errors.push("endpoint and artifact bindings must stay separate");
  if (report?.scope?.excludes_language_style_analysis !== true) errors.push("language-style analysis must stay out of scope");
  if (report?.scope?.includes_attention_as_evidence !== false) errors.push("attention cannot be evidence");
  if (report?.policy?.minimum_silent_days !== 7) errors.push("minimum silent days must remain seven");
  if (report?.policy?.source_ready_claim_is_not_source_promotion !== true) errors.push("source-ready claim cannot mean source promotion");
  if (report?.policy?.health_is_not_reproducibility !== true) errors.push("health cannot imply reproducibility");
  if (report?.policy?.external_human_decision_ledger_required !== true) errors.push("external human decision ledger must be required");
  if (report?.policy?.result_lineage_not_source_count !== true) errors.push("result lineage must not be inferred from source count");
  if (!Array.isArray(report?.policy?.automatic_promotions) || report.policy.automatic_promotions.length) errors.push("automatic promotions must stay empty");
  if (report?.notification_policy?.enabled !== false || report?.notification_policy?.eligible !== false || report?.notification_policy?.priority !== null) errors.push("notifications must stay disabled");
  if (!Array.isArray(report?.notification_policy?.external_actions) || report.notification_policy.external_actions.length) errors.push("external actions must stay empty");

  let expected = null;
  try {
    expected = createSourcePromotionReadiness({
      productionAudit,
      candidateAudit,
      sourceDiligence,
      semanticDossier,
      now: new Date(report.generated_at),
    });
  } catch (error) {
    errors.push(`input snapshot chain invalid: ${error.message}`);
  }
  if (expected && canonicalJson(report) !== canonicalJson(expected)) errors.push("report is not an exact projection of the four input snapshots");

  const sources = array(report?.sources);
  const sourceKeys = sources.map((source) => source.endpoint_key);
  if (new Set(sourceKeys).size !== sourceKeys.length) errors.push("endpoint sources must be unique");
  for (const source of sources) {
    const key = source.endpoint_key || "unknown";
    if (!source.registry?.canonical_url) errors.push(`canonical URL missing: ${key}`);
    if (!array(source.authority_tiers).length) errors.push(`authority tier missing: ${key}`);
    if (!array(source.result_lineage_ids).length) errors.push(`result lineage missing: ${key}`);
    if (!array(source.artifact_refs).length || !array(source.artifact_identities).length) errors.push(`artifact binding missing: ${key}`);
    if (array(source.artifact_identities).some((identity) => !identity.observed_identity || identity.identity_quality === "unavailable")) errors.push(`immutable or snapshot identity missing: ${key}`);
    if (source.source_fingerprint !== sourceFingerprint(source)) errors.push(`source fingerprint mismatch: ${key}`);
    if (source.notification_eligible !== false) errors.push(`source notification enabled: ${key}`);
    const review = source.promotion_review || {};
    if (review.automatic_promotion !== false) errors.push(`automatic promotion enabled: ${key}`);
    if (review.human_reviewed !== false || review.decision !== null || review.reviewer !== null || review.reviewed_at !== null || review.reviewed_source_fingerprint !== null || review.target_tier !== null) {
      errors.push(`fabricated human source decision: ${key}`);
    }
    if (!["existing-production", "blocked", "observing", "await-human-source-review", "ready-for-manual-promotion"].includes(review.readiness_state)) errors.push(`invalid readiness state: ${key}`);
    if (review.readiness_state === "ready-for-manual-promotion") errors.push(`manual promotion readiness cannot exist without a decision ledger: ${key}`);
    if (source.namespace === "production") {
      if (!source.current_collection_tier.startsWith("production-")) errors.push(`production tier mismatch: ${key}`);
      if (source.stability?.scope !== "global-only" || source.stability?.per_source_status !== "not-measured" || source.stability?.observed_days !== null || source.stability?.passed !== null) {
        errors.push(`production global gate was fabricated as per-source stability: ${key}`);
      }
      if (review.readiness_state !== "existing-production") errors.push(`existing production source was re-promoted: ${key}`);
      if (!array(review.blockers).includes("per-source-stability-not-evidenced")) errors.push(`production stability limitation missing: ${key}`);
      if (source.health?.healthy !== true && !array(review.blockers).includes("source-unhealthy")) errors.push(`production health failure omitted: ${key}`);
      for (const blocker of array(source.health?.semantic_blockers)) {
        if (!array(review.blockers).includes(`semantic-blocker:${blocker}`)) errors.push(`production semantic blocker omitted: ${key}/${blocker}`);
      }
      if (["source-regressed", "identity-regressed", "regressed"].includes(source.health?.observation_state) && !array(review.blockers).includes("source-identity-regressed")) errors.push(`production regression omitted: ${key}`);
      if (array(source.identity_qualities).includes("unavailable") && !array(review.blockers).includes("immutable-identity-missing")) errors.push(`production identity failure omitted: ${key}`);
    } else if (source.namespace === "candidate") {
      if (source.current_collection_tier !== "shadow") errors.push(`candidate escaped shadow tier: ${key}`);
      if (source.stability?.scope !== "per-source" || source.stability?.per_source_status !== "measured") errors.push(`candidate per-source stability missing: ${key}`);
      const hardBlocked = source.health?.healthy !== true
        || array(source.health?.semantic_blockers).length > 0
        || ["source-regressed", "identity-regressed"].includes(source.health?.observation_state)
        || array(source.identity_qualities).includes("unavailable");
      if (hardBlocked && review.readiness_state !== "blocked") errors.push(`blocked candidate marked ready: ${key}`);
      if (!hardBlocked && !source.stability?.passed && review.readiness_state !== "observing") errors.push(`candidate below seven days escaped observation: ${key}`);
      if (!hardBlocked && source.stability?.passed && review.readiness_state !== "await-human-source-review") errors.push(`stable candidate skipped human review: ${key}`);
    } else {
      errors.push(`invalid namespace: ${key}`);
    }
    if (source.artifact_assessment?.completeness === "blocked" && !array(review.blockers).includes("artifact-risk-review-required")) errors.push(`blocked artifact risk omitted: ${key}`);
    if (array(source.artifact_assessment?.manual_risk_flags).length && source.artifact_assessment?.completeness === "not-assessed") errors.push(`manual risk presented as clean: ${key}`);
    if (source.artifact_assessment?.completeness_claimed !== false) errors.push(`artifact completeness was fabricated: ${key}`);
    if (array(source.health?.warnings).length && !array(review.blockers).includes("source-warning-review-required")) errors.push(`source warning omitted from promotion blockers: ${key}`);
    if (array(source.health?.review_flags).length && !array(review.blockers).includes("source-review-flag-unresolved")) errors.push(`source review flag omitted from promotion blockers: ${key}`);
  }

  const hardBlockedCount = sources.filter((source) => {
    const blockers = array(source?.promotion_review?.blockers);
    return source?.promotion_review?.readiness_state === "blocked"
      || blockers.includes("source-unhealthy")
      || blockers.includes("source-identity-regressed")
      || blockers.includes("immutable-identity-missing")
      || blockers.some((blocker) => blocker.startsWith("semantic-blocker:"));
  }).length;
  if (report?.metrics?.blocked_endpoints !== hardBlockedCount) errors.push("blocked endpoint metric mismatch");
  if ((hardBlockedCount > 0) !== (report?.status === "blocked-sources-present")) errors.push("blocked report status mismatch");

  for (const source of array(report?.discovery_sources)) {
    if (source.claim_evidence_allowed !== false || source.affects_evidence_grade !== false || source.affects_claim_status !== false) errors.push(`discovery source entered evidence: ${source.source_id}`);
    if (source.automatic_promotion !== false || source.notification_eligible !== false) errors.push(`discovery source enabled action: ${source.source_id}`);
  }

  const shortlist = report?.manual_review_shortlist || {};
  const shortlistItems = array(shortlist.items);
  if (shortlist.maximum_items !== 12) errors.push("manual review shortlist limit must remain twelve");
  if (shortlist.selection_is_review_priority_not_promotion !== true) errors.push("manual shortlist must remain review priority only");
  if (shortlistItems.length > 12) errors.push("manual review shortlist exceeds limit");
  if (report?.metrics?.manual_review_shortlist_endpoints !== shortlistItems.length) errors.push("manual review shortlist metric mismatch");
  const shortlistKeys = shortlistItems.map((item) => item.endpoint_key);
  if (new Set(shortlistKeys).size !== shortlistKeys.length) errors.push("manual review shortlist contains duplicates");
  const sourceByKey = new Map(sources.map((source) => [source.endpoint_key, source]));
  const eligibleShortlistSources = sources.filter((source) => source.namespace === "candidate"
    && source.promotion_review?.readiness_state === "await-human-source-review"
    && array(source.bindings).length > 0);
  if (shortlist.eligible_endpoints !== eligibleShortlistSources.length) errors.push("manual review shortlist eligible count mismatch");
  if (shortlist.deferred_endpoints !== Math.max(0, eligibleShortlistSources.length - shortlistItems.length)) errors.push("manual review shortlist deferred count mismatch");
  for (const item of shortlistItems) {
    const source = sourceByKey.get(item.endpoint_key);
    if (!source || source.namespace !== "candidate") errors.push(`manual shortlist source missing: ${item.endpoint_key}`);
    if (source?.promotion_review?.readiness_state !== "await-human-source-review") errors.push(`manual shortlist source is not stable: ${item.endpoint_key}`);
    if (!array(source?.bindings).length) errors.push(`manual shortlist source has no claim binding: ${item.endpoint_key}`);
    if (item.source_fingerprint !== source?.source_fingerprint) errors.push(`manual shortlist fingerprint mismatch: ${item.endpoint_key}`);
    if (item.human_decision !== null || item.automatic_promotion !== false || item.notification_eligible !== false) errors.push(`manual shortlist enabled a decision or action: ${item.endpoint_key}`);
  }
  const eligibleTopics = new Set(eligibleShortlistSources.flatMap((source) => array(source.bindings).map((binding) => binding.topic_id)));
  const selectedTopics = new Set(shortlistItems.flatMap((item) => array(item.topic_ids)));
  if (eligibleTopics.size <= shortlist.maximum_items) {
    for (const topicId of eligibleTopics) if (!selectedTopics.has(topicId)) errors.push(`manual shortlist omitted eligible topic: ${topicId}`);
  }

  const bundles = array(report?.source_bundles);
  const bundleIds = bundles.map((bundle) => bundle.bundle_id);
  if (new Set(bundleIds).size !== bundleIds.length) errors.push("claim bundles must be unique");
  for (const bundle of bundles) {
    const key = bundle.bundle_id || "unknown";
    if (bundle.bundle_fingerprint !== bundleFingerprint(bundle)) errors.push(`bundle fingerprint mismatch: ${key}`);
    if (bundle.attention?.used_as_evidence !== false) errors.push(`attention used as bundle evidence: ${key}`);
    if (bundle.independent_reproduction_claimed_by_source_count !== false) errors.push(`source count became independent reproduction: ${key}`);
    if (bundle.notification?.eligible !== false || bundle.notification?.priority !== null) errors.push(`bundle notification enabled: ${key}`);
    if (bundle.event_status === "no-event" && array(bundle.event_evidence).length) errors.push(`no-event bundle contains event evidence: ${key}`);
    const supportingRefs = new Set(array(bundle.supporting_requirements).flatMap((requirement) => requirement.source_refs));
    const counterRefs = new Set(array(bundle.counterevidence_requirements).flatMap((requirement) => requirement.source_refs));
    for (const ref of counterRefs) if (supportingRefs.has(ref)) errors.push(`counterevidence reused as positive support: ${key}/${ref}`);
    for (const requirement of array(bundle.counterevidence_requirements)) {
      if (requirement.evidence_role !== "counterevidence") errors.push(`counterevidence axis mislabeled: ${key}/${requirement.id}`);
    }
    for (const requirement of array(bundle.supporting_requirements)) {
      if (requirement.evidence_role !== "supporting") errors.push(`supporting axis mislabeled: ${key}/${requirement.id}`);
    }
  }
  for (const topicId of ["ouro-looplm", "coconut-continuous-thought"]) {
    const authored = bundles.find((bundle) => bundle.topic_id === topicId && bundle.claim_id === "authored-mechanism");
    if (authored && authored.result_lineages.length !== 1) errors.push(`paper and official artifact double-counted as independent results: ${topicId}`);
  }

  if (report.report_fingerprint !== reportFingerprint(report)) errors.push("report fingerprint mismatch");
  if (report?.metrics?.human_decisions_recorded !== 0) errors.push("human decisions metric must remain zero");
  if (report?.metrics?.ready_for_manual_promotion_endpoints !== 0) errors.push("manual promotion metric must remain zero without a decision ledger");
  if (report?.metrics?.notification_eligible_records !== 0) errors.push("notification metric must remain zero");
  return { ok: errors.length === 0, errors };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const reportPath = process.argv[2] || "work/source-promotion-readiness/readiness.json";
  const productionPath = process.env.PRODUCTION_AUDIT_PATH || "work/mechanism-watch/audit.json";
  const candidatePath = process.env.CANDIDATE_PROBE_OUTPUT_PATH || "work/candidate-source-probe/audit.json";
  const diligencePath = process.env.SOURCE_DILIGENCE_OUTPUT_PATH || "work/source-diligence/coverage.json";
  const dossierPath = process.env.SEMANTIC_REVIEW_OUTPUT_PATH || "work/semantic-review-dossiers/dossier.json";
  const [report, productionAudit, candidateAudit, sourceDiligence, semanticDossier] = await Promise.all([
    readJson(reportPath),
    readJson(productionPath),
    readJson(candidatePath),
    readJson(diligencePath),
    readJson(dossierPath),
  ]);
  const result = verifySourcePromotionReadiness(report, { productionAudit, candidateAudit, sourceDiligence, semanticDossier });
  if (!result.ok) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, mode: report.mode, status: report.status, ...report.metrics }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
