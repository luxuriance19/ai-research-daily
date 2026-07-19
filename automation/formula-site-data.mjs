#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const array = (value) => Array.isArray(value) ? value : [];
const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");

export const RANKING_FORMULA = Object.freeze({
  id: "editorial-ranking-score-v1",
  scope: "editorial-method",
  label_zh: "Top 3 筛选公式",
  latex: String.raw`S = I + \Delta_{\mathrm{tech}} + A_{\mathrm{artifact}} + H + F`,
  alt_zh: "总分等于一手身份、技术增量、Artifact、独立关注与时效性之和",
  provenance: {
    verification_state: "local-policy-exact",
    source_identity: "daily-core-source-shortlist:top3-score-v1",
    source_url: "./digests.json",
  },
});

function assetFields(latex) {
  const contentHash = sha256(latex).slice(0, 12);
  return {
    content_hash: contentHash,
    asset_file: `formula-${contentHash}.png`,
    asset_url: `/formulas/formula-${contentHash}.png`,
  };
}

function projectResearchFormula(dossier, point) {
  const formula = point?.formula;
  if (!formula) return null;
  if (formula.verification_state !== "source-exact") throw new Error(`research formula is not source-exact: ${point.topic}`);
  if (formula.source_url !== point.source_url || formula.source_identity !== point.source_identity) {
    throw new Error(`research formula provenance differs from its evidence point: ${point.topic}`);
  }
  const latex = String(formula.latex || "").trim();
  if (!latex || latex.length > 1_500) throw new Error(`research formula has invalid LaTeX: ${point.topic}`);
  if (!/^[a-f0-9]{64}$/.test(String(formula.source_excerpt_sha256 || ""))) {
    throw new Error(`research formula lacks an exact source-excerpt fingerprint: ${point.topic}`);
  }
  return {
    id: `research-${sha256(`${dossier.story_id}\n${point.topic}\n${latex}`).slice(0, 16)}`,
    scope: "research-source-exact",
    story_id: dossier.story_id,
    point_topic: point.topic,
    label_zh: String(formula.label_zh || "一手来源公式").slice(0, 120),
    latex,
    alt_zh: String(formula.alt_zh || formula.label_zh || "一手来源公式").slice(0, 240),
    provenance: {
      verification_state: "source-exact",
      source_identity: formula.source_identity,
      source_url: formula.source_url,
      source_excerpt_sha256: formula.source_excerpt_sha256,
    },
  };
}

export function buildFormulaSiteData(top3) {
  if (top3?.mode !== "local-top3-site-snapshot") throw new Error("unexpected Top 3 site mode");
  if (top3?.manual_review_only !== true || top3?.notification_enabled !== false || top3?.publishing_enabled !== false) {
    throw new Error("formula projection crossed the local-review boundary");
  }
  const formulas = [{ ...RANKING_FORMULA }];
  for (const dossier of array(top3.dossiers)) {
    for (const point of array(dossier.key_points)) {
      const formula = projectResearchFormula(dossier, point);
      if (formula) formulas.push(formula);
    }
  }
  const projected = formulas.map((formula) => ({ ...formula, ...assetFields(formula.latex) }));
  const report = {
    schema_version: 1,
    mode: "verified-formula-site-manifest",
    generated_at: top3.generated_at,
    manual_review_only: true,
    notification_enabled: false,
    publishing_enabled: false,
    policy: {
      research_formula_requires_exact_primary_excerpt: true,
      inferred_or_reconstructed_formulas_allowed: false,
      client_side_math_runtime_required: false,
      wechat_raster_assets: true,
    },
    formulas: projected,
  };
  report.report_fingerprint = sha256(JSON.stringify(report));
  return report;
}

async function atomicWrite(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
  await writeFile(pending, body, { encoding: "utf8", flag: "wx" });
  await rename(pending, path);
}

export async function syncFormulaSiteData({
  top3Path = resolve("data/top3-latest.json"),
  outputPath = resolve("data/formula-assets-latest.json"),
} = {}) {
  const top3 = JSON.parse(await readFile(top3Path, "utf8"));
  const report = buildFormulaSiteData(top3);
  await atomicWrite(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main() {
  const report = await syncFormulaSiteData({
    top3Path: resolve(process.env.TOP3_SITE_DATA_PATH || "data/top3-latest.json"),
    outputPath: resolve(process.env.FORMULA_SITE_DATA_PATH || "data/formula-assets-latest.json"),
  });
  process.stdout.write(`${JSON.stringify({ formulas: report.formulas.length, fingerprint: report.report_fingerprint }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
