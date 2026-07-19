import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildTop3EvidenceDossier,
  isAllowedOfficialDetailUrl,
  normalizeOfficialHtml,
} from "../automation/top3-evidence-dossier.mjs";
import { runAndVerifyTop3Evidence } from "../automation/run-and-verify-top3-evidence-dossier.mjs";
import { verifyTop3EvidenceDossier } from "../automation/verify-top3-evidence-dossier.mjs";

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const NOW = "2026-07-18T10:30:00.000Z";

function fixtures() {
  const k3 = {
    rank: 1,
    story_id: "url:kimi.com/blog/kimi-k3",
    title: "Kimi K3: Open Frontier Intelligence",
    primary_section: "new-model",
    canonical_url: "https://www.kimi.com/blog/kimi-k3",
    score: { total: 8.5 },
    source_lanes: ["model-compute-shadow", "tech-discovery"],
    source_ids: ["kimi-research-index"],
  };
  const inspect = {
    rank: 2,
    story_id: "url:github.com/ukgovernmentbeis/inspect_evals/releases/tag/v0.15.0",
    title: "UKGovernmentBEIS/inspect_evals v0.15.0",
    primary_section: "harness-eval",
    mechanism_layer: "E1",
    canonical_url: "https://github.com/UKGovernmentBEIS/inspect_evals/releases/tag/v0.15.0",
    score: { total: 7 },
    source_lanes: ["tech-discovery"],
    source_ids: ["official-github-releases-existing-snapshots"],
  };
  const top3Audit = { generated_at: NOW, selected_top3: [k3, inspect] };
  const techAudit = { generated_at: NOW };
  const mechanismAudit = { generated_at: NOW, records: [] };
  const body = "SciKnowEval domain-prefixed key fell through to Score(0); strips the domain prefix. AbstentionBench compared Yes/No with 1.0, recall/F1 were 0, and had no word boundaries.";
  const release = {
    id: "355500485",
    repository: "UKGovernmentBEIS/inspect_evals",
    tag_name: "v0.15.0",
    release_snapshot_sha256: sha256("release"),
    body_sha256: sha256(body),
    body_excerpt: body,
    body_excerpt_sha256: sha256(body),
    body_excerpt_truncated: false,
    immutable: false,
    target_commitish: "main",
    tag_commit_resolution: "not-fetched",
  };
  const candidateAudit = { source_events: [{ source_id: "inspect-evals-releases", status: "fresh", snapshot: { releases: [release] } }] };
  const modelComputeAudit = { source_events: [], daily_editorial_candidates: [] };
  const normalizedText = [
    "Kimi K3 is built on Kimi Delta Attention (KDA) and Attention Residuals (AttnRes). KDA scales attention, while AttnRes selectively retrieves representations across depth rather than accumulating them uniformly.",
    "Stable LatentMoE effectively activating 16 out of 896 experts.",
    "Quantile Balancing and Per-Head Muon work with Sigmoid Tanh Unit for training.",
    "Kimi K3 applies quantization-aware training with MXFP4 weights and MXFP8 activations.",
    "The full model weights will be released by July 27, 2026 with the technical report.",
    "K3 was trained in preserved thinking history mode and the harness must pass back all the historical thinking content.",
    "Models use three agentic harnesses: KimiCode, Claude Code, and Codex.",
  ].join("\n");
  const officialSnapshots = [{
    url: k3.canonical_url,
    status: "fresh",
    fetched_at: NOW,
    response_bytes: 1000,
    content_sha256: sha256("official-html"),
    normalized_text_sha256: sha256(normalizedText),
    normalized_text: normalizedText,
  }];
  return { top3Audit, techAudit, mechanismAudit, candidateAudit, modelComputeAudit, officialSnapshots };
}

