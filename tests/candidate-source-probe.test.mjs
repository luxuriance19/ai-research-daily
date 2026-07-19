import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateSources } from "../automation/candidate-source-registry.mjs";
import { mechanismSources } from "../automation/mechanism-source-registry.mjs";
import {
  createCandidateSourceAudit,
  parseCandidateSource,
  renderCandidateSourceReview,
  runCandidateSourceProbe,
} from "../automation/run-candidate-source-probe.mjs";
import { verifyCandidateSourceProbe } from "../automation/verify-candidate-source-probe.mjs";
import { observedSourceIdentity } from "../automation/source-identity.mjs";

const source = (id) => candidateSources.find((candidate) => candidate.id === id);

const arxivBody = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>http://arxiv.org/abs/2510.25741v5</id><title>Ouro</title><published>2025-10-29T17:45:42Z</published><updated>2026-07-01T23:25:58Z</updated></entry>
  <entry><id>http://arxiv.org/abs/2412.06769v3</id><title>Coconut</title><published>2024-12-09T18:55:56Z</published><updated>2025-11-03T00:53:34Z</updated></entry>
  <entry><id>http://arxiv.org/abs/2605.26733v1</id><title>STARS</title><published>2026-05-26T09:11:12Z</published><updated>2026-05-26T09:11:12Z</updated></entry>
  <entry><id>http://arxiv.org/abs/2512.21711v1</id><title>Do Latent Tokens Think?</title><published>2025-12-25T15:14:53Z</published><updated>2025-12-25T15:14:53Z</updated></entry>
</feed>`;

const readoutArxivBody = `<html><head><title>[2606.24898] Dense Supervision Is Not Enough: The Readout Blind Spot in Looped Language Models</title></head>
<body><a href="/abs/2606.24898v1">arXiv:2606.24898v1</a><div>Submission history v1</div></body></html>`;

const rssBody = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><guid>new</guid><title>Harness Engineering</title><link>https://example.com/new</link><pubDate>Wed, 15 Jul 2026 08:00:00 GMT</pubDate><description><![CDATA[<a href="https://github.com/example/harness?utm_source=feed">code</a><a href="https://news.example.com/story">coverage</a>]]></description></item>
  <item><guid>old</guid><title>Latent Reasoning</title><link>https://example.com/old</link><pubDate>Wed, 08 Jul 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`;

test("candidate registry is public and remains disjoint from the production mechanism registry", () => {
  assert.equal(candidateSources.length, 64);
  assert.equal(new Set(candidateSources.map((candidate) => candidate.id)).size, candidateSources.length);
  assert.ok(candidateSources.every((candidate) => candidate.authentication === "public"));
  assert.ok(candidateSources.every((candidate) => ["T2", "T3", "T4"].includes(candidate.authority_tier)));
  const productionIds = new Set(mechanismSources.map((candidate) => candidate.id));
  assert.ok(candidateSources.every((candidate) => !productionIds.has(candidate.id)));
});

test("high-signal packages use scoped primary identities instead of trend or media sources", () => {
  const expected = [
    "openai-model-spec-tree",
    "openai-model-spec-changelog",
    "openai-model-spec-version-manifest",
    "ouro-family-1-4b-model",
    "ouro-family-1-4b-thinking-model",
    "ouro-family-2-6b-model",
    "ouro-family-2-6b-thinking-model",
    "latent-cot-thinking-arxiv",
    "latent-cot-thinking-commits",
    "pando-arxiv",
    "pando-artifact-tree",
    "pando-evaluation-results",
    "mib-arxiv",
    "mib-circuit-track-tree",
    "interpbench-arxiv",
    "interpbench-models",
    "inspect-evals-releases",
    "inspect-evals-task-versioning",
    "inspect-evals-changelog",
    "rethinking-harness-evolution-arxiv",
    "rethinking-harness-evolution-commits",
  ];
  assert.ok(expected.every((id) => source(id)));
  assert.ok(candidateSources.every((candidate) => !candidate.id.includes("github-trending")));
  assert.equal(source("inspect-evals-task-versioning").expected_path, "TASK_VERSIONING.md");
  assert.match(source("inspect-evals-releases").url, /UKGovernmentBEIS\/inspect_evals/);
  assert.notEqual(source("rethinking-harness-evolution-arxiv").independence_group, source("harness-updating-arxiv").independence_group);
});

