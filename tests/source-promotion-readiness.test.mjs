import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { publicCandidateRegistry } from "../automation/candidate-source-registry.mjs";
import { publicRegistryView } from "../automation/mechanism-source-registry.mjs";
import {
  createSourcePromotionReadiness,
  renderSourcePromotionReadiness,
  sourceFingerprint,
} from "../automation/run-source-promotion-readiness.mjs";
import { createSemanticReviewDossier } from "../automation/run-semantic-review-dossiers.mjs";
import { diligenceSourceProfiles, diligenceTopics } from "../automation/source-diligence-contracts.mjs";
import { verifySourcePromotionReadiness } from "../automation/verify-source-promotion-readiness.mjs";

const PRODUCTION_AT = "2026-07-17T01:00:00.000Z";
const CANDIDATE_AT = "2026-07-17T02:00:00.000Z";
const DILIGENCE_AT = "2026-07-17T03:00:00.000Z";
const DOSSIER_AT = "2026-07-17T04:00:00.000Z";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function refParts(ref) {
  const match = /^(production|candidate):([^#]+)(?:#(.+))?$/.exec(ref);
  return { namespace: match?.[1] || "", sourceId: match?.[2] || "", artifactId: match?.[3] || "" };
}

function fixtureIdentity(profile) {
  const { namespace, artifactId } = refParts(profile.ref);
  if (namespace === "production") return `response-sha256:${digest(profile.ref)}`;
  if (artifactId) return `arxiv:${artifactId}v1`;
  return `git-commit:${digest(profile.ref).slice(0, 40)}; scope:repository`;
}

function evaluateRequirement(requirement, byRef) {
  const accepted = new Set(requirement.accepted_polarities || ["supporting"]);
  const sources = requirement.source_refs.map((ref) => byRef.get(ref)).filter(Boolean);
  const eligible = sources.filter((source) => source.healthy && accepted.has(source.evidence_polarity || "supporting"));
  const resultGroups = [...new Set(eligible.map((source) => source.result_independence_group || source.independence_group))].sort();
  const alternatives = (requirement.alternative_source_sets || []).map((refs) => {
    const alternativeSources = refs.map((ref) => byRef.get(ref)).filter(Boolean);
    const alternativeEligible = alternativeSources.filter((source) => source.healthy && accepted.has(source.evidence_polarity || "supporting"));
    const groups = [...new Set(alternativeEligible.map((source) => source.result_independence_group || source.independence_group))];
    return {
      source_refs: refs,
      passed: alternativeEligible.length === refs.length
        && alternativeEligible.length >= requirement.min_healthy
        && groups.length >= requirement.min_independence_groups,
    };
  });
  const matchingAlternatives = alternatives.filter((item) => item.passed);
  const counterPolarityObserved = requirement.evidence_role !== "counterevidence"
    || eligible.some((source) => ["counter", "mixed"].includes(source.evidence_polarity));
  const passed = (alternatives.length
    ? matchingAlternatives.length > 0
    : eligible.length >= requirement.min_healthy && resultGroups.length >= requirement.min_independence_groups)
    && counterPolarityObserved;
  return {
    ...requirement,
    observed_healthy: eligible.length,
    observed_independence_groups: resultGroups,
    observed_result_independence_groups: resultGroups,
    observed_source_independence_groups: [...new Set(eligible.map((source) => source.independence_group))],
    observed_artifact_owners: [...new Set(eligible.map((source) => source.artifact_owner))],
    scientific_result_lineage_count: resultGroups.length,
    counter_polarity_observed: counterPolarityObserved,
    evaluated_alternative_source_sets: alternatives,
    matching_alternative_source_sets: matchingAlternatives.map((item) => item.source_refs),
    active_source_refs: matchingAlternatives.length ? [...new Set(matchingAlternatives.flatMap((item) => item.source_refs))] : requirement.source_refs,
    passed,
    source_statuses: sources.map((source) => ({
      ref: source.ref,
      healthy: source.healthy,
      eligible_for_requirement: accepted.has(source.evidence_polarity || "supporting"),
      status: source.current_status,
      evidence_polarity: source.evidence_polarity,
      independence_group: source.independence_group,
      result_independence_group: source.result_independence_group,
    })),
  };
}

function sourceDiligenceFixture() {
  const profiles = diligenceSourceProfiles.map((profile) => {
    const { namespace, sourceId, artifactId } = refParts(profile.ref);
    return {
      ...profile,
      namespace,
      source_id: sourceId,
      artifact_id: artifactId,
      registered: true,
      current_status: "fresh",
      network_healthy: true,
      content_present: true,
      semantic_blockers: [],
      warnings: [],
      review_flags: [],
      observed_identity: fixtureIdentity(profile),
      healthy: true,
      observation_state: "unchanged",
      event_candidate: false,
      change_events: [],
    };
  });
  const byRef = new Map(profiles.map((profile) => [profile.ref, profile]));
  const topics = diligenceTopics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    layers: [...topic.layers],
    attention: { level: "A0", distinct_editorial_groups: [], matched_items: [] },
    notification_eligible: false,
    claims: topic.claims.map((claim) => {
      const requirements = claim.requirements.map((requirement) => evaluateRequirement(requirement, byRef));
      const counterevidenceRequirements = (claim.counterevidence_requirements || []).map((requirement) => evaluateRequirement(requirement, byRef));
      const requirementsPassed = requirements.every((requirement) => requirement.passed);
      const counterevidenceAvailable = counterevidenceRequirements.some((requirement) => requirement.passed);
      const coverageStatus = !requirementsPassed ? "evidence-gap" : claim.human_review_required ? "human-review-required" : "source-ready";
      return {
        ...claim,
        requirements,
        counterevidence_requirements: counterevidenceRequirements,
        requirements_passed: requirementsPassed,
        supporting_requirements_passed: requirementsPassed,
        counterevidence_available: counterevidenceAvailable,
        counterevidence_status: counterevidenceAvailable ? "available-human-review-required" : "none-or-incomplete",
        coverage_status: coverageStatus,
        status: coverageStatus,
        event_status: "no-event",
        event_evidence: [],
        claim_verdict: !requirementsPassed
          ? "not-established"
          : claim.event_required
            ? "no-current-event"
            : claim.human_review_required || counterevidenceAvailable
              ? "pending-human-review"
              : "source-supported-with-ceiling",
        attention_used_for_status: false,
        notification_eligible: false,
      };
    }),
  }));
  return {
    schema_version: 1,
    generated_at: DILIGENCE_AT,
    mode: "source-diligence-audit",
    input_snapshots: {
      production_generated_at: PRODUCTION_AT,
      candidate_generated_at: CANDIDATE_AT,
    },
    source_profiles: profiles,
    source_review_queue: [],
    topics,
  };
}

