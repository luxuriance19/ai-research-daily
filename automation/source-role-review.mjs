#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(AUTOMATION_DIR, "..");
const list = (value) => Array.isArray(value) ? value : [];
const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");
const allowedDecisions = Object.freeze(["retain-daily", "move-to-low-frequency", "manual-watchlist-only", "reject-unattended"]);
const laneLabels = Object.freeze({ mechanism: "论文与机制", "model-compute": "模型与算力", "technology-attention": "技术与关注" });
const roleLabels = Object.freeze({
  "official-primary-or-contract": "官方一手 / 版本化规范",
  "primary-paper-index": "一手论文索引",
  "research-or-artifact-discovery": "研究 / Artifact 发现",
  "attention-paper-discovery": "论文关注发现",
  "official-discovery": "官方发现",
  "artifact-discovery": "Artifact 发现",
  "official-release-discovery": "官方 Release 发现",
  "attention-only": "仅关注信号",
});

function priority(source) {
  return [
    source.observation?.ready_for_human_role_review === true ? 1 : 0,
    Number(source.today?.selected_top3_attributions || 0),
    Number(source.today?.eligible_candidate_attributions || 0),
    source.official === true || String(source.quality_role).includes("primary") || String(source.quality_role).includes("official") ? 1 : 0,
    Number(source.today?.editorial_exclusion_attributions || 0),
  ];
}

function compareSources(left, right) {
  const a = priority(left);
  const b = priority(right);
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return b[index] - a[index];
  return left.id.localeCompare(right.id);
}

export function buildSourceRoleReview(scorecard) {
  if (scorecard?.mode !== "discovery-source-quality-scorecard" || list(scorecard.sources).length !== 48) {
    throw new Error("source role review requires the verified 48-source scorecard");
  }
  if (scorecard.policy?.human_decision_required !== true || scorecard.policy?.automatic_pruning_enabled !== false || scorecard.policy?.automatic_promotion_enabled !== false || scorecard.policy?.ranking_impact !== "none" || scorecard.policy?.notification_enabled !== false) {
    throw new Error("source role review input crossed the human decision boundary");
  }
  const sources = [...scorecard.sources].sort(compareSources).map((source, reviewIndex) => ({
    review_order: reviewIndex + 1,
    source_id: source.id,
    label: source.label,
    lane: source.lane,
    lane_label: laneLabels[source.lane] || source.lane,
    current_quality_role: source.quality_role,
    current_quality_role_label: roleLabels[source.quality_role] || source.quality_role,
    current_configured_tier: source.configured_tier,
    official: source.official,
    health_state: source.health?.state,
    source_status: source.health?.source_status,
    consecutive_healthy_days: source.observation?.scorecard_consecutive_healthy_days || 0,
    required_days: source.observation?.required_days_for_role_review || scorecard.policy.minimum_silent_days_for_role_review,
    review_eligible: source.observation?.ready_for_human_role_review === true,
    current_window_attributions: source.today?.current_window_attributions || 0,
    editorial_exclusion_attributions: source.today?.editorial_exclusion_attributions || 0,
    eligible_candidate_attributions: source.today?.eligible_candidate_attributions || 0,
    selected_top3_attributions: source.today?.selected_top3_attributions || 0,
    system_observation: source.recommendation,
    allowed_human_decisions: [...allowedDecisions],
    human_decision: null,
    reviewer: null,
    reviewed_at: null,
    rationale: null,
    automatic_role_change: false,
    ranking_impact: "none",
    notification_eligible: false,
  }));
  const report = {
    schema_version: 1,
    mode: "source-role-human-review-worksheet",
    generated_at: scorecard.generated_at,
    report_date: scorecard.report_date,
    source_scorecard_fingerprint: scorecard.report_fingerprint,
    status: sources.some((source) => source.review_eligible) ? "awaiting-human-decisions" : "waiting-for-seven-natural-days",
    policy: {
      minimum_natural_days: scorecard.policy.minimum_silent_days_for_role_review,
      human_decision_required: true,
      automatic_role_changes_allowed: false,
      automatic_pruning_allowed: false,
      ranking_impact: "none",
      notification_enabled: false,
      publishing_enabled: false,
    },
    summary: {
      registered_sources: sources.length,
      eligible_for_human_review: sources.filter((source) => source.review_eligible).length,
      waiting_for_observation: sources.filter((source) => !source.review_eligible).length,
      completed_human_decisions: 0,
      notification_eligible_records: 0,
    },
    sources,
    external_actions: [],
  };
  report.report_fingerprint = sha256(JSON.stringify(report));
  return report;
}

