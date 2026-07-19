import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSourceQualityScorecard, verifySourceQualityScorecard } from "../automation/source-quality-site-data.mjs";

const json = async (path) => JSON.parse(await readFile(new URL(path, new URL("../", import.meta.url)), "utf8"));

async function currentAudits() {
  return {
    mechanism: await json("work/mechanism-watch/audit.json"),
    tech: await json("work/tech-discovery-probe/audit.json"),
    model: await json("work/model-compute-source-probe/audit.json"),
    top: await json("work/unified-top3-replay/audit.json"),
  };
}

test("source scorecard keeps all 48 discovery endpoints role-aware and action-free", async () => {
  const audits = await currentAudits();
  const report = buildSourceQualityScorecard(audits);
  assert.equal(report.sources.length, 48);
  assert.equal(new Set(report.sources.map((source) => source.id)).size, 48);
  assert.equal(report.summary.selected_stories, audits.top.selected_top3.length);
  assert.equal(report.policy.authority_and_attention_separate, true);
  assert.equal(report.policy.ranking_impact, "none");
  assert.equal(report.policy.automatic_pruning_enabled, false);
  assert.equal(report.policy.notification_enabled, false);
  assert.equal(report.summary.automatic_role_changes, 0);
  assert.equal(report.sources.every((source) => source.automatic_role_change === false && source.notification_eligible === false), true);
  const registeredIds = new Set(report.sources.map((source) => source.id));
  const expectedSelectedIds = [...new Set(audits.top.selected_top3.flatMap((story) => [
    story.source_id,
    story.existing_source_id,
    ...(story.source_ids || []),
    ...(story.source_records || []).map((record) => record.source_id),
  ]).filter((sourceId) => sourceId && registeredIds.has(sourceId)))].sort();
  const selectedIds = report.sources.filter((source) => source.today.selected_top3_attributions > 0).map((source) => source.id).sort();
  assert.equal(report.summary.selected_top3_contributors, expectedSelectedIds.length);
  assert.deepEqual(selectedIds, expectedSelectedIds);
  assert.deepEqual(verifySourceQualityScorecard(report), { ok: true, errors: [] });
});

test("same-day reruns replace history while a new natural day advances the source-quality gate once", async () => {
  const audits = await currentAudits();
  const first = buildSourceQualityScorecard(audits);
  const sameDay = buildSourceQualityScorecard({ ...audits, previous: first });
  assert.equal(sameDay.sources.every((source) => source.daily_history.length === 1), true);

  const next = structuredClone(audits);
  for (const audit of Object.values(next)) audit.generated_at = "2026-07-19T16:30:00.000Z";
  const secondDay = buildSourceQualityScorecard({ ...next, previous: sameDay });
  assert.equal(secondDay.report_date > sameDay.report_date, true);
  assert.equal(secondDay.sources.every((source) => source.daily_history.length === 2), true);
  assert.equal(secondDay.sources.every((source) => source.observation.scorecard_consecutive_healthy_days <= 2), true);
  assert.equal(secondDay.summary.ready_for_human_role_review, 0);
  assert.deepEqual(verifySourceQualityScorecard(secondDay), { ok: true, errors: [] });
});

test("verifier rejects fabricated pruning, ranking, notification, and source histories", async () => {
  const report = buildSourceQualityScorecard(await currentAudits());
  const invalid = structuredClone(report);
  invalid.policy.automatic_pruning_enabled = true;
  invalid.policy.ranking_impact = "boost";
  invalid.policy.notification_enabled = true;
  invalid.sources[0].automatic_role_change = true;
  invalid.sources[0].daily_history.push({ ...invalid.sources[0].daily_history[0], date: "2999-01-01" });
  const result = verifySourceQualityScorecard(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("automatic source role changes must remain disabled"));
  assert.ok(result.errors.includes("scorecard must not affect ranking"));
  assert.ok(result.errors.includes("scorecard notification and publishing must remain disabled"));
  assert.ok(result.errors.some((error) => error.startsWith("source action boundary violated:")));
  assert.ok(result.errors.some((error) => error.startsWith("future source history:")));
});