test("OpenAI Model Spec tree and short version manifest detect only relevant semantic changes", () => {
  const treeSource = source("openai-model-spec-tree");
  const baselineBody = JSON.stringify({
    sha: "tree-1",
    truncated: false,
    tree: [
      { path: "model_spec.md", type: "blob", sha: "model-v1" },
      { path: "CHANGELOG.md", type: "blob", sha: "changelog-v1" },
      { path: "docs/version-manifest.json", type: "blob", sha: "manifest-v1" },
      { path: "docs/2025-12-18.html", type: "blob", sha: "release-v1" },
      { path: "evals/README.md", type: "blob", sha: "unrelated-v1" },
    ],
  });
  const baseline = parseCandidateSource(treeSource, baselineBody);
  assert.deepEqual(baseline.semantic_blockers, []);
  assert.deepEqual(baseline.review_flags, []);
  assert.equal(baseline.snapshot.tracked_files.length, 3);
  assert.deepEqual(baseline.snapshot.versioned_files.map((file) => file.path), ["docs/2025-12-18.html"]);

  const unrelated = parseCandidateSource(treeSource, baselineBody.replace("tree-1", "tree-2").replace("unrelated-v1", "unrelated-v2"), {
    previousSnapshot: baseline.snapshot,
  });
  assert.deepEqual(unrelated.review_flags, []);

  const changed = parseCandidateSource(treeSource, baselineBody
    .replace("tree-1", "tree-3")
    .replace("model-v1", "model-v2")
    .replace(']}', ',{"path":"docs/2026-07-17.html","type":"blob","sha":"release-v2"}]}'), {
    previousSnapshot: baseline.snapshot,
  });
  assert.ok(changed.review_flags.includes("github-tracked-files-changed-human-artifact-review:1"));
  assert.ok(changed.review_flags.includes("model-spec-version-index-changed-human-canonical-review"));

  const manifestSource = source("openai-model-spec-version-manifest");
  const manifestBody = (value) => JSON.stringify({
    type: "file",
    path: "docs/version-manifest.json",
    name: "version-manifest.json",
    sha: `blob-${value}`,
    encoding: "base64",
    content: Buffer.from(JSON.stringify({ latest_version: value })).toString("base64"),
    html_url: manifestSource.canonical_url,
  });
  const manifest = parseCandidateSource(manifestSource, manifestBody("2025-12-18"));
  assert.deepEqual(manifest.semantic_blockers, []);
  assert.deepEqual(manifest.snapshot.structured_fields, { latest_version: "2025-12-18" });
  assert.match(manifest.latest_item_title, /latest_version=2025-12-18/);
  const invalid = parseCandidateSource(manifestSource, manifestBody("latest"));
  assert.ok(invalid.semantic_blockers.includes("github-file-json-field-invalid:latest_version"));
});

test("Ouro family uses one strict public artifact contract for all four official models", () => {
  const ids = [
    ["ouro-family-1-4b-model", "ByteDance/Ouro-1.4B", "574fa66cb8bf5abdc979642d01cf2b79b16bfab1"],
    ["ouro-family-1-4b-thinking-model", "ByteDance/Ouro-1.4B-Thinking", "3aaa2224253a92ca45cf2e3d427c360e1ef9c93d"],
    ["ouro-family-2-6b-model", "ByteDance/Ouro-2.6B", "1ed04250da1a9936042725d302e81c8fa2ab5abd"],
    ["ouro-family-2-6b-thinking-model", "ByteDance/Ouro-2.6B-Thinking", "f1edd81e7ac41355db670500ceaf204e0f73af68"],
  ];
  for (const [sourceId, artifactId, revision] of ids) {
    const candidate = source(sourceId);
    const body = JSON.stringify({
      id: artifactId,
      sha: revision,
      lastModified: "2026-07-01T00:00:00.000Z",
      private: false,
      gated: false,
      disabled: false,
      cardData: { license: "apache-2.0" },
      siblings: candidate.expected_files_all.map((rfilename) => ({ rfilename })),
    });
    const result = parseCandidateSource(candidate, body);
    assert.deepEqual(result.semantic_blockers, [], sourceId);
    assert.deepEqual(result.review_flags, ["huggingface-review-file-missing:LICENSE"], sourceId);
    assert.deepEqual(result.snapshot.review_files, [{ path: "LICENSE", present: false }], sourceId);
    assert.equal(result.snapshot.revision_sha, revision);
    assert.equal(result.snapshot.license, "apache-2.0");
  }
});

test("paper-linked artifact trees fail closed when benchmark files disappear", () => {
  const candidate = source("pando-artifact-tree");
  const complete = JSON.stringify({
    sha: "tree-pando",
    truncated: false,
    tree: candidate.required_paths_all.map((path, index) => ({ path, type: "blob", sha: `sha-${index}` })),
  });
  const parsed = parseCandidateSource(candidate, complete);
  assert.deepEqual(parsed.semantic_blockers, []);
  assert.equal(parsed.snapshot.tracked_files.length, candidate.required_paths_all.length);
  const missing = parseCandidateSource(candidate, JSON.stringify({
    sha: "tree-pando-2",
    truncated: false,
    tree: [{ path: "README.md", type: "blob", sha: "readme" }],
  }));
  assert.ok(missing.semantic_blockers.includes("github-required-path-missing:scripts/eval.py"));
  const truncated = parseCandidateSource(candidate, complete.replace('"truncated":false', '"truncated":true'));
  assert.ok(truncated.semantic_blockers.includes("github-artifact-tree-truncated"));
});

test("paper-linked branch refs and latent trajectory artifacts have immutable public endpoints", () => {
  const harnessBranch = source("harness-updating-commits");
  assert.equal(harnessBranch.branch_ref, "release/harness-evolution");
  assert.match(harnessBranch.url, /sha=release%2Fharness-evolution/);
  assert.equal(harnessBranch.authentication, "public");

  const latentPaper = source("latent-cot-dynamics-arxiv");
  assert.equal(latentPaper.expected_id, "2607.09698");
  const simCot = source("latent-cot-simcot-coconut-model");
  assert.deepEqual(simCot.expected_files_all, ["README.md", "config.json", "checkpoint_28"]);
});

