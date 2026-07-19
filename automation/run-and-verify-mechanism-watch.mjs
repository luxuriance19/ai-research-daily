#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(AUTOMATION_DIR, "..");
const RUNNER_PATH = resolve(AUTOMATION_DIR, "run-mechanism-watch.mjs");
const VERIFIER_PATH = resolve(AUTOMATION_DIR, "verify-mechanism-audit.mjs");

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

export function promoteStagedMechanismWatch({
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
    throw new Error("mechanism review path must be distinct from audit output and state paths");
  }
  const audit = readFileImpl(stagedAuditPath);
  const review = readFileImpl(stagedReviewPath);
  try {
    atomicWriteImpl(finalReviewPath, review);
    if (finalOutputPath !== finalStatePath) atomicWriteImpl(finalOutputPath, audit);
    // Persistent identity history advances only after the staged report verifies.
    atomicWriteImpl(finalStatePath, audit);
  } finally {
    cleanup([stagedAuditPath, stagedReviewPath], unlinkImpl);
  }
}

function exitCode(result, stage) {
  if (result.error) {
    process.stderr.write(`${stage} failed to start: ${result.error.message}\n`);
    return 1;
  }
  if (Number.isInteger(result.status)) return result.status;
  process.stderr.write(`${stage} terminated without an exit code${result.signal ? ` (${result.signal})` : ""}\n`);
  return 1;
}

export function runAndVerifyMechanismWatch({
  spawnImpl = spawnSync,
  nodePath = process.execPath,
  cwd = WEBSITE_DIR,
  environment = process.env,
  promoteImpl = promoteStagedMechanismWatch,
  unlinkImpl = unlinkSync,
} = {}) {
  const finalOutputPath = resolve(cwd, environment.OUTPUT_PATH || "work/mechanism-watch/audit.json");
  const finalStatePath = resolve(cwd, environment.STATE_PATH || "work/mechanism-watch/audit.json");
  const finalReviewPath = resolve(cwd, environment.REVIEW_PATH || "work/mechanism-watch/review.md");
  if (finalReviewPath === finalStatePath || finalReviewPath === finalOutputPath) return 1;

  const stagedAuditPath = pendingPath(finalOutputPath, "audit");
  const stagedReviewPath = pendingPath(finalReviewPath, "review");
  const stagedPaths = [stagedAuditPath, stagedReviewPath];
  const childEnvironment = {
    ...environment,
    OUTPUT_PATH: stagedAuditPath,
    STATE_PATH: finalStatePath,
    REVIEW_PATH: stagedReviewPath,
  };
  const options = { cwd, env: childEnvironment, stdio: "inherit", shell: false };

  const runnerCode = exitCode(spawnImpl(nodePath, [RUNNER_PATH], options), "mechanism runner");
  if (runnerCode !== 0) {
    cleanup(stagedPaths, unlinkImpl);
    return runnerCode;
  }
  const verifierCode = exitCode(spawnImpl(nodePath, [VERIFIER_PATH, stagedAuditPath], options), "mechanism verifier");
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
    process.stderr.write(`mechanism commit failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runAndVerifyMechanismWatch();
}
