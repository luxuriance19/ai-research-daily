import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCriticalPathMechanismRadarSiteData,
  buildMechanismRadarSiteData,
  syncMechanismRadarSiteData,
  verifyMechanismRadarSiteData,
} from "../automation/mechanism-radar-site-data.mjs";

const sourceIds = [
  "claude-constitution-tree", "claude-constitution-readme", "latent-reasoning-arxiv-seeds",
  "ouro-family-1-4b-model", "ouro-family-1-4b-thinking-model", "ouro-family-2-6b-model", "ouro-family-2-6b-thinking-model",
  "latent-cot-dynamics-arxiv", "latent-cot-dynamics-commits", "latent-cot-vanilla-coconut-model", "latent-cot-simcot-coconut-model",
  "openai-agents-sdk-releases", "claude-agent-sdk-releases", "google-adk-releases", "inspect-evals-releases",
];

function history(sourceId) {
  const degraded = sourceId.includes("sdk-releases");
  return {
    source_id: sourceId,
    current_status: degraded ? "stale-cache" : "not-modified",
    review_flags: degraded ? ["rate-limit"] : [],
    criteria: {
      minimum_observation_days: { observed: degraded ? 0 : 2 },
      human_source_review: { passed: false },
    },
  };
}

const candidateAudit = {
  mode: "shadow-source-probe",
  generated_at: "2026-07-18T01:00:00.000Z",
  source_history: sourceIds.map(history),
};

const diligenceAudit = {
  mode: "source-diligence-audit",
  generated_at: "2026-07-18T02:00:00.000Z",
  metrics: { claims_with_current_event_candidates: 0 },
  topics: [
    { id: "claude-constitution", attention: { level: "A0" }, claims: [{ status: "human-review-required" }, { status: "evidence-gap" }] },
    { id: "ouro-looplm", attention: { level: "A0" }, claims: [{ status: "source-ready" }, { status: "evidence-gap" }] },
    { id: "coconut-continuous-thought", attention: { level: "A0" }, claims: [{ status: "source-ready" }, { status: "evidence-gap" }] },
    { id: "agent-harness", attention: { level: "A1" }, claims: [{ status: "source-ready" }, { status: "evidence-gap" }] },
    { id: "evaluation-harness", attention: { level: "A1" }, claims: [{ status: "source-ready" }, { status: "evidence-gap" }] },
  ],
};

test("mechanism radar exposes four claim-bounded tracks without manufacturing news", () => {
  const radar = buildMechanismRadarSiteData(candidateAudit, diligenceAudit);
  assert.deepEqual(verifyMechanismRadarSiteData(radar), { ok: true, errors: [] });
  assert.equal(radar.cards.length, 4);
  assert.equal(radar.current_event_candidates, 0);
  assert.equal(radar.notification_enabled, false);
  assert.equal(radar.cards.every((card) => card.current_event === false), true);
  assert.equal(radar.cards.find((card) => card.id === "claude-constitution").source_observation.observed_days, 2);
  assert.equal(radar.cards.find((card) => card.id === "harness-progress").source_observation.state, "degraded");
  assert.match(radar.cards.find((card) => card.id === "coconut-continuous-thought").boundary_zh, /忠实|因果/);
});

test("cold critical path projects four bounded tracks when slow audits have not run", async () => {
  const root = await mkdtemp(join(tmpdir(), "mechanism-radar-cold-"));
  try {
    const mechanismPath = join(root, "mechanism.json");
    const outputPath = join(root, "radar.json");
    await writeFile(mechanismPath, JSON.stringify({ generated_at: "2026-07-19T02:00:00.000Z" }));
    const radar = await syncMechanismRadarSiteData({
      candidatePath: join(root, "missing-candidate.json"),
      diligencePath: join(root, "missing-diligence.json"),
      mechanismPath,
      outputPath,
    });
    assert.deepEqual(radar, buildCriticalPathMechanismRadarSiteData("2026-07-19T02:00:00.000Z"));
    assert.deepEqual(verifyMechanismRadarSiteData(radar), { ok: true, errors: [] });
    assert.equal(radar.status, "awaiting-supplemental-audits");
    assert.equal(radar.cards.length, 4);
    assert.equal(radar.cards.every((card) => card.source_observation.state === "supplemental-audit-not-run"), true);
    assert.equal(JSON.parse(await readFile(outputPath, "utf8")).snapshot_fingerprint, radar.snapshot_fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
