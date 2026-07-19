import assert from "node:assert/strict";
import test from "node:test";
import { buildUnifiedTop3Replay } from "../automation/unified-top3-replay.mjs";
import { runAndVerifyUnifiedTop3 } from "../automation/run-and-verify-unified-top3.mjs";
import { verifyUnifiedTop3Replay } from "../automation/verify-unified-top3-replay.mjs";

const NOW = "2026-07-18T06:25:18.683Z";

function mechanismRecord({
  id,
  title,
  layer,
  publishedAt = "2026-07-17T04:00:00.000Z",
  concrete = true,
  evidence = "G1",
  artifacts = ["paper"],
  sourceIds = ["arxiv-mechanisms"],
}) {
  return {
    canonical_id: id,
    canonical_url: `https://arxiv.org/abs/${id.replace("arxiv:", "")}`,
    title,
    published_at: publishedAt,
    source_ids: sourceIds,
    sources: sourceIds.map((sourceId) => ({ id: sourceId, official: false, artifact_type: "paper" })),
    artifact_types: artifacts,
    primary_layer: layer,
    concrete_mechanism_delta: concrete,
    evidence_grade: evidence,
    change: "unchanged",
  };
}

function releaseSemanticReview(hasDelta = true) {
  return {
    has_semantic_delta_cue: hasDelta,
    human_semantic_review_required: hasDelta,
    capability_uplift_proven: false,
    score_comparability_proven: false,
  };
}

function techItem({
  storyId,
  title,
  url,
  sections,
  publishedAt,
  basis,
  fingerprint,
  kind = "community-story",
  groups = [],
  semanticReview = null,
  bridgeEligible = true,
  performanceClaim = false,
  performanceConfigurationComplete,
  repository,
  artifactLinks = [],
}) {
  return {
    canonical_story_key: storyId,
    title,
    canonical_url: url,
    daily_sections: sections,
    published_at: publishedAt,
    normalized_event_identity_basis: basis,
    normalized_event_fingerprint: fingerprint,
    discovery_kind: kind,
    editorial_identity_ready: bridgeEligible,
    editorial_bridge_eligible: bridgeEligible,
    primary_verified: false,
    change_candidate: false,
    performance_claim: performanceClaim,
    performance_configuration_complete: performanceConfigurationComplete,
    release_semantic_review: semanticReview,
    primary_identity_hint: repository ? { repository } : {},
    artifact_links: artifactLinks,
    source_records: groups.map((group, index) => ({ source_id: `source-${index}`, independence_group: group })),
  };
}

function modelComputeItem({
  sourceId,
  identity,
  title,
  url,
  publishedAt,
  kind,
  metadata = {},
}) {
  return {
    source_id: sourceId,
    identity,
    title,
    url,
    published_at: publishedAt,
    updated_at: null,
    kind,
    metadata,
    manual_review_only: true,
    primary_verification_required: true,
    claim_evidence_allowed: false,
    can_raise_evidence_grade: false,
    can_change_availability_state: false,
    notification_eligible: false,
    editorial_gate: {
      eligible: true,
      reasons: [],
      manual_review_only: true,
      claim_evidence_allowed: false,
      notification_eligible: false,
    },
  };
}

