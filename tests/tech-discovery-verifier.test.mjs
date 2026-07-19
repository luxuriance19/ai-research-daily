import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { techDiscoverySources } from "../automation/tech-discovery-registry.mjs";
import {
  promoteStagedTechDiscovery,
  runAndVerifyTechDiscoveryProbe,
} from "../automation/run-and-verify-tech-discovery-probe.mjs";
import { runTechDiscoveryProbe } from "../automation/run-tech-discovery-probe.mjs";
import { verifyTechDiscoveryProbe } from "../automation/verify-tech-discovery-probe.mjs";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const WEBSITE_DIR = resolve(TEST_DIR, "..");
const ROOT_DIR = resolve(WEBSITE_DIR, "..");

const response = (body) => new Response(body, { status: 200 });
const githubSource = () => structuredClone(techDiscoverySources.find((source) => source.id === "github-trending-daily"));

async function changedAudit() {
  const root = await mkdtemp(join(tmpdir(), "tech-discovery-verifier-"));
  const paths = {
    outputPath: join(root, "audit.json"),
    statePath: join(root, "audit.json"),
    reviewPath: join(root, "review.md"),
    cacheDir: join(root, "cache"),
    candidateAuditPath: join(root, "candidate-audit.json"),
  };
  const source = githubSource();
  const baseline = `<article class="Box-row"><h2><a href="/old/model">old/model</a></h2><p>Open LLM model</p></article>`;
  const changed = `${baseline}<article class="Box-row"><h2><a href="/new/model">new/model</a></h2><p>New LLM model</p></article>`;
  await runTechDiscoveryProbe({
    sources: [source],
    ...paths,
    fetchImpl: async () => response(baseline),
    now: new Date("2026-07-17T09:00:00Z"),
  });
  const audit = await runTechDiscoveryProbe({
    sources: [source],
    ...paths,
    fetchImpl: async () => response(changed),
    now: new Date("2026-07-17T10:00:00Z"),
  });
  // The audit contract requires an explicit negative, never a truthy/missing default.
  for (const event of audit.source_events) {
    for (const item of event.items) item.primary_verified = false;
    for (const item of event.queue_candidates) item.primary_verified = false;
  }
  for (const item of audit.human_review_queue) item.primary_verified = false;
  return { audit, source };
}

test("verifier validates every audit registry field, not only source IDs", async () => {
  const { audit, source } = await changedAudit();
  assert.deepEqual(verifyTechDiscoveryProbe(audit, [source]), { ok: true, errors: [] });

  const boundaryMutation = structuredClone(audit);
  boundaryMutation.source_registry[0].can_trigger_notification = true;
  const boundaryResult = verifyTechDiscoveryProbe(boundaryMutation, [source]);
  assert.equal(boundaryResult.ok, false);
  assert.ok(boundaryResult.errors.some((error) => error.includes("audit registry: can_trigger_notification boundary violated")));

  const endpointMutation = structuredClone(audit);
  endpointMutation.source_registry[0].endpoint = "https://mirror.invalid/trending";
  const endpointResult = verifyTechDiscoveryProbe(endpointMutation, [source]);
  assert.equal(endpointResult.ok, false);
  assert.ok(endpointResult.errors.includes("source_registry fields must exactly match the requested registry"));
});

test("final human queue fails closed for every evidence, promotion, verification, and notification field", async () => {
  const { audit, source } = await changedAudit();
  const mutations = [
    ["claim_evidence_allowed", true, "claim-evidence boundary"],
    ["claim_evidence_delta", 1, "claim-evidence boundary"],
    ["automatic_promotion", true, "automatic promotion"],
    ["queue_state", "ready", "pending human queue"],
    ["primary_verified", true, "primary-unverified"],
    ["primary_verification_required", false, "require primary verification"],
    ["requires_primary_verification", false, "require primary verification"],
    ["manual_review_only", false, "manual-review-only"],
    ["notification_eligible", true, "enabled notification"],
  ];
  for (const [field, value, message] of mutations) {
    const mutated = structuredClone(audit);
    mutated.human_review_queue[0][field] = value;
    const result = verifyTechDiscoveryProbe(mutated, [source]);
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.some((error) => error.includes(message)), `${field}: ${result.errors.join("; ")}`);
  }

  const missingExplicitNegative = structuredClone(audit);
  delete missingExplicitNegative.human_review_queue[0].primary_verified;
  const missingResult = verifyTechDiscoveryProbe(missingExplicitNegative, [source]);
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.some((error) => error.includes("primary-unverified")));
});

