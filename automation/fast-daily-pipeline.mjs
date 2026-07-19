#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mechanismSources } from "./mechanism-source-registry.mjs";
import { modelComputeShadowSources } from "./model-compute-source-registry.mjs";
import { techDiscoverySources } from "./tech-discovery-registry.mjs";

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(AUTOMATION_DIR, "..");
const GENERIC_CHILD_OUTPUT_KEYS = Object.freeze(["OUTPUT_PATH", "STATE_PATH", "REVIEW_PATH", "CACHE_DIR"]);

export const FAST_DAILY_POLICY = Object.freeze({
  discovery_source_count: 48,
  discovery_window_hours: 48,
  maximum_selected_stories: 3,
  standard_score_threshold: 6,
  deep_evidence_after_selection_only: true,
  notification_enabled: false,
  publishing_requires_verified_dossier: true,
});

export function createFastDailyPlan() {
  const discoveryCount = mechanismSources.length + techDiscoverySources.length + modelComputeShadowSources.length;
  if (discoveryCount !== FAST_DAILY_POLICY.discovery_source_count) {
    throw new Error(`fast-daily discovery registry drift: expected 48, received ${discoveryCount}`);
  }
  return {
    supplement: {
      id: "community-supplement",
      optional: true,
      commands: [[process.execPath, ["automation/run-daily.mjs"]]],
    },
    discovery: [
      {
        id: "mechanism-lane",
        endpoints: mechanismSources.length,
        snapshot: "work/mechanism-watch/audit.json",
        commands: [[process.execPath, ["automation/run-and-verify-mechanism-watch.mjs"]]],
      },
      {
        id: "technology-lane",
        endpoints: techDiscoverySources.length,
        snapshot: "work/tech-discovery-probe/audit.json",
        commands: [["npm", ["run", "gate:tech-discovery"]]],
      },
      {
        id: "model-compute-lane",
        endpoints: modelComputeShadowSources.length,
        snapshot: "work/model-compute-source-probe/audit.json",
        commands: [["npm", ["run", "gate:model-compute-sources"]]],
      },
    ],
    afterDiscovery: [
      { id: "select-top3", commands: [["npm", ["run", "gate:unified-top3"]]] },
      { id: "dossier-top3", commands: [["npm", ["run", "gate:top3-evidence"]]] },
      {
        id: "project-mechanism-radar",
        optional: true,
        fallback: "data/mechanism-radar-latest.json",
        commands: [["npm", ["run", "sync:mechanism-radar-site"]]],
      },
      {
        id: "project-source-quality",
        optional: true,
        fallback: "data/source-quality-latest.json",
        commands: [["npm", ["run", "sync:source-quality-site"]]],
      },
      {
        id: "project-source-role-review",
        optional: true,
        fallback: "data/source-role-review-latest.json",
        commands: [["npm", ["run", "sync:source-role-review"]]],
      },
      { id: "render-formula-assets", commands: [["npm", ["run", "sync:formula-assets"]]] },
      { id: "export-static", commands: [["npm", ["run", "export:static", "--", "data/latest.json", "public-pages"]]] },
      { id: "verify-static", commands: [[process.execPath, ["--test", "tests/static-export.test.mjs"]]] },
    ],
    excludedFromCriticalPath: [
      "gate:source-candidates",
      "gate:source-diligence",
      "gate:semantic-review",
      "gate:source-readiness",
      "scout:evidence-gaps",
    ],
  };
}

function defaultExecutor(command, args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, stdio: "inherit", shell: false });
    child.once("error", (error) => resolvePromise({ code: 1, elapsed_ms: Date.now() - started, error: error.message }));
    child.once("exit", (code, signal) => resolvePromise({
      code: Number.isInteger(code) ? code : 1,
      elapsed_ms: Date.now() - started,
      signal: signal || null,
    }));
  });
}