function candidateAuditFixture(days = 1) {
  const registry = publicCandidateRegistry();
  const end = Date.parse("2026-07-17T00:00:00Z");
  const dates = Array.from({ length: days }, (_, index) => new Date(end - (days - index - 1) * 86_400_000).toISOString().slice(0, 10));
  return {
    schema_version: 1,
    generated_at: CANDIDATE_AT,
    mode: "shadow-source-probe",
    source_registry: registry,
    source_history: registry.map((source) => ({
      source_id: source.id,
      observed_network_success_dates: dates,
      consecutive_network_success_days: days,
      observed_semantic_healthy_dates: dates,
      consecutive_semantic_healthy_days: days,
      consecutive_source_stable_days: days,
      current_status: "fresh",
      semantic_blockers: [],
      warnings: [],
      observation_state: "unchanged",
      review_flags: [],
      criteria: {
        minimum_observation_days: { required: 7, observed: days, passed: days >= 7 },
        network_stability: { required_days: 7, observed_days: days, passed: days >= 7 },
        semantic_health: { required_blockers: 0, observed_blockers: 0, passed: true },
        semantic_stability: { required_days: 7, observed_days: days, passed: days >= 7 },
        human_source_review: { required: true, observed: false, passed: false },
      },
      ready_for_human_review: days >= 7,
      automatically_promoted: false,
    })),
  };
}

