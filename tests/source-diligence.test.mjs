import assert from "node:assert/strict";
import test from "node:test";
import { candidateSources } from "../automation/candidate-source-registry.mjs";
import { mechanismSources } from "../automation/mechanism-source-registry.mjs";
import { createSourceDiligenceAudit, renderSourceDiligenceReview } from "../automation/run-source-diligence.mjs";
import { verifySourceDiligence } from "../automation/verify-source-diligence.mjs";

function auditFor(sources, events, generatedAt = "2026-07-17T04:00:00.000Z") {
  return { generated_at: generatedAt, source_registry: sources, source_events: events };
}

function healthyEvents(sources) {
  return sources.map((source) => ({
    source_id: source.id,
    status: "fresh",
    items_parsed: 1,
    semantic_blockers: [],
    observation_state: "unchanged",
    event_candidate: false,
    change_events: [],
    event_review_flags: [],
    source_review_flags: [],
    snapshot: {},
  }));
}

function fixtureAudits() {
  const productionEvents = healthyEvents(mechanismSources);
  const candidateEvents = healthyEvents(candidateSources);
  const arxiv = candidateEvents.find((event) => event.source_id === "latent-reasoning-arxiv-seeds");
  arxiv.items_parsed = 4;
  arxiv.snapshot.papers = ["2510.25741", "2412.06769", "2605.26733", "2512.21711"].map((id) => ({ id, version: 1 }));
  const direct = candidateEvents.find((event) => event.source_id === "readout-blind-spot-arxiv");
  direct.snapshot.papers = [{ id: "2606.24898", version: 1 }];
  for (const [sourceId, paperId] of [
    ["model-spec-midtraining-arxiv", "2605.02087"],
    ["switch-latent-reasoning-arxiv", "2606.13106"],
    ["hidden-decoding-arxiv", "2607.08186"],
    ["long-horizon-terminal-bench-arxiv", "2607.08964"],
    ["latent-cot-dynamics-arxiv", "2607.09698"],
    ["harness-updating-arxiv", "2605.30621"],
    ["latent-cot-thinking-arxiv", "2602.00449"],
    ["pando-arxiv", "2604.11061"],
    ["mib-arxiv", "2504.13151"],
    ["interpbench-arxiv", "2407.14494"],
    ["rethinking-harness-evolution-arxiv", "2607.12227"],
  ]) {
    candidateEvents.find((event) => event.source_id === sourceId).snapshot.papers = [{ id: paperId, version: 1 }];
  }
  candidateEvents.find((event) => event.source_id === "switch-latent-reasoning-model").snapshot = {
    artifact_kind: "model",
    artifact_id: "LARK-Lab/SWITCH-Phase3-GRPO-LoRA-Qwen3-8B",
    revision_sha: "246fee75d774c02a110ea8608ac841a916dd5d35",
    license: "mit",
    file_count: 3,
  };
  const googleAdk = candidateEvents.find((event) => event.source_id === "google-adk-releases");
  googleAdk.warnings = ["latest-endpoint-not-in-release-list"];
  googleAdk.review_flags = ["release-list-lags-latest-endpoint:v2.5.0"];
  for (const sourceId of ["latent-space-feed", "interconnects-feed"]) {
    const event = candidateEvents.find((candidate) => candidate.source_id === sourceId);
    event.snapshot.items = [{ id: `${sourceId}-1`, title: "Agent harness engineering for Codex", url: `https://example.com/${sourceId}`, published_at: "2026-07-16T00:00:00.000Z" }];
  }
  return {
    productionAudit: auditFor(mechanismSources, productionEvents),
    candidateAudit: auditFor(candidateSources, candidateEvents),
  };
}

test("authority and attention remain orthogonal while Latent Space-style mentions only affect queue priority", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  const harness = audit.topics.find((topic) => topic.id === "agent-harness");
  assert.equal(harness.attention.level, "A2");
  assert.equal(harness.attention.affects_evidence_grade, false);
  assert.equal(harness.attention.affects_claim_status, false);
  assert.equal(harness.claims.find((claim) => claim.id === "capability-uplift").status, "evidence-gap");
  assert.equal(audit.axis_policy.authority_attention_merged, false);
});

