#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MODEL_COMPUTE_SHADOW_POLICY,
  modelComputeShadowSources,
  validateModelComputeShadowRegistry,
} from "./model-compute-source-registry.mjs";

const REQUIRED_PERFORMANCE_FIELDS = Object.freeze([
  "hardware",
  "precision",
  "batch_or_concurrency",
  "input_output_length",
  "model",
  "software_version",
  "baseline",
  "metric_definition",
  "measurement_identity",
]);

const TECHNICAL_CUES = Object.freeze([
  ["runner", /\bmodel runner\b|\brunner v\d+\b/i],
  ["scheduler", /\bschedul(?:er|ing)\b/i],
  ["speculative-decoding", /\bspeculative decoding\b|\bspec v\d+\b/i],
  ["cuda-graph", /\bcuda graph(?:able)?\b/i],
  ["kv-cache", /\b(?:kv|prefix) cache\b/i],
  ["kernel", /\bkernel\b|\bgemm\b|\battention\b|\bmoe\b/i],
  ["compiler", /\bcompil(?:er|ation)\b|\boperator api\b/i],
  ["parallelism", /\bparallel(?:ism)?\b|\bcollective\b|\boffload\b/i],
  ["runtime-architecture", /\bruntime\b|\bmodular architecture\b|\bthe\s*rock\b/i],
  ["numeric-format", /\bfp\d+\b|\bmx(?:fp)?\d+\b|\bquantiz(?:e|ation)\b/i],
]);

const ORDINARY_PATCH_CUES = Object.freeze([
  /\bpatch release\b/i,
  /\btargeted bug fixes?\b/i,
  /\bdependency (?:update|bump)\b/i,
  /\bcompatibility fix\b/i,
  /\bmodel support fix\b/i,
  /\bcompilation failure\b/i,
  /\bregression fix\b/i,
]);

const array = (value) => Array.isArray(value) ? value : [];
const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");
const normalize = (value) => String(value ?? "").trim();

export const MODEL_COMPUTE_REPLAY_POLICY = Object.freeze({
  schema_version: 1,
  mode: "offline-model-compute-source-admission-replay",
  model_availability_states: ["A1-announced", "A2-api-demo", "A3-open-weights", "A4-reproducible-stack"],
  excludes_derivative_model_kinds: ["adapter", "quantization", "tokenizer", "ordinary-finetune"],
  publication_date_cannot_replace_event_date: true,
  attention_can_raise_availability: false,
  performance_required_fields: REQUIRED_PERFORMANCE_FIELDS,
  ordinary_patch_is_technical_progress: false,
  claim_evidence_allowed: false,
  availability_promotion_allowed: false,
  notification_eligible: false,
  external_actions: [],
});