function productionAuditFixture() {
  const registry = publicRegistryView();
  return {
    schema_version: 1,
    generated_at: PRODUCTION_AT,
    mode: "silent-audit",
    source_registry: registry,
    source_events: registry.map((source) => ({ source_id: source.id, tier: source.tier, status: "fresh", items_parsed: 1 })),
    notification_gate: {
      observed_silent_dates: ["2026-07-17"],
      consecutive_silent_days: 1,
      criteria: {
        minimum_silent_days: { required: 7, observed: 1, passed: false },
        human_review: { required: true, observed: false, passed: false },
      },
    },
  };
}

function inputs(days = 1) {
  const productionAudit = productionAuditFixture();
  const candidateAudit = candidateAuditFixture(days);
  const sourceDiligence = sourceDiligenceFixture();
  const semanticDossier = createSemanticReviewDossier({
    sourceDiligence,
    candidateAudit,
    now: new Date(DOSSIER_AT),
  });
  return { productionAudit, candidateAudit, sourceDiligence, semanticDossier };
}

test("readiness is an exact read-only endpoint and artifact projection", () => {
  const fixture = inputs(1);
  const report = createSourcePromotionReadiness({ ...fixture, now: new Date("2026-07-17T05:00:00.000Z") });
  assert.equal(report.metrics.topics, 9);
  assert.equal(report.metrics.claim_bundles, 26);
  assert.equal(report.metrics.artifact_bindings, 76);
  assert.equal(report.metrics.evidence_endpoints, 73);
  assert.equal(report.metrics.production_core_endpoints, 8);
  assert.equal(report.metrics.production_supplemental_endpoints, 5);
  assert.equal(report.metrics.shadow_endpoints, 60);
  assert.equal(report.metrics.discovery_only_endpoints, 4);
  assert.equal(report.metrics.observing_endpoints, 60);
  assert.equal(report.metrics.manual_review_shortlist_endpoints, 0);
  assert.deepEqual(report.manual_review_shortlist.items, []);
  assert.equal(report.metrics.ready_for_manual_promotion_endpoints, 0);
  assert.equal(report.metrics.human_decisions_recorded, 0);
  assert.equal(report.metrics.notification_eligible_records, 0);
  assert.deepEqual(verifySourcePromotionReadiness(report, fixture), { ok: true, errors: [] });
});

test("production global history never becomes per-source stability and existing tier is preserved", () => {
  const fixture = inputs(1);
  const report = createSourcePromotionReadiness({ ...fixture });
  const ouro = report.sources.find((source) => source.endpoint_key === "production:ouro-model");
  const coconut = report.sources.find((source) => source.endpoint_key === "production:coconut-code");
  for (const source of [ouro, coconut]) {
    assert.equal(source.current_collection_tier, "production-supplemental");
    assert.equal(source.promotion_review.readiness_state, "existing-production");
    assert.equal(source.stability.scope, "global-only");
    assert.equal(source.stability.per_source_status, "not-measured");
    assert.equal(source.stability.observed_days, null);
    assert.equal(source.stability.passed, null);
    assert.ok(source.promotion_review.blockers.includes("per-source-stability-not-evidenced"));
  }
});

test("production health failures keep their tier but become explicit report blockers", () => {
  const fixture = inputs(1);
  const profile = fixture.sourceDiligence.source_profiles.find((item) => item.ref === "production:ouro-model");
  profile.healthy = false;
  profile.current_status = "failed";
  const report = createSourcePromotionReadiness({ ...fixture });
  const source = report.sources.find((item) => item.endpoint_key === "production:ouro-model");
  assert.equal(source.current_collection_tier, "production-supplemental");
  assert.equal(source.promotion_review.readiness_state, "existing-production");
  assert.ok(source.promotion_review.blockers.includes("source-unhealthy"));
  assert.equal(report.status, "blocked-sources-present");
  assert.equal(report.metrics.blocked_endpoints, 1);
  assert.deepEqual(verifySourcePromotionReadiness(report, fixture), { ok: true, errors: [] });
});

