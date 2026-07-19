#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_DAYS = 7;
const array = (value) => Array.isArray(value) ? value : [];
const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");

const RADAR_CONFIG = Object.freeze([
  {
    id: "claude-constitution",
    layer: "B0",
    title: "Claude Constitution",
    topic_id: "claude-constitution",
    thesis_zh: "追踪的是版本化行为规范、权衡顺序与权限边界；它描述 intended behavior，不是模型权重中的已学习机制。",
    boundary_zh: "只有官方版本 diff 加人工语义复核，才能称为规范变化；不能据此声称线上 Claude 已完全遵守。",
    primary_url: "https://github.com/anthropics/claude-constitution",
    source_ids: ["claude-constitution-tree", "claude-constitution-readme"],
  },
  {
    id: "ouro-looplm",
    layer: "M1 / M3",
    title: "Ouro / Looped Language Model",
    topic_id: "ouro-looplm",
    thesis_zh: "核心是循环复用层块增加有效深度，并在完整 recurrent loops 后选择输出状态；公开权重与 config 可以审计实现边界。",
    boundary_zh: "当前不能把 state selection 写成自适应提前退出，也不能声称已经证明计算节省、因果泛化或完整训练复现。",
    primary_url: "https://arxiv.org/abs/2510.25741v5",
    source_ids: ["latent-reasoning-arxiv-seeds", "ouro-family-1-4b-model", "ouro-family-1-4b-thinking-model", "ouro-family-2-6b-model", "ouro-family-2-6b-thinking-model"],
  },
  {
    id: "coconut-continuous-thought",
    layer: "M1 / M3",
    title: "Coconut / Continuous Latent Thought",
    topic_id: "coconut-continuous-thought",
    thesis_zh: "核心是把连续隐藏状态反馈为下一步计算输入，而不是每一步都解码为自然语言 token；这是一种计算路径，不等于可解释思维。",
    boundary_zh: "官方代码不自动证明 latent state 忠实、具备 BFS 语义或跨 backbone 泛化；独立轨迹诊断仍缺原始隐藏状态链和完整因果验证。",
    primary_url: "https://arxiv.org/abs/2412.06769v3",
    source_ids: ["latent-reasoning-arxiv-seeds", "latent-cot-dynamics-arxiv", "latent-cot-dynamics-commits", "latent-cot-vanilla-coconut-model", "latent-cot-simcot-coconut-model"],
  },
  {
    id: "harness-progress",
    layer: "H1 / E1",
    title: "Agent & Evaluation Harness",
    topic_ids: ["agent-harness", "evaluation-harness"],
    thesis_zh: "上下文、memory、tools、sandbox、重试、并行、grader 与 task version 会共同塑造系统能力和可比性，不能把结果只归因于模型。",
    boundary_zh: "release 只证明版本发生；要声称能力提升，必须固定 model、task、environment、budget 与 grader 做前后对照。",
    primary_url: "https://github.com/UKGovernmentBEIS/inspect_evals/releases",
    source_ids: ["openai-agents-sdk-releases", "claude-agent-sdk-releases", "google-adk-releases", "inspect-evals-releases"],
  },
]);

function topicClaims(diligenceAudit, config) {
  const ids = new Set(config.topic_ids || [config.topic_id]);
  return array(diligenceAudit?.topics).filter((topic) => ids.has(topic.id)).flatMap((topic) => array(topic.claims));
}

function claimMetrics(claims) {
  const counts = { source_ready: 0, human_review_required: 0, evidence_gap: 0 };
  for (const claim of claims) {
    if (claim.status === "source-ready") counts.source_ready += 1;
    else if (claim.status === "human-review-required") counts.human_review_required += 1;
    else if (claim.status === "evidence-gap") counts.evidence_gap += 1;
  }
  return counts;
}

function sourceObservation(candidateAudit, sourceIds) {
  const historyById = new Map(array(candidateAudit?.source_history).map((item) => [item.source_id, item]));
  const histories = sourceIds.map((id) => historyById.get(id)).filter(Boolean);
  if (histories.length !== sourceIds.length) throw new Error("mechanism radar source binding missing from candidate audit");
  const observedDays = Math.min(...histories.map((item) => Number(item?.criteria?.minimum_observation_days?.observed || 0)));
  const degradedSources = histories.filter((item) => !["fresh", "not-modified"].includes(item.current_status)).map((item) => item.source_id);
  const reviewFlags = [...new Set(histories.flatMap((item) => array(item.review_flags)))];
  return {
    observed_days: observedDays,
    required_days: REQUIRED_DAYS,
    state: degradedSources.length ? "degraded" : observedDays >= REQUIRED_DAYS ? "await-human-source-review" : "observing",
    degraded_source_count: degradedSources.length,
    review_flag_count: reviewFlags.length,
    human_review_complete: histories.every((item) => item?.criteria?.human_source_review?.passed === true),
  };
}

function unavailableSourceObservation() {
  return {
    observed_days: 0,
    required_days: REQUIRED_DAYS,
    state: "supplemental-audit-not-run",
    degraded_source_count: 0,
    review_flag_count: 0,
    human_review_complete: false,
  };
}

