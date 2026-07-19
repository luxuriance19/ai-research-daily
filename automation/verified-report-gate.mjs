import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

function exitCode(result, stage) {
  if (result.error) {
    console.error(`${stage} failed to start: ${result.error.message}`);
    return 1;
  }
  if (Number.isInteger(result.status)) return result.status;
  console.error(`${stage} terminated without an exit code${result.signal ? ` (${result.signal})` : ""}`);
  return 1;
}

export function promoteVerifiedReport({
  stagedOutputPath,
  stagedReviewPath,
  finalOutputPath,
  finalReviewPath,
  readFileImpl = readFileSync,
  atomicWriteImpl = atomicWriteSync,
  unlinkImpl = unlinkSync,
}) {
  if (finalOutputPath === finalReviewPath) throw new Error("report output and review paths must be distinct");
  const output = readFileImpl(stagedOutputPath);
  const review = readFileImpl(stagedReviewPath);
  try {
    atomicWriteImpl(finalReviewPath, review);
    atomicWriteImpl(finalOutputPath, output);
  } finally {
    cleanup([stagedOutputPath, stagedReviewPath], unlinkImpl);
  }
}

export function runAndVerifyReport({
  name,
  runnerPath,
  verifierPath,
  outputEnvironmentKey,
  reviewEnvironmentKey,
  defaultOutputPath,
  defaultReviewPath,
  spawnImpl = spawnSync,
  nodePath = process.execPath,
  cwd,
  environment = process.env,
  promoteImpl = promoteVerifiedReport,
  unlinkImpl = unlinkSync,
}) {
  const finalOutputPath = resolve(cwd, environment[outputEnvironmentKey] || defaultOutputPath);
  const finalReviewPath = resolve(cwd, environment[reviewEnvironmentKey] || defaultReviewPath);
  if (finalOutputPath === finalReviewPath) {
    console.error(`${name} gate requires distinct report and review paths`);
    return 1;
  }
  const stagedOutputPath = pendingPath(finalOutputPath, "report");
  const stagedReviewPath = pendingPath(finalReviewPath, "review");
  const stagedPaths = [stagedOutputPath, stagedReviewPath];
  const childEnvironment = {
    ...environment,
    [outputEnvironmentKey]: stagedOutputPath,
    [reviewEnvironmentKey]: stagedReviewPath,
  };
  const options = { cwd, env: childEnvironment, stdio: "inherit", shell: false };
  const runnerCode = exitCode(spawnImpl(nodePath, [runnerPath], options), `${name} runner`);
  if (runnerCode !== 0) {
    cleanup(stagedPaths, unlinkImpl);
    return runnerCode;
  }
  const verifierCode = exitCode(spawnImpl(nodePath, [verifierPath, stagedOutputPath], options), `${name} verifier`);
  if (verifierCode !== 0) {
    cleanup(stagedPaths, unlinkImpl);
    return verifierCode;
  }
  try {
    promoteImpl({
      stagedOutputPath,
      stagedReviewPath,
      finalOutputPath,
      finalReviewPath,
      unlinkImpl,
    });
    return 0;
  } catch (error) {
    cleanup(stagedPaths, unlinkImpl);
    console.error(`${name} commit failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