test("versioned harness semantics stop at human review while capability and score causality remain evidence gaps", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  const agentHarness = audit.topics.find((topic) => topic.id === "agent-harness");
  const evalHarness = audit.topics.find((topic) => topic.id === "evaluation-harness");
  assert.equal(agentHarness.claims.find((claim) => claim.id === "semantic-delta").status, "human-review-required");
  assert.equal(agentHarness.claims.find((claim) => claim.id === "capability-uplift").status, "evidence-gap");
  assert.equal(evalHarness.claims.find((claim) => claim.id === "semantic-delta").status, "human-review-required");
  assert.equal(evalHarness.claims.find((claim) => claim.id === "score-comparability").status, "evidence-gap");
  assert.equal(audit.metrics.causal_claims_source_ready, 0);
});

test("authored Ouro and Coconut mechanisms are source-ready but stronger causal interpretations remain gaps", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  const ouro = audit.topics.find((topic) => topic.id === "ouro-looplm");
  const coconut = audit.topics.find((topic) => topic.id === "coconut-continuous-thought");
  const ouroCausal = ouro.claims.find((claim) => claim.id === "causal-generalization");
  const coconutCausal = coconut.claims.find((claim) => claim.id === "faithful-reasoning");
  assert.equal(ouro.claims.find((claim) => claim.id === "authored-mechanism").status, "source-ready");
  assert.equal(ouro.claims.find((claim) => claim.id === "adaptive-halting-compute-savings").status, "evidence-gap");
  assert.deepEqual(coconut.layers, ["M1", "M2", "M3", "M4"]);
  assert.equal(ouroCausal.status, "evidence-gap");
  assert.equal(ouroCausal.counterevidence_requirements.find((requirement) => requirement.id === "direct-checkpoint-diagnostic").passed, true);
  assert.equal(ouroCausal.requirements.find((requirement) => requirement.id === "full-result-reproduction").passed, false);
  assert.equal(coconut.claims.find((claim) => claim.id === "authored-mechanism").status, "source-ready");
  assert.equal(coconutCausal.status, "evidence-gap");
  assert.equal(coconutCausal.counterevidence_requirements.find((requirement) => requirement.id === "switch-intervention-boundary").passed, true);
  assert.equal(coconutCausal.counterevidence_requirements.find((requirement) => requirement.id === "direct-coconut-trajectory-diagnostic").passed, true);
  assert.equal(coconutCausal.requirements.find((requirement) => requirement.id === "independent-cross-model-validation").passed, false);
  assert.equal(audit.metrics.causal_claims_source_ready, 0);
});

test("paper-linked harness controls improve source coverage without satisfying causal uplift", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  const harness = audit.topics.find((topic) => topic.id === "agent-harness");
  const uplift = harness.claims.find((claim) => claim.id === "capability-uplift");
  assert.equal(uplift.requirements.find((requirement) => requirement.id === "paper-linked-controlled-protocol").passed, true);
  assert.equal(uplift.counterevidence_requirements.find((requirement) => requirement.id === "independent-category-counterevidence").passed, true);
  assert.equal(uplift.requirements.find((requirement) => requirement.id === "independent-controlled-rerun").passed, false);
  const counterRefs = uplift.counterevidence_requirements.find((requirement) => requirement.id === "independent-category-counterevidence").source_refs;
  const rerunRefs = uplift.requirements.find((requirement) => requirement.id === "independent-controlled-rerun").source_refs;
  assert.deepEqual(rerunRefs, []);
  assert.ok(counterRefs.every((ref) => !rerunRefs.includes(ref)));
  assert.equal(uplift.status, "evidence-gap");
  assert.equal(audit.metrics.causal_claims_source_ready, 0);
});