test("paper-linked Hugging Face artifacts pin public revision identity and required files", () => {
  const candidate = source("switch-latent-reasoning-model");
  const body = JSON.stringify({
    id: "LARK-Lab/SWITCH-Phase3-GRPO-LoRA-Qwen3-8B",
    sha: "246fee75d774c02a110ea8608ac841a916dd5d35",
    lastModified: "2026-06-12T11:03:32.000Z",
    private: false,
    gated: false,
    disabled: false,
    tags: ["license:mit", "arxiv:2606.13106"],
    cardData: { license: "mit" },
    siblings: [
      { rfilename: "README.md" },
      { rfilename: "adapter_config.json" },
      { rfilename: "adapter_model.safetensors" },
    ],
  });
  const result = parseCandidateSource(candidate, body, {
    previousSnapshot: { revision_sha: "old-revision" },
  });
  assert.equal(result.items_parsed, 1);
  assert.equal(result.snapshot.revision_sha, "246fee75d774c02a110ea8608ac841a916dd5d35");
  assert.equal(result.snapshot.license, "mit");
  assert.equal(result.snapshot.file_count, 3);
  assert.deepEqual(result.semantic_blockers, []);
  assert.deepEqual(result.review_flags, ["huggingface-revision-changed-human-artifact-review:246fee75d774c02a110ea8608ac841a916dd5d35"]);

  const audit = createCandidateSourceAudit({
    now: new Date("2026-07-17T04:00:00.000Z"),
    sources: [candidate],
    sourceEvents: [{ source_id: candidate.id, status: "fresh", response_bytes: body.length, ...result }],
  });
  const review = renderCandidateSourceReview(audit);
  assert.match(review, /revision:246fee75d774c02a110ea8608ac841a916dd5d35/);
  assert.match(review, /不可变身份是否与 canonical upstream 一致/);

  const incomplete = parseCandidateSource(candidate, JSON.stringify({
    ...JSON.parse(body),
    gated: "auto",
    siblings: [{ rfilename: "README.md" }],
  }));
  assert.ok(incomplete.semantic_blockers.includes("huggingface-artifact-gated"));
  assert.ok(incomplete.semantic_blockers.includes("huggingface-expected-file-missing:adapter_model.safetensors"));
});

test("versioned GitHub changelogs keep blob identity and require human review when content changes", () => {
  const candidate = source("inspect-ai-changelog");
  const content = "# Changelog\n\n## 1.2.3\n\n- Fix task scorer and sandbox behavior.\n".repeat(20);
  const body = JSON.stringify({
    type: "file",
    path: "CHANGELOG.md",
    name: "CHANGELOG.md",
    sha: "blob-new",
    encoding: "base64",
    content: Buffer.from(content).toString("base64"),
    html_url: candidate.canonical_url,
  });
  const result = parseCandidateSource(candidate, body, { previousSnapshot: { blob_sha: "blob-old" } });
  assert.equal(result.items_parsed, 1);
  assert.equal(result.snapshot.blob_sha, "blob-new");
  assert.ok(result.snapshot.normalized_text_chars > 500);
  assert.deepEqual(result.semantic_blockers, []);
  assert.deepEqual(result.review_flags, ["versioned-document-changed-human-semantic-review"]);
});

test("path-scoped and repository-wide commits expose bounded semantic-diff review queues", () => {
  const candidate = source("lm-eval-task-commits");
  const body = JSON.stringify([
    { sha: "new", html_url: "https://github.com/example/commit/new", commit: { message: "Fix scorer normalization\nDetails", committer: { date: "2026-07-17T02:00:00Z" } } },
    { sha: "old", html_url: "https://github.com/example/commit/old", commit: { message: "Add task", committer: { date: "2026-07-10T02:00:00Z" } } },
  ]);
  const result = parseCandidateSource(candidate, body, {
    previousSnapshot: { commits: [{ sha: "old" }] },
  });
  assert.equal(result.items_parsed, 2);
  assert.equal(result.newly_observed_commits[0].sha, "new");
  assert.deepEqual(result.semantic_blockers, []);
  assert.deepEqual(result.review_flags, ["path-scoped-commits-changed-human-diff-review:1"]);

  const artifact = source("readout-blind-spot-commits");
  const artifactResult = parseCandidateSource(artifact, body, {
    previousSnapshot: { commits: [{ sha: "old" }] },
  });
  assert.equal(artifact.commit_scope, "repository");
  assert.equal(artifactResult.snapshot.commit_scope, "repository");
  assert.deepEqual(artifactResult.semantic_blockers, []);
  assert.deepEqual(artifactResult.review_flags, ["repository-commits-changed-human-diff-review:1"]);
});

