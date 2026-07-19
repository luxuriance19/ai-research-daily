#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { buildUnifiedTop3Replay, UNIFIED_TOP3_POLICY } from "./unified-top3-replay.mjs";

const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");
const array = (value) => Array.isArray(value) ? value : [];

export function verifyUnifiedTop3Replay(audit, mechanismAudit, techAudit, modelComputeAudit = null, inputFingerprints = {}) {
  const errors = [];
  let expected;
  try {
    expected = buildUnifiedTop3Replay({
      mechanismAudit,
      techAudit,
      modelComputeAudit,
      inputFingerprints,
    });
  } catch (error) {
    return { ok: false, errors: [`failed to recompute replay: ${error.message}`] };
  }
  if (!isDeepStrictEqual(audit, expected)) errors.push("audit does not match deterministic replay projection");
  if (audit?.mode !== "offline-unified-top3-replay") errors.push("unexpected replay mode");
  if (!isDeepStrictEqual(audit?.policy, UNIFIED_TOP3_POLICY)) errors.push("policy differs from encoded Top 3 contract");
  if (audit?.notification_policy?.enabled !== false || audit?.notification_policy?.eligible_records !== 0) errors.push("notification boundary violated");
  if (!isDeepStrictEqual(audit?.external_actions, [])) errors.push("external actions must remain empty");
  if (array(audit?.selected_top3).length > 3) errors.push("selected queue exceeds Top 3");
  if (new Set(array(audit?.selected_top3).map((item) => item.primary_section)).size !== array(audit?.selected_top3).length) errors.push("selected queue repeats a primary section");
  if (new Set(array(audit?.eligible_candidates).map((item) => item.canonical_story_identity)).size !== array(audit?.eligible_candidates).length) errors.push("eligible queue repeats a canonical story");
  for (const item of [...array(audit?.selected_top3), ...array(audit?.eligible_candidates)]) {
    const components = item?.score || {};
    const recomputed = Math.round(((components.primary_identity || 0) + (components.technical_delta || 0)
      + (components.artifact || 0) + (components.independent_attention || 0)
      + (components.freshness || 0) + (components.penalty || 0) + Number.EPSILON) * 100) / 100;
    if (components.total !== recomputed) errors.push(`score sum mismatch: ${item?.story_id}`);
    if (item?.manual_review_only !== true || item?.primary_verification_required !== true) errors.push(`item escaped mandatory human review: ${item?.story_id}`);
    if (item?.claim_evidence_allowed !== false || item?.notification_eligible !== false) errors.push(`item crossed evidence/notification boundary: ${item?.story_id}`);
    if (item?.story_id !== item?.canonical_story_identity) errors.push(`story identity is not canonical: ${item?.story_id}`);
    if (!array(item?.source_lanes).length) errors.push(`item has no source-lane provenance: ${item?.story_id}`);
  }
  for (const item of array(audit?.selected_top3)) {
    const primaryTrack = UNIFIED_TOP3_POLICY.mechanism_primary_track;
    const mechanismPrimaryEligible = item?.selection_rule === "mechanism-primary-track"
      && item?.primary_section === "mechanism"
      && item?.score?.total >= primaryTrack.minimum_score
      && item?.score?.primary_identity === primaryTrack.required_primary_identity
      && item?.score?.technical_delta === primaryTrack.required_technical_delta
      && item?.score?.freshness >= primaryTrack.minimum_freshness
      && primaryTrack.allowed_evidence_grades.includes(item?.evidence_grade);
    const standardEligible = item?.selection_rule === "standard-six-point-threshold"
      && item?.score?.total >= UNIFIED_TOP3_POLICY.minimum_score;
    if (!standardEligible && !mechanismPrimaryEligible) errors.push(`selected item has no valid selection rule: ${item?.story_id}`);
  }
  return { ok: errors.length === 0, errors };
}

async function main() {
  const auditPath = resolve(process.argv[2] || process.env.UNIFIED_TOP3_OUTPUT_PATH || "work/unified-top3-replay/audit.json");
  const mechanismPath = resolve(process.env.UNIFIED_TOP3_MECHANISM_PATH || "work/mechanism-watch/audit.json");
  const techPath = resolve(process.env.UNIFIED_TOP3_TECH_PATH || "work/tech-discovery-probe/audit.json");
  const modelComputePath = resolve(process.env.UNIFIED_TOP3_MODEL_COMPUTE_PATH || "work/model-compute-source-probe/audit.json");
  const [auditBody, mechanismBody, techBody, modelComputeBody] = await Promise.all([
    readFile(auditPath, "utf8"),
    readFile(mechanismPath, "utf8"),
    readFile(techPath, "utf8"),
    readFile(modelComputePath, "utf8"),
  ]);
  const result = verifyUnifiedTop3Replay(
    JSON.parse(auditBody),
    JSON.parse(mechanismBody),
    JSON.parse(techBody),
    JSON.parse(modelComputeBody),
    { mechanism: sha256(mechanismBody), tech: sha256(techBody), modelCompute: sha256(modelComputeBody) },
  );
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("unified Top 3 replay verified\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
