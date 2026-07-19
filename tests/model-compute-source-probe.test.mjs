import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { modelComputeShadowSources } from "../automation/model-compute-source-registry.mjs";
import {
  parseModelComputeSource,
  runModelComputeSourceProbe,
} from "../automation/run-model-compute-source-probe.mjs";
import {
  promoteStagedModelComputeProbe,
  runAndVerifyModelComputeSourceProbe,
} from "../automation/run-and-verify-model-compute-source-probe.mjs";
import { verifyModelComputeSourceProbe } from "../automation/verify-model-compute-source-probe.mjs";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const WEBSITE_DIR = resolve(TEST_DIR, "..");
const ROOT_DIR = resolve(WEBSITE_DIR, "..");
const NOW = new Date("2026-07-18T08:00:00.000Z");

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

function source(id) {
  return modelComputeShadowSources.find((item) => item.id === id);
}

function githubReleaseBody(tag = "v1.0.0") {
  return JSON.stringify([{
    tag_name: tag,
    name: `Release ${tag}`,
    html_url: `https://github.com/example/project/releases/tag/${tag}`,
    published_at: "2026-07-18T01:00:00.000Z",
    updated_at: "2026-07-18T01:00:00.000Z",
    prerelease: false,
    draft: false,
    body: "New model runner, CUDA graph scheduling, prefix cache, and kernel compiler API.",
  }]);
}

function bodyForSource(sourceItem, { extraQwenModel = false } = {}) {
  switch (sourceItem.id) {
    case "kimi-research-index":
      return `<a href="/en/blog/kimi-k3" aria-label="Kimi K3"></a><div><h4 class="card-title">Kimi K3</h4><p class="card-date">2026/07/17</p></div>`;
    case "thinking-machines-sitemap":
      return `<?xml version="1.0"?><urlset><url><loc>https://thinkingmachines.ai/news/introducing-inkling/</loc><lastmod>2026-07-15</lastmod></url></urlset>`;
    case "mistral-news-index":
      return `<a href="/news/new-frontier-model"><h3>New Frontier Model</h3><time>2026-07-17</time></a>`;
    case "nvidia-developer-blog-atom":
      return `<?xml version="1.0"?><feed><entry><title>New CUDA kernel for AI inference</title><link href="https://developer.nvidia.com/blog/new-cuda-kernel/" rel="alternate"/><published>2026-07-17T02:00:00Z</published><summary>AI inference GPU kernel and compiler runtime</summary></entry></feed>`;
    case "nvidia-newsroom-press-xml":
      return `<?xml version="1.0"?><rss><channel><item><title>NVIDIA launches AI GPU rack system</title><link>https://nvidianews.nvidia.com/news/ai-gpu-rack</link><pubDate>Fri, 17 Jul 2026 03:00:00 GMT</pubDate><description>AI accelerator memory and interconnect system</description></item></channel></rss>`;
    case "rocm-release-history":
      return `<h2>ROCm 7.14.0</h2><p>2026-07-17</p>`;
    default:
      if (sourceItem.format === "github-rest-releases-json") return githubReleaseBody();
      if (sourceItem.format === "huggingface-model-list-json") {
        const author = new URL(sourceItem.endpoint).searchParams.get("author") || "community";
        const models = [{
          id: `${author}/Model-One`,
          modelId: `${author}/Model-One`,
          sha: "a".repeat(40),
          createdAt: "2026-07-17T04:00:00.000Z",
          lastModified: "2026-07-17T04:00:00.000Z",
          tags: ["text-generation"],
          likes: 10,
          downloads: 100,
        }];
        if (extraQwenModel && sourceItem.id === "hf-org-qwen") models.unshift({
          id: "Qwen/New-Model",
          modelId: "Qwen/New-Model",
          sha: "b".repeat(40),
          createdAt: "2026-07-18T07:00:00.000Z",
          lastModified: "2026-07-18T07:00:00.000Z",
          tags: ["text-generation"],
          likes: 20,
          downloads: 200,
        });
        return JSON.stringify(models);
      }
      throw new Error(`missing fixture body: ${sourceItem.id}`);
  }
}

