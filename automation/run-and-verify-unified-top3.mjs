#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(AUTOMATION_DIR, "..");
const RUNNER_PATH = resolve(AUTOMATION_DIR, "unified-top3-replay.mjs");
const VERIFIER_PATH = resolve(AUTOMATION_DIR, "verify-unified-top3-replay.mjs");

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

export function promoteStagedUnifiedTop3({
  stagedAuditPath,
  stagedReviewPath,
  finalAuditPath,
  finalReviewPath,
  readFileImpl = readFileSync,
  atomicWriteImpl = atomicWriteSync,
  unlinkImpl = unlinkSync,
}) {
  const audit = readFileImpl(stagedAuditPath);
  const review = readFileImpl(stagedReviewPath);
  try {
    atomicWriteImpl(finalReviewPath, review);
    atomicWriteImpl(finalAuditPath, audit);
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

export function runAndVerifyUnifiedTop3({
  spawnImpl = spawnSync,
  nodePath = process.execPath,
  cwd = WEBSITE_DIR,
  environment = process.env,
  promoteImpl = promoteStagedUnifiedTop3,
  unlinkImpl = unlinkSync,
} = {}) {
  const finalAuditPath = resolve(cwd, environment.UNIFIED_TOP3_OUTPUT_PATH || "work/unified-top3-replay/audit.json");
  const finalReviewPath = resolve(cwd, environment.UNIFIED_TOP3_REVIEW_PATH || "work/unified-top3-replay/review.md");
  const stagedAuditPath = pendingPath(finalAuditPath, "audit");
  const stagedReviewPath = pendingPath(finalReviewPath, "review");
  const stagedPaths = [stagedAuditPath, stagedReviewPath];
  const childEnvironment = {
    ...environment,
    UNIFIED_TOP3_OUTPUT_PATH: stagedAuditPath,
    UNIFIED_TOP3_REVIEW_PATH: stagedReviewPath,
  };
  const options = { cwd, env: childEnvironment, stdio: "inherit", shell: false };
  const runnerCode = exitCode(spawnImpl(nodePath, [RUNNER_PATH], options), "unified Top 3 runner");
  if (runnerCode !== 0) {
    cleanup(stagedPaths, unlinkImpl);
    return runnerCode;
  }
  const verifierCode = exitCode(spawnImpl(nodePath, [VERIFIER_PATH, stagedAuditPath], options), "unified Top 3 verifier");
  if (verifierCode !== 0) {
    cleanup(stagedPaths, unlinkImpl);
    return verifierCode;
  }
  try {
    promoteImpl({ stagedAuditPath, stagedReviewPath, finalAuditPath, finalReviewPath, unlinkImpl });
    return 0;
  } catch (error) {
    cleanup(stagedPaths, unlinkImpl);
    process.stderr.write(`unified Top 3 commit failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runAndVerifyUnifiedTop3();
}
