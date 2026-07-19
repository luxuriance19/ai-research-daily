import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSourceRoleReview, renderSourceRoleReviewMarkdown, verifySourceRoleReview } from "../automation/source-role-review.mjs";

const scorecard = async () => JSON.parse(await readFile(new URL("../data/source-quality-latest.json", import.meta.url), "utf8"));

test("source role worksheet exposes all 48 endpoints without manufacturing human decisions", async () => {
  const sourceScorecard = await scorecard();
  const report = buildSourceRoleReview(sourceScorecard);
  assert.equal(report.sources.length, 48);
  assert.equal(report.summary.completed_human_decisions, 0);
  assert.equal(report.summary.notification_eligible_records, 0);
  assert.equal(report.external_actions.length, 0);
  assert.equal(report.sources.every((source) => source.human_decision === null && source.automatic_role_change === false && source.notification_eligible === false), true);
  assert.equal(report.summary.eligible_for_human_review, sourceScorecard.summary.ready_for_human_role_review);
  assert.deepEqual(verifySourceRoleReview(report, sourceScorecard), { ok: true, errors: [] });
  const markdown = renderSourceRoleReviewMarkdown(report);
  assert.match(markdown, /不得以同日复跑补足天数/);
  assert.match(markdown, /retain-daily/);
  assert.match(markdown, /GitHub Trending/);
});

test("source role verifier rejects prefilled decisions and automatic actions", async () => {
  const sourceScorecard = await scorecard();
  const report = buildSourceRoleReview(sourceScorecard);
  const invalid = structuredClone(report);
  invalid.sources[0].human_decision = "retain-daily";
  invalid.sources[0].reviewer = "automation";
  invalid.sources[0].automatic_role_change = true;
  invalid.policy.notification_enabled = true;
  const result = verifySourceRoleReview(invalid, sourceScorecard);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("source role review action boundary violated"));
  assert.ok(result.errors.some((error) => error.startsWith("source review worksheet prefilled a human decision:")));
  assert.ok(result.errors.some((error) => error.startsWith("source review source action boundary violated:")));
});