test("primary interpretability HTML is hashed as a document and content changes require human review", () => {
  const candidate = source("anthropic-circuit-tracing-methods-page");
  const body = `<html><head><title>${candidate.expected_title}</title><link rel="canonical" href="${candidate.canonical_url}"></head><body>${"causal tracing ".repeat(2_000)}</body></html>`;
  const baseline = parseCandidateSource(candidate, body, {
    responseHeaders: { last_modified: "Wed, 01 Jul 2026 05:34:45 GMT" },
  });
  assert.equal(baseline.items_parsed, 1);
  assert.equal(baseline.latest_item_at, "2026-07-01T05:34:45.000Z");
  assert.deepEqual(baseline.semantic_blockers, []);
  assert.deepEqual(baseline.review_flags, []);
  const changed = parseCandidateSource(candidate, body.replace("causal tracing", "causal intervention"), {
    previousSnapshot: baseline.snapshot,
  });
  assert.deepEqual(changed.review_flags, ["primary-document-content-changed-human-semantic-review"]);
});

test("repository tree parsing detects a new dated constitution without changing canonical automatically", () => {
  const candidate = source("claude-constitution-tree");
  const previousSnapshot = {
    dated_files: [{ path: "20260120-constitution.md", sha: "old" }],
  };
  const result = parseCandidateSource(candidate, JSON.stringify({
    sha: "head-2",
    truncated: false,
    tree: [
      { path: "README.md", type: "blob", sha: "readme" },
      { path: "20260120-constitution.md", type: "blob", sha: "old" },
      { path: "20260701-constitution.md", type: "blob", sha: "new" }
    ],
  }), { previousSnapshot });
  assert.deepEqual(result.semantic_blockers, []);
  assert.deepEqual(result.review_flags, ["new-dated-constitution-human-canonical-review"]);
  assert.equal(result.observation_state, "changed");
  assert.equal(result.event_candidate, true);
  assert.deepEqual(result.change_events.map((event) => event.kind), ["dated-policy-file-added"]);
  assert.equal(result.snapshot.tracked_sha, "old");
  assert.deepEqual(result.snapshot.dated_files.map((file) => file.path), ["20260120-constitution.md", "20260701-constitution.md"]);
});

test("Constitution change events ignore head-only churn and bind canonical blobs and README pointers", () => {
  const treeSource = source("claude-constitution-tree");
  const treeBody = (head, trackedSha) => JSON.stringify({
    sha: head,
    truncated: false,
    tree: [
      { path: "README.md", type: "blob", sha: "readme" },
      { path: "20260120-constitution.md", type: "blob", sha: trackedSha },
    ],
  });
  const baseline = parseCandidateSource(treeSource, treeBody("head-1", "canonical-1"));
  assert.equal(baseline.observation_state, "baseline");
  assert.equal(baseline.event_candidate, false);
  assert.deepEqual(baseline.change_events, []);

  const headOnly = parseCandidateSource(treeSource, treeBody("head-2", "canonical-1"), { previousSnapshot: baseline.snapshot });
  assert.equal(headOnly.observation_state, "unchanged");
  assert.equal(headOnly.event_candidate, false);
  assert.deepEqual(headOnly.change_events, []);

  const canonicalChanged = parseCandidateSource(treeSource, treeBody("head-3", "canonical-2"), { previousSnapshot: baseline.snapshot });
  assert.equal(canonicalChanged.event_candidate, true);
  assert.ok(canonicalChanged.change_events.some((event) => event.kind === "canonical-blob-changed"));

  const readmeSource = source("claude-constitution-readme");
  const readmeBody = (sha, month) => JSON.stringify({
    type: "file",
    path: "README.md",
    name: "README.md",
    sha,
    encoding: "base64",
    content: Buffer.from(`# Claude Constitution\n\nThe current version is from ${month}.\n${"policy ".repeat(30)}`).toString("base64"),
    html_url: readmeSource.canonical_url,
  });
  const readmeBaseline = parseCandidateSource(readmeSource, readmeBody("readme-1", "January 2026"));
  assert.equal(readmeBaseline.snapshot.structured_fields.declared_current_version, "2026-01");
  assert.deepEqual(readmeBaseline.change_events, []);

  const copyEdit = parseCandidateSource(readmeSource, readmeBody("readme-2", "January 2026"), { previousSnapshot: readmeBaseline.snapshot });
  assert.equal(copyEdit.event_candidate, false);
  assert.deepEqual(copyEdit.source_review_flags, ["versioned-document-changed-human-semantic-review"]);
  assert.deepEqual(copyEdit.change_events, []);

  const pointerChanged = parseCandidateSource(readmeSource, readmeBody("readme-3", "July 2026"), { previousSnapshot: readmeBaseline.snapshot });
  assert.equal(pointerChanged.event_candidate, true);
  assert.deepEqual(pointerChanged.change_events.map((event) => event.kind), ["canonical-pointer-changed"]);
  assert.equal(pointerChanged.snapshot.structured_fields.declared_current_version, "2026-07");
});

