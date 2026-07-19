#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runAndVerifyReport } from "./verified-report-gate.mjs";

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(AUTOMATION_DIR, "..");

export function runAndVerifySemanticReview(options = {}) {
  return runAndVerifyReport({
    name: "semantic-review",
    runnerPath: resolve(AUTOMATION_DIR, "run-semantic-review-dossiers.mjs"),
    verifierPath: resolve(AUTOMATION_DIR, "verify-semantic-review-dossiers.mjs"),
    outputEnvironmentKey: "SEMANTIC_REVIEW_OUTPUT_PATH",
    reviewEnvironmentKey: "SEMANTIC_REVIEW_MARKDOWN_PATH",
    defaultOutputPath: "work/semantic-review-dossiers/dossier.json",
    defaultReviewPath: "work/semantic-review-dossiers/dossier.md",
    cwd: WEBSITE_DIR,
    ...options,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runAndVerifySemanticReview();