function fixtureAudits() {
  const mechanismAudit = {
    generated_at: "2026-07-18T00:20:04.196Z",
    source_events: [{ source_id: "arxiv-mechanisms", status: "fresh" }],
    records: [
      mechanismRecord({
        id: "arxiv:2607.14427",
        title: "Per-Token Fixed-Point Convergence in Depth-Recurrent Transformers",
        layer: "M1",
      }),
      mechanismRecord({ id: "arxiv:2607.14306", title: "Tracing LLM Behavior to Training Data", layer: "M4" }),
      mechanismRecord({ id: "arxiv:2607.14000", title: "Ordinary Harness Patch", layer: "H1", concrete: false }),
    ],
  };
  const techAudit = {
    generated_at: NOW,
    daily_current_window_review: [
      techItem({
        storyId: "event:k3",
        title: "Kimi K3: Open Frontier Intelligence",
        url: "https://www.kimi.com/blog/kimi-k3",
        sections: ["new-model", "evaluation"],
        publishedAt: "2026-07-16T14:46:05.000Z",
        basis: "canonical-official-announcement",
        fingerprint: "official-announcement:kimi.com/blog/kimi-k3",
        groups: ["hacker-news", "latent-space", "simon-willison"],
      }),
      techItem({
        storyId: "event:inspect",
        title: "Inspect Evals v0.15.0",
        url: "https://github.com/UKGovernmentBEIS/inspect_evals/releases/tag/v0.15.0",
        sections: ["evaluation"],
        publishedAt: "2026-07-17T06:06:52.000Z",
        basis: "primary-identity-hint",
        fingerprint: "git-release:ukgovernmentbeis/inspect_evals@v0.15.0",
        kind: "github-release",
        semanticReview: releaseSemanticReview(),
        repository: "UKGovernmentBEIS/inspect_evals",
      }),
      techItem({
        storyId: "event:agents",
        title: "OpenAI Agents SDK v0.18.3",
        url: "https://github.com/openai/openai-agents-python/releases/tag/v0.18.3",
        sections: ["harness"],
        publishedAt: "2026-07-17T03:39:51.000Z",
        basis: "primary-identity-hint",
        fingerprint: "git-release:openai/openai-agents-python@v0.18.3",
        kind: "github-release",
        semanticReview: releaseSemanticReview(),
        repository: "openai/openai-agents-python",
      }),
      techItem({
        storyId: "event:patch",
        title: "Claude Agent SDK patch",
        url: "https://github.com/anthropics/claude-agent-sdk-python/releases/tag/v0.2.122",
        sections: ["harness"],
        publishedAt: "2026-07-18T01:33:32.000Z",
        basis: "primary-identity-hint",
        fingerprint: "git-release:anthropics/claude-agent-sdk-python@v0.2.122",
        kind: "github-release",
        semanticReview: releaseSemanticReview(false),
        repository: "anthropics/claude-agent-sdk-python",
      }),
      techItem({
        storyId: "event:bare-repo",
        title: "Popular bare repository",
        url: "https://github.com/example/hot-agent",
        sections: ["harness"],
        publishedAt: "2026-07-18T01:00:00.000Z",
        basis: "normalized-title",
        fingerprint: "github-repository:example/hot-agent",
        bridgeEligible: false,
        groups: ["github-trending"],
      }),
      techItem({
        storyId: "event:vendor-number",
        title: "Vendor reports 10x GPU speed",
        url: "https://vendor.example/new-chip",
        sections: ["compute-chip"],
        publishedAt: "2026-07-18T01:00:00.000Z",
        basis: "canonical-official-announcement",
        fingerprint: "official-announcement:vendor.example/new-chip",
        performanceClaim: true,
        performanceConfigurationComplete: false,
      }),
    ],
  };
  const k3 = modelComputeItem({
    sourceId: "kimi-research-index",
    identity: "official-article:https://www.kimi.com/blog/kimi-k3",
    title: "Kimi K3",
    url: "https://www.kimi.com/blog/kimi-k3",
    publishedAt: "2026-07-16T16:00:00.000Z",
    kind: "official-model-announcement-index-item",
  });
  const modelComputeAudit = {
    generated_at: NOW,
    source_registry: [{
      id: "kimi-research-index",
      lane: "new-model",
      role: "official-announcement-discovery",
      independence_group: "moonshot-ai",
      identity_binding: "official-domain-index-reviewed",
    }],
    source_events: [{
      source_id: "kimi-research-index",
      status: "fresh",
      current_window_items: [k3],
    }],
    daily_editorial_candidates: [k3],
  };
  return { mechanismAudit, techAudit, modelComputeAudit };
}

test("the simple replay merges all lanes and selects one representative per primary section", () => {
  const { mechanismAudit, techAudit, modelComputeAudit } = fixtureAudits();
  const audit = buildUnifiedTop3Replay({ mechanismAudit, techAudit, modelComputeAudit, now: NOW });
  assert.deepEqual(audit.selected_top3.map((item) => item.title), [
    "Kimi K3",
    "Inspect Evals v0.15.0",
    "Per-Token Fixed-Point Convergence in Depth-Recurrent Transformers",
  ]);
  assert.deepEqual(audit.selected_top3.map((item) => item.primary_section), ["new-model", "harness-eval", "mechanism"]);
  assert.deepEqual(audit.selected_top3.map((item) => item.score.total), [8.5, 7, 6]);
  assert.equal(audit.selected_top3[0].limitations.includes("primary-claim-not-yet-verified"), true);
  assert.equal(audit.selected_top3[1].limitations.includes("score-comparability-not-proven"), true);
  assert.deepEqual(audit.selected_top3[0].source_lanes, ["model-compute-shadow", "tech-discovery"]);
  assert.equal(audit.eligible_candidates.filter((item) => item.canonical_url === "https://www.kimi.com/blog/kimi-k3").length, 1);
  assert.equal(audit.metrics.model_compute_editorial_candidates_read, 1);
});