test("daily current-window review fails closed on evidence, promotion, notification, or unverifiable source records", async () => {
  const root = await mkdtemp(join(tmpdir(), "tech-discovery-daily-verifier-"));
  const source = structuredClone(techDiscoverySources.find((candidate) => candidate.id === "hacker-news-topstories"));
  source.limits = { ...source.limits, max_items: 1, request_budget: 2, max_bytes: 20_000 };
  const item = {
    id: 442001,
    type: "story",
    time: Date.parse("2026-07-16T14:46:05Z") / 1000,
    score: 1691,
    descendants: 992,
    title: "Kimi K3: Open Frontier Intelligence",
    url: "https://www.kimi.com/blog/kimi-k3",
  };
  const audit = await runTechDiscoveryProbe({
    sources: [source],
    outputPath: join(root, "audit.json"),
    statePath: join(root, "audit.json"),
    reviewPath: join(root, "review.md"),
    cacheDir: join(root, "cache"),
    candidateAuditPath: join(root, "candidate-audit.json"),
    fetchImpl: async (url) => response(String(url).endsWith("topstories.json") ? JSON.stringify([item.id]) : JSON.stringify(item)),
    now: new Date("2026-07-17T10:00:00Z"),
  });
  assert.ok(audit.daily_current_window_review.length > 0);
  const mutations = [
    ["claim_evidence_allowed", true, "discovery-only evidence boundary"],
    ["claim_evidence_delta", 1, "discovery-only evidence boundary"],
    ["automatic_promotion", true, "manual-only review"],
    ["manual_review_only", false, "manual-only review"],
    ["primary_verified", true, "unverified primary bridge"],
    ["notification_eligible", true, "discovery-only evidence boundary"],
  ];
  for (const [field, value, message] of mutations) {
    const mutated = structuredClone(audit);
    mutated.daily_current_window_review[0][field] = value;
    const result = verifyTechDiscoveryProbe(mutated, [source]);
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.some((error) => error.includes(message)), `${field}: ${result.errors.join("; ")}`);
  }

  const inventedSource = structuredClone(audit);
  inventedSource.daily_current_window_review[0].source_records[0].source_story_key = "not-in-current-window";
  const inventedResult = verifyTechDiscoveryProbe(inventedSource, [source]);
  assert.equal(inventedResult.ok, false);
  assert.ok(inventedResult.errors.some((error) => error.includes("non-current source record")));
});

test("daily editorial exclusion audit fails closed on a fabricated reason or notification path", async () => {
  const root = await mkdtemp(join(tmpdir(), "tech-discovery-exclusion-verifier-"));
  const source = githubSource();
  const audit = await runTechDiscoveryProbe({
    sources: [source],
    outputPath: join(root, "audit.json"),
    statePath: join(root, "audit.json"),
    reviewPath: join(root, "review.md"),
    cacheDir: join(root, "cache"),
    candidateAuditPath: join(root, "candidate-audit.json"),
    fetchImpl: async () => response(`<article class="Box-row"><h2><a href="/acme/agent-core">acme/agent-core</a></h2><p>AI agent harness runtime</p><span>900 stars today</span></article>`),
    now: new Date("2026-07-17T10:00:00Z"),
  });
  assert.equal(audit.daily_current_window_review.length, 0);
  assert.equal(audit.daily_editorial_exclusions.length, 1);
  assert.equal(audit.daily_editorial_exclusions[0].exclusion_reason, "single-source-bare-repository");
  assert.deepEqual(verifyTechDiscoveryProbe(audit, [source]), { ok: true, errors: [] });

  const fabricated = structuredClone(audit);
  fabricated.daily_editorial_exclusions[0].exclusion_reason = "approved";
  fabricated.daily_editorial_exclusions[0].notification_eligible = true;
  const result = verifyTechDiscoveryProbe(fabricated, [source]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("exclusion reason mismatch")));
  assert.ok(result.errors.some((error) => error.includes("discovery-only boundary")));
});