function fixtureFetch(options = {}) {
  return async (url) => {
    const sourceItem = modelComputeShadowSources.find((candidate) => candidate.endpoint === String(url));
    assert.ok(sourceItem, `unexpected URL ${url}`);
    return response(bodyForSource(sourceItem, options), {
      headers: sourceItem.format === "github-rest-releases-json"
        ? { "x-ratelimit-remaining": "50", etag: '"github-etag"' }
        : { etag: `"${sourceItem.id}"` },
    });
  };
}

async function paths(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    outputPath: join(root, "audit.json"),
    statePath: join(root, "audit.json"),
    reviewPath: join(root, "review.md"),
    cacheDir: join(root, "cache"),
  };
}

test("Kimi index parsing captures K3 official identity and source date without fetching the detail page", () => {
  const items = parseModelComputeSource(source("kimi-research-index"), bodyForSource(source("kimi-research-index")));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Kimi K3");
  assert.equal(items[0].url, "https://www.kimi.com/blog/kimi-k3");
  assert.equal(items[0].published_at, "2026-07-16T16:00:00.000Z");
  assert.equal(items[0].metadata.source_date, "2026-07-17");
  assert.equal(items[0].metadata.source_timezone, "Asia/Shanghai");
  assert.equal(items[0].claim_evidence_allowed, false);
});

test("Hugging Face parsing preserves revision identity and labels derivative model cues", () => {
  const hf = source("hf-models-trending-fallback");
  const items = parseModelComputeSource(hf, JSON.stringify([{
    id: "community/Example-70B-AWQ",
    sha: "c".repeat(40),
    createdAt: "2026-07-18T01:00:00Z",
    tags: ["quantized"],
  }]));
  assert.equal(items[0].identity, `huggingface:community/Example-70B-AWQ@${"c".repeat(40)}`);
  assert.equal(items[0].metadata.derivative_model_cue, true);
  assert.equal(items[0].kind, "model-attention-signal");
});