test("editorial attention can merge into K3 but cannot replace its official representative URL", () => {
  const { mechanismAudit, techAudit, modelComputeAudit } = fixtureAudits();
  const editorial = techAudit.daily_current_window_review[0];
  editorial.title = "[AINews] Kimi K3 2.8T-A50B: media framing";
  editorial.canonical_url = "https://www.latent.space/p/ainews-kimi-k3";
  editorial.artifact_links = [{ url: "https://www.kimi.com/blog/kimi-k3", candidate_type: "official-article-candidate" }];

  const audit = buildUnifiedTop3Replay({ mechanismAudit, techAudit, modelComputeAudit, now: NOW });
  const k3 = audit.selected_top3[0];
  assert.equal(k3.title, "Kimi K3");
  assert.equal(k3.canonical_url, "https://www.kimi.com/blog/kimi-k3");
  assert.equal(k3.representative_source_lane, "model-compute-shadow");
  assert.equal(k3.score.independent_attention, 2);
  assert.equal(k3.score.total, 8.5);
  assert.deepEqual(k3.source_lanes, ["model-compute-shadow", "tech-discovery"]);
  assert.equal(audit.eligible_candidates.filter((item) => /kimi-k3/.test(item.canonical_story_identity)).length, 1);
});

test("a later editorial story cannot refresh an expired official model event", () => {
  const { mechanismAudit, techAudit, modelComputeAudit } = fixtureAudits();
  mechanismAudit.records = [];
  techAudit.daily_current_window_review = [techAudit.daily_current_window_review[0]];
  const editorial = techAudit.daily_current_window_review[0];
  editorial.title = "[AINews] Kimi K3 follow-up coverage";
  editorial.published_at = "2026-07-17T01:46:36.000Z";
  editorial.canonical_url = "https://www.latent.space/p/ainews-kimi-k3";
  editorial.artifact_links = [{ url: "https://www.kimi.com/blog/kimi-k3", candidate_type: "official-article-candidate" }];

  const audit = buildUnifiedTop3Replay({
    mechanismAudit,
    techAudit,
    modelComputeAudit,
    now: "2026-07-18T16:08:03.733Z",
  });
  assert.equal(audit.selected_top3.length, 0);
  assert.equal(audit.eligible_candidates.some((item) => /kimi-k3/.test(item.canonical_story_identity)), false);
  assert.equal(audit.metrics.exclusion_counts["outside-48-hour-window"], 2);
});

test("ordinary patches, bare Trending repositories, and unconfigured vendor numbers fail the hard gate", () => {
  const { mechanismAudit, techAudit, modelComputeAudit } = fixtureAudits();
  const audit = buildUnifiedTop3Replay({ mechanismAudit, techAudit, modelComputeAudit, now: NOW });
  const eligibleTitles = new Set(audit.eligible_candidates.map((item) => item.title));
  assert.equal(eligibleTitles.has("Ordinary Harness Patch"), false);
  assert.equal(eligibleTitles.has("Claude Agent SDK patch"), false);
  assert.equal(eligibleTitles.has("Popular bare repository"), false);
  assert.equal(eligibleTitles.has("Vendor reports 10x GPU speed"), false);
  assert.equal(audit.metrics.exclusion_counts["no-concrete-technical-delta"], 1);
  assert.equal(audit.metrics.exclusion_counts["release-without-semantic-delta"], 1);
  assert.equal(audit.metrics.exclusion_counts["no-primary-identity-bridge"], 1);
  assert.equal(audit.metrics.exclusion_counts["vendor-performance-config-incomplete"], 1);
});

