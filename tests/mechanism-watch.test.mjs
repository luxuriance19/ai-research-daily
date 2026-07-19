import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mechanismSeeds, mechanismSources, publicRegistryView, publicSeedGraph } from "../automation/mechanism-source-registry.mjs";
import { recoverMechanismDailyWindow } from "../automation/recover-mechanism-window.mjs";
import { boundedLineDiff, canonicalId, classifyCandidate, createAudit, createDailyCurrentWindowRecords, createDailyQualityReview, dedupeCandidates, normalizeUrl, parseSource, renderMechanismReview } from "../automation/run-mechanism-watch.mjs";
import { verifySilentAudit } from "../automation/verify-mechanism-audit.mjs";

const source = (overrides = {}) => ({
  id: "test-paper",
  artifactType: "paper",
  official: false,
  ...overrides,
});

test("classifies mechanism layers without treating presentation style as a mechanism", () => {
  assert.equal(classifyCandidate({ title: "Scaling Latent Reasoning in Language Models via Recurrent Depth", summary: "Adaptive computation with early exit." }, source()).primary_layer, "M3");
  assert.equal(classifyCandidate({ title: "Circuit Tracing in a Large Language Model", summary: "A replacement model supports causal intervention." }, source()).primary_layer, "M4");
  assert.equal(classifyCandidate({ title: "A Constitution for Large Language Model Behavior", summary: "A versioned behavior specification." }, source()).primary_layer, "B0");
  assert.equal(classifyCandidate({ title: "A Long-Running Agent Harness", summary: "Context compaction and handoff for a coding agent." }, source()).primary_layer, "H1");
  assert.equal(classifyCandidate({ title: "Evaluation Harness for Language Models", summary: "A grader and scoring protocol." }, source()).primary_layer, "E1");
  assert.equal(classifyCandidate({ title: "A More Expressive Writing Style", summary: "Tone, personality, and storytelling." }, source()).primary_layer, null);
  assert.equal(classifyCandidate({ title: "State Space Model for Weather Forecasting", summary: "A new architecture for station data." }, source()).primary_layer, null);
  assert.equal(classifyCandidate({ title: "A Medical Benchmark", summary: "We benchmark several LLMs for diagnosis." }, source()).primary_layer, null);
  assert.equal(classifyCandidate({ title: "Constitutional Classifiers for Language Models", summary: "A constitutional classifier is trained for robust refusals." }, source()).primary_layer, "M2");
  assert.equal(classifyCandidate({ title: "A System Card for a Coding Agent", summary: "The agent harness is evaluated." }, source({ defaultLayer: "E1" })).primary_layer, "E1");
});

test("rejects observed cross-domain and application-only keyword collisions without losing latent recurrence", () => {
  const humanoid = classifyCandidate({
    title: "Scaling Behavior Foundation Model for Humanoid Robots",
    summary: "A Humanoid Transformer uses a scalable model architecture for whole-body motion control.",
  }, source());
  assert.equal(humanoid.primary_layer, null);
  assert.equal(humanoid.exclusion_reason, "paper-outside-language-model-scope");

  const privacy = classifyCandidate({
    title: "Privacy Leakage in Federated Learning in Radiology Reports",
    summary: "We compare tokenizers with the GPT-2-style transformer model architecture held fixed.",
  }, source());
  assert.equal(privacy.primary_layer, null);

  const survey = classifyCandidate({
    title: "Human-In-The-Loop Machine Learning for Safe Autonomous Vehicles",
    summary: "This paper presents a tutorial survey of curriculum learning and human-in-the-loop large language models.",
  }, source());
  assert.equal(survey.primary_layer, null);
  assert.equal(survey.exclusion_reason, "paper-survey-not-mechanism-delta");

  const application = classifyCandidate({
    title: "Digital Pantheon: Simulating Coalition Formation with LLM Agents",
    summary: "We present a political simulation combining direct preference optimization and reinforcement learning from human feedback.",
  }, source());
  assert.equal(application.primary_layer, null);

  const latentRecurrence = classifyCandidate({
    title: "T^2MLR: Transformer with Temporal Middle-Layer Recurrence",
    summary: "A latent reasoning architecture improves natural-language pretraining through middle-layer recurrence during autoregressive decoding.",
  }, source());
  assert.equal(latentRecurrence.primary_layer, "M3");

  const depthRecurrence = classifyCandidate({
    title: "Per-Token Fixed-Point Convergence in Depth-Recurrent Transformers",
    summary: "A depth-recurrent transformer trained on FineWeb-Edu reaches per-token fixed points at variable inference depths.",
  }, source());
  assert.equal(depthRecurrence.primary_layer, "M1");

  const preferenceTraining = classifyCandidate({
    title: "Step-Level Preference Learning for Generative Agents",
    summary: "Open-weight language models use direct preference optimization on step-level human supervision.",
  }, source());
  assert.equal(preferenceTraining.primary_layer, "M2");

  const functionAwareMidTraining = classifyCandidate({
    title: "Function-Aware Fill-in-the-Middle as Mid-Training for Coding Agent Foundation Models",
    summary: "We mid-train Qwen coding language models with a self-supervised objective, then apply existing agentic post-training pipelines.",
  }, source());
  assert.equal(functionAwareMidTraining.primary_layer, "M2");
  assert.ok(functionAwareMidTraining.secondary_layers.includes("H1"));
});