export const MODEL_COMPUTE_REPLAY_FIXTURES = Object.freeze({
  evaluated_at: "2026-07-18T08:00:00.000Z",
  model_signals: [
    {
      id: "k3-official",
      model_family: "kimi-k3",
      canonical_official_url: "https://www.kimi.com/blog/kimi-k3",
      source_id: "kimi-research-index",
      independence_group: "moonshot-ai",
      official_announcement: true,
      official_api_demo: true,
      downloadable_weights: false,
      explicit_license: false,
      model_card: false,
      inference_code: false,
      inference_config: false,
      object_kind: "foundation-model",
    },
    ...["hacker-news", "latent-space", "simon-willison"].map((group) => ({
      id: `k3-${group}`,
      model_family: "kimi-k3",
      canonical_official_url: "https://www.kimi.com/blog/kimi-k3",
      source_id: group,
      independence_group: group,
      attention_only: true,
      object_kind: "foundation-model",
    })),
    {
      id: "inkling-official",
      model_family: "inkling",
      canonical_official_url: "https://thinkingmachines.ai/news/introducing-inkling/",
      source_id: "thinking-machines-sitemap",
      independence_group: "thinking-machines",
      official_announcement: true,
      object_kind: "foundation-model",
    },
    {
      id: "inkling-artifact",
      model_family: "inkling",
      canonical_official_url: "https://thinkingmachines.ai/news/introducing-inkling/",
      source_id: "hf-org-thinkingmachines",
      independence_group: "thinking-machines",
      downloadable_weights: true,
      explicit_license: true,
      model_card: true,
      inference_code: true,
      inference_config: true,
      object_kind: "foundation-model",
    },
    {
      id: "ordinary-quantization",
      model_family: "example-70b-awq",
      canonical_official_url: "https://huggingface.co/community/example-70b-awq",
      source_id: "hf-models-trending-fallback",
      independence_group: "hugging-face-trending",
      attention_only: true,
      downloadable_weights: true,
      explicit_license: true,
      model_card: true,
      object_kind: "quantization",
    },
  ],
  compute_releases: [
    {
      id: "vllm-0.25.0",
      source_id: "vllm-rest-releases",
      version_identity: "vllm-project/vllm@v0.25.0",
      title: "vLLM v0.25.0",
      body: "Model Runner V2 is now default, with dynamic speculative decoding, CUDA graph support, and prefix cache changes.",
      release_kind: "stable",
      expected_eligible: true,
    },
    {
      id: "vllm-0.25.1",
      source_id: "vllm-rest-releases",
      version_identity: "vllm-project/vllm@v0.25.1",
      title: "vLLM v0.25.1",
      body: "Patch release with two targeted bug fixes.",
      release_kind: "patch",
      expected_eligible: false,
    },
    {
      id: "cutlass-4.6.0",
      source_id: "cutlass-rest-releases",
      version_identity: "NVIDIA/cutlass@v4.6.0",
      title: "CUTLASS 4.6.0",
      body: "Fine-grained compilation control, in-kernel event tracing, and a new Operator API.",
      release_kind: "stable",
      expected_eligible: true,
    },
    {
      id: "cutlass-4.6.1",
      source_id: "cutlass-rest-releases",
      version_identity: "NVIDIA/cutlass@v4.6.1",
      title: "CUTLASS 4.6.1",
      body: "Patch release for compilation failures and regression fixes.",
      release_kind: "patch",
      expected_eligible: false,
    },
    {
      id: "sglang-0.5.15",
      source_id: "sglang-rest-releases",
      version_identity: "sgl-project/sglang@v0.5.15",
      title: "SGLang 0.5.15",
      body: "Spec V2, CUDA-graphable scheduling, IndexShare MTP, and TopK kernel fusion.",
      release_kind: "stable",
      expected_eligible: true,
    },
    {
      id: "bluefield-old-event-explainer",
      source_id: "nvidia-developer-blog-atom",
      version_identity: "",
      title: "How BlueField-4 powers AI infrastructure",
      body: "A technical explainer for the previously announced BlueField-4, DOCA, and CMX architecture.",
      release_kind: "article",
      publication_repackages_prior_event: true,
      expected_eligible: false,
    },
    {
      id: "vendor-incomplete-performance",
      source_id: "nvidia-newsroom-press-xml",
      version_identity: "vendor-product-v1",
      title: "Vendor reports 10x inference throughput",
      body: "A new AI system reports 10x inference throughput over the previous generation.",
      release_kind: "product-announcement",
      performance_claim: true,
      performance_configuration: {
        hardware: "Vendor GPU X",
        precision: "FP8",
        model: "ExampleLM",
      },
      expected_eligible: false,
    },
  ],
});

export function evaluateModelAvailability(signals) {
  const accepted = array(signals).filter((signal) => !MODEL_COMPUTE_REPLAY_POLICY.excludes_derivative_model_kinds.includes(signal?.object_kind));
  const official = accepted.some((signal) => signal?.official_announcement === true);
  const apiDemo = accepted.some((signal) => signal?.official_api_demo === true);
  const downloadableWeights = accepted.some((signal) => signal?.downloadable_weights === true);
  const explicitLicense = accepted.some((signal) => signal?.explicit_license === true);
  const modelCard = accepted.some((signal) => signal?.model_card === true);
  const inferenceCode = accepted.some((signal) => signal?.inference_code === true);
  const inferenceConfig = accepted.some((signal) => signal?.inference_config === true);
  const openWeights = downloadableWeights && explicitLicense && modelCard;
  const reproducibleStack = openWeights && inferenceCode && inferenceConfig;
  return {
    "A1-announced": official,
    "A2-api-demo": apiDemo,
    "A3-open-weights": openWeights,
    "A4-reproducible-stack": reproducibleStack,
    observed_artifacts: {
      downloadable_weights: downloadableWeights,
      explicit_license: explicitLicense,
      model_card: modelCard,
      inference_code: inferenceCode,
      inference_config: inferenceConfig,
    },
    training_openness_proven: false,
  };
}

export function mergeModelSignals(signals) {
  const groups = new Map();
  for (const signal of array(signals)) {
    const key = normalize(signal?.canonical_official_url) || normalize(signal?.model_family);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(signal);
  }
  return [...groups.entries()].map(([storyId, records]) => {
    const derivativeOnly = records.every((record) => MODEL_COMPUTE_REPLAY_POLICY.excludes_derivative_model_kinds.includes(record?.object_kind));
    const attentionGroups = [...new Set(records.filter((record) => record?.attention_only === true).map((record) => record.independence_group).filter(Boolean))].sort();
    return {
      story_id: storyId,
      model_family: records[0]?.model_family || storyId,
      source_ids: [...new Set(records.map((record) => record.source_id).filter(Boolean))].sort(),
      attention_groups: attentionGroups,
      availability: evaluateModelAvailability(records),
      eligible_for_editorial_review: !derivativeOnly && records.some((record) => record?.official_announcement === true),
      exclusion_reason: derivativeOnly ? "derivative-model-kind" : records.some((record) => record?.official_announcement === true) ? null : "official-announcement-required",
      manual_review_only: true,
      claim_evidence_allowed: false,
      availability_promotion_allowed: false,
      notification_eligible: false,
    };
  }).sort((left, right) => left.model_family.localeCompare(right.model_family));
}

