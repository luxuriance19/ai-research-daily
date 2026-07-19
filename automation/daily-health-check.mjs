#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(AUTOMATION_DIR, "..");
const list = (value) => Array.isArray(value) ? value : [];
const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");

const expectedStages = Object.freeze([
  { id: "fast-daily", key: "fast", mode: "fast-daily-top3-pipeline", timestamp: "completed_at", acceptable: new Set(["ok", "degraded"]) },
  { id: "candidate-probe", key: "candidate", mode: "shadow-source-probe", timestamp: "generated_at", acceptable: new Set(["ok", "degraded"]) },
  { id: "source-diligence", key: "diligence", mode: "source-diligence-audit", timestamp: "generated_at", acceptable: new Set(["evidence-gaps-present", "review-ready"]) },
  { id: "semantic-review", key: "semantic", mode: "mechanism-semantic-review-dossier", timestamp: "generated_at", acceptable: new Set(["waiting-for-stability-and-human-review", "review-ready"]) },
  { id: "source-readiness", key: "readiness", mode: "source-promotion-readiness", timestamp: "generated_at", acceptable: new Set(["blocked-sources-present", "observing", "awaiting-human-review", "review-ready"]) },
  { id: "evidence-scout", key: "scout", mode: "evidence-gap-scout", timestamp: "generated_at", acceptable: new Set(["ok", "degraded"]) },
  { id: "source-quality", key: "quality", mode: "discovery-source-quality-scorecard", timestamp: "generated_at", acceptable: new Set(["ok", "degraded"]) },
  { id: "source-role-review", key: "roleReview", mode: "source-role-human-review-worksheet", timestamp: "generated_at", acceptable: new Set(["waiting-for-seven-natural-days", "awaiting-human-decisions"]) },
  { id: "top3-site", key: "top3", mode: "local-top3-site-snapshot", timestamp: "generated_at", acceptable: new Set(["review-ready"]) },
]);

function shanghaiDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function notificationBoundaryViolations(value, path = "root", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const violations = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (/notification.*(?:enabled|eligible)|(?:enabled|eligible).*notification/i.test(key)) {
      if (child === true || (typeof child === "number" && child !== 0)) violations.push(childPath);
    }
    if (/publishing_enabled/i.test(key) && child === true) violations.push(childPath);
    if (/external_actions/i.test(key) && list(child).length) violations.push(childPath);
    violations.push(...notificationBoundaryViolations(child, childPath, seen));
  }
  return violations;
}

function stageCheck(definition, inputs, reportDate) {
  const value = inputs[definition.key];
  if (!value) return { id: definition.id, state: "missing", fresh_for_report_date: false, mode_ok: false, status_ok: false, notification_boundary_ok: false, detail: "input missing" };
  const timestamp = value[definition.timestamp];
  const fresh = shanghaiDate(timestamp) === reportDate;
  const modeOk = value.mode === definition.mode;
  const statusOk = definition.acceptable.has(value.status);
  const violations = notificationBoundaryViolations(value, definition.id);
  const state = fresh && modeOk && statusOk && !violations.length
    ? value.status === "degraded" ? "degraded" : "healthy"
    : "failed";
  return {
    id: definition.id,
    state,
    timestamp: timestamp || null,
    fresh_for_report_date: fresh,
    mode_ok: modeOk,
    status: value.status || null,
    status_ok: statusOk,
    notification_boundary_ok: violations.length === 0,
    notification_boundary_violations: violations,
  };
}

export function buildDailyHealth(inputs, { now = new Date(), expectedHour = 9, expectedMinute = 15 } = {}) {
  const reportDate = shanghaiDate(now);
  if (!reportDate) throw new Error("daily health requires a valid current time");
  const minutes = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(now).replace(":", ""));
  const expectedMinutes = expectedHour * 100 + expectedMinute;
  const stages = expectedStages.map((definition) => stageCheck(definition, inputs, reportDate));
  const qualityBinding = inputs.roleReview?.source_scorecard_fingerprint === inputs.quality?.report_fingerprint;
  const topStoryIds = list(inputs.top3?.dossiers).map((dossier) => dossier.story_id).sort();
  const qualityStoryIds = list(inputs.quality?.summary?.selected_story_ids).sort();
  const topBinding = JSON.stringify(topStoryIds) === JSON.stringify(qualityStoryIds);
  const archiveFresh = inputs.archive?.date === reportDate && shanghaiDate(inputs.archive?.generated_at) === reportDate;
  const archiveBinding = inputs.archive?.top3_fingerprint === inputs.top3?.source_report_fingerprint;
  const invariantChecks = [
    { id: "source-role-scorecard-fingerprint", ok: qualityBinding },
    { id: "top3-source-quality-story-set", ok: topBinding },
    { id: "dated-archive-current", ok: archiveFresh },
    { id: "dated-archive-top3-fingerprint", ok: archiveBinding },
  ];
  const afterWindow = minutes >= expectedMinutes;
  const failures = stages.filter((stage) => ["missing", "failed"].includes(stage.state)).length + invariantChecks.filter((check) => !check.ok).length;
  const degraded = stages.filter((stage) => stage.state === "degraded").length;
  const status = failures
    ? afterWindow ? "degraded" : "pending-schedule-window"
    : degraded ? "degraded" : "healthy";
  const report = {
    schema_version: 1,
    mode: "daily-pipeline-health-check",
    generated_at: now.toISOString(),
    report_date: reportDate,
    expected_complete_by: `${String(expectedHour).padStart(2, "0")}:${String(expectedMinute).padStart(2, "0")} Asia/Shanghai`,
    status,
    policy: {
      network_requests: 0,
      external_actions_allowed: false,
      notification_enabled: false,
      publishing_enabled: false,
      same_day_rerun_advances_source_history: false,
    },
    summary: {
      stages: stages.length,
      healthy_stages: stages.filter((stage) => stage.state === "healthy").length,
      degraded_stages: degraded,
      failed_or_missing_stages: failures,
      invariant_checks: invariantChecks.length,
      failed_invariants: invariantChecks.filter((check) => !check.ok).length,
      notification_boundary_violations: stages.reduce((sum, stage) => sum + list(stage.notification_boundary_violations).length, 0),
      external_actions: 0,
    },
    stages,
    invariant_checks: invariantChecks,
    external_actions: [],
  };
  report.report_fingerprint = sha256(JSON.stringify(report));
  return report;
}