test("daily quality sampling is deterministic, stratified, and cannot self-complete human review", () => {
  const records = ["B0", "M1", "M2", "M3", "M4", "H1", "E1"].flatMap((layer) => [1, 2, 3].map((index) => ({
    canonical_id: `${layer.toLowerCase()}:${index}`,
    canonical_url: `https://example.com/${layer}/${index}`,
    title: `${layer} sample ${index}`,
    primary_layer: layer,
    evidence_grade: "G1",
    change: "unchanged",
    source_ids: ["primary"],
    matched_terms: [layer],
    concrete_mechanism_delta: true,
  })));
  const first = createDailyQualityReview(records, "2026-07-17");
  const second = createDailyQualityReview(records, "2026-07-17");
  assert.deepEqual(first, second);
  assert.equal(first.sampled_records, 14);
  assert.equal(first.human_reviewed, false);
  assert.equal(first.can_satisfy_human_gate, false);
  assert.deepEqual(first.human_decisions, []);
  assert.ok(first.samples.every((sample) => sample.human_reviewed === false && sample.human_decision === null));
  for (const layer of ["B0", "M1", "M2", "M3", "M4", "H1", "E1"]) {
    assert.equal(first.samples.filter((sample) => sample.primary_layer === layer).length, 2);
  }
});

test("normalizes canonical paper and release identities", () => {
  assert.equal(canonicalId({ url: "https://arxiv.org/abs/2510.25741v3" }), "arxiv:2510.25741");
  assert.equal(canonicalId({ url: "https://github.com/openai/codex/releases/tag/v1.2.3" }), "github-release:openai/codex:v1.2.3");
  assert.equal(normalizeUrl("https://example.com/paper/?utm_source=x#abstract"), "https://example.com/paper");
});

test("deduplicates paper artifacts and assigns deterministic evidence grades", () => {
  const item = {
    id: "2510.25741v2",
    title: "Scaling Latent Reasoning via Looped Language Models",
    summary: "A looped language model uses recurrent depth and early exit.",
    url: "https://arxiv.org/abs/2510.25741v2",
    published_at: "2025-10-29T00:00:00.000Z",
  };
  const records = dedupeCandidates([
    { ...item, source: source({ id: "arxiv" }) },
    { ...item, url: "https://arxiv.org/abs/2510.25741", source: source({ id: "huggingface" }) },
  ]);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].source_ids, ["arxiv", "huggingface"]);
  assert.equal(records[0].evidence_grade, "G1");
  assert.equal(records[0].notification_eligible, false);
});