test("OpenAI Model Spec is a parallel B0 contract and never proves learned implementation", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  const modelSpec = audit.topics.find((topic) => topic.id === "openai-model-spec");
  assert.equal(modelSpec.claims.find((claim) => claim.id === "official-text-change").status, "human-review-required");
  assert.equal(modelSpec.claims.find((claim) => claim.id === "learned-implementation").status, "evidence-gap");
  assert.equal(modelSpec.claims.find((claim) => claim.id === "official-text-change").requirements.find((requirement) => requirement.id === "release-semantics").observed_healthy, 2);
  assert.equal(modelSpec.notification_eligible, false);
});

test("Ouro family completeness and Coconut sequentiality tests remain artifact-scoped", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  const ouro = audit.topics.find((topic) => topic.id === "ouro-looplm");
  const family = ouro.claims.find((claim) => claim.id === "official-model-family");
  assert.equal(family.status, "source-ready");
  assert.equal(family.requirements[0].observed_healthy, 4);
  assert.deepEqual(family.requirements[0].observed_source_independence_groups, ["bytedance-seed"]);
  assert.deepEqual(family.requirements[0].observed_result_independence_groups, ["ouro-authors"]);
  assert.equal(family.requirements[0].scientific_result_lineage_count, 1);
  const authoredOuro = ouro.claims.find((claim) => claim.id === "authored-mechanism");
  assert.deepEqual(authoredOuro.requirements.map((requirement) => requirement.observed_result_independence_groups), [["ouro-authors"], ["ouro-authors"]]);
  assert.equal(ouro.claims.find((claim) => claim.id === "causal-generalization").status, "evidence-gap");

  const coconut = audit.topics.find((topic) => topic.id === "coconut-continuous-thought");
  const authoredCoconut = coconut.claims.find((claim) => claim.id === "authored-mechanism");
  assert.deepEqual(authoredCoconut.requirements.map((requirement) => requirement.observed_result_independence_groups), [["coconut-authors"], ["coconut-authors"]]);
  assert.deepEqual(authoredCoconut.requirements.map((requirement) => requirement.observed_source_independence_groups), [["coconut-authors"], ["meta-fair"]]);
  assert.equal(coconut.claims.find((claim) => claim.id === "sequentiality-stress-test").status, "human-review-required");
  assert.equal(coconut.claims.find((claim) => claim.id === "faithful-reasoning").status, "evidence-gap");
});

test("Pando and MIB-InterpBench establish scoped method boundaries without closing causal logic", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  const circuit = audit.topics.find((topic) => topic.id === "circuit-tracing");
  const boundaries = circuit.claims.find((claim) => claim.id === "method-benchmark-boundaries");
  const lineage = boundaries.requirements.find((requirement) => requirement.id === "distinct-external-lineages");
  assert.equal(boundaries.causal_claim, false);
  assert.equal(boundaries.status, "human-review-required");
  assert.equal(lineage.observed_healthy, 7);
  assert.deepEqual(lineage.observed_independence_groups.sort(), ["mib-interpbench-overlap-lineage", "pando-authors"]);
  assert.equal(circuit.claims.find((claim) => claim.id === "complete-causal-logic").status, "evidence-gap");
  assert.equal(circuit.claims.find((claim) => claim.id === "complete-causal-logic").requirements.find((requirement) => requirement.id === "independent-result-validation").source_refs.length, 0);
  assert.equal(audit.metrics.causal_claims_source_ready, 0);
});

test("Inspect Evals release-policy-changelog chain stops at semantic human review", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  const evaluation = audit.topics.find((topic) => topic.id === "evaluation-harness");
  const inspectEvals = evaluation.claims.find((claim) => claim.id === "inspect-evals-versioned-comparability");
  assert.equal(inspectEvals.status, "human-review-required");
  assert.equal(inspectEvals.requirements.every((requirement) => requirement.passed), true);
  assert.equal(evaluation.claims.find((claim) => claim.id === "score-comparability").status, "evidence-gap");
});