test("a semantic compute release competes in the same Top 3 while a stale-cache projection cannot enter", () => {
  const { mechanismAudit, techAudit, modelComputeAudit } = fixtureAudits();
  const release = modelComputeItem({
    sourceId: "vllm-rest-releases",
    identity: "github-release:vllm-project/vllm@v0.25.0",
    title: "vLLM v0.25.0",
    url: "https://github.com/vllm-project/vllm/releases/tag/v0.25.0",
    publishedAt: "2026-07-18T01:00:00.000Z",
    kind: "official-compute-release",
    metadata: { semantic_review: { human_semantic_review_required: true } },
  });
  modelComputeAudit.source_registry.push({
    id: "vllm-rest-releases",
    lane: "compute-system",
    role: "official-version-discovery",
    independence_group: "vllm-project",
    identity_binding: "not-applicable",
  });
  modelComputeAudit.source_events.push({ source_id: "vllm-rest-releases", status: "fresh", current_window_items: [release] });
  modelComputeAudit.daily_editorial_candidates.push(release);

  const audit = buildUnifiedTop3Replay({ mechanismAudit, techAudit, modelComputeAudit, now: NOW });
  assert.deepEqual(audit.selected_top3.map((item) => item.title), [
    "Kimi K3",
    "Inspect Evals v0.15.0",
    "vLLM v0.25.0",
  ]);
  assert.equal(audit.selected_top3[2].primary_section, "compute-system");

  modelComputeAudit.source_events.at(-1).status = "stale-cache";
  const staleAudit = buildUnifiedTop3Replay({ mechanismAudit, techAudit, modelComputeAudit, now: NOW });
  assert.equal(staleAudit.eligible_candidates.some((item) => item.title === "vLLM v0.25.0"), false);
  assert.equal(staleAudit.metrics.exclusion_counts["no-current-model-compute-source-snapshot"], 1);
});

test("a versioned low-attention B0 change remains eligible without community popularity", () => {
  const mechanismAudit = {
    generated_at: NOW,
    source_events: [{ source_id: "constitution", status: "fresh" }],
    records: [{
      canonical_id: "github-commit:anthropics/claude-constitution:abc123",
      canonical_url: "https://github.com/anthropics/claude-constitution/commit/abc123",
      title: "Claude Constitution versioned text change",
      published_at: "2026-07-18T01:00:00.000Z",
      source_ids: ["constitution"],
      sources: [{ id: "constitution", official: true, artifact_type: "versioned-policy" }],
      artifact_types: ["versioned-policy"],
      primary_layer: "B0",
      concrete_mechanism_delta: true,
      evidence_grade: "G1",
      change: "updated",
    }],
  };
  const audit = buildUnifiedTop3Replay({ mechanismAudit, techAudit: { generated_at: NOW, daily_current_window_review: [] }, now: NOW });
  assert.equal(audit.selected_top3.length, 1);
  assert.equal(audit.selected_top3[0].title, "Claude Constitution versioned text change");
  assert.equal(audit.selected_top3[0].score.independent_attention, 0);
  assert.equal(audit.selected_top3[0].manual_review_only, true);
});

test("a 5.5-point primary mechanism paper remains selectable without code or community attention", () => {
  const mechanismAudit = {
    generated_at: NOW,
    source_events: [{ source_id: "arxiv-mechanisms", status: "fresh" }],
    records: [mechanismRecord({
      id: "arxiv:2607.15555",
      title: "A New Bottom-Level Transformer Mechanism",
      layer: "M1",
      publishedAt: "2026-07-16T14:25:18.683Z",
    })],
  };
  const audit = buildUnifiedTop3Replay({ mechanismAudit, techAudit: { generated_at: NOW, daily_current_window_review: [] }, now: NOW });
  assert.equal(audit.selected_top3.length, 1);
  assert.equal(audit.selected_top3[0].score.total, 5.5);
  assert.equal(audit.selected_top3[0].selection_rule, "mechanism-primary-track");
  assert.equal(audit.selected_top3[0].score.artifact, 0);
  assert.equal(audit.selected_top3[0].score.independent_attention, 0);
  assert.ok(audit.selected_top3[0].limitations.includes("no-verified-linked-artifact-in-current-snapshot"));
  assert.equal(audit.metrics.candidates_at_or_above_threshold, 0);
  assert.equal(audit.metrics.mechanism_primary_track_candidates, 1);
  assert.deepEqual(verifyUnifiedTop3Replay(audit, mechanismAudit, { generated_at: NOW, daily_current_window_review: [] }), { ok: true, errors: [] });
});

test("the mechanism primary track rejects weak identity, weak technical delta, stale work, and non-mechanism lanes", () => {
  const { mechanismAudit, techAudit, modelComputeAudit } = fixtureAudits();
  mechanismAudit.records = [
    mechanismRecord({ id: "arxiv:2607.15556", title: "Weak evidence", layer: "M1", evidence: "G0", publishedAt: "2026-07-16T14:25:18.683Z" }),
    mechanismRecord({ id: "arxiv:2607.15557", title: "Stale mechanism", layer: "M1", publishedAt: "2026-07-16T06:00:00.000Z" }),
  ];
  techAudit.daily_current_window_review = [techItem({
    storyId: "event:weak-harness",
    title: "Barely scored harness",
    url: "https://example.com/harness-update",
    sections: ["harness"],
    publishedAt: "2026-07-16T14:25:18.683Z",
    basis: "canonical-official-announcement",
    fingerprint: "official-announcement:example.com/harness-update",
  })];
  modelComputeAudit.daily_editorial_candidates = [];
  modelComputeAudit.source_events[0].current_window_items = [];
  const audit = buildUnifiedTop3Replay({ mechanismAudit, techAudit, modelComputeAudit, now: NOW });
  assert.equal(audit.selected_top3.length, 0);
  assert.equal(audit.eligible_candidates.some((item) => item.title === "Weak evidence"), false);
  assert.equal(audit.eligible_candidates.some((item) => item.title === "Stale mechanism"), false);
  assert.equal(audit.eligible_candidates.some((item) => item.title === "Barely scored harness"), true);
  assert.equal(audit.metrics.candidates_passing_selection_gate, 0);
});

