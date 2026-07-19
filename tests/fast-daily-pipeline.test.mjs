import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFastDailyPlan, FAST_DAILY_POLICY, runFastDaily } from "../automation/fast-daily-pipeline.mjs";

const WEBSITE_DIR = fileURLToPath(new URL("..", import.meta.url));
const ROOT_DIR = join(WEBSITE_DIR, "..");

async function fixtureWithSnapshots() {
  const root = await mkdtemp(join(tmpdir(), "fast-daily-"));
  for (const path of [
    "work/mechanism-watch/audit.json",
    "work/tech-discovery-probe/audit.json",
    "work/model-compute-source-probe/audit.json",
  ]) {
    const full = join(root, path);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(full, ".."), { recursive: true }));
    await writeFile(full, "{}\n");
  }
  return root;
}

test("fast daily critical path is exactly 48 registered discovery sources then Top 3 evidence", () => {
  const plan = createFastDailyPlan();
  assert.equal(plan.discovery.reduce((total, lane) => total + lane.endpoints, 0), 48);
  assert.deepEqual(plan.discovery.map((lane) => lane.endpoints).sort((a, b) => a - b), [11, 16, 21]);
  assert.equal(FAST_DAILY_POLICY.maximum_selected_stories, 3);
  assert.equal(FAST_DAILY_POLICY.deep_evidence_after_selection_only, true);
  const criticalCommands = JSON.stringify([...plan.discovery, ...plan.afterDiscovery].flatMap((task) => task.commands));
  for (const excluded of plan.excludedFromCriticalPath) assert.doesNotMatch(criticalCommands, new RegExp(excluded.replaceAll(":", "\\:")));
  assert.deepEqual(plan.afterDiscovery.map((task) => task.id), ["select-top3", "dossier-top3", "project-mechanism-radar", "project-source-quality", "project-source-role-review", "render-formula-assets", "export-static", "verify-static"]);
});

test("reuse mode runs no discovery network commands and records an auditable manifest", async () => {
  const cwd = await fixtureWithSnapshots();
  const calls = [];
  const manifest = await runFastDaily({
    cwd,
    reuseDiscovery: true,
    skipSupplement: true,
    execute: async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, elapsed_ms: 1, signal: null };
    },
  });
  assert.equal(manifest.status, "ok");
  assert.equal(calls.length, 8);
  assert.deepEqual(manifest.stages.slice(0, 3).map((stage) => stage.status), ["reused", "reused", "reused"]);
  assert.equal(manifest.stages.at(-1).id, "verify-static");
  const persisted = JSON.parse(await readFile(join(cwd, "work/fast-daily/run.json"), "utf8"));
  assert.equal(persisted.discovery_registry.total, 48);
  assert.equal(persisted.policy.notification_enabled, false);
});

test("a failed discovery refresh may reuse a verified prior snapshot but deep gates remain off-path", async () => {
  const cwd = await fixtureWithSnapshots();
  const calls = [];
  const manifest = await runFastDaily({
    cwd,
    skipSupplement: true,
    execute: async (command, args) => {
      const name = [command, ...args].join(" ");
      calls.push(name);
      return { code: name.includes("run-and-verify-mechanism-watch") ? 9 : 0, elapsed_ms: 1, signal: null };
    },
  });
  assert.equal(manifest.status, "degraded");
  assert.equal(manifest.stages.find((stage) => stage.id === "mechanism-lane").status, "degraded-reused-previous");
  assert.equal(calls.some((call) => /source-candidates|source-diligence|semantic-review|source-readiness/.test(call)), false);
});

test("mechanism radar projection reuses its last audited snapshot instead of blocking the daily", async () => {
  const cwd = await fixtureWithSnapshots();
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(cwd, "data"), { recursive: true }));
  await writeFile(join(cwd, "data/mechanism-radar-latest.json"), "{}\n");
  const calls = [];
  const manifest = await runFastDaily({
    cwd,
    reuseDiscovery: true,
    skipSupplement: true,
    execute: async (command, args) => {
      const name = [command, ...args].join(" ");
      calls.push(name);
      return { code: name.includes("sync:mechanism-radar-site") ? 7 : 0, elapsed_ms: 1, signal: null };
    },
  });
  assert.equal(manifest.status, "degraded");
  const radar = manifest.stages.find((stage) => stage.id === "project-mechanism-radar");
  assert.equal(radar.status, "degraded-reused-previous");
  assert.equal(radar.fallback, "data/mechanism-radar-latest.json");
  assert.equal(calls.some((call) => call.includes("export:static")), true);
  assert.equal(calls.some((call) => call.includes("static-export.test.mjs")), true);
});