test("versioned policy commit occurrence stays non-concrete and cannot enter P0 review", () => {
  const candidate = {
    id: "spec-commit",
    title: "Update Model Spec behavior specification",
    summary: "A versioned authority rule changed.",
    url: "https://github.com/openai/model_spec/commit/abcdef123456",
    published_at: "2026-07-17T00:00:00.000Z",
    source: source({ id: "openai-model-spec", artifactType: "versioned-policy", official: true, defaultLayer: "B0" }),
  };
  const audit = createAudit({
    now: new Date("2026-07-17T08:00:00.000Z"),
    sourceEvents: [{ source_id: "openai-model-spec", tier: "core", status: "fresh" }],
    candidates: [candidate],
    previousRecords: [{
      canonical_id: "github-commit:openai/model_spec:abcdef123456",
      record_hash: "previous-content-hash",
      first_seen_at: "2026-07-16T08:00:00.000Z",
    }],
  });
  assert.equal(audit.notification_policy.enabled, false);
  assert.deepEqual(audit.notification_policy.external_actions, []);
  assert.equal(audit.notification_gate.eligible, false);
  assert.equal(audit.notification_gate.consecutive_silent_days, 1);
  assert.deepEqual(audit.notification_gate.blockers, ["minimum_silent_days", "human_review"]);
  assert.equal(audit.metrics.notification_eligible_records, 0);
  assert.equal(audit.records[0].concrete_mechanism_delta, false);
  assert.equal(audit.records[0].provisional_priority, "none");
  assert.equal(audit.records[0].notification_eligible, false);
  assert.match(audit.records[0].blockers.join(" "), /versioned-policy-commit-occurrence-only/);
  assert.equal(audit.records[0].source_metadata[0].source_concrete_mechanism_delta, false);

  const verifiableAudit = createAudit({
    now: new Date("2026-07-17T08:00:00.000Z"),
    sourceEvents: mechanismSources.map((entry) => ({ source_id: entry.id, tier: entry.tier, status: "fresh" })),
    candidates: [candidate],
    previousRecords: [{
      canonical_id: "github-commit:openai/model_spec:abcdef123456",
      record_hash: "previous-content-hash",
      first_seen_at: "2026-07-16T08:00:00.000Z",
    }],
  });
  assert.equal(verifySilentAudit(verifiableAudit).status, "ok");
  const tampered = structuredClone(verifiableAudit);
  tampered.records[0].concrete_mechanism_delta = true;
  tampered.records[0].provisional_priority = "P0";
  assert.throws(() => verifySilentAudit(tampered), /versioned policy commit record is concrete/);
});

test("baseline and unchanged records cannot become provisional alerts", () => {
  const candidate = {
    id: "2510.25741",
    title: "Scaling Latent Reasoning via Looped Language Models",
    summary: "A looped language model uses recurrent depth and early exit.",
    url: "https://arxiv.org/abs/2510.25741",
    published_at: "2025-10-29T00:00:00.000Z",
    source: source({ id: "arxiv-mechanisms" }),
  };
  const baseline = dedupeCandidates([candidate]);
  assert.equal(baseline[0].change, "baseline");
  assert.equal(baseline[0].provisional_priority, "none");
  const unchanged = dedupeCandidates([candidate], baseline);
  assert.equal(unchanged[0].change, "unchanged");
  assert.equal(unchanged[0].provisional_priority, "none");
  assert.match(unchanged[0].blockers.join(" "), /no-content-change/);

  const onboarding = dedupeCandidates([candidate], [{ canonical_id: "url:https://example.com/prior", record_hash: "prior" }], {
    baselineSourceIds: ["arxiv-mechanisms"],
  });
  assert.equal(onboarding[0].change, "baseline");
  assert.equal(onboarding[0].provisional_priority, "none");
});

test("an internal source taxonomy correction does not masquerade as a content update", () => {
  const item = {
    id: "tool-release",
    title: "Circuit-Tracer v0.2 release with attribution graph interventions",
    summary: "A feature circuit tooling release adds intervention support.",
    url: "https://github.com/decoderesearch/circuit-tracer/releases/tag/v0.2",
    published_at: "2026-07-15T00:00:00.000Z",
  };
  const before = dedupeCandidates([{ ...item, source: source({ id: "circuit-tracer", artifactType: "independent-reproduction", defaultLayer: "M4" }) }]);
  const after = dedupeCandidates([{ ...item, source: source({ id: "circuit-tracer", artifactType: "paper-linked-tooling", defaultLayer: "M4" }) }], before);
  assert.equal(after[0].source_content_hash, before[0].source_content_hash);
  assert.notEqual(after[0].record_hash, before[0].record_hash);
  assert.equal(after[0].change, "unchanged");
  assert.equal(after[0].provisional_priority, "none");
});

test("parses the arXiv RSS version and announce type as primary revision evidence", () => {
  const [paper] = parseSource({ format: "rss-or-atom" }, `<?xml version="1.0"?>
    <rss xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><item>
      <title>Looped Language Models with Recurrent Depth</title>
      <link>https://arxiv.org/abs/2607.12463</link>
      <description>arXiv:2607.12463v2 Announce Type: replace Abstract: A language model uses recurrent depth.</description>
      <guid isPermaLink="false">oai:arXiv.org:2607.12463v2</guid>
      <pubDate>Fri, 17 Jul 2026 00:00:00 -0400</pubDate>
      <arxiv:announce_type>replace</arxiv:announce_type>
    </item></channel></rss>`);
  assert.equal(paper.metadata.arxiv_id, "2607.12463");
  assert.equal(paper.metadata.arxiv_version, 2);
  assert.equal(paper.metadata.arxiv_announce_type, "replace");
});

