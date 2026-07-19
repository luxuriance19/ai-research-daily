#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(AUTOMATION_DIR, "..");
const RUNNER_PATH = resolve(AUTOMATION_DIR, "run-model-compute-source-probe.mjs");
const VERIFIER_PATH = resolve(AUTOMATION_DIR, "verify-model-compute-source-probe.mjs");

function pendingPath(finalPath, label) {
  return join(dirname(finalPath), `.${basename(finalPath)}.${label}.${process.pid}.${randomUUID()}.pending`);
}

function atomicWriteSync(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function cleanup(paths, unlinkImpl = unlinkSync) {
  for (const path of paths) {
    try { unlinkImpl(path); } catch {}
  }
}

export function promoteStagedModelComputeProbe({
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
    atomicWriteImpl(finalReviewPath, review);
    if (finalOutputPath !== finalStatePath) atomicWriteImpl(finalOutputPath, audit);
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

export function runAndVerifyModelComputeSourceProbe({
  spawnImpl = spawnSync,
  nodePath = process.execPath,
  cwd = WEBSITE_DIR,
  environment = process.env,
  promoteImpl = promoteStagedModelComputeProbe,
  unlinkImpl = unlinkSync,
} = {}) {
  const finalOutputPath = resolve(cwd, environment.MODEL_COMPUTE_PROBE_OUTPUT_PATH || "work/model-compute-source-probe/audit.json");
  const finalStatePath = resolve(cwd, environment.MODEL_COMPUTE_PROBE_STATE_PATH || "work/model-compute-source-probe/audit.json");
  const finalReviewPath = resolve(cwd, environment.MODEL_COMPUTE_PROBE_REVIEW_PATH || "work/model-compute-source-probe/review.md");
  const stagedAuditPath = pendingPath(finalOutputPath, "audit");
  const stagedReviewPath = pendingPath(finalReviewPath, "review");
  const childEnvironment = {
    ...environment,
    MODEL_COMPUTE_PROBE_OUTPUT_PATH: stagedAuditPath,
    MODEL_COMPUTE_PROBE_STATE_PATH: finalStatePath,
    MODEL_COMPUTE_PROBE_REVIEW_PATH: stagedReviewPath,
    MODEL_COMPUTE_PROBE_DEFER_STATE_COMMIT: "1",
  };
  const options = { cwd, env: childEnvironment, stdio: "inherit", shell: false };
  const runner = spawnImpl(nodePath, [RUNNER_PATH], options);
  const runnerCode = exitCode(runner, "model/compute runner");
  if (runnerCode !== 0) {
    cleanup([stagedAuditPath, stagedReviewPath], unlinkImpl);
    return runnerCode;
  }
  const verifier = spawnImpl(nodePath, [VERIFIER_PATH, stagedAuditPath], options);
  const verifierCode = exitCode(verifier, "model/compute verifier");
  if (verifierCode !== 0) {
    cleanup([stagedAuditPath, stagedReviewPath], unlinkImpl);
    return verifierCode;
  }
  try {
    promoteImpl({ stagedAuditPath, stagedReviewPath, finalOutputPath, finalStatePath, finalReviewPath, unlinkImpl });
    return 0;
  } catch (error) {
    cleanup([stagedAuditPath, stagedReviewPath], unlinkImpl);
    console.error(`model/compute commit failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runAndVerifyModelComputeSourceProbe();