test("arXiv id-list parsing records the latest version update instead of the original publication date", () => {
  const candidate = source("latent-reasoning-arxiv-seeds");
  const result = parseCandidateSource(candidate, arxivBody, {
    previousSnapshot: { papers: [{ id: "2510.25741", version: 4 }] },
  });
  assert.equal(result.items_parsed, 4);
  assert.equal(result.latest_item_at, "2026-07-01T23:25:58.000Z");
  assert.deepEqual(result.semantic_blockers, []);
  assert.deepEqual(result.review_flags, ["arxiv-version-updated:2510.25741:v5"]);
  assert.equal(result.snapshot.papers.find((paper) => paper.id === "2510.25741").version, 5);

  const directDiagnostic = source("readout-blind-spot-arxiv");
  const directResult = parseCandidateSource(directDiagnostic, readoutArxivBody);
  assert.equal(directResult.items_parsed, 1);
  assert.equal(directResult.snapshot.papers[0].id, "2606.24898");
  assert.deepEqual(directResult.semantic_blockers, []);
  assert.deepEqual(directResult.review_flags, []);
  const directRevision = parseCandidateSource(directDiagnostic, readoutArxivBody.replaceAll("v1", "v2"), {
    previousSnapshot: directResult.snapshot,
  });
  assert.deepEqual(directRevision.review_flags, ["arxiv-version-updated:2606.24898:v2"]);
  const directRegression = parseCandidateSource(directDiagnostic, readoutArxivBody, {
    previousSnapshot: directRevision.snapshot,
  });
  assert.deepEqual(directRegression.semantic_blockers, ["arxiv-version-regressed:2606.24898"]);
});

test("release parsing separates stable and prerelease streams and records pagination coverage", () => {
  const candidate = source("microsoft-agent-framework-releases");
  const body = JSON.stringify([
    { id: 3, tag_name: "python-1.11.0", name: "Python 1.11", draft: false, prerelease: false, immutable: true, published_at: "2026-07-10T03:19:16Z" },
    { id: 2, tag_name: "dotnet-1.13.0-rc.1", name: "Dotnet RC", draft: false, prerelease: true, immutable: false, published_at: "2026-07-09T03:19:16Z" },
    { id: 1, tag_name: "dotnet-1.12.0", name: "Dotnet 1.12", draft: false, prerelease: false, immutable: true, published_at: "2026-07-03T17:18:25Z" }
  ]);
  const result = parseCandidateSource(candidate, body, {
    responseHeaders: { link: "<https://api.github.com/page=2>; rel=\"next\"" },
    latestRelease: { id: 3, tag_name: "python-1.11.0", name: "Python 1.11", draft: false, prerelease: false, immutable: true, published_at: "2026-07-10T03:19:16Z" },
    companionStatus: "fresh",
  });
  assert.equal(result.stable_count, 2);
  assert.equal(result.prerelease_count, 1);
  assert.deepEqual(result.release_stream_counts, { python: 1, dotnet: 2 });
  assert.equal(result.latest_stable.tag_name, "python-1.11.0");
  assert.deepEqual(result.semantic_blockers, []);
  assert.deepEqual(result.warnings, ["pagination-available"]);
});

