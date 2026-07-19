import assert from "node:assert/strict";
import test from "node:test";
import { buildTop3SiteData, verifyTop3SiteData } from "../automation/top3-site-data.mjs";
import { runAndVerifyTop3Evidence } from "../automation/run-and-verify-top3-evidence-dossier.mjs";

function auditFixture() {
  return {
    mode: "top3-claim-specific-evidence-dossier",
    generated_at: "2026-07-18T11:00:00.000Z",
    status: "review-ready",
    report_fingerprint: "verified-report",
    metrics: { dossiers_created: 1, key_points_extracted: 1, evidence_gaps: 1 },
    notification_policy: { enabled: false, eligible_records: 0 },
    publishing_policy: { enabled: false, eligible_records: 0 },
    external_actions: [],
    dossiers: [{
      rank: 1,
      story_id: "url:example.com/story",
      title: "A mechanism story",
      primary_section: "mechanism",
      canonical_url: "https://example.com/story",
      selection_score: 6,
      evidence_status: "source-audited-manual-review",
      key_points: [{
        topic: "mechanism-path",
        mechanism_layer: "M1",
        statement_zh: "一个可定位的计算路径。",
        evidence_ceiling: "G1-author-reported",
        verification_state: "manual-review-required",
        boundary: "不能证明独立因果。",
        source_url: "https://example.com/story",
        source_identity: "arxiv:2607.00001v1",
        evidence_excerpt: "private source excerpt intentionally omitted from the site projection",
      }],
      evidence_gaps: ["independent-reproduction-missing"],
    }],
  };
}

test("the site snapshot is a deterministic public projection of the verified dossier", () => {
  const audit = auditFixture();
  const snapshot = buildTop3SiteData(audit);
  assert.equal(snapshot.dossiers.length, 1);
  assert.equal(snapshot.dossiers[0].key_points[0].statement_zh, "一个可定位的计算路径。");
  assert.equal("evidence_excerpt" in snapshot.dossiers[0].key_points[0], false);
  assert.equal(snapshot.notification_enabled, false);
  assert.equal(snapshot.publishing_enabled, false);
  assert.deepEqual(verifyTop3SiteData(snapshot, audit), { ok: true, errors: [] });

  const mutated = structuredClone(snapshot);
  mutated.dossiers[0].key_points[0].boundary = "已证明因果";
  assert.equal(verifyTop3SiteData(mutated, audit).ok, false);
});

test("only an exact formula contained in the verified primary excerpt reaches the site snapshot", () => {
  const audit = auditFixture();
  const point = audit.dossiers[0].key_points[0];
  point.evidence_excerpt = "The update optimizes the exact objective $L = L_{task} + \\lambda L_{aux}$ under the stated setup.";
  point.formula = {
    label_zh: "训练目标",
    alt_zh: "任务损失加权辅助损失",
    latex: String.raw`L = L_{task} + \lambda L_{aux}`,
    source_excerpt: String.raw`L = L_{task} + \lambda L_{aux}`,
    source_url: point.source_url,
    source_identity: point.source_identity,
    verification_state: "source-exact",
  };
  const snapshot = buildTop3SiteData(audit);
  const projected = snapshot.dossiers[0].key_points[0].formula;
  assert.equal(projected.latex, String.raw`L = L_{task} + \lambda L_{aux}`);
  assert.equal(projected.verification_state, "source-exact");
  assert.match(projected.source_excerpt_sha256, /^[a-f0-9]{64}$/);
  assert.equal("source_excerpt" in projected, false);

  const reconstructed = auditFixture();
  reconstructed.dossiers[0].key_points[0].formula = { ...point.formula, source_excerpt: "not present in evidence" };
  assert.throws(() => buildTop3SiteData(reconstructed), /not present in the verified evidence excerpt/);
});

test("the scheduled evidence gate syncs the site only after generation, verification, and promotion", () => {
  const stages = [];
  const code = runAndVerifyTop3Evidence({
    spawnImpl: (_node, args) => { stages.push(args[0]); return { status: 0 }; },
    nodePath: "/node",
    cwd: "/tmp",
    environment: {},
    promoteImpl: () => { stages.push("promote"); },
    unlinkImpl: () => {},
    syncSite: true,
  });
  assert.equal(code, 0);
  assert.match(stages[0], /top3-evidence-dossier\.mjs$/);
  assert.match(stages[1], /verify-top3-evidence-dossier\.mjs$/);
  assert.equal(stages[2], "promote");
  assert.match(stages[3], /top3-site-data\.mjs$/);
});
