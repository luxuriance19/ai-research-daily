#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runAndVerifyReport } from "./verified-report-gate.mjs";

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(AUTOMATION_DIR, "..");

export function runAndVerifySourceReadiness(options = {}) {
  return runAndVerifyReport({
    name: "source-readiness",
    runnerPath: resolve(AUTOMATION_DIR, "run-source-promotion-readiness.mjs"),
    verifierPath: resolve(AUTOMATION_DIR, "verify-source-promotion-readiness.mjs"),
    outputEnvironmentKey: "SOURCE_PROMOTION_READINESS_PATH",
    reviewEnvironmentKey: "SOURCE_PROMOTION_READINESS_MARKDOWN_PATH",
    defaultOutputPath: "work/source-promotion-readiness/readiness.json",
    defaultReviewPath: "work/source-promotion-readiness/readiness.md",
    cwd: WEBSITE_DIR,
    ...options,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runAndVerifySourceReadiness();