test("release snapshots bind body hash and mutable metadata while only new stable releases enter semantic review", () => {
  const candidate = source("openai-agents-sdk-releases");
  const release = {
    id: 101,
    tag_name: "v1.0.0",
    name: "Stable 1.0",
    body: "Adds a versioned session lifecycle.",
    target_commitish: "commit-a",
    draft: false,
    prerelease: false,
    immutable: false,
    created_at: "2026-07-16T01:00:00Z",
    updated_at: "2026-07-16T02:00:00Z",
    published_at: "2026-07-16T02:00:00Z",
  };
  const baseline = parseCandidateSource(candidate, JSON.stringify([release]), {
    latestRelease: release,
    companionStatus: "fresh",
  });
  assert.deepEqual(baseline.review_flags, [
    "release-record-mutable-upstream:v1.0.0",
    "release-tag-commit-not-resolved:v1.0.0",
  ]);
  assert.equal(baseline.snapshot.latest_stable.id, "101");
  assert.equal(baseline.snapshot.latest_stable.immutable, false);
  assert.equal(baseline.snapshot.latest_stable.target_commitish, "commit-a");
  assert.equal(baseline.snapshot.latest_stable.tag_commit_resolution, "not-fetched");
  assert.match(baseline.snapshot.latest_stable.body_sha256, /^[a-f0-9]{64}$/);
  assert.equal(baseline.snapshot.latest_stable.body_excerpt, "Adds a versioned session lifecycle.");
  assert.match(baseline.snapshot.latest_stable.body_excerpt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(baseline.snapshot.latest_stable.body_excerpt_truncated, false);

  const mutatedRelease = {
    ...release,
    body: "Adds a versioned session lifecycle and a sandbox fix.",
    updated_at: "2026-07-17T01:00:00Z",
  };
  const mutated = parseCandidateSource(candidate, JSON.stringify([mutatedRelease]), {
    previousSnapshot: baseline.snapshot,
    latestRelease: mutatedRelease,
    companionStatus: "fresh",
  });
  assert.deepEqual(mutated.review_flags, [
    "github-release-content-edited-human-semantic-review:1",
    "release-record-mutable-upstream:v1.0.0",
    "release-tag-commit-not-resolved:v1.0.0",
  ]);
  assert.equal(mutated.observation_state, "changed");
  assert.equal(mutated.event_kind, "mutable-release-edit");
  assert.notEqual(mutated.snapshot.latest_stable.body_sha256, baseline.snapshot.latest_stable.body_sha256);

  const timestampOnly = parseCandidateSource(candidate, JSON.stringify([{ ...release, updated_at: "2026-07-17T00:30:00Z" }]), {
    previousSnapshot: baseline.snapshot,
    latestRelease: { ...release, updated_at: "2026-07-17T00:30:00Z" },
    companionStatus: "fresh",
  });
  assert.equal(timestampOnly.event_candidate, false);
  assert.deepEqual(timestampOnly.event_review_flags, []);
  assert.deepEqual(timestampOnly.source_review_flags, [
    "github-release-metadata-edited:1",
    "release-record-mutable-upstream:v1.0.0",
    "release-tag-commit-not-resolved:v1.0.0",
  ]);
  assert.ok(timestampOnly.release_change_flags.includes("release-metadata-edited"));
  assert.equal(timestampOnly.snapshot.latest_stable.semantic_payload_sha256, baseline.snapshot.latest_stable.semantic_payload_sha256);
  assert.notEqual(timestampOnly.snapshot.latest_stable.release_snapshot_sha256, baseline.snapshot.latest_stable.release_snapshot_sha256);

  const legacySnapshot = structuredClone(baseline.snapshot);
  for (const legacyRelease of legacySnapshot.releases) {
    delete legacyRelease.body_sha256;
    delete legacyRelease.asset_manifest_sha256;
    delete legacyRelease.semantic_payload_sha256;
    delete legacyRelease.release_snapshot_sha256;
  }
  const migrated = parseCandidateSource(candidate, JSON.stringify([release]), {
    previousSnapshot: legacySnapshot,
    latestRelease: release,
    companionStatus: "fresh",
  });
  assert.equal(migrated.event_candidate, false);
  assert.equal(migrated.event_kind, "none");
  assert.equal(migrated.release_change_state, "identity-schema-migrated");
  assert.deepEqual(migrated.event_review_flags, []);
  assert.deepEqual(migrated.source_review_flags, [
    "github-release-identity-schema-migrated:1",
    "release-record-mutable-upstream:v1.0.0",
    "release-tag-commit-not-resolved:v1.0.0",
  ]);
  assert.equal(migrated.identity_migrated_release_snapshots.length, 1);

  const newRelease = {
    ...release,
    id: 102,
    tag_name: "v1.1.0",
    name: "Stable 1.1",
    body: "Adds resumable background tasks.",
    target_commitish: "commit-b",
    created_at: "2026-07-17T02:00:00Z",
    updated_at: "2026-07-17T02:00:00Z",
    published_at: "2026-07-17T02:00:00Z",
  };
  const changed = parseCandidateSource(candidate, JSON.stringify([newRelease, release]), {
    previousSnapshot: baseline.snapshot,
    latestRelease: newRelease,
    companionStatus: "fresh",
  });
  assert.deepEqual(changed.review_flags, [
    "github-stable-releases-changed-human-semantic-review:1",
    "release-record-mutable-upstream:v1.1.0",
    "release-tag-commit-not-resolved:v1.1.0",
  ]);
  const identity = observedSourceIdentity({ snapshot: changed.snapshot });
  assert.match(identity, /^github-release-snapshot:openai\/openai-agents-python@[a-f0-9]{64}; release-id:102; tag:v1\.1\.0; target:commit-b; upstream-immutable:false$/);

  const sourceEvents = candidateSources.map((entry) => ({
    source_id: entry.id,
    status: "fresh",
    semantic_blockers: [],
    warnings: [],
    review_flags: [],
  }));
  sourceEvents.find((event) => event.source_id === candidate.id).snapshot = baseline.snapshot;
  const audit = createCandidateSourceAudit({ now: new Date("2026-07-17T02:00:00Z"), sourceEvents });
  assert.deepEqual(verifyCandidateSourceProbe(audit), { ok: true, errors: [] });
  audit.source_events.find((event) => event.source_id === candidate.id).snapshot.releases[0].body_excerpt = "tampered release semantics";
  assert.ok(verifyCandidateSourceProbe(audit).errors.some((error) => error.includes("release body excerpt hash mismatch")));
});

test("a paginated release window shorter than two days is a semantic blocker despite HTTP success", () => {
  const candidate = source("openai-agents-sdk-releases");
  const body = JSON.stringify([
    { id: 2, tag_name: "v2.0.0", draft: false, prerelease: false, published_at: "2026-07-17T02:00:00Z" },
    { id: 1, tag_name: "v1.9.0", draft: false, prerelease: false, published_at: "2026-07-17T01:00:00Z" }
  ]);
  const result = parseCandidateSource(candidate, body, {
    responseHeaders: { link: "<https://api.github.com/page=2>; rel=\"next\"" },
    latestRelease: { id: 2, tag_name: "v2.0.0", draft: false, prerelease: false, published_at: "2026-07-17T02:00:00Z" },
    companionStatus: "fresh",
  });
  assert.ok(result.semantic_blockers.includes("release-window-too-short"));
});

test("the official latest endpoint repairs a newly published stable release missing from the list response", () => {
  const candidate = source("google-adk-releases");
  const body = JSON.stringify([
    { id: 24, tag_name: "v2.4.0", draft: false, prerelease: false, published_at: "2026-07-07T19:45:22Z" },
    { id: 23, tag_name: "v2.3.0", draft: false, prerelease: false, published_at: "2026-06-18T18:45:04Z" }
  ]);
  const result = parseCandidateSource(candidate, body, {
    latestRelease: { id: 25, tag_name: "v2.5.0", draft: false, prerelease: false, published_at: "2026-07-16T20:41:30Z" },
    companionStatus: "fresh",
  });
  assert.equal(result.list_latest_stable, "v2.4.0");
  assert.equal(result.latest_stable.tag_name, "v2.5.0");
  assert.equal(result.latest_endpoint_in_list, false);
  assert.ok(result.warnings.includes("latest-endpoint-not-in-release-list"));
  assert.deepEqual(result.review_flags, [
    "release-list-lags-latest-endpoint:v2.5.0",
    "release-record-mutable-upstream:v2.5.0",
    "release-tag-commit-not-resolved:v2.5.0",
  ]);
  assert.deepEqual(result.event_review_flags, []);
  assert.deepEqual(result.source_review_flags, [
    "release-list-lags-latest-endpoint:v2.5.0",
    "release-record-mutable-upstream:v2.5.0",
    "release-tag-commit-not-resolved:v2.5.0",
  ]);
  assert.equal(result.event_candidate, false);
  assert.deepEqual(result.semantic_blockers, []);
});

test("editorial RSS remains discovery-only and exposes freshness without upgrading authority", () => {
  const candidate = source("latent-space-feed");
  const result = parseCandidateSource(candidate, rssBody, { now: new Date("2026-07-17T04:00:00Z") });
  assert.equal(candidate.role, "editorial-discovery");
  assert.equal(candidate.authority_tier, "T2");
  assert.equal(result.items_parsed, 2);
  assert.equal(result.latest_item_at, "2026-07-15T08:00:00.000Z");
  assert.deepEqual(result.snapshot.items.map((item) => item.title), ["Harness Engineering", "Latent Reasoning"]);
  assert.deepEqual(result.snapshot.items[0].artifact_links, [{
    url: "https://github.com/example/harness",
    candidate_type: "code-or-release-candidate",
    link_context: "code",
    authority_verified: false,
    requires_primary_verification: true,
  }]);
  assert.deepEqual(result.semantic_blockers, []);
});

test("seven network-success days make a source ready only for human review, never automatic promotion or notification", () => {
  const candidate = source("latent-space-feed");
  const previousAudit = {
    source_history: [{
      source_id: candidate.id,
      observed_network_success_dates: ["2026-07-11", "2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"],
      observed_semantic_healthy_dates: ["2026-07-11", "2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"],
    }],
  };
  const audit = createCandidateSourceAudit({
    now: new Date("2026-07-17T02:00:00Z"),
    sources: [candidate],
    previousAudit,
    sourceEvents: [{ source_id: candidate.id, status: "fresh", observation_state: "unchanged", semantic_blockers: [], warnings: [], review_flags: [] }],
  });
  const history = audit.source_history[0];
  assert.equal(history.consecutive_network_success_days, 7);
  assert.equal(history.consecutive_semantic_healthy_days, 7);
  assert.equal(history.consecutive_source_stable_days, 7);
  assert.equal(history.ready_for_human_review, true);
  assert.equal(history.automatically_promoted, false);
  assert.equal(history.criteria.human_source_review.passed, false);
  assert.equal(audit.notification_policy.eligible, false);
  assert.deepEqual(audit.notification_policy.external_actions, []);
});

test("semantic blockers reset the clean seven-day source-stability gate", () => {
  const candidate = source("latent-space-feed");
  let previousAudit = null;
  for (let day = 11; day <= 16; day += 1) {
    previousAudit = createCandidateSourceAudit({
      now: new Date(`2026-07-${day}T02:00:00Z`),
      sources: [candidate],
      previousAudit,
      sourceEvents: [{
        source_id: candidate.id,
        status: "fresh",
        observation_state: "blocked",
        semantic_blockers: ["schema-drift"],
        warnings: [],
        review_flags: [],
      }],
    });
  }
  const recovered = createCandidateSourceAudit({
    now: new Date("2026-07-17T02:00:00Z"),
    sources: [candidate],
    previousAudit,
    sourceEvents: [{
      source_id: candidate.id,
      status: "fresh",
      observation_state: "unchanged",
      semantic_blockers: [],
      warnings: [],
      review_flags: [],
    }],
  });
  const history = recovered.source_history[0];
  assert.equal(history.consecutive_network_success_days, 7);
  assert.equal(history.consecutive_semantic_healthy_days, 1);
  assert.equal(history.consecutive_source_stable_days, 1);
  assert.equal(history.ready_for_human_review, false);
});

test("a same-day blocked rerun removes the earlier clean day from both streaks", () => {
  const candidate = source("latent-space-feed");
  const clean = createCandidateSourceAudit({
    now: new Date("2026-07-17T01:00:00Z"),
    sources: [candidate],
    sourceEvents: [{
      source_id: candidate.id,
      status: "fresh",
      observation_state: "unchanged",
      semantic_blockers: [],
      warnings: [],
      review_flags: [],
    }],
  });
  const blocked = createCandidateSourceAudit({
    now: new Date("2026-07-17T03:00:00Z"),
    sources: [candidate],
    previousAudit: clean,
    sourceEvents: [{
      source_id: candidate.id,
      status: "failed",
      observation_state: "blocked",
      semantic_blockers: ["schema-drift"],
      warnings: [],
      review_flags: [],
    }],
  });
  const history = blocked.source_history[0];
  assert.deepEqual(history.observed_network_success_dates, []);
  assert.deepEqual(history.observed_semantic_healthy_dates, []);
  assert.equal(history.consecutive_source_stable_days, 0);
  assert.equal(history.ready_for_human_review, false);
});

test("the verifier rejects future, unsorted, or fabricated stability dates", () => {
  const sourceEvents = candidateSources.map((candidate) => ({
    source_id: candidate.id,
    status: "fresh",
    observation_state: "unchanged",
    semantic_blockers: [],
    warnings: [],
    review_flags: [],
  }));
  const audit = createCandidateSourceAudit({ now: new Date("2026-07-17T02:00:00Z"), sourceEvents });
  const history = audit.source_history[0];
  const future = ["2099-01-01", "2099-01-02", "2099-01-03", "2099-01-04", "2099-01-05", "2099-01-06", "2099-01-07"];
  history.observed_network_success_dates = future;
  history.observed_semantic_healthy_dates = future;
  history.consecutive_network_success_days = 7;
  history.consecutive_semantic_healthy_days = 7;
  history.consecutive_source_stable_days = 7;
  history.criteria.minimum_observation_days = { required: 7, observed: 7, passed: true };
  history.criteria.network_stability = { required_days: 7, observed_days: 7, passed: true };
  history.criteria.semantic_stability = { required_days: 7, observed_days: 7, passed: true };
  history.ready_for_human_review = true;
  audit.metrics.ready_for_human_review = 1;
  const result = verifyCandidateSourceProbe(audit);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("contains a future date")));
});

