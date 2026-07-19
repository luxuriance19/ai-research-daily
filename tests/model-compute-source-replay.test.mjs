import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModelComputePolicyReplay,
  classifyComputeRelease,
  evaluateModelAvailability,
  mergeModelSignals,
  MODEL_COMPUTE_REPLAY_FIXTURES,
} from "../automation/replay-model-compute-source-policy.mjs";
import { verifyModelComputeSourceReplay } from "../automation/verify-model-compute-source-replay.mjs";

test("K3 is merged once and attention cannot upgrade announced/API status into open weights", () => {
  const audit = buildModelComputePolicyReplay();
  const k3 = audit.model_stories.find((story) => story.model_family === "kimi-k3");
  assert.ok(k3);
  assert.deepEqual(k3.attention_groups, ["hacker-news", "latent-space", "simon-willison"]);
  assert.equal(k3.availability["A1-announced"], true);
  assert.equal(k3.availability["A2-api-demo"], true);
  assert.equal(k3.availability["A3-open-weights"], false);
  assert.equal(k3.availability["A4-reproducible-stack"], false);
  assert.equal(audit.model_stories.filter((story) => story.model_family === "kimi-k3").length, 1);
});

test("Inkling can reach reproducible open stack without implying training openness", () => {
  const audit = buildModelComputePolicyReplay();
  const inkling = audit.model_stories.find((story) => story.model_family === "inkling");
  assert.equal(inkling.availability["A1-announced"], true);
  assert.equal(inkling.availability["A3-open-weights"], true);
  assert.equal(inkling.availability["A4-reproducible-stack"], true);
  assert.equal(inkling.availability.training_openness_proven, false);
});

test("weights alone cannot establish A3 and inference code alone cannot establish A4", () => {
  const availability = evaluateModelAvailability([{
    official_announcement: true,
    downloadable_weights: true,
    explicit_license: false,
    model_card: true,
    inference_code: true,
    inference_config: true,
    object_kind: "foundation-model",
  }]);
  assert.equal(availability["A1-announced"], true);
  assert.equal(availability["A3-open-weights"], false);
  assert.equal(availability["A4-reproducible-stack"], false);
});

test("quantizations, adapters, tokenizers, and ordinary finetunes remain discovery-only", () => {
  const stories = mergeModelSignals([
    { model_family: "q", canonical_official_url: "https://example.test/q", object_kind: "quantization", official_announcement: false },
    { model_family: "a", canonical_official_url: "https://example.test/a", object_kind: "adapter", official_announcement: false },
    { model_family: "t", canonical_official_url: "https://example.test/t", object_kind: "tokenizer", official_announcement: false },
    { model_family: "f", canonical_official_url: "https://example.test/f", object_kind: "ordinary-finetune", official_announcement: false },
  ]);
  assert.ok(stories.every((story) => !story.eligible_for_editorial_review));
  assert.ok(stories.every((story) => story.exclusion_reason === "derivative-model-kind"));
});

test("major runtime and kernel releases pass while ordinary patches fail", () => {
  const audit = buildModelComputePolicyReplay();
  const byId = Object.fromEntries(audit.compute_cases.map((item) => [item.id, item]));
  assert.equal(byId["vllm-0.25.0"].eligible_for_editorial_review, true);
  assert.equal(byId["vllm-0.25.1"].eligible_for_editorial_review, false);
  assert.ok(byId["vllm-0.25.1"].exclusion_reasons.includes("ordinary-patch-or-maintenance-release"));
  assert.equal(byId["cutlass-4.6.0"].eligible_for_editorial_review, true);
  assert.equal(byId["cutlass-4.6.1"].eligible_for_editorial_review, false);
  assert.equal(byId["sglang-0.5.15"].eligible_for_editorial_review, true);
});

test("a newly published explainer cannot manufacture a new product event", () => {
  const fixture = MODEL_COMPUTE_REPLAY_FIXTURES.compute_releases.find((item) => item.id === "bluefield-old-event-explainer");
  const result = classifyComputeRelease(fixture);
  assert.equal(result.eligible_for_editorial_review, false);
  assert.ok(result.exclusion_reasons.includes("article-date-does-not-create-a-new-product-event"));
  assert.ok(result.exclusion_reasons.includes("versioned-event-identity-required"));
});

test("vendor performance claims fail closed when any required configuration is absent", () => {
  const fixture = MODEL_COMPUTE_REPLAY_FIXTURES.compute_releases.find((item) => item.id === "vendor-incomplete-performance");
  const result = classifyComputeRelease(fixture);
  assert.equal(result.eligible_for_editorial_review, false);
  assert.equal(result.performance_claim_status, "vendor-claim-incomplete");
  assert.ok(result.missing_performance_fields.includes("baseline"));
  assert.ok(result.exclusion_reasons.includes("performance-configuration-incomplete"));
});

test("the verifier keeps deterministic, evidence, notification, and external-action boundaries closed", () => {
  const audit = buildModelComputePolicyReplay();
  assert.deepEqual(verifyModelComputeSourceReplay(audit), { ok: true, errors: [] });
  assert.equal(audit.notification_policy.enabled, false);
  assert.deepEqual(audit.external_actions, []);

  const mutated = structuredClone(audit);
  mutated.model_stories[0].notification_eligible = true;
  const result = verifyModelComputeSourceReplay(mutated);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("audit-does-not-match-deterministic-replay"));
  assert.ok(result.errors.some((error) => error.startsWith("model-story-crossed-safety-boundary:")));
});