test("seven candidate days only reach human source review, never promotion", () => {
  const fixture = inputs(7);
  const report = createSourcePromotionReadiness({ ...fixture });
  const source = report.sources.find((item) => item.endpoint_key === "candidate:claude-constitution-tree");
  assert.equal(source.stability.passed, true);
  assert.equal(source.promotion_review.readiness_state, "await-human-source-review");
  assert.equal(source.promotion_review.human_reviewed, false);
  assert.equal(source.promotion_review.decision, null);
  assert.equal(source.promotion_review.target_tier, null);
  assert.equal(report.metrics.ready_for_manual_promotion_endpoints, 0);
  assert.equal(report.manual_review_shortlist.maximum_items, 12);
  assert.equal(report.manual_review_shortlist.items.length, 12);
  assert.equal(report.metrics.manual_review_shortlist_endpoints, 12);
  assert.ok(report.manual_review_shortlist.deferred_endpoints > 0);
  assert.ok(report.manual_review_shortlist.items.every((item) => item.human_decision === null
    && item.automatic_promotion === false
    && item.notification_eligible === false));
  const shortlistedTopics = new Set(report.manual_review_shortlist.items.flatMap((item) => item.topic_ids));
  for (const topicId of report.scope.topic_ids) assert.ok(shortlistedTopics.has(topicId), `shortlist missing ${topicId}`);
});

test("paper and official artifact remain one scientific result lineage", () => {
  const report = createSourcePromotionReadiness({ ...inputs(1) });
  for (const topicId of ["ouro-looplm", "coconut-continuous-thought"]) {
    const bundle = report.source_bundles.find((item) => item.topic_id === topicId && item.claim_id === "authored-mechanism");
    assert.equal(bundle.result_lineages.length, 1);
    assert.ok(bundle.result_lineages[0].source_refs.length >= 2);
    assert.equal(bundle.independent_reproduction_claimed_by_source_count, false);
  }
});

test("artifact risks and blocked paper-code matches cannot look complete", () => {
  const report = createSourcePromotionReadiness({ ...inputs(1) });
  const readout = report.sources.find((source) => source.endpoint_key === "candidate:readout-blind-spot-commits");
  const ouro = report.sources.find((source) => source.endpoint_key === "production:ouro-model");
  assert.equal(readout.artifact_assessment.completeness, "blocked");
  assert.ok(readout.promotion_review.blockers.includes("artifact-risk-review-required"));
  assert.equal(ouro.artifact_assessment.completeness, "risk-flagged");
  assert.ok(ouro.artifact_assessment.manual_risk_flags.includes("official-model-card-config-paper-conflict"));
  assert.equal(ouro.artifact_assessment.completeness_claimed, false);
});

test("shared arXiv endpoint keeps distinct artifact bindings but one stability record", () => {
  const report = createSourcePromotionReadiness({ ...inputs(1) });
  const endpoint = report.sources.find((source) => source.endpoint_key === "candidate:latent-reasoning-arxiv-seeds");
  assert.equal(endpoint.artifact_refs.length, 4);
  assert.equal(endpoint.artifact_identities.length, 4);
  assert.equal(endpoint.stability.observed_days, 1);
});

test("semantic blockers force a candidate to blocked", () => {
  const fixture = inputs(7);
  const history = fixture.candidateAudit.source_history.find((item) => item.source_id === "claude-constitution-tree");
  history.semantic_blockers = ["tree-truncated"];
  history.criteria.semantic_health = { required_blockers: 0, observed_blockers: 1, passed: false };
  const report = createSourcePromotionReadiness({ ...fixture });
  const source = report.sources.find((item) => item.endpoint_key === "candidate:claude-constitution-tree");
  assert.equal(source.promotion_review.readiness_state, "blocked");
  assert.ok(source.promotion_review.blockers.includes("semantic-blocker:tree-truncated"));
});

test("snapshot chain mismatch fails before source readiness is generated", () => {
  const fixture = inputs(1);
  fixture.semanticDossier.input_snapshots.candidate_probe_generated_at = "2026-07-16T00:00:00.000Z";
  assert.throws(() => createSourcePromotionReadiness({ ...fixture }), /semantic dossier candidate snapshot mismatch/);
});