test("the verifier enforces full candidate coverage and production isolation", () => {
  const sourceEvents = candidateSources.map((candidate) => ({
    source_id: candidate.id,
    status: "fresh",
    semantic_blockers: [],
    warnings: [],
    review_flags: [],
  }));
  const audit = createCandidateSourceAudit({ now: new Date("2026-07-17T02:00:00Z"), sourceEvents });
  assert.deepEqual(verifyCandidateSourceProbe(audit), { ok: true, errors: [] });
  audit.notification_policy.enabled = true;
  assert.equal(verifyCandidateSourceProbe(audit).ok, false);
});

test("the verifier rejects baseline event flags and unchanged event candidates", () => {
  const sourceEvents = candidateSources.map((candidate) => ({
    source_id: candidate.id,
    status: "fresh",
    semantic_blockers: [],
    warnings: [],
    review_flags: [],
  }));
  const baselineAudit = createCandidateSourceAudit({ now: new Date("2026-07-17T02:00:00Z"), sourceEvents });
  baselineAudit.source_events[0] = {
    ...baselineAudit.source_events[0],
    observation_state: "baseline",
    event_candidate: false,
    event_review_flags: ["fabricated-change"],
    source_review_flags: [],
    review_flags: ["fabricated-change"],
    change_events: [{ kind: "fabricated" }],
  };
  assert.ok(verifyCandidateSourceProbe(baselineAudit).errors.some((error) => error.includes("baseline source cannot contain event review flags")));

  const unchangedAudit = createCandidateSourceAudit({ now: new Date("2026-07-17T02:00:00Z"), sourceEvents: structuredClone(sourceEvents) });
  unchangedAudit.source_events[0] = {
    ...unchangedAudit.source_events[0],
    observation_state: "unchanged",
    event_candidate: true,
    event_review_flags: [],
    source_review_flags: [],
    review_flags: [],
    change_events: [{ kind: "fabricated" }],
  };
  assert.ok(verifyCandidateSourceProbe(unchangedAudit).errors.some((error) => error.includes("unchanged source cannot be an event candidate")));
});

