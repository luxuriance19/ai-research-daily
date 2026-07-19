#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { mechanismSources } from "./mechanism-source-registry.mjs";
import {
  canonicalId,
  classifyCandidate,
  createAudit,
  createDailyCurrentWindowRecords,
  parseSource,
  renderMechanismReview,
} from "./run-mechanism-watch.mjs";
import { verifySilentAudit } from "./verify-mechanism-audit.mjs";

const array = (value) => Array.isArray(value) ? value : [];

async function atomicWrite(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, body);
  await rename(temporaryPath, path);
}

export function recoverMechanismDailyWindow({ audit, arxivBody, observedAt = audit?.generated_at } = {}) {
  if (!audit || !arxivBody) throw new Error("audit and arxivBody are required");
  const now = new Date(observedAt);
  if (!Number.isFinite(now.getTime())) throw new Error("invalid recovery time");
  const source = mechanismSources.find((entry) => entry.id === "arxiv-mechanisms");
  if (!source) throw new Error("arxiv-mechanisms source is not registered");
  const knownIds = new Set(array(audit.identity_history).map((entry) => entry.canonical_id));
  const parsed = parseSource(source, arxivBody)
    .map((item) => ({ ...item, source }))
    .filter((item) => knownIds.has(canonicalId(item)) && classifyCandidate(item, source).primary_layer);
  const recoveredAudit = createAudit({
    now,
    sourceEvents: audit.source_events,
    candidates: parsed,
    previousRecords: audit.records,
    previousIdentityHistory: audit.identity_history,
    previousAudit: audit,
  });
  const recoverySnapshot = {
    ...audit,
    records: [...array(audit.records), ...recoveredAudit.records],
  };
  const dailyCurrentWindowRecords = createDailyCurrentWindowRecords({
    now,
    records: [],
    sourceEvents: [],
    previousAudit: recoverySnapshot,
  });
  const recoveredIds = new Set(recoveredAudit.records.map((record) => record.canonical_id));
  const result = structuredClone(audit);
  result.daily_current_window_records = dailyCurrentWindowRecords;
  result.metrics.daily_current_window_records = dailyCurrentWindowRecords.length;
  result.daily_window_recovery = {
    mode: "bounded-known-arxiv-identities",
    observed_at: now.toISOString(),
    requested_known_identities: knownIds.size,
    parsed_entries: parsed.length,
    retained_records: dailyCurrentWindowRecords.length,
    recovered_record_ids: dailyCurrentWindowRecords.map((record) => record.canonical_id).filter((id) => recoveredIds.has(id)),
    fresh_change_evidence_allowed: false,
    claim_evidence_allowed: false,
    notification_eligible: false,
    external_actions: [],
  };
  verifySilentAudit(result);
  return result;
}

export async function recoverMechanismDailyWindowFiles({
  auditPath = process.env.AUDIT_PATH || "work/mechanism-watch/audit.json",
  arxivPath = process.env.ARXIV_RECOVERY_PATH || "work/mechanism-watch/arxiv-known-id-recovery.xml",
  reviewPath = process.env.REVIEW_PATH || "work/mechanism-watch/review.md",
} = {}) {
  const [audit, arxivBody] = await Promise.all([
    readFile(auditPath, "utf8").then(JSON.parse),
    readFile(arxivPath, "utf8"),
  ]);
  const result = recoverMechanismDailyWindow({ audit, arxivBody });
  await atomicWrite(auditPath, `${JSON.stringify(result, null, 2)}\n`);
  await atomicWrite(reviewPath, renderMechanismReview(result));
  return result;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  recoverMechanismDailyWindowFiles().then((audit) => {
    console.log(JSON.stringify({
      status: "recovered",
      daily_current_window_records: audit.metrics.daily_current_window_records,
      recovered_record_ids: audit.daily_window_recovery.recovered_record_ids,
    }));
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
