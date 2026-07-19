import assert from "node:assert/strict";
import test from "node:test";
import { diligenceSourceProfiles, diligenceTopics } from "../automation/source-diligence-contracts.mjs";
import {
  createSemanticReviewDossier,
  renderSemanticReviewDossier,
} from "../automation/run-semantic-review-dossiers.mjs";
import { semanticReviewPackages } from "../automation/semantic-review-contracts.mjs";
import { verifySemanticReviewDossier } from "../automation/verify-semantic-review-dossiers.mjs";

function sourceIdFromRef(ref) {
  return /^candidate:([^#]+)/.exec(ref)?.[1] || "";
}

function sourceDiligenceFixture() {
  const profiles = diligenceSourceProfiles.map((source) => ({
    ...source,
    registered: true,
    current_status: "fresh",
    network_healthy: true,
    content_present: true,
    semantic_blockers: [],
    warnings: [],
    review_flags: [],
    observed_identity: `fixture-identity:${source.ref}`,
    healthy: true,
    observation_state: "unchanged",
    event_candidate: false,
    change_events: [],
  }));
  const byRef = new Map(profiles.map((source) => [source.ref, source]));
  const evaluateRequirement = (requirement) => {
    const sources = requirement.source_refs.map((ref) => byRef.get(ref)).filter(Boolean);
    const accepted = new Set(requirement.accepted_polarities || ["supporting"]);
    const eligible = sources.filter((source) => source.healthy && accepted.has(source.evidence_polarity || "supporting"));
    const groups = [...new Set(eligible.map((source) => source.result_independence_group || source.independence_group))];
    const alternatives = (requirement.alternative_source_sets || []).map((refs) => {
      const alternativeSources = refs.map((ref) => byRef.get(ref)).filter(Boolean);
      const alternativeEligible = alternativeSources.filter((source) => source.healthy && accepted.has(source.evidence_polarity || "supporting"));
      const alternativeGroups = [...new Set(alternativeEligible.map((source) => source.result_independence_group || source.independence_group))];
      return {
        source_refs: refs,
        passed: alternativeEligible.length === refs.length
          && alternativeEligible.length >= requirement.min_healthy
          && alternativeGroups.length >= requirement.min_independence_groups,
      };
    });
    const counterPolarityObserved = requirement.evidence_role !== "counterevidence"
      || eligible.some((source) => ["counter", "mixed"].includes(source.evidence_polarity));
    const matchedAlternatives = alternatives.filter((alternative) => alternative.passed);
    const passed = (alternatives.length
      ? matchedAlternatives.length > 0
      : eligible.length >= requirement.min_healthy && groups.length >= requirement.min_independence_groups)
      && counterPolarityObserved;
    return {
      ...requirement,
      observed_healthy: eligible.length,
      observed_independence_groups: groups,
      observed_result_independence_groups: groups,
      active_source_refs: matchedAlternatives.length
        ? [...new Set(matchedAlternatives.flatMap((alternative) => alternative.source_refs))]
        : requirement.source_refs,
      passed,
      source_statuses: sources.map((source) => ({ ref: source.ref, healthy: true, status: "fresh" })),
    };
  };
  const topics = diligenceTopics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    layers: [...topic.layers],
    attention: { level: "A0", distinct_editorial_groups: [], matched_items: [] },
    notification_eligible: false,
    claims: topic.claims.map((claim) => {
      const requirements = claim.requirements.map(evaluateRequirement);
      const counterevidenceRequirements = (claim.counterevidence_requirements || []).map(evaluateRequirement);
      const requirementsPassed = requirements.every((requirement) => requirement.passed);
      const counterevidenceAvailable = counterevidenceRequirements.some((requirement) => requirement.passed);
      const coverageStatus = !requirementsPassed ? "evidence-gap" : claim.human_review_required ? "human-review-required" : "source-ready";
      return {
        ...claim,
        requirements,
        counterevidence_requirements: counterevidenceRequirements,
        requirements_passed: requirementsPassed,
        counterevidence_available: counterevidenceAvailable,
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
    generated_at: "2026-07-17T04:00:00.000Z",
    mode: "source-diligence-audit",
    source_profiles: profiles,
    topics,
  };
}

function candidateAuditFixture(days = 1) {
  const sourceIds = [...new Set(diligenceSourceProfiles.map((source) => sourceIdFromRef(source.ref)).filter(Boolean))];
  const observedDates = Array.from({ length: days }, (_, index) => `2026-07-${String(17 + index).padStart(2, "0")}`);
  return {
    schema_version: 1,
    generated_at: "2026-07-17T04:00:00.000Z",
    mode: "shadow-source-probe",
    source_history: sourceIds.map((sourceId) => ({
      source_id: sourceId,
      observed_network_success_dates: observedDates,
      consecutive_network_success_days: days,
      current_status: "fresh",
      semantic_blockers: [],
      warnings: [],
      review_flags: [],
      criteria: {
        minimum_observation_days: { required: 7, observed: days, passed: days >= 7 },
        semantic_health: { required_blockers: 0, observed_blockers: 0, passed: true },
        human_source_review: { required: true, observed: false, passed: false },
      },
      ready_for_human_review: days >= 7,
      automatically_promoted: false,
    })),
  };
}

test("semantic dossier covers every claim in four bottom-mechanism review packages", () => {
  const dossier = createSemanticReviewDossier({
    sourceDiligence: sourceDiligenceFixture(),
    candidateAudit: candidateAuditFixture(1),
    now: new Date("2026-07-17T05:00:00.000Z"),
  });
  assert.equal(dossier.metrics.review_packages, 4);
  assert.equal(dossier.metrics.topics, 9);
  assert.equal(dossier.metrics.claims, 26);
  assert.equal(dossier.metrics.source_ready_claims, 9);
  assert.equal(dossier.metrics.human_review_required_claims, 7);
  assert.equal(dossier.metrics.evidence_gap_claims, 10);
  assert.equal(dossier.metrics.no_change_claims, 7);
  assert.equal(dossier.metrics.current_event_candidates, 0);
  assert.equal(dossier.metrics.claims_with_counterevidence, 3);
  assert.deepEqual(dossier.packages.map((item) => item.id), semanticReviewPackages.map((item) => item.id));
  assert.deepEqual(verifySemanticReviewDossier(dossier), { ok: true, errors: [] });
});

test("no-change policy packets monitor silently while MSM and adaptive halting stay separately scoped", () => {
  const dossier = createSemanticReviewDossier({
    sourceDiligence: sourceDiligenceFixture(),
    candidateAudit: candidateAuditFixture(1),
  });
  const claims = dossier.packages.flatMap((item) => item.claims);
  const policy = claims.find((claim) => claim.topic_id === "openai-model-spec" && claim.claim_id === "official-text-change");
  assert.equal(policy.event_status, "no-event");
  assert.equal(policy.claim_verdict, "no-current-event");
  assert.equal(policy.disposition, "monitor-no-change");
  assert.deepEqual(policy.notification.blockers, ["no-change-observed", "notification-policy-disabled"]);
  assert.doesNotMatch(policy.permitted_summary, /已确认/);

  const policyPackage = dossier.packages.find((item) => item.id === "policy-to-weights");
  assert.ok(policyPackage.topic_ids.includes("model-spec-midtraining"));
  const msm = claims.find((claim) => claim.topic_id === "model-spec-midtraining" && claim.claim_id === "learned-internalization");
  assert.equal(msm.source_status, "evidence-gap");
  const adaptive = claims.find((claim) => claim.topic_id === "ouro-looplm" && claim.claim_id === "adaptive-halting-compute-savings");
  assert.equal(adaptive.source_status, "evidence-gap");
  assert.match(adaptive.permitted_summary, /不得/);
});

test("counter and mixed evidence is rendered on a separate axis and cannot become positive support", () => {
  const dossier = createSemanticReviewDossier({
    sourceDiligence: sourceDiligenceFixture(),
    candidateAudit: candidateAuditFixture(7),
  });
  const faithful = dossier.packages.flatMap((item) => item.claims)
    .find((claim) => claim.topic_id === "coconut-continuous-thought" && claim.claim_id === "faithful-reasoning");
  assert.equal(faithful.source_status, "evidence-gap");
  assert.equal(faithful.counterevidence_available, true);
  assert.ok(faithful.counterevidence.some((source) => source.evidence_polarity === "mixed"));
  assert.ok(faithful.counterevidence.every((source) => source.evidence_role === "counterevidence"));
  assert.equal(faithful.supporting_evidence.length, 0);
});

test("source-ready artifacts remain notification-ineligible until stability and human review", () => {
  const dossier = createSemanticReviewDossier({
    sourceDiligence: sourceDiligenceFixture(),
    candidateAudit: candidateAuditFixture(1),
  });
  const claims = dossier.packages.flatMap((item) => item.claims);
  const ouro = claims.find((claim) => claim.topic_id === "ouro-looplm" && claim.claim_id === "authored-mechanism");
  const coconutCausal = claims.find((claim) => claim.topic_id === "coconut-continuous-thought" && claim.claim_id === "faithful-reasoning");
  assert.equal(ouro.source_status, "source-ready");
  assert.equal(ouro.disposition, "await-stability-and-human-review");
  assert.equal(ouro.notification.eligible, false);
  assert.ok(ouro.notification.blockers.includes("minimum-silent-days-not-met"));
  assert.ok(ouro.notification.blockers.includes("human-semantic-review-not-completed"));
  assert.equal(coconutCausal.disposition, "hold-evidence-gap");
  assert.ok(coconutCausal.notification.blockers.includes("claim-evidence-gap"));
  assert.equal(dossier.notification_policy.enabled, false);
  assert.deepEqual(dossier.notification_policy.external_actions, []);
});

test("seven successful days only move packets to human review and never fill a human decision", () => {
  const dossier = createSemanticReviewDossier({
    sourceDiligence: sourceDiligenceFixture(),
    candidateAudit: candidateAuditFixture(7),
  });
  const claims = dossier.packages.flatMap((item) => item.claims);
  const ready = claims.find((claim) => claim.source_status === "source-ready" && claim.stability_gate.applicable);
  assert.equal(dossier.status, "human-review-required");
  assert.equal(ready.disposition, "await-human-review");
  assert.equal(ready.human_review.human_reviewed, false);
  assert.equal(ready.human_review.decision, null);
  assert.equal(ready.notification.eligible, false);
  assert.equal(dossier.metrics.human_decisions_recorded, 0);
});

test("packet fingerprints change when an immutable source identity changes", () => {
  const beforeInput = sourceDiligenceFixture();
  const afterInput = structuredClone(beforeInput);
  const target = afterInput.source_profiles.find((source) => source.ref === "candidate:latent-reasoning-arxiv-seeds#2510.25741");
  target.observed_identity = "arxiv:2510.25741v6";
  const before = createSemanticReviewDossier({ sourceDiligence: beforeInput, candidateAudit: candidateAuditFixture(7) });
  const after = createSemanticReviewDossier({ sourceDiligence: afterInput, candidateAudit: candidateAuditFixture(7) });
  const findOuro = (dossier) => dossier.packages.flatMap((item) => item.claims).find((claim) => claim.topic_id === "ouro-looplm" && claim.claim_id === "authored-mechanism");
  assert.notEqual(findOuro(before).packet_fingerprint, findOuro(after).packet_fingerprint);
  assert.match(findOuro(after).evidence[0].observed_identity, /2510\.25741v6/);
});

test("verifier rejects fabricated human review, notification eligibility, and missing claim coverage", () => {
  const dossier = createSemanticReviewDossier({
    sourceDiligence: sourceDiligenceFixture(),
    candidateAudit: candidateAuditFixture(7),
  });
  const mutated = structuredClone(dossier);
  const claim = mutated.packages[0].claims[0];
  claim.human_review.human_reviewed = true;
  claim.human_review.decision = "approve";
  claim.notification.eligible = true;
  mutated.packages.at(-1).claims.pop();
  const result = verifySemanticReviewDossier(mutated);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.startsWith("human decision must remain blank:")));
  assert.ok(result.errors.some((error) => error.startsWith("claim notification must remain ineligible:")));
  assert.ok(result.errors.includes("claim packet coverage or ordering mismatch"));
});

test("rendered review packet exposes exact identities, gaps, and unchecked human questions", () => {
  const dossier = createSemanticReviewDossier({
    sourceDiligence: sourceDiligenceFixture(),
    candidateAudit: candidateAuditFixture(1),
  });
  const markdown = renderSemanticReviewDossier(dossier);
  assert.match(markdown, /机器准备的证据包，不是人工结论/);
  assert.match(markdown, /fixture-identity:candidate:latent-reasoning-arxiv-seeds#2510\.25741/);
  assert.match(markdown, /claim-evidence-gap/);
  assert.match(markdown, /- \[ \] 确认每个来源仍指向 canonical upstream/);
  assert.doesNotMatch(markdown, /- \[[xX]\]/);
});
