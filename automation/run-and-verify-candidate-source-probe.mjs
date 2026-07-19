#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(AUTOMATION_DIR, "..");
const RUNNER_PATH = resolve(AUTOMATION_DIR, "run-candidate-source-probe.mjs");
const VERIFIER_PATH = resolve(AUTOMATION_DIR, "verify-candidate-source-probe.mjs");

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

export function promoteStagedCandidateProbe({
  stagedAuditPath,
  stagedReviewPath,
  finalOutputPath,
  finalStatePath,
  finalReviewPath,
  readFileImpl = readFileSync,
  atomicWriteImpl = atomicWriteSync,
  unlinkImpl = unlinkSync,
}) {
  if (finalReviewPath === finalStatePath || finalReviewPath === finalOutputPath) {
    throw new Error("candidate review path must be distinct from audit output and state paths");
  }
  const audit = readFileImpl(stagedAuditPath);
  const review = readFileImpl(stagedReviewPath);
  try {
    // Commit persistent history last. A report-only partial failure can be
    // replayed, but it cannot advance the seven-day source history.
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

export function runAndVerifyCandidateSourceProbe({
  spawnImpl = spawnSync,
  nodePath = process.execPath,
  cwd = WEBSITE_DIR,
  environment = process.env,
  promoteImpl = promoteStagedCandidateProbe,
  unlinkImpl = unlinkSync,
} = {}) {
  const finalOutputPath = resolve(cwd, environment.CANDIDATE_PROBE_OUTPUT_PATH || "work/candidate-source-probe/audit.json");
  const finalStatePath = resolve(cwd, environment.CANDIDATE_PROBE_STATE_PATH || "work/candidate-source-probe/audit.json");
  const finalReviewPath = resolve(cwd, environment.CANDIDATE_PROBE_REVIEW_PATH || "work/candidate-source-probe/review.md");
  if (finalReviewPath === finalStatePath || finalReviewPath === finalOutputPath) {
    console.error("candidate-source gate requires a review path distinct from audit output and state paths");
    return 1;
  }
  const stagedAuditPath = pendingPath(finalOutputPath, "audit");
  const stagedReviewPath = pendingPath(finalReviewPath, "review");
  const stagedPaths = [stagedAuditPath, stagedReviewPath];
  const childEnvironment = {
    ...environment,
    CANDIDATE_PROBE_OUTPUT_PATH: stagedAuditPath,
    CANDIDATE_PROBE_STATE_PATH: finalStatePath,
    CANDIDATE_PROBE_REVIEW_PATH: stagedReviewPath,
  };
  const commonOptions = {
    cwd,
    env: childEnvironment,
    stdio: "inherit",
    shell: false,
  };

  const runner = spawnImpl(nodePath, [RUNNER_PATH], commonOptions);
  const runnerCode = exitCode(runner, "candidate-source runner");
  if (runnerCode !== 0) {
    cleanup(stagedPaths, unlinkImpl);
    return runnerCode;
  }

  const verifier = spawnImpl(nodePath, [VERIFIER_PATH, stagedAuditPath], commonOptions);
  const verifierCode = exitCode(verifier, "candidate-source verifier");
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
    console.error(`candidate-source commit failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runAndVerifyCandidateSourceProbe();
}