export function buildCriticalPathMechanismRadarSiteData(generatedAt) {
  const timestamp = new Date(generatedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("critical-path mechanism radar requires a valid generated_at");
  const siteData = {
    schema_version: 1,
    mode: "local-mechanism-radar-site-snapshot",
    generated_at: timestamp.toISOString(),
    status: "awaiting-supplemental-audits",
    manual_review_only: true,
    notification_enabled: false,
    publishing_enabled: false,
    supplemental_audits_available: false,
    current_event_candidates: 0,
    cards: RADAR_CONFIG.map((config) => ({
      id: config.id,
      layer: config.layer,
      title: config.title,
      thesis_zh: config.thesis_zh,
      boundary_zh: config.boundary_zh,
      primary_url: config.primary_url,
      current_event: false,
      attention_level: "A0",
      claim_metrics: claimMetrics([]),
      source_observation: unavailableSourceObservation(),
    })),
  };
  siteData.snapshot_fingerprint = sha256(JSON.stringify(siteData));
  return siteData;
}

export function buildMechanismRadarSiteData(candidateAudit, diligenceAudit) {
  if (candidateAudit?.mode !== "shadow-source-probe") throw new Error("unexpected candidate audit mode");
  if (diligenceAudit?.mode !== "source-diligence-audit") throw new Error("unexpected source diligence mode");
  const generatedAt = new Date(Math.max(Date.parse(candidateAudit.generated_at), Date.parse(diligenceAudit.generated_at))).toISOString();
  const cards = RADAR_CONFIG.map((config) => {
    const claims = topicClaims(diligenceAudit, config);
    return {
      id: config.id,
      layer: config.layer,
      title: config.title,
      thesis_zh: config.thesis_zh,
      boundary_zh: config.boundary_zh,
      primary_url: config.primary_url,
      current_event: false,
      attention_level: array(diligenceAudit.topics).find((topic) => (config.topic_ids || [config.topic_id]).includes(topic.id))?.attention?.level || "A0",
      claim_metrics: claimMetrics(claims),
      source_observation: sourceObservation(candidateAudit, config.source_ids),
    };
  });
  const siteData = {
    schema_version: 1,
    mode: "local-mechanism-radar-site-snapshot",
    generated_at: generatedAt,
    status: cards.some((card) => card.source_observation.state === "degraded") ? "degraded" : "observing",
    manual_review_only: true,
    notification_enabled: false,
    publishing_enabled: false,
    current_event_candidates: Number(diligenceAudit?.metrics?.claims_with_current_event_candidates || 0),
    cards,
  };
  siteData.snapshot_fingerprint = sha256(JSON.stringify(siteData));
  return siteData;
}

export function verifyMechanismRadarSiteData(siteData) {
  const errors = [];
  if (siteData?.mode !== "local-mechanism-radar-site-snapshot") errors.push("unexpected mechanism radar mode");
  if (siteData?.manual_review_only !== true || siteData?.notification_enabled !== false || siteData?.publishing_enabled !== false) errors.push("mechanism radar crossed review boundary");
  if (array(siteData?.cards).length !== RADAR_CONFIG.length) errors.push("mechanism radar must expose exactly four audited research tracks");
  if (array(siteData?.cards).some((card) => card.current_event !== false)) errors.push("long-term radar cannot manufacture a current event");
  if (array(siteData?.cards).some((card) => !card.primary_url || !card.boundary_zh || !card.source_observation)) errors.push("mechanism radar card missing source or proof boundary");
  return { ok: errors.length === 0, errors };
}

async function atomicWrite(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
  await writeFile(pending, body, { encoding: "utf8", flag: "wx" });
  await rename(pending, path);
}

export async function syncMechanismRadarSiteData({
  candidatePath = resolve("work/candidate-source-probe/audit.json"),
  diligencePath = resolve("work/source-diligence/coverage.json"),
  mechanismPath = resolve("work/mechanism-watch/audit.json"),
  outputPath = resolve("data/mechanism-radar-latest.json"),
} = {}) {
  const readOptionalJson = async (path) => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const [candidateAudit, diligenceAudit, mechanismAudit] = await Promise.all([
    readOptionalJson(candidatePath),
    readOptionalJson(diligencePath),
    readFile(mechanismPath, "utf8").then(JSON.parse),
  ]);
  const siteData = candidateAudit && diligenceAudit
    ? buildMechanismRadarSiteData(candidateAudit, diligenceAudit)
    : buildCriticalPathMechanismRadarSiteData(mechanismAudit.generated_at);
  const verified = verifyMechanismRadarSiteData(siteData);
  if (!verified.ok) throw new Error(verified.errors.join("; "));
  await atomicWrite(outputPath, `${JSON.stringify(siteData, null, 2)}\n`);
  return siteData;
}

async function main() {
  const siteData = await syncMechanismRadarSiteData({
    candidatePath: resolve(process.env.MECHANISM_RADAR_CANDIDATE_PATH || "work/candidate-source-probe/audit.json"),
    diligencePath: resolve(process.env.MECHANISM_RADAR_DILIGENCE_PATH || "work/source-diligence/coverage.json"),
    mechanismPath: resolve(process.env.MECHANISM_RADAR_MECHANISM_PATH || "work/mechanism-watch/audit.json"),
    outputPath: resolve(process.env.MECHANISM_RADAR_OUTPUT_PATH || "data/mechanism-radar-latest.json"),
  });
  process.stdout.write(`${JSON.stringify({ status: siteData.status, cards: siteData.cards.length, current_events: siteData.current_event_candidates }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