test("conditional requests reuse a bounded cache while counting a second network-verified day", async () => {
  const root = await mkdtemp(join(tmpdir(), "candidate-source-probe-"));
  try {
    const candidate = { ...source("latent-space-feed"), id: "test-feed" };
    const outputPath = join(root, "audit.json");
    const reviewPath = join(root, "review.md");
    const cacheDir = join(root, "cache");
    const firstFetch = async () => new Response(rssBody, { status: 200, headers: { etag: "\"feed-v1\"", "content-type": "application/rss+xml" } });
    const first = await runCandidateSourceProbe({
      sources: [candidate], outputPath, statePath: outputPath, reviewPath, cacheDir,
      now: new Date("2026-07-17T02:00:00Z"), fetchImpl: firstFetch,
    });
    assert.equal(first.source_events[0].status, "fresh");
    const secondFetch = async (_url, options) => {
      assert.equal(options.headers["if-none-match"], "\"feed-v1\"");
      return new Response(null, { status: 304, headers: { etag: "\"feed-v1\"" } });
    };
    const second = await runCandidateSourceProbe({
      sources: [candidate], outputPath, statePath: outputPath, reviewPath, cacheDir,
      now: new Date("2026-07-18T02:00:00Z"), fetchImpl: secondFetch,
    });
    assert.equal(second.source_events[0].status, "not-modified");
    assert.equal(second.source_history[0].consecutive_network_success_days, 2);
    assert.equal(second.notification_policy.eligible, false);
    assert.match(await readFile(reviewPath, "utf8"), /不发送通知/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