test("arXiv primary metadata enriches a mirrored paper without becoming a paper update", () => {
  const mirrored = {
    id: "2607.12463",
    title: "Function-Aware Mid-Training for Coding Agent Foundation Models",
    summary: "A language model uses a mid-training objective for a coding agent.",
    url: "https://arxiv.org/abs/2607.12463",
    published_at: "2026-07-16T00:00:00.000Z",
    metadata: { arxiv_id: "2607.12463", upvotes: 10 },
    source: source({ id: "huggingface-daily" }),
  };
  const baseline = dedupeCandidates([mirrored]);
  const primary = {
    ...mirrored,
    id: "oai:arXiv.org:2607.12463v1",
    summary: "arXiv:2607.12463v1 Announce Type: new Abstract: A language model uses a mid-training objective for a coding agent.",
    metadata: { arxiv_id: "2607.12463", arxiv_version: 1, arxiv_announce_type: "new" },
    source: source({ id: "arxiv-mechanisms" }),
  };
  const [enriched] = dedupeCandidates([mirrored, primary], baseline);
  assert.equal(enriched.change, "enriched");
  assert.equal(enriched.arxiv_version, 1);
  assert.equal(enriched.provisional_priority, "none");
  assert.match(enriched.blockers.join(" "), /source-enrichment-only/);
});

test("an explicit arXiv version increment is a revision while mirror-window churn is unchanged", () => {
  const arxivPaper = (version) => ({
    id: `oai:arXiv.org:2607.12463v${version}`,
    title: "Function-Aware Mid-Training for Coding Agent Foundation Models",
    summary: `arXiv:2607.12463v${version} Announce Type: ${version === 1 ? "new" : "replace"} Abstract: A language model uses a mid-training objective for a coding agent.`,
    url: "https://arxiv.org/abs/2607.12463",
    published_at: `2026-07-${15 + version}T00:00:00.000Z`,
    metadata: { arxiv_id: "2607.12463", arxiv_version: version },
    source: source({ id: "arxiv-mechanisms" }),
  });
  const baseline = dedupeCandidates([arxivPaper(1)]);
  const [revision] = dedupeCandidates([arxivPaper(2)], baseline);
  assert.equal(revision.change, "revision");
  assert.equal(revision.arxiv_version_observed, 2);
  assert.equal(revision.provisional_priority, "P2");

  const [regressed] = dedupeCandidates([arxivPaper(1)], [revision]);
  assert.equal(regressed.change, "source-regressed");
  assert.equal(regressed.arxiv_version, 2);
  assert.equal(regressed.provisional_priority, "none");
  assert.match(regressed.blockers.join(" "), /source-version-regressed/);

  const mirrorOnly = {
    ...arxivPaper(2),
    id: "2607.12463",
    summary: "A differently normalized mirror abstract about a language model and coding agent mid-training.",
    metadata: { arxiv_id: "2607.12463", upvotes: 25 },
    source: source({ id: "huggingface-daily" }),
  };
  const [windowChurn] = dedupeCandidates([mirrorOnly], [revision]);
  assert.equal(windowChurn.change, "unchanged");
  assert.equal(windowChurn.arxiv_version_observed, null);
  assert.equal(windowChurn.arxiv_version, 2);
  assert.equal(windowChurn.source_content_hash, revision.source_content_hash);
});

test("identity history prevents an unchanged paper reappearing outside the prior feed window from becoming new", () => {
  const candidate = {
    id: "2607.12463",
    title: "Function-Aware Mid-Training for Coding Agent Foundation Models",
    summary: "A language model uses a mid-training objective for a coding agent.",
    url: "https://arxiv.org/abs/2607.12463",
    published_at: "2026-07-16T00:00:00.000Z",
    source: source({ id: "huggingface-daily" }),
  };
  const first = createAudit({ now: new Date("2026-07-16T02:00:00.000Z"), candidates: [candidate] });
  const absent = createAudit({
    now: new Date("2026-07-17T02:00:00.000Z"),
    previousRecords: first.records,
    previousIdentityHistory: first.identity_history,
    previousAudit: first,
  });
  assert.equal(absent.records.length, 0);
  assert.equal(absent.identity_history.length, 1);
  const reappeared = createAudit({
    now: new Date("2026-07-18T02:00:00.000Z"),
    candidates: [candidate],
    previousRecords: absent.records,
    previousIdentityHistory: absent.identity_history,
    previousAudit: absent,
  });
  assert.equal(reappeared.records[0].change, "unchanged");
  assert.equal(reappeared.records[0].first_seen_at, first.records[0].first_seen_at);
  assert.equal(reappeared.identity_history[0].last_seen_at, "2026-07-18T02:00:00.000Z");
});