test("new authored mechanism packages stay scoped below broad causal claims", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  const constitution = audit.topics.find((topic) => topic.id === "claude-constitution");
  const midtraining = audit.topics.find((topic) => topic.id === "model-spec-midtraining");
  const hiddenDecoding = audit.topics.find((topic) => topic.id === "hidden-decoding");
  const evalHarness = audit.topics.find((topic) => topic.id === "evaluation-harness");
  assert.equal(constitution.claims.find((claim) => claim.id === "learned-implementation").status, "evidence-gap");
  assert.equal(midtraining.claims.find((claim) => claim.id === "spec-midtraining-open-model-control").status, "source-ready");
  assert.equal(midtraining.claims.find((claim) => claim.id === "learned-internalization").status, "evidence-gap");
  assert.equal(hiddenDecoding.claims.find((claim) => claim.id === "authored-mechanism").status, "source-ready");
  assert.equal(hiddenDecoding.claims.find((claim) => claim.id === "frontier-scale-reproduction").status, "evidence-gap");
  assert.equal(evalHarness.claims.find((claim) => claim.id === "long-horizon-benchmark-artifact").status, "source-ready");
  assert.equal(evalHarness.claims.find((claim) => claim.id === "score-comparability").status, "evidence-gap");
  assert.equal(audit.metrics.causal_claims_source_ready, 0);
});

test("human review output exposes immutable identities and source exceptions without changing claims", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  const model = audit.source_profiles.find((profile) => profile.ref === "candidate:switch-latent-reasoning-model");
  const googleAdk = audit.source_review_queue.find((item) => item.ref === "candidate:google-adk-releases");
  assert.match(model.observed_identity, /revision:246fee75d774c02a110ea8608ac841a916dd5d35/);
  assert.deepEqual(googleAdk.warnings, ["latest-endpoint-not-in-release-list"]);
  assert.deepEqual(googleAdk.review_flags, ["release-list-lags-latest-endpoint:v2.5.0"]);
  assert.equal(googleAdk.affects_claim_status_automatically, false);
  assert.equal(googleAdk.notification_eligible, false);
  const review = renderSourceDiligenceReview(audit);
  assert.match(review, /来源异常与语义复核队列/);
  assert.match(review, /revision:246fee75d774c02a110ea8608ac841a916dd5d35/);
  assert.match(review, /warning:latest-endpoint-not-in-release-list/);
});

test("a Constitution source change always stops at human semantic review", () => {
  const fixtures = fixtureAudits();
  const tree = fixtures.candidateAudit.source_events.find((event) => event.source_id === "claude-constitution-tree");
  tree.observation_state = "changed";
  tree.event_candidate = true;
  tree.change_events = [{ kind: "dated-constitution-file-added", source_id: tree.source_id, paths: ["20260717-constitution.md"] }];
  const audit = createSourceDiligenceAudit({ ...fixtures, now: new Date("2026-07-17T04:00:00.000Z") });
  const constitution = audit.topics.find((topic) => topic.id === "claude-constitution");
  const textChange = constitution.claims.find((claim) => claim.id === "official-text-change");
  const learnedImplementation = constitution.claims.find((claim) => claim.id === "learned-implementation");
  assert.equal(textChange.requirements_passed, true);
  assert.equal(textChange.status, "human-review-required");
  assert.equal(textChange.event_status, "human-review-required");
  assert.equal(textChange.claim_verdict, "pending-human-review");
  assert.equal(textChange.event_evidence.length, 1);
  assert.equal(learnedImplementation.status, "evidence-gap");
  assert.equal(constitution.notification_eligible, false);
});

test("healthy source coverage is not a current event and source-review anomalies do not manufacture one", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  const semanticDelta = audit.topics.find((topic) => topic.id === "agent-harness").claims.find((claim) => claim.id === "semantic-delta");
  assert.equal(semanticDelta.coverage_status, "human-review-required");
  assert.equal(semanticDelta.status, semanticDelta.coverage_status);
  assert.equal(semanticDelta.event_status, "no-event");
  assert.equal(semanticDelta.claim_verdict, "no-current-event");
  assert.deepEqual(semanticDelta.event_evidence, []);
  assert.equal(audit.event_status, "no-event");
  assert.equal(audit.axis_policy.healthy_coverage_is_current_event, false);
});