test("GitHub release parsing keeps version occurrence separate from semantic-review eligibility", () => {
  const items = parseModelComputeSource(source("vllm-rest-releases"), githubReleaseBody("v0.25.0"));
  assert.equal(items.length, 1);
  assert.equal(items[0].identity, "github-release:vllm-project/vllm@v0.25.0");
  assert.equal(items[0].metadata.semantic_review.eligible_for_editorial_review, true);
  assert.match(items[0].metadata.release_body_excerpt, /CUDA graph scheduling/);
  assert.match(items[0].metadata.release_body_excerpt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(items[0].metadata.release_body_excerpt_truncated, false);
  assert.equal(items[0].claim_evidence_allowed, false);
});

test("the first network run is a baseline while dated K3 remains visible for manual daily review", async () => {
  const runPaths = await paths("model-compute-baseline-");
  const audit = await runModelComputeSourceProbe({
    ...runPaths,
    fetchImpl: fixtureFetch(),
    now: NOW,
    retryBaseDelayMs: 0,
  });
  assert.deepEqual(verifyModelComputeSourceProbe(audit), { ok: true, errors: [] });
  assert.equal(audit.metrics.source_count, 16);
  assert.equal(audit.metrics.fresh_or_not_modified, 16);
  assert.equal(audit.metrics.onboarding_source_count, 16);
  assert.equal(audit.human_change_review_queue.length, 0);
  const k3 = audit.daily_current_window_review.find((item) => item.title === "Kimi K3");
  assert.ok(k3);
  assert.equal(k3.source_id, "kimi-research-index");
  assert.ok(audit.daily_editorial_candidates.some((item) => item.title === "Kimi K3"));
  assert.equal(audit.notification_policy.enabled, false);
  assert.deepEqual(audit.external_actions, []);
  const review = await readFile(runPaths.reviewPath, "utf8");
  assert.match(review, /Kimi K3/);
  assert.match(review, /Hugging Face organization identity bindings/);
  assert.match(review, /primary-source-verified-pending-human-signoff/);
  assert.match(review, /human signoff: unchecked/);
});

test("only a model identity first observed after onboarding becomes a manual change candidate", async () => {
  const runPaths = await paths("model-compute-change-");
  await runModelComputeSourceProbe({ ...runPaths, fetchImpl: fixtureFetch(), now: NOW, retryBaseDelayMs: 0 });
  const audit = await runModelComputeSourceProbe({
    ...runPaths,
    fetchImpl: fixtureFetch({ extraQwenModel: true }),
    now: new Date("2026-07-19T08:00:00.000Z"),
    retryBaseDelayMs: 0,
  });
  assert.deepEqual(verifyModelComputeSourceProbe(audit), { ok: true, errors: [] });
  assert.equal(audit.human_change_review_queue.length, 1);
  assert.equal(audit.human_change_review_queue[0].title, "Qwen/New-Model");
  assert.equal(audit.human_change_review_queue[0].manual_review_only, true);
  assert.equal(audit.human_change_review_queue[0].notification_eligible, false);
});

test("conditional 304 responses reuse bounded cache without manufacturing changes", async () => {
  const runPaths = await paths("model-compute-conditional-");
  await runModelComputeSourceProbe({ ...runPaths, fetchImpl: fixtureFetch(), now: NOW, retryBaseDelayMs: 0 });
  const audit = await runModelComputeSourceProbe({
    ...runPaths,
    fetchImpl: async () => response(null, { status: 304 }),
    now: new Date("2026-07-19T08:00:00.000Z"),
    retryBaseDelayMs: 0,
  });
  assert.deepEqual(verifyModelComputeSourceProbe(audit), { ok: true, errors: [] });
  assert.equal(audit.source_events.every((event) => event.status === "not-modified"), true);
  assert.equal(audit.human_change_review_queue.length, 0);
});

test("a failed or rate-skipped source completes onboarding only after its first successful response", async () => {
  const runPaths = await paths("model-compute-recovery-baseline-");
  await runModelComputeSourceProbe({
    ...runPaths,
    fetchImpl: async (url) => {
      const sourceItem = modelComputeShadowSources.find((candidate) => candidate.endpoint === String(url));
      if (sourceItem.format === "github-rest-releases-json") return response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
      return fixtureFetch()(url);
    },
    now: NOW,
    maxRetries: 0,
    retryBaseDelayMs: 0,
  });
  const recovered = await runModelComputeSourceProbe({
    ...runPaths,
    fetchImpl: fixtureFetch(),
    now: new Date("2026-07-19T08:00:00.000Z"),
    retryBaseDelayMs: 0,
  });
  const githubEvents = recovered.source_events.filter((event) => event.source_id.endsWith("rest-releases"));
  assert.equal(githubEvents.every((event) => event.status === "fresh" && event.onboarding_baseline), true);
  assert.equal(githubEvents.every((event) => event.change_candidates.length === 0), true);
  assert.equal(recovered.human_change_review_queue.length, 0);
  assert.deepEqual(verifyModelComputeSourceProbe(recovered), { ok: true, errors: [] });

  const changed = await runModelComputeSourceProbe({
    ...runPaths,
    fetchImpl: async (url) => {
      const sourceItem = modelComputeShadowSources.find((candidate) => candidate.endpoint === String(url));
      if (sourceItem.id === "vllm-rest-releases") return response(githubReleaseBody("v1.1.0"), { headers: { "x-ratelimit-remaining": "50" } });
      return fixtureFetch()(url);
    },
    now: new Date("2026-07-20T08:00:00.000Z"),
    retryBaseDelayMs: 0,
  });
  assert.equal(changed.human_change_review_queue.length, 1);
  assert.equal(changed.human_change_review_queue[0].identity, "github-release:vllm-project/vllm@v1.1.0");
});

test("one oversized source fails semantically without blocking the other fifteen sources", async () => {
  const runPaths = await paths("model-compute-bounds-");
  const target = source("thinking-machines-sitemap");
  const audit = await runModelComputeSourceProbe({
    ...runPaths,
    fetchImpl: async (url) => String(url) === target.endpoint
      ? response("x".repeat(target.limits.max_bytes + 1))
      : fixtureFetch()(url),
    now: NOW,
    maxRetries: 0,
    retryBaseDelayMs: 0,
  });
  assert.deepEqual(verifyModelComputeSourceProbe(audit), { ok: true, errors: [] });
  assert.equal(audit.source_events.find((event) => event.source_id === target.id).status, "failed");
  assert.equal(audit.metrics.fresh_or_not_modified, 15);
  assert.equal(audit.notification_policy.eligible_records, 0);
});

test("the verifier fails closed on fabricated availability, notification, and production writes", async () => {
  const runPaths = await paths("model-compute-verifier-");
  const audit = await runModelComputeSourceProbe({ ...runPaths, fetchImpl: fixtureFetch(), now: NOW, retryBaseDelayMs: 0 });
  const mutated = structuredClone(audit);
  mutated.raw_items[0].can_change_availability_state = true;
  mutated.source_events[0].items[0].can_change_availability_state = true;
  mutated.notification_policy.enabled = true;
  mutated.isolation.production_state_written = true;
  const result = verifyModelComputeSourceProbe(mutated);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("crossed-safety-boundary")));
  assert.ok(result.errors.includes("notification-boundary-violated"));
  assert.ok(result.errors.includes("isolation-boundary-violated: production_state_written"));
});