test("the 48-hour editorial window retains a prior paper when a fresh RSS batch is empty", () => {
  const candidate = {
    id: "2607.14427",
    title: "Per-Token Fixed-Point Convergence in Depth-Recurrent Transformers",
    summary: "A depth-recurrent language model reaches per-token fixed points at variable inference depths.",
    url: "https://arxiv.org/abs/2607.14427",
    published_at: "2026-07-17T04:00:00.000Z",
    source: source({ id: "arxiv-mechanisms" }),
  };
  const sourceEvents = mechanismSources.map((entry) => ({ source_id: entry.id, tier: entry.tier, status: "fresh" }));
  const first = createAudit({
    now: new Date("2026-07-17T06:00:00.000Z"),
    sourceEvents,
    candidates: [candidate],
  });
  assert.equal(first.daily_current_window_records.length, 1);
  assert.equal(first.daily_current_window_records[0].daily_window_state, "current-source");
  assert.equal(first.daily_current_window_records[0].fresh_for_change_detection, true);

  const emptyNextBatch = createAudit({
    now: new Date("2026-07-18T06:00:00.000Z"),
    sourceEvents,
    previousRecords: first.records,
    previousIdentityHistory: first.identity_history,
    previousAudit: first,
  });
  assert.equal(emptyNextBatch.records.length, 0);
  assert.equal(emptyNextBatch.daily_current_window_records.length, 1);
  assert.equal(emptyNextBatch.daily_current_window_records[0].daily_window_state, "retained-from-prior-snapshot");
  assert.equal(emptyNextBatch.daily_current_window_records[0].fresh_for_change_detection, false);
  assert.equal(emptyNextBatch.daily_current_window_records[0].daily_change_candidate, false);
  assert.equal(emptyNextBatch.daily_current_window_records[0].notification_eligible, false);
  assert.equal(emptyNextBatch.daily_current_window_records[0].claim_evidence_allowed, false);
  assert.equal(verifySilentAudit(emptyNextBatch).status, "ok");

  const expired = createDailyCurrentWindowRecords({
    now: new Date("2026-07-19T06:00:01.000Z"),
    sourceEvents,
    previousAudit: emptyNextBatch,
  });
  assert.deepEqual(expired, []);

  const tampered = structuredClone(emptyNextBatch);
  tampered.daily_current_window_records[0].notification_eligible = true;
  assert.throws(() => verifySilentAudit(tampered), /daily window safety boundary is open/);
});