export function verifyDailyHealth(report) {
  const errors = [];
  if (report?.mode !== "daily-pipeline-health-check" || list(report?.stages).length !== expectedStages.length) errors.push("invalid daily health report shape");
  if (report?.policy?.network_requests !== 0 || report?.policy?.external_actions_allowed !== false || report?.policy?.notification_enabled !== false || report?.policy?.publishing_enabled !== false || report?.policy?.same_day_rerun_advances_source_history !== false) errors.push("daily health action boundary violated");
  const observedViolations = list(report?.stages).reduce((sum, stage) => sum + list(stage?.notification_boundary_violations).length, 0);
  if (report?.summary?.notification_boundary_violations !== observedViolations) errors.push("daily health notification observation count mismatch");
  if (report?.summary?.external_actions !== 0 || list(report?.external_actions).length) errors.push("daily health report contains an external action");
  const clone = structuredClone(report);
  delete clone.report_fingerprint;
  if (report?.report_fingerprint !== sha256(JSON.stringify(clone))) errors.push("daily health fingerprint mismatch");
  return { ok: errors.length === 0, errors };
}

export function renderDailyHealthMarkdown(report) {
  const stageRows = report.stages.map((stage) => `| ${stage.id} | ${stage.state} | ${stage.status || "—"} | ${stage.fresh_for_report_date ? "是" : "否"} | ${stage.notification_boundary_ok ? "关闭" : "违规"} |`).join("\n");
  const invariantRows = report.invariant_checks.map((check) => `- ${check.ok ? "[x]" : "[ ]"} ${check.id}`).join("\n");
  return `# AI 日报每日流水线健康报告

- 报告日期：${report.report_date}（Asia/Shanghai）
- 预期完成：${report.expected_complete_by}
- 状态：\`${report.status}\`
- 指纹：\`${report.report_fingerprint}\`

该检查只读取本地结果，不发网络请求、不通知、不发布，也不会推进来源自然日历史。

| 阶段 | 状态 | 上游状态 | 当日新鲜 | 通知边界 |
|---|---|---|---|---|
${stageRows}

## 一致性检查

${invariantRows}
`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function atomicWrite(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
  await writeFile(pending, body, { encoding: "utf8", flag: "wx" });
  await rename(pending, path);
}

export async function runDailyHealthCheck({ root = WEBSITE_DIR, now = new Date() } = {}) {
  const paths = {
    fast: "work/fast-daily/run.json",
    candidate: "work/candidate-source-probe/audit.json",
    diligence: "work/source-diligence/coverage.json",
    semantic: "work/semantic-review-dossiers/dossier.json",
    readiness: "work/source-promotion-readiness/readiness.json",
    scout: "work/evidence-gap-scout/audit.json",
    quality: "data/source-quality-latest.json",
    roleReview: "data/source-role-review-latest.json",
    top3: "data/top3-latest.json",
  };
  const entries = await Promise.all(Object.entries(paths).map(async ([key, relative]) => [key, await readJson(resolve(root, relative))]));
  const reportDate = shanghaiDate(now);
  const archive = await readJson(resolve(root, `public-pages/archive/${reportDate}/metadata.json`));
  const report = buildDailyHealth({ ...Object.fromEntries(entries), archive }, { now });
  const verification = verifyDailyHealth(report);
  if (!verification.ok) throw new Error(`daily health report rejected: ${verification.errors.join("; ")}`);
  await atomicWrite(resolve(root, "data/daily-health-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  await atomicWrite(resolve(root, "data/daily-health-latest.md"), renderDailyHealthMarkdown(report));
  return report;
}

async function main() {
  const report = await runDailyHealthCheck();
  process.stdout.write(`${JSON.stringify({ status: report.status, ...report.summary }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