async function runTask(task, { cwd, env, execute }) {
  const startedAt = new Date().toISOString();
  const commands = [];
  for (const [command, args] of task.commands) {
    const result = await execute(command, args, { cwd, env });
    commands.push({ command, args, ...result });
    if (result.code !== 0) return { id: task.id, status: "failed", started_at: startedAt, commands };
  }
  return { id: task.id, status: "ok", started_at: startedAt, commands };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

async function ensureSupplementFallback(cwd) {
  const latest = resolve(cwd, "data/latest.json");
  if (await exists(latest)) return "reused-previous-snapshot";
  const seed = JSON.parse(await readFile(resolve(cwd, "data/seed.json"), "utf8"));
  seed.warnings = [...(seed.warnings || []), "本次社区论文补充抓取失败，页面暂用内置快照；Top 3 主链不受影响。"];
  await atomicJson(latest, seed);
  return "seed-fallback";
}

export async function runFastDaily({
  cwd = WEBSITE_DIR,
  environment = process.env,
  execute = defaultExecutor,
  reuseDiscovery = false,
  skipSupplement = false,
} = {}) {
  const plan = createFastDailyPlan();
  const pipelineEnvironment = { ...environment };
  // Some legacy collectors use generic output variable names. Never let a
  // parent scheduler's supplement path leak into unrelated collector lanes.
  for (const key of GENERIC_CHILD_OUTPUT_KEYS) delete pipelineEnvironment[key];
  const manifest = {
    schema_version: 1,
    mode: "fast-daily-top3-pipeline",
    started_at: new Date().toISOString(),
    policy: FAST_DAILY_POLICY,
    discovery_registry: {
      mechanism: mechanismSources.length,
      technology: techDiscoverySources.length,
      model_compute: modelComputeShadowSources.length,
      total: FAST_DAILY_POLICY.discovery_source_count,
    },
    excluded_from_critical_path: plan.excludedFromCriticalPath,
    stages: [],
    status: "running",
  };

  if (!skipSupplement) {
    const supplementEnvironment = {
      ...pipelineEnvironment,
      SKIP_INGEST: "1",
      OUTPUT_PATH: "data/latest.json",
    };
    const supplement = await runTask(plan.supplement, { cwd, env: supplementEnvironment, execute });
    if (supplement.status === "failed") supplement.fallback = await ensureSupplementFallback(cwd);
    manifest.stages.push(supplement);
  }

  if (reuseDiscovery) {
    for (const task of plan.discovery) {
      const snapshot = resolve(cwd, task.snapshot);
      if (!(await exists(snapshot))) throw new Error(`cannot reuse missing discovery snapshot: ${task.snapshot}`);
      manifest.stages.push({ id: task.id, status: "reused", endpoints: task.endpoints, snapshot: task.snapshot });
    }
  } else {
    const results = await Promise.all(plan.discovery.map((task) => runTask(task, { cwd, env: pipelineEnvironment, execute })));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const task = plan.discovery[index];
      result.endpoints = task.endpoints;
      result.snapshot = task.snapshot;
      if (result.status === "failed" && await exists(resolve(cwd, task.snapshot))) result.status = "degraded-reused-previous";
      manifest.stages.push(result);
    }
  }

  for (const stage of manifest.stages.filter((item) => item.snapshot)) {
    if (stage.status === "failed") throw new Error(`discovery lane failed without a reusable snapshot: ${stage.id}`);
  }

  for (const task of plan.afterDiscovery) {
    const result = await runTask(task, { cwd, env: pipelineEnvironment, execute });
    if (result.status === "failed" && task.optional && task.fallback && await exists(resolve(cwd, task.fallback))) {
      result.status = "degraded-reused-previous";
      result.fallback = task.fallback;
    }
    manifest.stages.push(result);
    if (result.status !== "ok" && !result.status.startsWith("degraded")) {
      manifest.status = "failed";
      manifest.completed_at = new Date().toISOString();
      await atomicJson(resolve(cwd, "work/fast-daily/run.json"), manifest);
      throw new Error(`fast-daily critical stage failed: ${task.id}`);
    }
  }

  manifest.status = manifest.stages.some((item) => item.status.startsWith("degraded") || item.status === "failed") ? "degraded" : "ok";
  manifest.completed_at = new Date().toISOString();
  await atomicJson(resolve(cwd, "work/fast-daily/run.json"), manifest);
  return manifest;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  const reuseDiscovery = process.argv.includes("--reuse-discovery");
  const skipSupplement = process.argv.includes("--skip-supplement");
  runFastDaily({ reuseDiscovery, skipSupplement }).then((manifest) => {
    process.stdout.write(`fast daily: ${manifest.status}; 48 registered discovery sources -> Top 3 -> verified static site\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