function semanticFixture() {
  return {
    packages: [{ claims: [
      {
        topic_id: "claude-constitution",
        claim_id: "official-text-change",
        evidence_ceiling_when_met: "G3 for intended-policy change only",
      },
      {
        topic_id: "claude-constitution",
        claim_id: "learned-implementation",
        missing_requirements: [{ required_next: "需要公开的因果干预、训练/权重对照和独立复现；官方文本 diff 不能替代。" }],
      },
      {
        topic_id: "ouro-looplm",
        claim_id: "authored-mechanism",
        claim_verdict: "source-supported-with-ceiling",
        evidence_ceiling_when_met: "G2 author-attributed; no adaptive-compute claim",
        evidence: [
          { ref: "candidate:latent-reasoning-arxiv-seeds#2510.25741", label: "Ouro paper version", observed_identity: "arxiv:2510.25741v5", proves: "The authors report the current looped architecture and exit-weighted method.", does_not_prove: "Independent causal validity or production behavior.", healthy: true },
          { ref: "production:ouro-model", label: "ByteDance Ouro model artifact", observed_identity: "model:ByteDance/Ouro-2.6B; revision:ourosha", proves: "Official weights, config and post-loop state-selection code exist.", does_not_prove: "Adaptive recurrent-forward short-circuiting or measured compute savings.", healthy: true },
        ],
      },
      {
        topic_id: "ouro-looplm",
        claim_id: "adaptive-halting-compute-savings",
        missing_requirements: [{ required_next: "The released code must show real loop short-circuiting and matched wall-clock/FLOPs results." }],
      },
      { topic_id: "ouro-looplm", claim_id: "official-model-family", evidence: [] },
      {
        topic_id: "ouro-looplm",
        claim_id: "causal-generalization",
        evidence: [{ label: "Readout Blind Spot", observed_identity: "arxiv:2606.24898v1", proves: "An independent group reports controlled readout and scale-clamp diagnostics.", does_not_prove: "That recurrence itself is globally causal.", evidence_polarity: "mixed", healthy: true }],
      },
      {
        topic_id: "coconut-continuous-thought",
        claim_id: "authored-mechanism",
        claim_verdict: "source-supported-with-ceiling",
        evidence_ceiling_when_met: "G2 author-attributed",
        evidence: [
          { ref: "candidate:latent-reasoning-arxiv-seeds#2412.06769", label: "Coconut paper version", observed_identity: "arxiv:2412.06769v3", proves: "The authors report the continuous hidden-state feedback method.", does_not_prove: "That latent states form a complete or faithful causal reasoning trace.", healthy: true },
          { ref: "production:coconut-code", label: "Meta FAIR Coconut code", observed_identity: "git-commit:coconutsha", proves: "The official implementation and commit identity exist.", does_not_prove: "A cheap turnkey reproduction or official pretrained checkpoint.", healthy: true },
        ],
      },
      {
        topic_id: "coconut-continuous-thought",
        claim_id: "faithful-reasoning",
        missing_requirements: [{ required_next: "Need public raw hidden states and independent cross-backbone reproduction." }],
        evidence: [{ label: "SWITCH hidden-state recurrence paper", observed_identity: "arxiv:2606.13106v1", proves: "Same-norm random-state and other interventions bound a Coconut-style mechanism.", does_not_prove: "A direct intervention on the published Coconut checkpoint or cross-model validity.", evidence_polarity: "mixed", healthy: true }],
      },
    ] }],
  };
}

test("official HTML normalization drops executable and diagram content while preserving decoded text", () => {
  const text = normalizeOfficialHtml("<script>secret()</script><svg><text>diagram</text></svg><p>K3 &amp; AttnRes &#x27;max&#x27;</p>");
  assert.equal(text, "K3 & AttnRes 'max'");
});

test("only first-party hosts enter the official-detail evidence lane", () => {
  assert.equal(isAllowedOfficialDetailUrl("https://www.kimi.com/blog/kimi-k3"), true);
  assert.equal(isAllowedOfficialDetailUrl("https://simonwillison.net/2026/Jul/19/claude-code-in-bun-in-rust"), false);
  assert.equal(isAllowedOfficialDetailUrl("not-a-url"), false);
});

test("selected K3 and Inspect release become detailed claim-bounded dossiers", () => {
  const values = fixtures();
  const audit = buildTop3EvidenceDossier({ ...values, generatedAt: NOW });
  assert.equal(audit.status, "review-ready");
  assert.equal(audit.metrics.key_points_extracted, 9);
  assert.deepEqual(audit.dossiers[0].key_points.map((claim) => claim.topic), [
    "architecture-information-flow",
    "sparse-moe-routing",
    "training-stability",
    "low-precision-and-serving",
    "artifact-availability",
    "harness-state-coupling",
    "benchmark-harness-comparability",
  ]);
  assert.ok(audit.dossiers[0].evidence_gaps.includes("technical-report-not-yet-published"));
  assert.ok(audit.dossiers[1].key_points.some((claim) => claim.topic === "scorer-semantics-sciknoweval"));
  assert.ok(audit.dossiers[1].evidence_gaps.includes("score-comparability-not-established"));

  const inputs = {
    top3Body: JSON.stringify(values.top3Audit),
    techBody: JSON.stringify(values.techAudit),
    mechanismBody: JSON.stringify(values.mechanismAudit),
    candidateBody: JSON.stringify(values.candidateAudit),
    modelComputeBody: JSON.stringify(values.modelComputeAudit),
  };
  assert.deepEqual(verifyTop3EvidenceDossier(audit, inputs), { ok: true, errors: [] });

  const mutated = structuredClone(audit);
  mutated.dossiers[0].key_points[0].claim_evidence_allowed = true;
  const result = verifyTop3EvidenceDossier(mutated, inputs);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("claim crossed review boundary")));
});