test("verifier rejects fabricated stability, approvals, missing bundles, and notifications", () => {
  const fixture = inputs(1);
  const report = createSourcePromotionReadiness({ ...fixture });
  const mutated = structuredClone(report);
  const production = mutated.sources.find((source) => source.namespace === "production");
  production.stability.scope = "per-source";
  production.stability.observed_days = 7;
  production.stability.passed = true;
  const candidate = mutated.sources.find((source) => source.namespace === "candidate");
  candidate.promotion_review.human_reviewed = true;
  candidate.promotion_review.decision = "approve";
  candidate.promotion_review.target_tier = "production-core";
  mutated.notification_policy.enabled = true;
  mutated.source_bundles.pop();
  const result = verifySourcePromotionReadiness(mutated, fixture);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("report is not an exact projection of the four input snapshots"));
  assert.ok(result.errors.some((error) => error.startsWith("production global gate was fabricated as per-source stability:")));
  assert.ok(result.errors.some((error) => error.startsWith("fabricated human source decision:")));
  assert.ok(result.errors.includes("notifications must stay disabled"));
});

test("identity changes invalidate both source and report fingerprints", () => {
  const beforeFixture = inputs(1);
  const afterFixture = inputs(1);
  const target = afterFixture.sourceDiligence.source_profiles.find((profile) => profile.ref === "candidate:latent-reasoning-arxiv-seeds#2510.25741");
  target.observed_identity = "arxiv:2510.25741v6";
  const before = createSourcePromotionReadiness({ ...beforeFixture, now: new Date("2026-07-17T06:00:00.000Z") });
  const after = createSourcePromotionReadiness({ ...afterFixture, now: new Date("2026-07-17T06:00:00.000Z") });
  const find = (report) => report.sources.find((source) => source.endpoint_key === "candidate:latent-reasoning-arxiv-seeds");
  assert.notEqual(find(before).source_fingerprint, find(after).source_fingerprint);
  assert.notEqual(before.report_fingerprint, after.report_fingerprint);
});

test("source fingerprints bind authority, result lineage, proof boundary, and promotion blockers", () => {
  const report = createSourcePromotionReadiness({ ...inputs(1) });
  const source = report.sources.find((item) => item.endpoint_key === "production:ouro-model");
  const mutations = [
    (copy) => copy.authority_tiers.push("T0"),
    (copy) => { copy.result_lineage_ids = ["fabricated-independent-lineage"]; },
    (copy) => copy.proves.push("fabricated causal proof"),
    (copy) => copy.does_not_prove.pop(),
    (copy) => copy.promotion_review.blockers.pop(),
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(source);
    mutate(copy);
    assert.notEqual(sourceFingerprint(copy), source.source_fingerprint);
  }
});

test("counterevidence remains separate and cannot close a causal evidence gap", () => {
  const report = createSourcePromotionReadiness({ ...inputs(1) });
  const bundle = report.source_bundles.find((item) => item.topic_id === "coconut-continuous-thought" && item.claim_id === "faithful-reasoning");
  assert.equal(bundle.coverage_status, "evidence-gap");
  assert.equal(bundle.counterevidence_available, true);
  assert.equal(bundle.supporting_requirements[0].source_refs.length, 0);
  assert.ok(bundle.counterevidence_requirements.every((requirement) => requirement.evidence_role === "counterevidence"));
  assert.equal(bundle.notification.eligible, false);
});

test("rendered readiness states the source/claim boundary and leaves discovery outside evidence", () => {
  const markdown = renderSourcePromotionReadiness(createSourcePromotionReadiness({ ...inputs(1) }));
  assert.match(markdown, /source-ready 只描述 claim 覆盖，绝不等于来源已晋级/);
  assert.match(markdown, /发现层（不参与证据）/);
  assert.match(markdown, /逐源未测/);
  assert.match(markdown, /official-model-card-config-paper-conflict/);
});
