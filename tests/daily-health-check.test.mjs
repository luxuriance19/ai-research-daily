import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildDailyHealth, verifyDailyHealth } from "../automation/daily-health-check.mjs";

const GENERATED = "2026-07-19T01:10:00.000Z";
const WEBSITE_DIR = fileURLToPath(new URL("..", import.meta.url));
const ROOT_DIR = join(WEBSITE_DIR, "..");

function fixtures() {
  const noActions = { notification_enabled: false, publishing_enabled: false, notification_eligible_records: 0, external_actions: [] };
  const top3Fingerprint = "verified-top3";
  const qualityFingerprint = "verified-quality";
  return {
    fast: { mode: "fast-daily-top3-pipeline", completed_at: GENERATED, status: "ok", ...noActions },
    candidate: { mode: "shadow-source-probe", generated_at: GENERATED, status: "ok", ...noActions },
    diligence: { mode: "source-diligence-audit", generated_at: GENERATED, status: "evidence-gaps-present", ...noActions },
    semantic: { mode: "mechanism-semantic-review-dossier", generated_at: GENERATED, status: "waiting-for-stability-and-human-review", ...noActions },
    readiness: { mode: "source-promotion-readiness", generated_at: GENERATED, status: "blocked-sources-present", ...noActions },
    scout: { mode: "evidence-gap-scout", generated_at: GENERATED, status: "ok", ...noActions },
    quality: { mode: "discovery-source-quality-scorecard", generated_at: GENERATED, status: "ok", report_fingerprint: qualityFingerprint, summary: { selected_story_ids: ["story-1"] }, ...noActions },
    roleReview: { mode: "source-role-human-review-worksheet", generated_at: GENERATED, status: "waiting-for-seven-natural-days", source_scorecard_fingerprint: qualityFingerprint, ...noActions },
    top3: { mode: "local-top3-site-snapshot", generated_at: GENERATED, status: "review-ready", source_report_fingerprint: top3Fingerprint, dossiers: [{ story_id: "story-1" }], ...noActions },
    archive: { date: "2026-07-19", generated_at: GENERATED, top3_fingerprint: top3Fingerprint },
  };
}

test("09:15 health check validates all local stages, bindings, and closed notification paths", () => {
  const report = buildDailyHealth(fixtures(), { now: new Date("2026-07-19T01:15:00.000Z") });
  assert.equal(report.status, "healthy");
  assert.equal(report.summary.healthy_stages, 9);
  assert.equal(report.summary.failed_or_missing_stages, 0);
  assert.equal(report.summary.notification_boundary_violations, 0);
  assert.deepEqual(verifyDailyHealth(report), { ok: true, errors: [] });
});

test("stale or notification-enabled output degrades after the schedule window and stays pending before it", () => {
  const values = fixtures();
  values.scout.generated_at = "2026-07-18T01:10:00.000Z";
  values.candidate.notification_eligible_records = 1;
  const pending = buildDailyHealth(values, { now: new Date("2026-07-19T00:00:00.000Z") });
  assert.equal(pending.status, "pending-schedule-window");
  assert.ok(pending.summary.notification_boundary_violations > 0);
  assert.deepEqual(verifyDailyHealth(pending), { ok: true, errors: [] });

  const degraded = buildDailyHealth(values, { now: new Date("2026-07-19T01:20:00.000Z") });
  assert.equal(degraded.status, "degraded");
});

test("09:15 LaunchAgent is network-free and runs only the local health checker", () => {
  const plist = execFileSync("python3", [join(ROOT_DIR, "scripts/install_daily_health_launchd.py"), "--dry-run"], { cwd: ROOT_DIR, encoding: "utf8" });
  assert.match(plist, /daily-health-check\.mjs/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>9<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>15<\/integer>/);
  assert.doesNotMatch(plist, /GITHUB|CLOUDFLARE|WECHAT|TOKEN|SECRET|API_KEY/i);
});