test("cold critical path builds Harness evidence from the same-run tech release snapshot", () => {
  const values = fixtures();
  const inspect = values.top3Audit.selected_top3[1];
  const release = values.candidateAudit.source_events[0].snapshot.releases[0];
  values.top3Audit.selected_top3 = [inspect];
  values.candidateAudit = null;
  values.techAudit.source_events = [{
    source_id: "official-github-releases-existing-snapshots",
    status: "fresh",
    items: [{
      canonical_url: inspect.canonical_url,
      summary_for_discovery_only: release.body_excerpt,
      primary_identity_hint: {
        repository: release.repository,
        release_id: release.id,
        tag_name: release.tag_name,
        body_sha256: release.body_sha256,
        body_excerpt_sha256: release.body_excerpt_sha256,
        target_commitish: release.target_commitish,
        immutable: false,
      },
    }],
  }];
  const audit = buildTop3EvidenceDossier({ ...values, generatedAt: NOW });
  assert.equal(audit.status, "review-ready");
  assert.equal(audit.input_snapshots.candidate_fingerprint, null);
  assert.ok(audit.dossiers[0].key_points.some((claim) => claim.topic === "scorer-semantics-sciknoweval"));
  assert.ok(audit.dossiers[0].evidence_gaps.includes("release-tag-commit-not-resolved"));
});

test("an unfamiliar official model gets a generic source-excerpt profile instead of a fabricated mechanism analysis", () => {
  const values = fixtures();
  const item = {
    ...values.top3Audit.selected_top3[0],
    story_id: "url:thinkingmachines.ai/news/new-model",
    title: "A New Model",
    canonical_url: "https://thinkingmachines.ai/news/new-model/",
  };
  values.top3Audit.selected_top3 = [item];
  const text = [
    "The architecture uses a recurrent attention system with a 12B parameter mixture of experts.",
    "Post-training uses SFT and reinforcement learning with a new optimizer.",
    "Weights and model card will be available with an explicit license and technical report.",
    "Evaluation uses an agentic harness with a 100 turn limit and a judge model.",
  ].join("\n");
  values.officialSnapshots = [{
    url: item.canonical_url,
    status: "fresh",
    fetched_at: NOW,
    response_bytes: 900,
    content_sha256: sha256("new-model-html"),
    normalized_text_sha256: sha256(text),
    normalized_text: text,
  }];
  const audit = buildTop3EvidenceDossier({ ...values, generatedAt: NOW });
  assert.equal(audit.dossiers[0].profile, "generic-official-model-release-v1");
  assert.equal(audit.dossiers[0].evidence_status, "source-excerpts-awaiting-model-specific-review");
  assert.ok(audit.dossiers[0].key_points.length >= 3);
  assert.ok(audit.dossiers[0].key_points.every((claim) => claim.evidence_ceiling === "G0-official-excerpt-awaiting-model-specific-review"));
  assert.ok(audit.dossiers[0].evidence_gaps.includes("model-specific-claim-profile-and-human-semantic-review-required"));
});