export function verifySourceRoleReview(report, scorecard) {
  const errors = [];
  if (report?.mode !== "source-role-human-review-worksheet") errors.push("invalid source role review mode");
  if (report?.source_scorecard_fingerprint !== scorecard?.report_fingerprint) errors.push("source role review fingerprint binding mismatch");
  if (list(report?.sources).length !== 48 || new Set(list(report?.sources).map((source) => source.source_id)).size !== 48) errors.push("source role review must contain 48 unique sources");
  if (report?.policy?.human_decision_required !== true || report?.policy?.automatic_role_changes_allowed !== false || report?.policy?.automatic_pruning_allowed !== false || report?.policy?.ranking_impact !== "none" || report?.policy?.notification_enabled !== false || report?.policy?.publishing_enabled !== false) errors.push("source role review action boundary violated");
  if (report?.summary?.completed_human_decisions !== 0 || report?.summary?.notification_eligible_records !== 0 || list(report?.external_actions).length) errors.push("source role review manufactured a decision or external action");
  for (const source of list(report?.sources)) {
    const scoreSource = list(scorecard?.sources).find((item) => item.id === source.source_id);
    if (!scoreSource || source.review_eligible !== scoreSource.observation?.ready_for_human_role_review) errors.push(`source review eligibility mismatch: ${source.source_id}`);
    if (source.human_decision !== null || source.reviewer !== null || source.reviewed_at !== null || source.rationale !== null) errors.push(`source review worksheet prefilled a human decision: ${source.source_id}`);
    if (source.automatic_role_change !== false || source.ranking_impact !== "none" || source.notification_eligible !== false) errors.push(`source review source action boundary violated: ${source.source_id}`);
    if (JSON.stringify(source.allowed_human_decisions) !== JSON.stringify(allowedDecisions)) errors.push(`source review decision vocabulary drift: ${source.source_id}`);
  }
  const clone = structuredClone(report);
  delete clone.report_fingerprint;
  if (report?.report_fingerprint !== sha256(JSON.stringify(clone))) errors.push("source role review report fingerprint mismatch");
  return { ok: errors.length === 0, errors };
}

const escapeCell = (value) => String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");

export function renderSourceRoleReviewMarkdown(report) {
  const eligible = report.sources.filter((source) => source.review_eligible);
  const waiting = report.sources.filter((source) => !source.review_eligible);
  const table = (sources) => [
    "| 顺序 | 来源 | 分组 | 当前角色 | 健康 | 观察 | Top贡献 | 排除归因 | 人工决策 |",
    "|---:|---|---|---|---|---:|---:|---:|---|",
    ...sources.map((source) => `| ${source.review_order} | ${escapeCell(source.label || source.source_id)}<br><code>${escapeCell(source.source_id)}</code> | ${escapeCell(source.lane_label)} | ${escapeCell(source.current_quality_role_label)} | ${escapeCell(source.health_state)} | ${source.consecutive_healthy_days}/${source.required_days} | ${source.selected_top3_attributions} | ${source.editorial_exclusion_attributions} | ${source.review_eligible ? "□ 保留每日 □ 降低频率 □ 仅人工 □ 拒绝无人值守" : "未到签字门槛"} |`),
  ].join("\n");
  return `# AI 日报来源角色人工审阅表

- 报告日期：${report.report_date}（Asia/Shanghai）
- 来源账本指纹：\`${report.source_scorecard_fingerprint}\`
- 审阅表指纹：\`${report.report_fingerprint}\`
- 当前状态：\`${report.status}\`
- 可签字：${eligible.length}/48；等待真实自然日：${waiting.length}/48

## 审阅边界

这张表只准备人工决策，不自动删源、升降级、影响 Top 3、通知或发布。健康、权威、关注度和 Top 贡献是不同事实。单日排除多只代表本日噪声观察，不能直接判定来源无价值。

人工只能选择四种明确决策：\`retain-daily\`、\`move-to-low-frequency\`、\`manual-watchlist-only\`、\`reject-unattended\`。决策必须绑定上方来源账本指纹并填写审阅者、时间和理由。

## 已达到七日门槛，可人工签字（${eligible.length}）

${eligible.length ? table(eligible) : "当前没有来源达到七个连续自然日。不得提前签字，也不得以同日复跑补足天数。"}

## 等待真实自然日观察（${waiting.length}）

${table(waiting)}

## 人工复核问题

1. 这个端点提供的是事实/Artifact 身份，还是只提供关注信号？
2. 它的角色是否与当前配置一致，是否存在把媒体热度当证据的错层？
3. Top 贡献是否来自可定位的一手身份，而不是重复报道或旧页面更新时间？
4. 排除归因是否连续出现，并且属于结构性噪声而非单日样本？
5. 降频或拒绝后，是否仍有另一条独立路径覆盖同类高质量事件？
`;
}

async function atomicWrite(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.pending`;
  await writeFile(temporary, body, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

export async function syncSourceRoleReview({
  scorecardPath = resolve(WEBSITE_DIR, "data/source-quality-latest.json"),
  outputPath = resolve(WEBSITE_DIR, "data/source-role-review-latest.json"),
  markdownPath = resolve(WEBSITE_DIR, "data/source-role-review-latest.md"),
} = {}) {
  const scorecard = JSON.parse(await readFile(scorecardPath, "utf8"));
  const report = buildSourceRoleReview(scorecard);
  const verification = verifySourceRoleReview(report, scorecard);
  if (!verification.ok) throw new Error(`source role review rejected: ${verification.errors.join("; ")}`);
  await atomicWrite(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  await atomicWrite(markdownPath, renderSourceRoleReviewMarkdown(report));
  return report;
}

async function main() {
  const report = await syncSourceRoleReview({
    scorecardPath: resolve(process.env.SOURCE_QUALITY_SITE_DATA_PATH || "data/source-quality-latest.json"),
    outputPath: resolve(process.env.SOURCE_ROLE_REVIEW_PATH || "data/source-role-review-latest.json"),
    markdownPath: resolve(process.env.SOURCE_ROLE_REVIEW_MARKDOWN_PATH || "data/source-role-review-latest.md"),
  });
  process.stdout.write(`${JSON.stringify({ status: report.status, eligible: report.summary.eligible_for_human_review, waiting: report.summary.waiting_for_observation }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
