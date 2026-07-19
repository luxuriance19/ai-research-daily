#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const array = (value) => Array.isArray(value) ? value : [];
const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");

function projectSourceExactFormula(point) {
  const formula = point?.formula;
  if (!formula) return null;
  const latex = String(formula.latex || "").trim();
  const sourceExcerpt = String(formula.source_excerpt || "");
  const evidenceExcerpt = String(point.evidence_excerpt || "");
  if (formula.verification_state !== "source-exact") throw new Error(`formula is not source-exact: ${point.topic}`);
  if (formula.source_url !== point.source_url || formula.source_identity !== point.source_identity) {
    throw new Error(`formula provenance differs from its evidence point: ${point.topic}`);
  }
  if (!latex || latex.length > 1_500 || !sourceExcerpt.includes(latex) || !evidenceExcerpt.includes(sourceExcerpt)) {
    throw new Error(`formula is not present in the verified evidence excerpt: ${point.topic}`);
  }
  return {
    label_zh: String(formula.label_zh || "一手来源公式").slice(0, 120),
    alt_zh: String(formula.alt_zh || formula.label_zh || "一手来源公式").slice(0, 240),
    latex,
    verification_state: "source-exact",
    source_url: formula.source_url,
    source_identity: formula.source_identity,
    source_excerpt_sha256: sha256(sourceExcerpt),
  };
}

export function buildTop3SiteData(audit) {
  if (audit?.mode !== "top3-claim-specific-evidence-dossier") throw new Error("unexpected Top 3 evidence mode");
  if (audit?.notification_policy?.enabled !== false || audit?.publishing_policy?.enabled !== false || array(audit?.external_actions).length) {
    throw new Error("Top 3 evidence crossed the local-review boundary");
  }
  const siteData = {
    schema_version: 1,
    mode: "local-top3-site-snapshot",
    generated_at: audit.generated_at,
    status: audit.status,
    source_report_fingerprint: audit.report_fingerprint,
    manual_review_only: true,
    notification_enabled: false,
    publishing_enabled: false,
    metrics: {
      dossiers_created: audit.metrics?.dossiers_created || 0,
      key_points_extracted: audit.metrics?.key_points_extracted || 0,
      evidence_gaps: audit.metrics?.evidence_gaps || 0,
    },
    dossiers: array(audit.dossiers).map((dossier) => ({
      rank: dossier.rank,
      story_id: dossier.story_id,
      title: dossier.title,
      primary_section: dossier.primary_section,
      canonical_url: dossier.canonical_url,
      selection_score: dossier.selection_score,
      evidence_status: dossier.evidence_status,
      key_points: array(dossier.key_points).map((point) => {
        const projected = {
          topic: point.topic,
          mechanism_layer: point.mechanism_layer,
          statement_zh: point.statement_zh,
          evidence_ceiling: point.evidence_ceiling,
          verification_state: point.verification_state,
          boundary: point.boundary,
          source_url: point.source_url,
          source_identity: point.source_identity,
        };
        const formula = projectSourceExactFormula(point);
        if (formula) projected.formula = formula;
        return projected;
      }),
      evidence_gaps: array(dossier.evidence_gaps),
      manual_review_only: true,
      notification_eligible: false,
    })),
  };
  siteData.snapshot_fingerprint = sha256(JSON.stringify(siteData));
  return siteData;
}

export function verifyTop3SiteData(siteData, audit) {
  const expected = buildTop3SiteData(audit);
  const errors = [];
  if (!isDeepStrictEqual(siteData, expected)) errors.push("site snapshot differs from verified Top 3 projection");
  if (siteData?.manual_review_only !== true || siteData?.notification_enabled !== false || siteData?.publishing_enabled !== false) errors.push("site snapshot crossed review boundary");
  if (array(siteData?.dossiers).some((dossier) => dossier?.manual_review_only !== true || dossier?.notification_eligible !== false)) errors.push("site dossier crossed review boundary");
  return { ok: errors.length === 0, errors };
}

async function atomicWrite(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
  await writeFile(pending, body, { encoding: "utf8", flag: "wx" });
  await rename(pending, path);
}

export async function syncTop3SiteData({
  auditPath = resolve("work/top3-evidence-dossier/audit.json"),
  outputPath = resolve("data/top3-latest.json"),
} = {}) {
  const audit = JSON.parse(await readFile(auditPath, "utf8"));
  const siteData = buildTop3SiteData(audit);
  const verified = verifyTop3SiteData(siteData, audit);
  if (!verified.ok) throw new Error(verified.errors.join("; "));
  await atomicWrite(outputPath, `${JSON.stringify(siteData, null, 2)}\n`);
  return siteData;
}

async function main() {
  const siteData = await syncTop3SiteData({
    auditPath: resolve(process.env.TOP3_SITE_AUDIT_PATH || "work/top3-evidence-dossier/audit.json"),
    outputPath: resolve(process.env.TOP3_SITE_OUTPUT_PATH || "data/top3-latest.json"),
  });
  process.stdout.write(`${JSON.stringify({ status: siteData.status, dossiers: siteData.metrics.dossiers_created, key_points: siteData.metrics.key_points_extracted }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
