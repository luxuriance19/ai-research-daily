#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(AUTOMATION_DIR, "..");
const RUNNER_PATH = resolve(AUTOMATION_DIR, "run-tech-discovery-probe.mjs");
const VERIFIER_PATH = resolve(AUTOMATION_DIR, "verify-tech-discovery-probe.mjs");

function pendingPath(finalPath, label) {
  return join(dirname(finalPath), `.${basename(finalPath)}.${label}.${process.pid}.${randomUUID()}.pending`);
}

function atomicWriteSync(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { flag: "wx" });
    renameSync(temporaryPath, path);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function cleanup(paths, unlinkImpl = unlinkSync) {
  for (const path of paths) {
    try { unlinkImpl(path); } catch {}
  }
}

export function promoteStagedTechDiscovery({
  stagedAuditPath,
  stagedReviewPath,
  finalOutputPath,
  finalStatePath,
  finalReviewPath,
  readFileImpl = readFileSync,
  atomicWriteImpl = atomicWriteSync,
  unlinkImpl = unlinkSync,
}) {
  const audit = readFileImpl(stagedAuditPath);
  const review = readFileImpl(stagedReviewPath);
  try {
    // State is committed last. A report-only partial failure may duplicate work,
    // but can never advance seen_story_keys and permanently hide a candidate.
    atomicWriteImpl(finalReviewPath, review);
    for (const outputPath of new Set([finalOutputPath])) {
      if (outputPath !== finalStatePath) atomicWriteImpl(outputPath, audit);
    }
    atomicWriteImpl(finalStatePath, audit);
  } finally {
    cleanup([stagedAuditPath, stagedReviewPath], unlinkImpl);
  }
}

function exitCode(result, stage) {
  if (result.error) {
    console.error(`${stage} failed to start: ${result.error.message}`);
    return 1;
  }
  if (Number.isInteger(result.status)) return result.status;
  console.error(`${stage} terminated without an exit code${result.signal ? ` (${result.signal})` : ""}`);
  return 1;
}

export function runAndVerifyTechDiscoveryProbe({
  spawnImpl = spawnSync,
  nodePath = process.execPath,
  cwd = WEBSITE_DIR,
  environment = process.env,
  promoteImpl = promoteStagedTechDiscovery,
  unlinkImpl = unlinkSync,
} = {}) {
  const finalOutputPath = resolve(cwd, environment.TECH_DISCOVERY_OUTPUT_PATH || "work/tech-discovery-probe/audit.json");
  const finalStatePath = resolve(cwd, environment.TECH_DISCOVERY_STATE_PATH || "work/tech-discovery-probe/audit.json");
  const finalReviewPath = resolve(cwd, environment.TECH_DISCOVERY_REVIEW_PATH || "work/tech-discovery-probe/review.md");
  const stagedAuditPath = pendingPath(finalOutputPath, "audit");
  const stagedReviewPath = pendingPath(finalReviewPath, "review");
  const stagedPaths = [stagedAuditPath, stagedReviewPath];
  const childEnvironment = {
    ...environment,
    TECH_DISCOVERY_OUTPUT_PATH: stagedAuditPath,
    TECH_DISCOVERY_STATE_PATH: finalStatePath,
    TECH_DISCOVERY_REVIEW_PATH: stagedReviewPath,
    TECH_DISCOVERY_DEFER_STATE_COMMIT: "1",
  };
  const commonOptions = {
    cwd,
    env: childEnvironment,
    stdio: "inherit",
    shell: false,
  };
  const runner = spawnImpl(nodePath, [RUNNER_PATH], commonOptions);
  const runnerCode = exitCode(runner, "tech-discovery runner");
  if (runnerCode !== 0) {
    cleanup(stagedPaths, unlinkImpl);
    return runnerCode;
  }

  const verifier = spawnImpl(nodePath, [VERIFIER_PATH, stagedAuditPath], commonOptions);
  const verifierCode = exitCode(verifier, "tech-discovery verifier");
  if (verifierCode !== 0) {
    cleanup(stagedPaths, unlinkImpl);
    return verifierCode;
  }
  try {
    promoteImpl({
      stagedAuditPath,
      stagedReviewPath,
      finalOutputPath,
      finalStatePath,
      finalReviewPath,
      unlinkImpl,
    });
    return 0;
  } catch (error) {
    cleanup(stagedPaths, unlinkImpl);
    console.error(`tech-discovery commit failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runAndVerifyTechDiscoveryProbe();
}