test("a selected compute release reuses its bounded official body and technical cues", () => {
  const values = fixtures();
  const item = {
    rank: 1,
    story_id: "url:github.com/vllm-project/vllm/releases/tag/v0.25.0",
    title: "vLLM v0.25.0",
    primary_section: "compute-system",
    canonical_url: "https://github.com/vllm-project/vllm/releases/tag/v0.25.0",
    score: { total: 7 },
    source_lanes: ["model-compute-shadow"],
    story_aliases: ["github-release:vllm-project/vllm@v0.25.0"],
  };
  values.top3Audit.selected_top3 = [item];
  const excerpt = "Model Runner V2 is now default with dynamic speculative decoding, CUDA graph support, prefix cache scheduling, and a new fused kernel.";
  values.modelComputeAudit = {
    source_events: [{ source_id: "vllm-rest-releases", status: "fresh" }],
    daily_editorial_candidates: [{
      source_id: "vllm-rest-releases",
      identity: "github-release:vllm-project/vllm@v0.25.0",
      url: item.canonical_url,
      kind: "official-compute-release",
      metadata: {
        release_body_hash: sha256(excerpt),
        release_body_excerpt: excerpt,
        release_body_excerpt_sha256: sha256(excerpt),
        release_body_excerpt_truncated: false,
        semantic_review: { technical_cues: ["runner", "scheduler", "cuda-graph", "kernel"] },
      },
    }],
  };
  values.officialSnapshots = [];
  const audit = buildTop3EvidenceDossier({ ...values, generatedAt: NOW });
  assert.equal(audit.dossiers[0].profile, "versioned-compute-release-v1");
  assert.equal(audit.dossiers[0].key_points[0].topic, "versioned-compute-semantic-change");
  assert.match(audit.dossiers[0].key_points[0].statement_zh, /cuda-graph/);
  assert.equal(audit.dossiers[0].key_points[0].evidence_excerpt, excerpt);
  assert.ok(audit.dossiers[0].evidence_gaps.includes("no-complete-performance-configuration-and-matched-baseline"));
});

test("a selected Claude Constitution change reports a B0 text diff without claiming weight implementation", () => {
  const values = fixtures();
  const item = {
    rank: 1,
    story_id: "github-commit:anthropics/claude-constitution:newsha",
    title: "Clarify Claude Constitution hierarchy",
    primary_section: "mechanism",
    canonical_url: "https://github.com/anthropics/claude-constitution/commit/newsha",
    score: { total: 7.5 },
    source_lanes: ["mechanism-watch"],
  };
  values.top3Audit.selected_top3 = [item];
  values.mechanismAudit.records = [{
    canonical_id: item.story_id,
    canonical_url: item.canonical_url,
    title: item.title,
    seed_ids: ["anthropic-constitution-2026"],
    source_ids: ["anthropic-constitution-text"],
    primary_layer: "B0",
    evidence_grade: "G3",
    artifact_types: ["versioned-policy-text"],
    source_metadata: [{ semantic_diff: { before_excerpt: "Prefer helpfulness unless unsafe.", after_excerpt: "Follow the stated priority hierarchy when helpfulness conflicts with safety." } }],
  }];
  values.semanticReviewAudit = semanticFixture();
  values.officialSnapshots = [];
  const audit = buildTop3EvidenceDossier({ ...values, generatedAt: NOW });
  const dossier = audit.dossiers[0];
  assert.equal(dossier.profile, "claude-constitution-versioned-policy-v1");
  assert.equal(dossier.key_points[0].mechanism_layer, "B0");
  assert.match(dossier.key_points[0].evidence_excerpt, /Before:.*After:/s);
  assert.match(dossier.key_points[0].boundary, /权重实现/);
  assert.ok(dossier.evidence_gaps.includes("policy-text-does-not-prove-learned-weight-implementation"));
});

test("selected Ouro and Coconut stories reuse audited mechanism contracts and preserve causal limits", () => {
  const values = fixtures();
  const ouro = {
    rank: 1,
    story_id: "url:huggingface.co/bytedance/ouro-2.6b",
    title: "ByteDance/Ouro-2.6B",
    primary_section: "mechanism",
    canonical_url: "https://huggingface.co/ByteDance/Ouro-2.6B",
    score: { total: 7 },
    source_lanes: ["mechanism-watch"],
  };
  const coconut = {
    rank: 2,
    story_id: "arxiv:2412.06769",
    title: "Training Large Language Models to Reason in a Continuous Latent Space",
    primary_section: "mechanism",
    canonical_url: "https://arxiv.org/abs/2412.06769",
    score: { total: 7 },
    source_lanes: ["mechanism-watch"],
  };
  values.top3Audit.selected_top3 = [ouro, coconut];
  values.mechanismAudit.records = [
    { canonical_id: ouro.story_id, canonical_url: ouro.canonical_url, title: ouro.title, seed_ids: ["ouro-looped-language-model"], source_ids: ["ouro-model"], primary_layer: "M3", evidence_grade: "G2", artifact_types: ["official-model"], source_metadata: [] },
    { canonical_id: coconut.story_id, canonical_url: coconut.canonical_url, title: coconut.title, seed_ids: ["coconut-continuous-thought"], source_ids: ["arxiv"], primary_layer: "M3", evidence_grade: "G2", artifact_types: ["paper", "official-code"], source_metadata: [] },
  ];
  values.semanticReviewAudit = semanticFixture();
  values.officialSnapshots = [];
  const audit = buildTop3EvidenceDossier({ ...values, generatedAt: NOW });
  assert.equal(audit.dossiers[0].profile, "ouro-looped-latent-reasoning-v1");
  assert.deepEqual(audit.dossiers[0].key_points.map((claim) => claim.topic), ["looped-recurrent-depth", "released-model-and-post-loop-selection", "independent-recurrence-boundary"]);
  assert.ok(audit.dossiers[0].evidence_gaps.includes("no-released-recurrent-forward-short-circuit-or-matched-latency-result"));
  assert.equal(audit.dossiers[1].profile, "coconut-continuous-latent-thought-v1");
  assert.ok(audit.dossiers[1].key_points.some((claim) => claim.topic === "latent-state-faithfulness-boundary"));
  assert.ok(audit.dossiers[1].evidence_gaps.includes("latent-state-function-does-not-establish-faithful-or-interpretable-reasoning"));
  assert.ok(audit.dossiers.flatMap((dossier) => dossier.key_points).every((claim) => claim.evidence_excerpt_kind === "source-diligence-contract"));
});

