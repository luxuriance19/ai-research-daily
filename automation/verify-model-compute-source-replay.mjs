#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  buildModelComputePolicyReplay,
  MODEL_COMPUTE_REPLAY_FIXTURES,
  MODEL_COMPUTE_REPLAY_POLICY,
} from "./replay-model-compute-source-policy.mjs";

const array = (value) => Array.isArray(value) ? value : [];

export function verifyModelComputeSourceReplay(audit, fixtures = MODEL_COMPUTE_REPLAY_FIXTURES) {
  const errors = [];
  let expected;
  try {
    expected = buildModelComputePolicyReplay(fixtures);
  } catch (error) {
    return { ok: false, errors: [`failed-to-recompute-replay: ${error.message}`] };
  }
  if (!isDeepStrictEqual(audit, expected)) errors.push("audit-does-not-match-deterministic-replay");
  if (audit?.mode !== MODEL_COMPUTE_REPLAY_POLICY.mode) errors.push("unexpected-replay-mode");
  if (!isDeepStrictEqual(audit?.policy, MODEL_COMPUTE_REPLAY_POLICY)) errors.push("policy-does-not-match-encoded-contract");
  if (audit?.registry?.source_count !== 16 || audit?.registry?.new_model_sources !== 9 || audit?.registry?.compute_system_sources !== 7) errors.push("registry-source-count-contract-violated");
  if (audit?.registry?.production_registry_changed !== false) errors.push("production-registry-boundary-violated");
  for (const [name, value] of Object.entries(audit?.acceptance || {})) {
    if (name !== "k3_attention_groups" && value !== true) errors.push(`acceptance-check-failed: ${name}`);
  }
  if (!isDeepStrictEqual(audit?.acceptance?.k3_attention_groups, ["hacker-news", "latent-space", "simon-willison"])) errors.push("k3-independent-attention-groups-incorrect");
  for (const story of array(audit?.model_stories)) {
    if (story?.manual_review_only !== true) errors.push(`model-story-escaped-human-review: ${story?.model_family}`);
    if (story?.claim_evidence_allowed !== false || story?.availability_promotion_allowed !== false || story?.notification_eligible !== false) errors.push(`model-story-crossed-safety-boundary: ${story?.model_family}`);
  }
  for (const release of array(audit?.compute_cases)) {
    if (release?.expectation_met !== true) errors.push(`compute-expectation-failed: ${release?.id}`);
    if (release?.manual_review_only !== true || release?.claim_evidence_allowed !== false || release?.notification_eligible !== false) errors.push(`compute-case-crossed-safety-boundary: ${release?.id}`);
  }
  if (audit?.notification_policy?.enabled !== false || audit?.notification_policy?.eligible_records !== 0) errors.push("notification-boundary-violated");
  if (!isDeepStrictEqual(audit?.external_actions, [])) errors.push("external-actions-must-remain-empty");
  return { ok: errors.length === 0, errors };
}

async function main() {
  const auditPath = resolve(process.argv[2] || process.env.MODEL_COMPUTE_REPLAY_OUTPUT_PATH || "work/model-compute-source-replay/audit.json");
  const audit = JSON.parse(await readFile(auditPath, "utf8"));
  const result = verifyModelComputeSourceReplay(audit);
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("model/compute source replay verified\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
