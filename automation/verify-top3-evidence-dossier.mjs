#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { TOP3_EVIDENCE_POLICY } from "./top3-evidence-dossier.mjs";

const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");
const array = (value) => Array.isArray(value) ? value : [];
const HASH = /^[a-f0-9]{64}$/;
const K3_TOPICS = new Set([
  "architecture-information-flow",
  "sparse-moe-routing",
  "training-stability",
  "low-precision-and-serving",
  "artifact-availability",
  "harness-state-coupling",
  "benchmark-harness-comparability",
]);

function fingerprintWithoutReport(audit) {
  const projected = structuredClone(audit);
  delete projected.report_fingerprint;
  return sha256(JSON.stringify(projected));
}

export function verifyTop3EvidenceDossier(audit, { top3Body, techBody, mechanismBody, candidateBody, modelComputeBody, semanticReviewBody } = {}) {
  const errors = [];
  if (audit?.schema_version !== 1 || audit?.mode !== "top3-claim-specific-evidence-dossier") errors.push("unexpected dossier schema or mode");
  if (!isDeepStrictEqual(audit?.policy, TOP3_EVIDENCE_POLICY)) errors.push("dossier policy differs from encoded contract");
  if (top3Body && audit?.input_snapshots?.top3_fingerprint !== sha256(top3Body)) errors.push("Top 3 input fingerprint mismatch");
  if (techBody && audit?.input_snapshots?.tech_fingerprint !== sha256(techBody)) errors.push("tech input fingerprint mismatch");
  if (mechanismBody && audit?.input_snapshots?.mechanism_fingerprint !== sha256(mechanismBody)) errors.push("mechanism input fingerprint mismatch");
  if (candidateBody && audit?.input_snapshots?.candidate_fingerprint !== sha256(candidateBody)) errors.push("candidate input fingerprint mismatch");
  if (modelComputeBody && audit?.input_snapshots?.model_compute_fingerprint !== sha256(modelComputeBody)) errors.push("model/compute input fingerprint mismatch");
  if (semanticReviewBody && audit?.input_snapshots?.semantic_review_fingerprint !== sha256(semanticReviewBody)) errors.push("semantic review input fingerprint mismatch");
  let top3 = null;
  try { top3 = top3Body ? JSON.parse(top3Body) : null; } catch { errors.push("Top 3 input is not valid JSON"); }
  if (top3 && array(top3.selected_top3).length !== array(audit?.dossiers).length) errors.push("dossier count differs from selected Top 3");
  for (const [index, dossier] of array(audit?.dossiers).entries()) {
    const selected = array(top3?.selected_top3)[index];
    if (selected && (dossier.story_id !== selected.story_id || dossier.rank !== selected.rank || dossier.canonical_url !== selected.canonical_url)) errors.push(`dossier selection projection mismatch: ${dossier?.story_id}`);
    if (dossier?.manual_review_only !== true || dossier?.primary_verification_required !== true) errors.push(`dossier escaped human review: ${dossier?.story_id}`);
    if (dossier?.claim_evidence_allowed !== false || dossier?.notification_eligible !== false) errors.push(`dossier crossed evidence/notification boundary: ${dossier?.story_id}`);
    if (dossier?.profile === "kimi-k3-official-technical-blog-v1") {
      const topics = new Set(array(dossier.key_points).map((claim) => claim.topic));
      for (const topic of K3_TOPICS) if (!topics.has(topic)) errors.push(`K3 claim profile missing topic: ${topic}`);
      if (!array(dossier.evidence_gaps).includes("technical-report-not-yet-published")) errors.push("K3 dossier hides missing technical report");
      if (!array(dossier.evidence_gaps).includes("weights-license-and-immutable-revision-not-yet-observed")) errors.push("K3 dossier hides undelivered weight artifact");
    }
    for (const claim of array(dossier?.key_points)) {
      if (!claim?.evidence_excerpt || claim.evidence_excerpt_sha256 !== sha256(claim.evidence_excerpt)) errors.push(`claim excerpt hash mismatch: ${dossier?.story_id}:${claim?.topic}`);
      if (!["primary-source-excerpt", "source-diligence-contract"].includes(claim?.evidence_excerpt_kind)) errors.push(`claim excerpt kind is invalid: ${dossier?.story_id}:${claim?.topic}`);
      if (!claim?.source_url || !claim?.source_identity) errors.push(`claim lacks source identity: ${dossier?.story_id}:${claim?.topic}`);
      if (claim?.requires_human_review !== true || claim?.claim_evidence_allowed !== false || claim?.notification_eligible !== false) errors.push(`claim crossed review boundary: ${dossier?.story_id}:${claim?.topic}`);
      if (!claim?.evidence_ceiling || !claim?.verification_state || !claim?.boundary) errors.push(`claim lacks explicit evidence boundary: ${dossier?.story_id}:${claim?.topic}`);
    }
  }
  for (const snapshot of array(audit?.official_snapshots)) {
    if (!/^https:\/\//.test(snapshot?.url || "")) errors.push(`invalid official snapshot URL: ${snapshot?.url}`);
    for (const field of ["content_sha256", "normalized_text_sha256", "evidence_profile_text_sha256"]) {
      if (!HASH.test(String(snapshot?.[field] || ""))) errors.push(`invalid official snapshot hash: ${snapshot?.url}:${field}`);
    }
  }
  if (audit?.notification_policy?.enabled !== false || audit?.notification_policy?.eligible_records !== 0) errors.push("notification boundary violated");
  if (audit?.publishing_policy?.enabled !== false || audit?.publishing_policy?.eligible_records !== 0) errors.push("publishing boundary violated");
  if (!isDeepStrictEqual(audit?.external_actions, [])) errors.push("external actions must remain empty");
  if (audit?.report_fingerprint !== fingerprintWithoutReport(audit)) errors.push("report fingerprint mismatch");
  return { ok: errors.length === 0, errors };
}

async function main() {
  const auditPath = resolve(process.argv[2] || process.env.TOP3_EVIDENCE_OUTPUT_PATH || "work/top3-evidence-dossier/audit.json");
  const paths = {
    top3: resolve(process.env.TOP3_EVIDENCE_TOP3_PATH || "work/unified-top3-replay/audit.json"),
    tech: resolve(process.env.TOP3_EVIDENCE_TECH_PATH || "work/tech-discovery-probe/audit.json"),
    mechanism: resolve(process.env.TOP3_EVIDENCE_MECHANISM_PATH || "work/mechanism-watch/audit.json"),
    candidate: resolve(process.env.TOP3_EVIDENCE_CANDIDATE_PATH || "work/candidate-source-probe/audit.json"),
    modelCompute: resolve(process.env.TOP3_EVIDENCE_MODEL_COMPUTE_PATH || "work/model-compute-source-probe/audit.json"),
    semanticReview: resolve(process.env.TOP3_EVIDENCE_SEMANTIC_REVIEW_PATH || "work/semantic-review-dossiers/dossier.json"),
  };
  const readOptionalBody = async (path) => {
    try { return await readFile(path, "utf8"); } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const [auditBody, top3Body, techBody, mechanismBody, candidateBody, modelComputeBody, semanticReviewBody] = await Promise.all([
    readFile(auditPath, "utf8"), readFile(paths.top3, "utf8"), readFile(paths.tech, "utf8"), readFile(paths.mechanism, "utf8"), readOptionalBody(paths.candidate), readFile(paths.modelCompute, "utf8"), readOptionalBody(paths.semanticReview),
  ]);
  const result = verifyTop3EvidenceDossier(JSON.parse(auditBody), { top3Body, techBody, mechanismBody, candidateBody, modelComputeBody, semanticReviewBody });
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Top 3 evidence dossier verified\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