test("the selected T2MLR paper is decomposed into cross-token state flow, locality, and retrofit claims", () => {
  const values = fixtures();
  const item = {
    rank: 1,
    story_id: "url:arxiv.org/abs/2607.15178v1",
    title: "T^2MLR: Transformer with Temporal Middle-Layer Recurrence",
    primary_section: "mechanism",
    canonical_url: "https://arxiv.org/abs/2607.15178v1",
    score: { total: 5.5 },
    source_lanes: ["mechanism-watch"],
  };
  values.top3Audit.selected_top3 = [item];
  values.mechanismAudit.records = [{
    canonical_id: "arxiv:2607.15178",
    canonical_url: item.canonical_url,
    title: item.title,
    summary: "Transformer reasoning is limited by autoregressive decoding, which repeatedly compresses rich hidden computation through token space and makes it difficult for intermediate reasoning states to persist across time. We introduce T2MLR, a latent reasoning architecture that fuses a cached middle layer representation from the previous token directly into an earlier layer of the current token position. Applying recurrence to only a localized middle-layer block, as little as 20% of the network, often outperforms full-layer recurrence. T2MLR does not require pretraining from scratch: retrofitting the recurrent pathway into an existing pretrained 1.7B Transformer and briefly finetuning improves math reasoning.",
    source_ids: ["arxiv-mechanisms"],
    primary_layer: "M3",
    evidence_grade: "G1",
    artifact_types: ["paper"],
    arxiv_version: 1,
  }];
  values.officialSnapshots = [];
  const audit = buildTop3EvidenceDossier({ ...values, generatedAt: NOW });
  const dossier = audit.dossiers[0];
  assert.equal(dossier.profile, "t2mlr-temporal-middle-layer-recurrence-v1");
  assert.deepEqual(dossier.key_points.map((claim) => claim.topic), [
    "autoregressive-hidden-state-bottleneck",
    "cross-token-middle-layer-recurrence",
    "localized-recurrence-scope",
    "pretrained-model-retrofit",
  ]);
  assert.match(dossier.key_points[1].statement_zh, /上一个 token.*当前 token/);
  assert.match(dossier.key_points[2].statement_zh, /20%/);
  assert.ok(dossier.evidence_gaps.includes("no-independent-reproduction-or-layer-location-intervention"));
});

test("the evidence gate never promotes a failed generation or verification", () => {
  const noCommit = () => assert.fail("promotion must not run");
  assert.equal(runAndVerifyTop3Evidence({ spawnImpl: () => ({ status: 17 }), nodePath: "/node", cwd: "/tmp", environment: {}, promoteImpl: noCommit, unlinkImpl: () => {} }), 17);
  let calls = 0;
  assert.equal(runAndVerifyTop3Evidence({ spawnImpl: () => ({ status: calls++ ? 23 : 0 }), nodePath: "/node", cwd: "/tmp", environment: {}, promoteImpl: noCommit, unlinkImpl: () => {} }), 23);
  let promoted = 0;
  assert.equal(runAndVerifyTop3Evidence({ spawnImpl: () => ({ status: 0 }), nodePath: "/node", cwd: "/tmp", environment: {}, promoteImpl: () => { promoted += 1; }, unlinkImpl: () => {} }), 0);
  assert.equal(promoted, 1);
});