test("a retained mechanism snapshot remains editorially eligible but cannot claim a fresh change", () => {
  const retained = {
    ...mechanismRecord({
      id: "arxiv:2607.14427",
      title: "Per-Token Fixed-Point Convergence in Depth-Recurrent Transformers",
      layer: "M1",
    }),
    daily_window_state: "retained-from-prior-snapshot",
    retained_from_generated_at: "2026-07-17T06:00:00.000Z",
    fresh_for_change_detection: false,
    daily_change_candidate: false,
    primary_verification_required: true,
    manual_review_only: true,
    claim_evidence_allowed: false,
    notification_eligible: false,
  };
  const mechanismAudit = {
    generated_at: NOW,
    source_events: [{ source_id: "arxiv-mechanisms", status: "fresh" }],
    records: [],
    daily_current_window_records: [retained],
  };
  const audit = buildUnifiedTop3Replay({ mechanismAudit, techAudit: { generated_at: NOW, daily_current_window_review: [] }, now: NOW });
  assert.equal(audit.selected_top3.length, 1);
  assert.equal(audit.selected_top3[0].title, retained.title);
  assert.ok(audit.selected_top3[0].limitations.includes("retained-editorial-snapshot-not-fresh-change-evidence"));
  assert.equal(audit.selected_top3[0].claim_evidence_allowed, false);
});

test("the replay and verifier keep every evidence, notification, and external-action boundary closed", () => {
  const { mechanismAudit, techAudit, modelComputeAudit } = fixtureAudits();
  const audit = buildUnifiedTop3Replay({ mechanismAudit, techAudit, modelComputeAudit, now: NOW });
  assert.deepEqual(verifyUnifiedTop3Replay(audit, mechanismAudit, techAudit, modelComputeAudit), { ok: true, errors: [] });
  assert.equal(audit.notification_policy.enabled, false);
  assert.deepEqual(audit.external_actions, []);
  assert.ok(audit.eligible_candidates.every((item) => item.manual_review_only && !item.claim_evidence_allowed && !item.notification_eligible));

  const mutated = structuredClone(audit);
  mutated.selected_top3[0].notification_eligible = true;
  const result = verifyUnifiedTop3Replay(mutated, mechanismAudit, techAudit, modelComputeAudit);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("deterministic replay projection")));
  assert.ok(result.errors.some((error) => error.includes("evidence/notification boundary")));
});

test("the unattended gate preserves the prior result when generation, verification, or promotion fails", () => {
  const noCommit = () => assert.fail("promotion must not run");
  assert.equal(runAndVerifyUnifiedTop3({
    spawnImpl: () => ({ status: 17 }),
    nodePath: "/node",
    cwd: "/tmp",
    environment: {},
    promoteImpl: noCommit,
    unlinkImpl: () => {},
  }), 17);

  let calls = 0;
  assert.equal(runAndVerifyUnifiedTop3({
    spawnImpl: () => ({ status: calls++ === 0 ? 0 : 23 }),
    nodePath: "/node",
    cwd: "/tmp",
    environment: {},
    promoteImpl: noCommit,
    unlinkImpl: () => {},
  }), 23);

  let promoted = 0;
  assert.equal(runAndVerifyUnifiedTop3({
    spawnImpl: () => ({ status: 0 }),
    nodePath: "/node",
    cwd: "/tmp",
    environment: {},
    promoteImpl: () => { promoted += 1; },
    unlinkImpl: () => {},
  }), 0);
  assert.equal(promoted, 1);

  assert.equal(runAndVerifyUnifiedTop3({
    spawnImpl: () => ({ status: 0 }),
    nodePath: "/node",
    cwd: "/tmp",
    environment: {},
    promoteImpl: () => { throw new Error("disk-full"); },
    unlinkImpl: () => {},
  }), 1);
});