test("the gate runs verifier after runner and promotes state last", () => {
  const invocations = [];
  const spawnImpl = (command, args, options) => {
    invocations.push({ command, args, options });
    return { status: 0, error: undefined, signal: null };
  };
  let promoted = null;
  assert.equal(runAndVerifyModelComputeSourceProbe({
    spawnImpl,
    nodePath: "/node",
    cwd: WEBSITE_DIR,
    environment: {},
    promoteImpl: (pathsValue) => { promoted = pathsValue; },
  }), 0);
  assert.equal(invocations.length, 2);
  assert.equal(basename(invocations[0].args[0]), "run-model-compute-source-probe.mjs");
  assert.equal(basename(invocations[1].args[0]), "verify-model-compute-source-probe.mjs");
  assert.equal(invocations[0].options.shell, false);
  assert.equal(invocations[0].options.env.MODEL_COMPUTE_PROBE_DEFER_STATE_COMMIT, "1");
  assert.equal(invocations[1].args[1], promoted.stagedAuditPath);
});

test("state-last promotion cannot advance state when report promotion fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-compute-promote-"));
  const stagedAuditPath = join(root, ".audit.pending");
  const stagedReviewPath = join(root, ".review.pending");
  const finalStatePath = join(root, "audit.json");
  const finalReviewPath = join(root, "review.md");
  const writes = [];
  assert.throws(() => promoteStagedModelComputeProbe({
    stagedAuditPath,
    stagedReviewPath,
    finalOutputPath: finalStatePath,
    finalStatePath,
    finalReviewPath,
    readFileImpl: (path) => path === stagedAuditPath ? Buffer.from("audit") : Buffer.from("review"),
    atomicWriteImpl: (path) => {
      writes.push(path);
      if (path === finalReviewPath) throw new Error("review-write-failed");
    },
    unlinkImpl: () => {},
  }), /review-write-failed/);
  assert.deepEqual(writes, [finalReviewPath]);
  assert.equal(writes.includes(finalStatePath), false);
});

test("the silent LaunchAgent uses the verified gate and contains no credentials or notification path", () => {
  const output = execFileSync("python3", [
    resolve(ROOT_DIR, "scripts/install_model_compute_probe_launchd.py"),
    "--dry-run",
    "--hour", "7",
    "--minute", "0",
  ], { cwd: ROOT_DIR, encoding: "utf8" });
  assert.match(output, /run-and-verify-model-compute-source-probe\.mjs/);
  assert.doesNotMatch(output, /<string>[^<]*run-model-compute-source-probe\.mjs<\/string>/);
  assert.doesNotMatch(output, /GITHUB_TOKEN|GEMINI|CLOUDFLARE|WECHAT/);
  assert.match(output, /<key>Hour<\/key>\s*<integer>7<\/integer>/);
});