test("bounded arXiv recovery only restores identities already present in local history", () => {
  const sourceEvents = mechanismSources.map((entry) => ({ source_id: entry.id, tier: entry.tier, status: "fresh" }));
  const candidate = {
    id: "2607.15178",
    title: "T^2MLR: Transformer with Temporal Middle-Layer Recurrence",
    summary: "A latent reasoning language model uses temporal middle-layer recurrence during autoregressive decoding.",
    url: "https://arxiv.org/abs/2607.15178",
    published_at: "2026-07-16T16:33:59.000Z",
    source: source({ id: "arxiv-mechanisms" }),
  };
  const first = createAudit({ now: new Date("2026-07-17T00:00:00.000Z"), sourceEvents, candidates: [candidate] });
  const overwritten = createAudit({
    now: new Date("2026-07-18T09:00:00.000Z"),
    sourceEvents,
    previousRecords: first.records,
    previousIdentityHistory: first.identity_history,
    previousAudit: first,
  });
  overwritten.daily_current_window_records = [];
  overwritten.metrics.daily_current_window_records = 0;
  const entry = ({ id, title }) => `<entry><id>http://arxiv.org/abs/${id}v1</id><updated>2026-07-16T16:33:59Z</updated><published>2026-07-16T16:33:59Z</published><title>${title}</title><summary>A latent reasoning language model uses temporal middle-layer recurrence during autoregressive decoding.</summary></entry>`;
  const body = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entry({ id: "2607.15178", title: "T^2MLR: Transformer with Temporal Middle-Layer Recurrence" })}${entry({ id: "2607.99999", title: "Unknown Recurrent Language Model" })}</feed>`;
  const recovered = recoverMechanismDailyWindow({ audit: overwritten, arxivBody: body });
  assert.deepEqual(recovered.daily_window_recovery.recovered_record_ids, ["arxiv:2607.15178"]);
  assert.equal(recovered.daily_current_window_records.length, 1);
  assert.equal(recovered.daily_current_window_records[0].daily_window_state, "retained-from-prior-snapshot");
  assert.equal(recovered.daily_current_window_records[0].fresh_for_change_detection, false);
  assert.equal(verifySilentAudit(recovered).status, "ok");
});

test("notification gate counts distinct consecutive Shanghai dates and remains human-review blocked", () => {
  const previousAudit = {
    mode: "silent-audit",
    generated_at: "2026-07-16T01:00:00.000Z",
    notification_gate: {
      observed_silent_dates: ["2026-07-15", "2026-07-16"],
    },
  };
  const audit = createAudit({
    now: new Date("2026-07-17T02:00:00.000Z"),
    previousAudit,
    sourceEvents: [{ source_id: "core", tier: "core", status: "fresh" }],
  });
  assert.deepEqual(audit.notification_gate.observed_silent_dates, ["2026-07-15", "2026-07-16", "2026-07-17"]);
  assert.equal(audit.notification_gate.consecutive_silent_days, 3);
  assert.equal(audit.notification_gate.criteria.core_source_success_rate.passed, true);
  assert.deepEqual(audit.notification_gate.blockers, ["minimum_silent_days", "human_review"]);

  const sevenDayAudit = createAudit({
    now: new Date("2026-07-17T02:00:00.000Z"),
    previousAudit: {
      mode: "silent-audit",
      generated_at: "2026-07-16T02:00:00.000Z",
      notification_gate: {
        observed_silent_dates: ["2026-07-11", "2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"],
      },
    },
    sourceEvents: [{ source_id: "core", tier: "core", status: "fresh" }],
  });
  assert.equal(sevenDayAudit.notification_gate.consecutive_silent_days, 7);
  assert.equal(sevenDayAudit.notification_gate.criteria.minimum_silent_days.passed, true);
  assert.equal(sevenDayAudit.notification_gate.eligible, false);
  assert.deepEqual(sevenDayAudit.notification_gate.blockers, ["human_review"]);
});

test("source registry is public and does not depend on Gemini, OAuth, or hosting credentials", () => {
  assert.ok(mechanismSources.length >= 10);
  assert.ok(publicRegistryView().every((entry) => entry.authentication === "public"));
  const arxivSource = mechanismSources.find((entry) => entry.id === "arxiv-mechanisms");
  assert.equal(arxivSource?.format, "rss-or-atom");
  assert.match(arxivSource?.url || "", /^https:\/\/rss\.arxiv\.org\/rss\//);
  const audit = createAudit();
  assert.deepEqual(audit.dependency_policy, {
    gemini_required: false,
    google_oauth_required: false,
    openai_membership_required: false,
    cloudflare_credentials_required: false,
  });
  assert.ok(mechanismSeeds.some((seed) => seed.id === "ouro-looped-language-model" && seed.counter_evidence.length > 0));
  assert.ok(mechanismSeeds.some((seed) => seed.id === "coconut-continuous-thought" && seed.counter_evidence.length > 0));
  assert.ok(publicSeedGraph().every((seed) => seed.baseline_only && !seed.notification_eligible));
  assert.ok(publicSeedGraph().find((seed) => seed.id === "anthropic-constitution-2026")?.monitored_source_ids.includes("anthropic-constitution"));
  assert.ok(publicSeedGraph().find((seed) => seed.id === "ouro-looped-language-model")?.monitored_source_ids.includes("ouro-model"));
  assert.ok(publicSeedGraph().find((seed) => seed.id === "coconut-continuous-thought")?.monitored_source_ids.includes("coconut-code"));
  assert.ok(publicSeedGraph().find((seed) => seed.id === "anthropic-circuit-tracing")?.monitored_source_ids.includes("circuit-tracer-releases"));
  const circuitTracer = mechanismSources.find((entry) => entry.id === "circuit-tracer-releases");
  assert.equal(circuitTracer?.artifactType, "paper-linked-tooling");
  assert.doesNotMatch(circuitTracer?.label || "", /independent/i);
  assert.deepEqual(mechanismSeeds.find((seed) => seed.id === "anthropic-circuit-tracing")?.independent_support, []);
  assert.ok(publicSeedGraph().find((seed) => seed.id === "frontier-agent-harness")?.monitored_source_ids.includes("codex-releases"));
  assert.equal(audit.metrics.seed_mechanisms, mechanismSeeds.length);
});

test("parses a Hugging Face model revision as a stable seed artifact", () => {
  const [model] = parseSource({ format: "huggingface-model" }, JSON.stringify({
    id: "ByteDance/Ouro-2.6B",
    lastModified: "2026-01-18T20:41:53.000Z",
    sha: "abc123",
    tags: ["looped-language-model", "recurrent-depth"],
    siblings: [{ rfilename: "model.safetensors" }, { rfilename: "config.json" }],
  }));
  assert.equal(model.url, "https://huggingface.co/ByteDance/Ouro-2.6B");
  assert.match(model.summary, /looped language model/);
  assert.equal(model.metadata.revision_sha, "abc123");
  assert.deepEqual(model.metadata.files, ["config.json", "model.safetensors"]);

  const [record] = dedupeCandidates([{
    id: "model",
    title: "Looped language model",
    summary: "A language model with recurrent depth.",
    url: "https://example.com/model",
    published_at: "2026-01-01T00:00:00.000Z",
    metadata: { revision_sha: "abc123", files: ["config.json", "model.bin"] },
    source: source({ id: "model-source", artifactType: "official-model", official: true, defaultLayer: "M3" }),
  }]);
  assert.equal(record.record_hash, "bf1a072b7b36b1af149de59616a2d4258884c9289e94c4e7fa9cc642db2e8d46");
});

test("captures bounded line evidence for versioned policy text without claiming semantic review", () => {
  const diff = boundedLineDiff("# Spec\nkeep\nold", "# Spec\nkeep\nnew\nadded", { maxExcerptLines: 1 });
  assert.equal(diff.status, "changed");
  assert.equal(diff.first_changed_line, 3);
  assert.equal(diff.removed_line_count, 1);
  assert.equal(diff.added_line_count, 2);
  assert.deepEqual(diff.before_excerpt, ["old"]);
  assert.deepEqual(diff.after_excerpt, ["new"]);
  assert.equal(diff.excerpt_truncated, true);
  assert.equal(diff.requires_human_semantic_review, true);
  assert.match(diff.previous_sha256, /^[a-f0-9]{64}$/);
  assert.match(diff.current_sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(diff.previous_sha256, diff.current_sha256);

  const [document] = parseSource({
    format: "raw-document",
    url: "https://raw.githubusercontent.com/example/spec/main/spec.md",
    canonicalUrl: "https://github.com/example/spec/blob/main/spec.md",
    documentTitle: "Example model spec",
  }, "# Model Spec\nbehavior specification", { previousBody: null });
  assert.equal(document.url, "https://github.com/example/spec/blob/main/spec.md");
  assert.equal(document.metadata.line_diff.status, "baseline");
  assert.equal(document.metadata.line_diff.requires_human_semantic_review, true);
  assert.equal(document.metadata.line_count, 2);

  const policySource = source({
    id: "policy-text",
    artifactType: "versioned-policy-text",
    official: true,
    defaultLayer: "B0",
  });
  const [baselineCandidate] = parseSource({
    ...policySource,
    format: "raw-document",
    url: "https://raw.githubusercontent.com/example/spec/main/spec.md",
    canonicalUrl: "https://github.com/example/spec/blob/main/spec.md",
    documentTitle: "Example Model Spec",
  }, "# Model Spec\nold authority rule", { previousBody: null });
  const baselineRecords = dedupeCandidates([{ ...baselineCandidate, source: policySource }]);
  assert.equal(baselineRecords[0].concrete_mechanism_delta, false);
  assert.equal(baselineRecords[0].provisional_priority, "none");
  const [unchangedCandidate] = parseSource({
    ...policySource,
    format: "raw-document",
    url: "https://raw.githubusercontent.com/example/spec/main/spec.md",
    canonicalUrl: "https://github.com/example/spec/blob/main/spec.md",
    documentTitle: "Example Model Spec",
  }, "# Model Spec\nold authority rule", { previousBody: "# Model Spec\nold authority rule" });
  const [unchangedRecord] = dedupeCandidates([{ ...unchangedCandidate, source: policySource }], baselineRecords);
  assert.equal(unchangedRecord.change, "unchanged");
  assert.equal(unchangedRecord.concrete_mechanism_delta, false);
  assert.equal(unchangedRecord.provisional_priority, "none");
  const [updatedCandidate] = parseSource({
    ...policySource,
    format: "raw-document",
    url: "https://raw.githubusercontent.com/example/spec/main/spec.md",
    canonicalUrl: "https://github.com/example/spec/blob/main/spec.md",
    documentTitle: "Example Model Spec",
  }, "# Model Spec\nnew authority rule", { previousBody: "# Model Spec\nold authority rule" });
  const [cachedDiffOnboarding] = dedupeCandidates([{ ...updatedCandidate, source: policySource }]);
  assert.equal(cachedDiffOnboarding.change, "baseline");
  assert.equal(cachedDiffOnboarding.concrete_mechanism_delta, false);
  assert.equal(cachedDiffOnboarding.provisional_priority, "none");
  assert.equal(cachedDiffOnboarding.source_metadata[0].source_concrete_mechanism_delta, false);
  const updatedAudit = createAudit({
    now: new Date("2026-07-18T02:00:00.000Z"),
    sourceEvents: [{ source_id: "policy-text", tier: "core", status: "fresh" }],
    candidates: [{ ...updatedCandidate, source: policySource }],
    previousRecords: baselineRecords,
  });
  assert.equal(updatedAudit.records[0].change, "updated");
  assert.equal(updatedAudit.records[0].concrete_mechanism_delta, true);
  assert.equal(updatedAudit.records[0].provisional_priority, "P0");
  assert.match(updatedAudit.records[0].blockers.join(" "), /human-semantic-diff-required/);
  assert.equal(updatedAudit.records[0].notification_eligible, false);
  const review = renderMechanismReview(updatedAudit);
  assert.match(review, /行级差异/);
  assert.match(review, /old authority rule/);
  assert.match(review, /new authority rule/);

  const verifiableAudit = createAudit({
    now: new Date("2026-07-18T02:00:00.000Z"),
    sourceEvents: mechanismSources.map((entry) => ({ source_id: entry.id, tier: entry.tier, status: "fresh" })),
    candidates: [{ ...updatedCandidate, source: policySource }],
    previousRecords: baselineRecords,
  });
  assert.equal(verifySilentAudit(verifiableAudit).status, "ok");
  const identityTampered = structuredClone(verifiableAudit);
  const snapshot = identityTampered.records[0].source_metadata[0];
  snapshot.line_diff.previous_sha256 = snapshot.line_diff.current_sha256;
  assert.throws(() => verifySilentAudit(identityTampered), /lacks bound changed identities/);
});

test("renders a human review worksheet while the verifier enforces the silent boundary", () => {
  const sourceEvents = mechanismSources.map((entry) => ({ source_id: entry.id, tier: entry.tier, status: "fresh" }));
  const audit = createAudit({
    now: new Date("2026-07-17T02:00:00.000Z"),
    sourceEvents,
    candidates: [{
      id: "2510.25741",
      title: "Scaling Latent Reasoning via Looped Language Models",
      summary: "A looped language model uses recurrent depth and early exit.",
      url: "https://arxiv.org/abs/2510.25741",
      published_at: "2025-10-29T00:00:00.000Z",
      source: source({ id: "arxiv-mechanisms" }),
    }],
  });
  assert.deepEqual(verifySilentAudit(audit), {
    mode: "silent-audit",
    status: "ok",
    sources: mechanismSources.length,
    core_success_rate: 1,
    silent_days: 1,
    gate_eligible: false,
  });
  const review = renderMechanismReview(audit);
  assert.match(review, /模型机制静默复核/);
  assert.match(review, /Scaling Latent Reasoning/);
  assert.match(review, /种子证据链健康/);
  assert.match(review, /每日分层质量抽样/);
  assert.match(review, /不是关键词误报/);
  const unsafe = structuredClone(audit);
  unsafe.notification_policy.enabled = true;
  assert.throws(() => verifySilentAudit(unsafe), /notification policy must be disabled/);
  const selfReviewed = structuredClone(audit);
  selfReviewed.quality_review.human_reviewed = true;
  assert.throws(() => verifySilentAudit(selfReviewed), /collector must not self-complete human quality review/);
});

test("scheduled GitHub audit has read-only permissions and no deployment or secret path", async () => {
  const workflow = await readFile(new URL("../.github/workflows/mechanism-audit.yml", import.meta.url), "utf8");
  assert.match(workflow, /permissions:\s+contents: read/s);
  assert.match(workflow, /actions\/cache@v4/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /npm run verify:mechanisms/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./i);
  assert.doesNotMatch(workflow, /deploy|wrangler|wechat|slack|webhook/i);
});