test("source quality projection reuses its last verified ledger instead of blocking the daily", async () => {
  const cwd = await fixtureWithSnapshots();
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(cwd, "data"), { recursive: true }));
  await writeFile(join(cwd, "data/source-quality-latest.json"), "{}\n");
  const calls = [];
  const manifest = await runFastDaily({
    cwd,
    reuseDiscovery: true,
    skipSupplement: true,
    execute: async (command, args) => {
      const name = [command, ...args].join(" ");
      calls.push(name);
      return { code: name.includes("sync:source-quality-site") ? 8 : 0, elapsed_ms: 1, signal: null };
    },
  });
  assert.equal(manifest.status, "degraded");
  const scorecard = manifest.stages.find((stage) => stage.id === "project-source-quality");
  assert.equal(scorecard.status, "degraded-reused-previous");
  assert.equal(scorecard.fallback, "data/source-quality-latest.json");
  assert.equal(calls.some((call) => call.includes("export:static")), true);
});

test("scheduler output variables are scoped to the supplement and cannot overwrite collector audits", async () => {
  const cwd = await fixtureWithSnapshots();
  const calls = [];
  await runFastDaily({
    cwd,
    reuseDiscovery: true,
    environment: {
      OUTPUT_PATH: "/wrong/global-output.json",
      STATE_PATH: "/wrong/global-state.json",
      REVIEW_PATH: "/wrong/global-review.md",
      CACHE_DIR: "/wrong/global-cache",
    },
    execute: async (command, args, options) => {
      calls.push({ name: [command, ...args].join(" "), env: options.env });
      return { code: 0, elapsed_ms: 1, signal: null };
    },
  });
  const supplement = calls.find((call) => call.name.includes("run-daily.mjs"));
  assert.equal(supplement.env.OUTPUT_PATH, "data/latest.json");
  for (const call of calls.filter((item) => item !== supplement)) {
    assert.equal("OUTPUT_PATH" in call.env, false, call.name);
    assert.equal("STATE_PATH" in call.env, false, call.name);
    assert.equal("REVIEW_PATH" in call.env, false, call.name);
    assert.equal("CACHE_DIR" in call.env, false, call.name);
  }
});

test("consolidated LaunchAgent invokes only the fast daily entrypoint", () => {
  const output = execFileSync("python3", [
    join(ROOT_DIR, "scripts", "install_fast_daily_launchd.py"),
    "--dry-run",
    "--hour", "7",
    "--minute", "30",
    "--replace-fragmented",
  ], { cwd: ROOT_DIR, encoding: "utf8" });
  assert.match(output, /fast-daily-pipeline\.mjs/);
  assert.match(output, /<key>Hour<\/key>\s*<integer>7<\/integer>/);
  assert.match(output, /<key>Minute<\/key>\s*<integer>30<\/integer>/);
  assert.doesNotMatch(output, /GEMINI|OPENAI_API|CLOUDFLARE|WECHAT|SECRET/i);
  assert.match(output, /would retire with rollback copies/);
  assert.match(output, /com\.user\.ai-research-unified-top3/);
  assert.doesNotMatch(output, /com\.user\.ai-research-source-diligence/);
});

test("manual GitHub workflow verifies the same credential-free fast path", async () => {
  const workflow = await readFile(join(WEBSITE_DIR, ".github/workflows/daily-digest.yml"), "utf8");
  assert.match(workflow, /npm run daily:fast/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /GEMINI|OAI_SITES|SITE_INGEST|OPENAI_API|WECHAT/i);
  assert.doesNotMatch(workflow, /\bsecrets\./i);
});

test("scheduled static workflow preserves the source ledger and dated archives across runs", async () => {
  const workflow = await readFile(join(WEBSITE_DIR, ".github/workflows/publish-static-sites.yml"), "utf8");
  assert.match(workflow, /data\/source-quality-latest\.json/);
  assert.match(workflow, /data\/source-role-review-latest\.json/);
  assert.match(workflow, /data\/source-role-review-latest\.md/);
  assert.match(workflow, /public-pages\/archive/);
  assert.match(workflow, /npm run daily:fast/);
  assert.doesNotMatch(workflow, /GEMINI|OAI_SITES|SITE_INGEST|OPENAI_API|WECHAT/i);
});
