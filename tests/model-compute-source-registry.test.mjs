import assert from "node:assert/strict";
import test from "node:test";
import {
  getModelComputeShadowSource,
  hfOrganizationIdentityBindings,
  MODEL_COMPUTE_SHADOW_POLICY,
  modelComputeShadowSources,
  validateModelComputeShadowRegistry,
} from "../automation/model-compute-source-registry.mjs";

test("the model and compute registry is bounded, public, isolated, and notification-free", () => {
  assert.deepEqual(validateModelComputeShadowRegistry(), { ok: true, errors: [] });
  assert.equal(modelComputeShadowSources.length, 16);
  assert.equal(modelComputeShadowSources.filter((source) => source.lane === "new-model").length, 9);
  assert.equal(modelComputeShadowSources.filter((source) => source.lane === "compute-system").length, 7);
  assert.ok(modelComputeShadowSources.every((source) => source.authentication === "public"));
  assert.ok(modelComputeShadowSources.every((source) => source.limits.request_budget === 1));
  assert.ok(modelComputeShadowSources.every((source) => source.limits.max_bytes <= 1_000_000));
  assert.ok(modelComputeShadowSources.every((source) => source.onboarding_baseline_required));
  assert.ok(modelComputeShadowSources.every((source) => !source.production_write_allowed && !source.claim_evidence_allowed));
  assert.ok(modelComputeShadowSources.every((source) => !source.can_raise_evidence_grade && !source.can_change_availability_state && !source.can_trigger_notification));
  assert.equal(MODEL_COMPUTE_SHADOW_POLICY.changes_production_registry, false);
  assert.equal(MODEL_COMPUTE_SHADOW_POLICY.notification_eligible, false);
  assert.deepEqual(MODEL_COMPUTE_SHADOW_POLICY.external_actions, []);
});

test("the minimum daily source contract is exactly three indexes, five HF orgs, one attention fallback, and seven compute sources", () => {
  assert.deepEqual(modelComputeShadowSources.map((source) => source.id), [
    "kimi-research-index",
    "thinking-machines-sitemap",
    "mistral-news-index",
    "hf-org-moonshotai",
    "hf-org-qwen",
    "hf-org-mistralai",
    "hf-org-deepseek-ai",
    "hf-org-thinkingmachines",
    "hf-models-trending-fallback",
    "nvidia-developer-blog-atom",
    "nvidia-newsroom-press-xml",
    "rocm-release-history",
    "vllm-rest-releases",
    "sglang-rest-releases",
    "tensorrt-llm-rest-releases",
    "cutlass-rest-releases",
  ]);
  assert.equal(getModelComputeShadowSource("mistral-news-index").admission.status, "supplemental-shadow");
  assert.equal(getModelComputeShadowSource("hf-org-qwen").identity_binding, "primary-source-verified-pending-human-signoff");
  assert.equal(getModelComputeShadowSource("hf-models-trending-fallback").authority_tier, "T1");
});

test("all five HF organizations have direct official-property reverse links but no fabricated human signoff", () => {
  assert.deepEqual(Object.keys(hfOrganizationIdentityBindings), ["moonshotai", "qwen", "mistralai", "deepseek-ai", "thinkingmachines"]);
  for (const [key, binding] of Object.entries(hfOrganizationIdentityBindings)) {
    assert.equal(binding.status, "primary-source-verified-pending-human-signoff", key);
    assert.equal(binding.human_signoff, null, key);
    assert.match(binding.extracted_markdown_sha256, /^[a-f0-9]{64}$/, key);
    assert.equal(new URL(binding.official_source_url).hostname === "huggingface.co", false, key);
    assert.equal(new URL(binding.direct_hf_target_url).hostname, "huggingface.co", key);
  }
  const hfSources = modelComputeShadowSources.filter((source) => source.role === "official-organization-artifact-discovery");
  assert.equal(hfSources.length, 5);
  assert.ok(hfSources.every((source) => source.identity_binding_evidence.human_signoff === null));
});

test("GitHub release discovery uses REST instead of robots-disallowed Atom feeds", () => {
  const githubSources = modelComputeShadowSources.filter((source) => source.format === "github-rest-releases-json");
  assert.equal(githubSources.length, 4);
  assert.ok(githubSources.every((source) => source.endpoint.startsWith("https://api.github.com/repos/")));
  assert.ok(githubSources.every((source) => !source.endpoint.includes("releases.atom")));
  assert.ok(githubSources.every((source) => source.admission.robots_decision === "use-official-rest-api-not-atom"));
});

test("the registry validator fails closed on safety, credentials, response bounds, and Atom endpoints", () => {
  const mutated = structuredClone(modelComputeShadowSources);
  mutated[0].claim_evidence_allowed = true;
  mutated[1].authentication = "google-oauth";
  mutated[2].limits.max_bytes = 2_000_000;
  mutated[12].endpoint = "https://github.com/vllm-project/vllm/releases.atom";
  mutated[3].identity_binding_evidence.direct_hf_target_url = "https://huggingface.co/unrelated/model";
  const result = validateModelComputeShadowRegistry(mutated);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("claim_evidence_allowed-boundary-violated: kimi-research-index"));
  assert.ok(result.errors.includes("credential-dependency: thinking-machines-sitemap"));
  assert.ok(result.errors.includes("unbounded-response: mistral-news-index"));
  assert.ok(result.errors.includes("forbidden-github-atom-endpoint: vllm-rest-releases"));
  assert.ok(result.errors.includes("HF-organization-target-namespace-mismatch: hf-org-moonshotai"));
});
