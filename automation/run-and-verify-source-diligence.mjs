#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runAndVerifyReport } from "./verified-report-gate.mjs";

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(AUTOMATION_DIR, "..");

export function runAndVerifySourceDiligence(options = {}) {
  return runAndVerifyReport({
    name: "source-diligence",
    runnerPath: resolve(AUTOMATION_DIR, "run-source-diligence.mjs"),
    verifierPath: resolve(AUTOMATION_DIR, "verify-source-diligence.mjs"),
    outputEnvironmentKey: "SOURCE_DILIGENCE_OUTPUT_PATH",
    reviewEnvironmentKey: "SOURCE_DILIGENCE_REVIEW_PATH",
    defaultOutputPath: "work/source-diligence/coverage.json",
    defaultReviewPath: "work/source-diligence/coverage.md",
    cwd: WEBSITE_DIR,
    ...options,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runAndVerifySourceDiligence();