test("scheduler gate runs verifier only after runner success and propagates either failure", () => {
  const invocations = [];
  const noCommit = () => {};
  const spawnImpl = (command, args, options) => {
    invocations.push({ command, args, options });
    return { status: invocations.length === 1 ? 17 : 0, error: undefined, signal: null };
  };
  assert.equal(runAndVerifyTechDiscoveryProbe({ spawnImpl, nodePath: "/node", environment: {}, promoteImpl: noCommit }), 17);
  assert.equal(invocations.length, 1);
  assert.equal(basename(invocations[0].args[0]), "run-tech-discovery-probe.mjs");
  assert.equal(invocations[0].options.shell, false);

  invocations.length = 0;
  const verifierFailure = (command, args, options) => {
    invocations.push({ command, args, options });
    return { status: invocations.length === 1 ? 0 : 23, error: undefined, signal: null };
  };
  assert.equal(runAndVerifyTechDiscoveryProbe({ spawnImpl: verifierFailure, nodePath: "/node", environment: {}, promoteImpl: noCommit }), 23);
  assert.equal(invocations.length, 2);
  assert.equal(basename(invocations[1].args[0]), "verify-tech-discovery-probe.mjs");
  assert.match(invocations[1].args[1], /\.audit\.json\.audit\..+\.pending$/);
  assert.equal(invocations[0].options.env.TECH_DISCOVERY_DEFER_STATE_COMMIT, "1");
  assert.equal(invocations[0].options.env.TECH_DISCOVERY_STATE_PATH, resolve(WEBSITE_DIR, "work/tech-discovery-probe/audit.json"));

  invocations.length = 0;
  const success = (command, args, options) => {
    invocations.push({ command, args, options });
    return { status: 0, error: undefined, signal: null };
  };
  let promoted = null;
  assert.equal(runAndVerifyTechDiscoveryProbe({
    spawnImpl: success,
    nodePath: "/node",
    environment: { TECH_DISCOVERY_OUTPUT_PATH: "/tmp/audit.json" },
    promoteImpl: (paths) => { promoted = paths; },
  }), 0);
  assert.equal(invocations[1].args[1], promoted.stagedAuditPath);
  assert.equal(promoted.finalOutputPath, "/tmp/audit.json");
});

test("two-phase promotion commits state last and verifier failure preserves the previous state", async () => {
  const root = await mkdtemp(join(tmpdir(), "tech-discovery-gate-"));
  const finalStatePath = join(root, "audit.json");
  const finalReviewPath = join(root, "review.md");
  const stagedAuditPath = join(root, ".audit.pending");
  const stagedReviewPath = join(root, ".review.pending");
  await writeFile(finalStatePath, "old-state\n");
  await writeFile(finalReviewPath, "old-review\n");
  await writeFile(stagedAuditPath, "new-state\n");
  await writeFile(stagedReviewPath, "new-review\n");

  const commitOrder = [];
  promoteStagedTechDiscovery({
    stagedAuditPath,
    stagedReviewPath,
    finalOutputPath: finalStatePath,
    finalStatePath,
    finalReviewPath,
    atomicWriteImpl: (path, content) => {
      commitOrder.push(path);
      writeFileSync(path, content);
    },
  });
  assert.deepEqual(commitOrder, [finalReviewPath, finalStatePath]);
  assert.equal(await readFile(finalStatePath, "utf8"), "new-state\n");
  assert.equal(await readFile(finalReviewPath, "utf8"), "new-review\n");

  await writeFile(finalStatePath, "valid-old-state\n");
  const failedInvocations = [];
  const verifierFailure = (_command, _args, options) => {
    failedInvocations.push(options.env);
    if (failedInvocations.length === 1) {
      writeFileSync(options.env.TECH_DISCOVERY_OUTPUT_PATH, "invalid-new-state\n");
      writeFileSync(options.env.TECH_DISCOVERY_REVIEW_PATH, "invalid-new-review\n");
      return { status: 0 };
    }
    return { status: 9 };
  };
  assert.equal(runAndVerifyTechDiscoveryProbe({
    spawnImpl: verifierFailure,
    nodePath: "/node",
    cwd: root,
    environment: {
      TECH_DISCOVERY_OUTPUT_PATH: finalStatePath,
      TECH_DISCOVERY_STATE_PATH: finalStatePath,
      TECH_DISCOVERY_REVIEW_PATH: finalReviewPath,
    },
  }), 9);
  assert.equal(await readFile(finalStatePath, "utf8"), "valid-old-state\n");
});

test("LaunchAgent ProgramArguments point at the no-shell runner-verifier gate", () => {
  const output = execFileSync("python3", [
    resolve(ROOT_DIR, "scripts/install_tech_discovery_launchd.py"),
    "--dry-run",
    "--hour", "8",
    "--minute", "30",
  ], { cwd: ROOT_DIR, encoding: "utf8" });
  assert.match(output, /run-and-verify-tech-discovery-probe\.mjs/);
  assert.doesNotMatch(output, /<string>[^<]*run-tech-discovery-probe\.mjs<\/string>/);
});
