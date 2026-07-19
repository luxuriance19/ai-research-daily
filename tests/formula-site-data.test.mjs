import assert from "node:assert/strict";
import test from "node:test";
import { buildFormulaSiteData } from "../automation/formula-site-data.mjs";

function top3Fixture() {
  return {
    mode: "local-top3-site-snapshot",
    generated_at: "2026-07-19T00:00:00.000Z",
    manual_review_only: true,
    notification_enabled: false,
    publishing_enabled: false,
    dossiers: [{
      story_id: "arxiv:2607.00001v1",
      key_points: [{
        topic: "training-objective",
        source_url: "https://arxiv.org/abs/2607.00001v1",
        source_identity: "arxiv:2607.00001@v1",
        formula: {
          label_zh: "训练目标",
          alt_zh: "任务损失加权辅助损失",
          latex: String.raw`L = L_{task} + \lambda L_{aux}`,
          verification_state: "source-exact",
          source_url: "https://arxiv.org/abs/2607.00001v1",
          source_identity: "arxiv:2607.00001@v1",
          source_excerpt_sha256: "a".repeat(64),
        },
      }],
    }],
  };
}

test("formula manifest separates the editorial rule from exact primary-source research formulas", () => {
  const report = buildFormulaSiteData(top3Fixture());
  assert.equal(report.formulas.length, 2);
  assert.equal(report.formulas[0].scope, "editorial-method");
  assert.equal(report.formulas[1].scope, "research-source-exact");
  assert.equal(report.formulas[1].provenance.source_excerpt_sha256, "a".repeat(64));
  assert.match(report.formulas[1].asset_file, /^formula-[a-f0-9]{12}\.png$/);
  assert.equal(report.policy.inferred_or_reconstructed_formulas_allowed, false);
  assert.equal(report.policy.wechat_raster_assets, true);
});

test("formula manifest rejects provenance drift and missing exact-source fingerprints", () => {
  const drifted = top3Fixture();
  drifted.dossiers[0].key_points[0].formula.source_identity = "arxiv:other@v1";
  assert.throws(() => buildFormulaSiteData(drifted), /provenance differs/);

  const missing = top3Fixture();
  missing.dossiers[0].key_points[0].formula.source_excerpt_sha256 = "";
  assert.throws(() => buildFormulaSiteData(missing), /lacks an exact source-excerpt fingerprint/);
});