function performanceConfiguration(release) {
  if (release?.performance_claim !== true) return { complete: true, missing: [] };
  const config = release?.performance_configuration || {};
  const missing = REQUIRED_PERFORMANCE_FIELDS.filter((field) => !normalize(config[field]));
  return { complete: missing.length === 0, missing };
}

export function classifyComputeRelease(release) {
  const text = `${normalize(release?.title)}\n${normalize(release?.body)}`;
  const technicalCues = TECHNICAL_CUES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const patchCues = ORDINARY_PATCH_CUES.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
  const perf = performanceConfiguration(release);
  const reasons = [];
  if (!normalize(release?.version_identity)) reasons.push("versioned-event-identity-required");
  if (release?.publication_repackages_prior_event === true) reasons.push("article-date-does-not-create-a-new-product-event");
  if (release?.release_kind === "patch" || patchCues.length > 0) reasons.push("ordinary-patch-or-maintenance-release");
  if (technicalCues.length === 0) reasons.push("no-compute-system-semantic-delta");
  if (!perf.complete) reasons.push("performance-configuration-incomplete");
  return {
    id: release?.id,
    source_id: release?.source_id,
    version_identity: normalize(release?.version_identity),
    eligible_for_editorial_review: reasons.length === 0,
    technical_cues: technicalCues,
    patch_cues: patchCues,
    performance_configuration_complete: perf.complete,
    missing_performance_fields: perf.missing,
    exclusion_reasons: reasons,
    performance_claim_status: release?.performance_claim === true
      ? perf.complete ? "vendor-claim-configured-not-independent" : "vendor-claim-incomplete"
      : "not-applicable",
    manual_review_only: true,
    claim_evidence_allowed: false,
    notification_eligible: false,
  };
}

export function buildModelComputePolicyReplay(fixtures = MODEL_COMPUTE_REPLAY_FIXTURES) {
  const registryValidation = validateModelComputeShadowRegistry();
  if (!registryValidation.ok) throw new Error(`invalid model/compute shadow registry: ${registryValidation.errors.join(", ")}`);
  const modelStories = mergeModelSignals(fixtures.model_signals);
  const computeCases = array(fixtures.compute_releases).map((release) => ({
    ...classifyComputeRelease(release),
    expected_eligible: release.expected_eligible,
    expectation_met: classifyComputeRelease(release).eligible_for_editorial_review === release.expected_eligible,
  }));
  const k3 = modelStories.find((story) => story.model_family === "kimi-k3");
  const inkling = modelStories.find((story) => story.model_family === "inkling");
  return {
    schema_version: 1,
    mode: MODEL_COMPUTE_REPLAY_POLICY.mode,
    generated_at: fixtures.evaluated_at,
    fixture_fingerprint: sha256(JSON.stringify(fixtures)),
    registry: {
      source_count: modelComputeShadowSources.length,
      new_model_sources: modelComputeShadowSources.filter((sourceItem) => sourceItem.lane === "new-model").length,
      compute_system_sources: modelComputeShadowSources.filter((sourceItem) => sourceItem.lane === "compute-system").length,
      validation: registryValidation,
      production_registry_changed: MODEL_COMPUTE_SHADOW_POLICY.changes_production_registry,
    },
    policy: MODEL_COMPUTE_REPLAY_POLICY,
    model_stories: modelStories,
    compute_cases: computeCases,
    acceptance: {
      k3_story_merged_once: modelStories.filter((story) => story.model_family === "kimi-k3").length === 1,
      k3_attention_groups: k3?.attention_groups || [],
      k3_availability_boundary_correct: k3?.availability?.["A1-announced"] === true
        && k3?.availability?.["A2-api-demo"] === true
        && k3?.availability?.["A3-open-weights"] === false
        && k3?.availability?.["A4-reproducible-stack"] === false,
      inkling_open_weights_boundary_correct: inkling?.availability?.["A1-announced"] === true
        && inkling?.availability?.["A3-open-weights"] === true
        && inkling?.availability?.["A4-reproducible-stack"] === true
        && inkling?.availability?.training_openness_proven === false,
      all_compute_expectations_met: computeCases.every((item) => item.expectation_met),
      notification_boundary_closed: true,
    },
    notification_policy: { enabled: false, eligible_records: 0 },
    external_actions: [],
  };
}

async function writeJsonAtomic(filePath, value) {
  const target = resolve(filePath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function main() {
  const outputPath = process.env.MODEL_COMPUTE_REPLAY_OUTPUT_PATH || "work/model-compute-source-replay/audit.json";
  const audit = buildModelComputePolicyReplay();
  await writeJsonAtomic(outputPath, audit);
  process.stdout.write(`model/compute policy replay: ${audit.registry.source_count} shadow sources, ${audit.compute_cases.filter((item) => item.eligible_for_editorial_review).length} compute candidates, notifications 0\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