test("onboarding baselines and regressions stay distinct from current change candidates", () => {
  const baselineFixtures = fixtureAudits();
  baselineFixtures.candidateAudit.source_events.find((event) => event.source_id === "claude-constitution-readme").observation_state = "baseline";
  const baselineAudit = createSourceDiligenceAudit({ ...baselineFixtures, now: new Date("2026-07-17T04:00:00.000Z") });
  const baselineClaim = baselineAudit.topics.find((topic) => topic.id === "claude-constitution").claims.find((claim) => claim.id === "official-text-change");
  assert.equal(baselineClaim.coverage_status, "human-review-required");
  assert.equal(baselineClaim.event_status, "baseline");
  assert.equal(baselineClaim.claim_verdict, "no-current-event");

  const regressionFixtures = fixtureAudits();
  const tree = regressionFixtures.candidateAudit.source_events.find((event) => event.source_id === "claude-constitution-tree");
  tree.observation_state = "regressed";
  tree.semantic_blockers = ["dated-constitution-file-removed"];
  const regressionAudit = createSourceDiligenceAudit({ ...regressionFixtures, now: new Date("2026-07-17T04:00:00.000Z") });
  const regressionClaim = regressionAudit.topics.find((topic) => topic.id === "claude-constitution").claims.find((claim) => claim.id === "official-text-change");
  assert.equal(regressionClaim.coverage_status, "evidence-gap");
  assert.equal(regressionClaim.event_status, "blocked-regression");
  assert.equal(regressionClaim.claim_verdict, "not-established");
});

test("same-project alternative sets reject a Claude release plus Google changelog cross-match", () => {
  const fixtures = fixtureAudits();
  fixtures.candidateAudit.source_events.find((event) => event.source_id === "claude-agent-sdk-changelog").status = "failed";
  fixtures.candidateAudit.source_events.find((event) => event.source_id === "google-adk-releases").status = "failed";
  const audit = createSourceDiligenceAudit({ ...fixtures, now: new Date("2026-07-17T04:00:00.000Z") });
  const semanticDelta = audit.topics.find((topic) => topic.id === "agent-harness").claims.find((claim) => claim.id === "semantic-delta");
  const paired = semanticDelta.requirements.find((requirement) => requirement.id === "same-project-release-and-changelog");
  assert.equal(paired.observed_healthy, 2);
  assert.deepEqual(paired.matching_alternative_source_sets, []);
  assert.equal(paired.passed, false);
  assert.equal(semanticDelta.coverage_status, "evidence-gap");
  assert.equal(semanticDelta.claim_verdict, "not-established");
});

test("counterevidence stays off the supporting axis and checkpoint hosts count as one scientific result lineage", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  const faithful = audit.topics.find((topic) => topic.id === "coconut-continuous-thought").claims.find((claim) => claim.id === "faithful-reasoning");
  const dynamics = faithful.counterevidence_requirements.find((requirement) => requirement.id === "direct-coconut-trajectory-diagnostic");
  assert.equal(faithful.requirements.length, 1);
  assert.equal(faithful.requirements[0].passed, false);
  assert.equal(dynamics.passed, true);
  assert.equal(dynamics.observed_healthy, 6);
  assert.deepEqual(dynamics.observed_result_independence_groups, ["latent-cot-dynamics-authors"]);
  assert.equal(dynamics.scientific_result_lineage_count, 1);
  assert.equal(faithful.counterevidence_available, true);
  assert.equal(faithful.coverage_status, "evidence-gap");
  assert.equal(faithful.claim_verdict, "not-established");
});

test("diligence verifier enforces isolation and notification boundaries", () => {
  const audit = createSourceDiligenceAudit({ ...fixtureAudits(), now: new Date("2026-07-17T04:00:00.000Z") });
  assert.deepEqual(verifySourceDiligence(audit), { ok: true, errors: [] });
  audit.axis_policy.attention_can_raise_evidence_grade = true;
  audit.notification_policy.enabled = true;
  audit.source_review_queue[0].notification_eligible = true;
  const result = verifySourceDiligence(audit);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("attention must not raise evidence grade"));
  assert.ok(result.errors.includes("notifications must remain disabled"));
  assert.ok(result.errors.includes("source review item cannot notify: candidate:google-adk-releases"));
});
