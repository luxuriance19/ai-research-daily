#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 500_000;
const REQUEST_TIMEOUT_MS = 15_000;
const STALE_CACHE_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;
const ALLOWED_DETAIL_HOSTS = new Set([
  "kimi.com",
  "www.kimi.com",
  "mistral.ai",
  "thinkingmachines.ai",
  "developer.nvidia.com",
  "nvidianews.nvidia.com",
]);

export const TOP3_EVIDENCE_POLICY = Object.freeze({
  schema_version: 1,
  mode: "top3-claim-specific-evidence-dossier",
  selected_input_limit: 3,
  official_detail_fetch_only_after_selection: true,
  maximum_detail_requests: 3,
  max_response_bytes: MAX_RESPONSE_BYTES,
  stale_cache_hours: STALE_CACHE_HOURS,
  deterministic_extraction_only: true,
  independent_verification_required: true,
  notification_enabled: false,
  publishing_enabled: false,
  external_actions: Object.freeze([]),
});

const array = (value) => Array.isArray(value) ? value : [];
const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");

function decodeEntities(value) {
  return String(value || "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export function normalizeOfficialHtml(html) {
  return decodeEntities(String(html || "")
    .replace(/<(?:script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg)>/gi, "\n")
    .replace(/<(?:br|\/p|\/div|\/section|\/article|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function excerptContaining(text, patterns, maximum = 900) {
  const lines = String(text || "").split("\n");
  const line = lines.find((candidate) => patterns.every((pattern) => pattern.test(candidate)));
  if (!line) return "";
  return line.slice(0, maximum);
}

function excerptAround(text, pattern, maximum = 700) {
  const value = String(text || "");
  const match = value.match(pattern);
  if (!match || match.index === undefined) return "";
  const start = Math.max(0, value.lastIndexOf("\n", match.index) + 1);
  const end = value.indexOf("\n", match.index);
  return value.slice(start, end < 0 ? start + maximum : Math.min(end, start + maximum));
}

const GENERIC_MODEL_CATEGORIES = Object.freeze([
  { topic: "architecture-candidate", layer: "M1", patterns: [/\barchitecture\b/i, /\battention\b/i, /\bMoE\b|mixture of experts/i, /\brecurrent\b|state space|latent/i], label: "架构与信息流" },
  { topic: "training-candidate", layer: "M2", patterns: [/\btraining\b|pretrain|post-train/i, /\bSFT\b|reinforcement learning|distill|optimizer/i], label: "训练目标与稳定性" },
  { topic: "systems-candidate", layer: "C1-C4", patterns: [/quantiz|\bFP[0-9]+\b|\bINT[0-9]+\b/i, /kernel|compiler|parallel|throughput|accelerator|inference/i], label: "低精度与计算系统" },
  { topic: "availability-candidate", layer: "model-release", patterns: [/weights|model card|license|technical report|\bAPI\b|available/i], label: "Artifact 与可用性" },
  { topic: "harness-candidate", layer: "H1", patterns: [/harness|agentic|tool use|sandbox|session|thinking history|context management/i], label: "Harness 与运行状态" },
  { topic: "evaluation-candidate", layer: "E1", patterns: [/benchmark|evaluation|judge|temperature|top-p|turn limit/i], label: "评测协议与可比性" },
]);

const GENERIC_SIGNALS = Object.freeze([
  /\b\d+(?:\.\d+)?[BTM]\b/gi,
  /\b\d+\s*(?:out of|of|\/)\s*\d+\b/gi,
  /\b(?:MoE|MLA|GQA|MHA|KDA|SFT|RLHF|DPO|GRPO|FP\d+|MXFP\d+|INT\d+)\b/gi,
  /\b(?:attention|recurrent|latent|router|optimizer|quantization|kernel|compiler|harness|weights|license|technical report)\b/gi,
]);

function genericSignals(excerpt) {
  const values = [];
  for (const pattern of GENERIC_SIGNALS) for (const match of String(excerpt || "").matchAll(pattern)) values.push(match[0]);
  return [...new Set(values.map((value) => value.toLowerCase()))].slice(0, 12);
}

function bestGenericExcerpt(text, patterns) {
  const lines = String(text || "").split("\n");
  const ranked = lines.map((line) => ({ line, score: patterns.filter((pattern) => pattern.test(line)).length }))
    .filter((entry) => entry.score > 0 && entry.line.length >= 50)
    .sort((left, right) => right.score - left.score || right.line.length - left.line.length);
  return ranked[0]?.line.slice(0, 900) || "";
}

function evidenceClaim({ topic, layer, statement, excerpt, ceiling, state, boundary, sourceUrl, sourceIdentity, excerptKind = "primary-source-excerpt" }) {
  return {
    topic,
    mechanism_layer: layer,
    statement_zh: statement,
    evidence_excerpt: excerpt,
    evidence_excerpt_sha256: sha256(excerpt),
    evidence_excerpt_kind: excerptKind,
    source_url: sourceUrl,
    source_identity: sourceIdentity,
    evidence_ceiling: ceiling,
    verification_state: state,
    boundary,
    requires_human_review: true,
    claim_evidence_allowed: false,
    notification_eligible: false,
  };
}

function semanticClaimForTopic(semanticReviewAudit, topicId, claimId) {
  return array(semanticReviewAudit?.packages)
    .flatMap((reviewPackage) => array(reviewPackage?.claims))
    .find((claim) => claim?.topic_id === topicId && claim?.claim_id === claimId);
}

function sourceUrlForEvidence(evidence, fallbackUrl) {
  const identity = String(evidence?.observed_identity || "");
  const arxiv = identity.match(/^arxiv:(\d{4}\.\d{4,5})(?:v\d+)?$/i)?.[1];
  if (arxiv) return `https://arxiv.org/abs/${arxiv}`;
  const model = identity.match(/^model:([^;]+)/i)?.[1];
  if (model) return `https://huggingface.co/${model}`;
  if (evidence?.ref === "production:coconut-code") return "https://github.com/facebookresearch/coconut";
  if (evidence?.ref === "production:ouro-model") return "https://huggingface.co/ByteDance/Ouro-2.6B";
  return fallbackUrl;
}

function diligenceEvidenceClaim({ evidence, topic, layer, statement, ceiling, state, fallbackUrl, boundary }) {
  const excerpt = `${evidence.label}: ${evidence.proves}`;
  return evidenceClaim({
    topic,
    layer,
    statement,
    excerpt,
    excerptKind: "source-diligence-contract",
    ceiling,
    state,
    boundary: boundary || evidence.does_not_prove,
    sourceUrl: sourceUrlForEvidence(evidence, fallbackUrl),
    sourceIdentity: evidence.observed_identity,
  });
}

const K3_CLAIMS = Object.freeze([
  {
    topic: "architecture-information-flow",
    layer: "M1",
    patterns: [/Kimi Delta Attention \(KDA\)/i, /Attention Residuals \(AttnRes\)/i, /selectively retrieves representations across depth/i],
    statement: "架构主干由 KDA 与 AttnRes 组成：前者面向长序列注意力效率，后者不是逐层均匀累积残差，而是跨深度选择性取回表征。",
    ceiling: "G1-official-author-architecture-claim",
    state: "author-claimed-not-independently-verified",
    boundary: "官方博客尚未提供技术报告、消融或可复现权重，不能把信息流设计写成已证明的能力因果。",
  },
  {
    topic: "sparse-moe-routing",
    layer: "M1",
    patterns: [/Stable LatentMoE/i, /16 out of 896 experts/i],
    statement: "模型采用高稀疏 MoE：896 个专家中每次有效激活 16 个，并以 Stable LatentMoE 处理该稀疏度下的路由与训练稳定性。",
    ceiling: "G1-official-author-architecture-claim",
    state: "author-claimed-not-independently-verified",
    boundary: "没有公开 router 日志、专家负载分布或 matched-compute 消融，不能确认稀疏度本身带来多少增益。",
  },
  {
    topic: "training-stability",
    layer: "M2",
    patterns: [/Quantile Balancing/i, /Per-Head Muon/i, /Sigmoid Tanh Unit/i],
    statement: "训练侧披露 Quantile Balancing、Per-Head Muon、SiTU 与 Gated MLA，分别针对专家分配、注意力头优化、激活控制和注意力选择性。",
    ceiling: "G1-official-author-training-claim",
    state: "author-claimed-not-independently-verified",
    boundary: "训练配方、超参数、日志与逐项消融尚未公开，不能判断各组件的独立贡献。",
  },
  {
    topic: "low-precision-and-serving",
    layer: "C1-C4",
    patterns: [/quantization-aware training/i, /MXFP4 weights/i, /MXFP8 activations/i],
    statement: "从 SFT 开始使用量化感知训练，权重为 MXFP4、激活为 MXFP8；官方同时披露静态形状、关键路径无 host synchronization 的专家并行方案。",
    ceiling: "G1-official-author-systems-claim",
    state: "author-claimed-not-independently-verified",
    boundary: "未给出完整硬件、吞吐、质量回退和同预算基线，不能写成已验证的效率提升。",
  },
  {
    topic: "artifact-availability",
    layer: "model-release",
    patterns: [/full model weights will be released by July 27, 2026/i, /technical report/i],
    statement: "当前可用的是产品与 API；完整权重承诺于 2026-07-27 发布，架构、训练和评测的更多细节承诺随技术报告公布。",
    ceiling: "T4-official-availability-and-future-commitment",
    state: "announced-not-yet-delivered",
    boundary: "在权重、许可证、revision 与技术报告实际出现前，不能标记为开放权重、可复现或 A3/A4 已满足。",
  },
  {
    topic: "harness-state-coupling",
    layer: "H1",
    patterns: [/preserved thinking history mode/i, /pass back all the historical thinking content/i],
    statement: "K3 对 Harness 有显式状态契约：训练采用 preserved thinking history，Harness 若未完整回传历史 thinking，或会话中途切换模型，生成质量可能不稳定。",
    ceiling: "G1-official-author-limitation",
    state: "author-reported-operational-limitation",
    boundary: "这是官方限制说明，不等于已完成跨 Harness 的受控复现；评测与部署必须记录历史状态传递策略。",
  },
  {
    topic: "benchmark-harness-comparability",
    layer: "E1",
    patterns: [/three agentic harnesses/i, /KimiCode/i, /Claude Code/i, /Codex/i],
    statement: "官方完整表明确混用了 KimiCode、Claude Code 与 Codex 三种 agentic harness；模型分数不能脱离 Harness、reasoning effort、turn limit 和 context-management 配置直接横比。",
    ceiling: "T4-official-evaluation-protocol-description",
    state: "comparability-not-established",
    boundary: "跨 Harness 最优分数不是固定协议重跑，不能把差异全部归因于模型底层能力。",
  },
]);

function buildK3Dossier(item, snapshot) {
  const sourceIdentity = `response-sha256:${snapshot.content_sha256}`;
  const claims = [];
  const missing = [];
  for (const profile of K3_CLAIMS) {
    const excerpt = excerptContaining(snapshot.normalized_text, profile.patterns);
    if (!excerpt) {
      missing.push(profile.topic);
      continue;
    }
    claims.push(evidenceClaim({
      ...profile,
      excerpt,
      sourceUrl: item.canonical_url,
      sourceIdentity,
    }));
  }
  return {
    profile: "kimi-k3-official-technical-blog-v1",
    evidence_status: claims.length && !missing.length ? "source-audited-manual-review" : "partial-evidence",
    primary_sources: [{
      source_url: snapshot.url,
      source_identity: sourceIdentity,
      fetch_status: snapshot.status,
      fetched_at: snapshot.fetched_at,
      response_bytes: snapshot.response_bytes,
      normalized_text_sha256: snapshot.normalized_text_sha256,
      authority_scope: "official author claims and availability state only",
    }],
    key_points: claims,
    evidence_gaps: [
      ...missing.map((topic) => `official-profile-excerpt-missing:${topic}`),
      "technical-report-not-yet-published",
      "weights-license-and-immutable-revision-not-yet-observed",
      "no-independent-matched-harness-reproduction",
      "no-public-component-ablation-or-training-logs",
    ],
  };
}

function buildGenericModelDossier(item, snapshot) {
  const sourceIdentity = `response-sha256:${snapshot.content_sha256}`;
  const claims = [];
  for (const category of GENERIC_MODEL_CATEGORIES) {
    const excerpt = bestGenericExcerpt(snapshot.normalized_text, category.patterns);
    if (!excerpt) continue;
    const signals = genericSignals(excerpt);
    claims.push(evidenceClaim({
      topic: category.topic,
      layer: category.layer,
      statement: `官方详情页存在“${category.label}”候选段落${signals.length ? `，可定位信号包括：${signals.join("、")}` : ""}；必须由人工确认这些词在该模型中的确切计算含义。`,
      excerpt,
      ceiling: "G0-official-excerpt-awaiting-model-specific-review",
      state: "candidate-excerpt-human-review-required",
      boundary: "通用抽取只负责定位原文，不能自动判定技术新颖性、组件因果贡献、开放状态或性能成立。",
      sourceUrl: item.canonical_url,
      sourceIdentity,
    }));
  }
  return {
    profile: "generic-official-model-release-v1",
    evidence_status: claims.length ? "source-excerpts-awaiting-model-specific-review" : "partial-evidence",
    primary_sources: [{
      source_url: snapshot.url,
      source_identity: sourceIdentity,
      fetch_status: snapshot.status,
      fetched_at: snapshot.fetched_at,
      response_bytes: snapshot.response_bytes,
      normalized_text_sha256: snapshot.normalized_text_sha256,
      authority_scope: "official author excerpts only; model-specific semantics unreviewed",
    }],
    key_points: claims,
    evidence_gaps: [
      "model-specific-claim-profile-and-human-semantic-review-required",
      "artifact-availability-must-be-verified-separately",
      "no-independent-matched-protocol-reproduction",
    ],
  };
}

function releaseForItem(item, candidateAudit, techAudit) {
  const techSourceId = array(item.source_ids).find((sourceId) => sourceId === "official-github-releases-existing-snapshots");
  if (!techSourceId) return null;
  const tag = item.canonical_url.match(/\/releases\/tag\/([^/?#]+)/)?.[1];
  const repository = item.canonical_url.match(/github\.com\/([^/]+\/[^/]+)\/releases/)?.[1]?.toLowerCase();
  if (!tag || !repository) return null;
  for (const event of array(candidateAudit?.source_events)) {
    for (const release of array(event?.snapshot?.releases)) {
      if (String(release.repository || "").toLowerCase() === repository && release.tag_name === tag) return { event, release };
    }
  }
  for (const event of array(techAudit?.source_events)) {
    if (event?.source_id !== techSourceId) continue;
    const techItem = array(event?.items).find((record) => record?.canonical_url === item.canonical_url);
    const hint = techItem?.primary_identity_hint;
    if (!techItem || !hint || String(hint.repository || "").toLowerCase() !== repository || hint.tag_name !== tag) continue;
    const bodyExcerpt = String(techItem.summary_for_discovery_only || "");
    const snapshotIdentity = sha256(JSON.stringify({
      repository: hint.repository,
      release_id: hint.release_id,
      tag_name: hint.tag_name,
      body_sha256: hint.body_sha256,
      body_excerpt_sha256: hint.body_excerpt_sha256,
      target_commitish: hint.target_commitish,
      immutable: hint.immutable === true,
    }));
    return {
      event,
      release: {
        id: hint.release_id,
        repository: hint.repository,
        tag_name: hint.tag_name,
        release_snapshot_sha256: snapshotIdentity,
        body_sha256: hint.body_sha256,
        body_excerpt: bodyExcerpt,
        body_excerpt_sha256: hint.body_excerpt_sha256,
        body_excerpt_truncated: bodyExcerpt.length >= 1000,
        immutable: hint.immutable === true,
        target_commitish: hint.target_commitish,
        tag_commit_resolution: "not-resolved-in-critical-path",
      },
    };
  }
  return null;
}

function buildHarnessDossier(item, candidateAudit, techAudit) {
  const match = releaseForItem(item, candidateAudit, techAudit);
  if (!match) return {
    profile: "versioned-harness-release",
    evidence_status: "missing-claim-specific-release-snapshot",
    primary_sources: [],
    key_points: [],
    evidence_gaps: ["exact-release-snapshot-not-found"],
  };
  const { event, release } = match;
  const sourceIdentity = `github-release-snapshot:${release.repository}@${release.release_snapshot_sha256}`;
  const claims = [];
  const body = release.body_excerpt || "";
  const sciKnow = excerptAround(body, /SciKnowEval/i, 1000);
  if (sciKnow) claims.push(evidenceClaim({
    topic: "scorer-semantics-sciknoweval",
    layer: "E1",
    statement: "SciKnowEval 的关系抽取评分原先用带 domain 前缀的 key 对照裸任务名，导致正确答案也落入占位 0 分路径；该版本改为先去除前缀，再运行 relation-extraction F1。",
    excerpt: sciKnow,
    ceiling: "T4-official-versioned-release-description",
    state: "artifact-change-human-review-required",
    boundary: "版本说明证明评分逻辑发生修复，但没有同一批模型的旧版/新版重跑，不能量化榜单变化。",
    sourceUrl: item.canonical_url,
    sourceIdentity,
  }));
  const abstention = excerptAround(body, /AbstentionBench/i, 1000);
  if (abstention) claims.push(evidenceClaim({
    topic: "scorer-semantics-abstentionbench",
    layer: "E1",
    statement: "AbstentionBench 原先把 Yes/No verdict 与“1.0”比较，并用无词边界的最左匹配正则，造成 abstention 判断和 recall/F1 系统性错误；该版本修正 verdict 转换与正则匹配边界。",
    excerpt: abstention,
    ceiling: "T4-official-versioned-release-description",
    state: "artifact-change-human-review-required",
    boundary: "修复意味着历史分数可能不可直接比较；实际影响仍需固定模型和样本的前后重跑。",
    sourceUrl: item.canonical_url,
    sourceIdentity,
  }));
  if (!claims.length && body) claims.push(evidenceClaim({
    topic: "versioned-harness-semantic-change",
    layer: item.mechanism_layer,
    statement: "官方 release 正文包含可定位的 Harness/Eval 语义变化，需人工确认其对任务、scorer、grader 或运行协议的影响。",
    excerpt: body.slice(0, 700),
    ceiling: "T4-official-versioned-release-description",
    state: "artifact-change-human-review-required",
    boundary: "release 发生和语义 cue 都不能证明模型能力提升或分数仍可比较。",
    sourceUrl: item.canonical_url,
    sourceIdentity,
  }));
  return {
    profile: "versioned-harness-release",
    evidence_status: claims.length ? "source-audited-manual-review" : "partial-evidence",
    primary_sources: [{
      source_url: item.canonical_url,
      source_identity: sourceIdentity,
      fetch_status: event.status,
      release_id: release.id,
      tag_name: release.tag_name,
      upstream_immutable: release.immutable === true,
      target_commitish: release.target_commitish,
      tag_commit_resolution: release.tag_commit_resolution,
      body_sha256: release.body_sha256,
      body_excerpt_sha256: release.body_excerpt_sha256,
      body_excerpt_truncated: release.body_excerpt_truncated,
      authority_scope: "official release occurrence and bounded release description only",
    }],
    key_points: claims,
    evidence_gaps: [
      ...(release.immutable === true ? [] : ["release-record-mutable-upstream"]),
      ...(release.tag_commit_resolution === "resolved" ? [] : ["release-tag-commit-not-resolved"]),
      "no-fixed-model-before-after-rerun",
      "score-comparability-not-established",
    ],
  };
}

function modelComputeItemForDossier(item, modelComputeAudit) {
  return array(modelComputeAudit?.daily_editorial_candidates).find((candidate) => candidate?.url === item.canonical_url
    || String(item.story_aliases || "").includes(candidate?.identity));
}

function buildComputeDossier(item, modelComputeAudit, snapshot) {
  const candidate = modelComputeItemForDossier(item, modelComputeAudit);
  if (candidate && ["official-compute-release", "official-compute-prerelease"].includes(candidate.kind)) {
    const metadata = candidate.metadata || {};
    const excerpt = String(metadata.release_body_excerpt || "");
    const sourceIdentity = `${candidate.identity};body-sha256:${metadata.release_body_hash}`;
    const cues = array(metadata.semantic_review?.technical_cues);
    const claims = excerpt ? [evidenceClaim({
      topic: "versioned-compute-semantic-change",
      layer: "C1-C4",
      statement: `官方版本正文包含可定位的算力/运行时技术变化；确定性语义 cue：${cues.join("、") || "未分类"}。`,
      excerpt,
      ceiling: "T4-official-versioned-release-description",
      state: "artifact-change-human-review-required",
      boundary: "release 正文与关键词只能证明版本描述发生，不能证明吞吐、延迟、质量或能力提升；性能结论仍需完整配置和同版本基线。",
      sourceUrl: item.canonical_url,
      sourceIdentity,
    })] : [];
    return {
      profile: "versioned-compute-release-v1",
      evidence_status: claims.length ? "source-audited-manual-review" : "partial-evidence",
      primary_sources: [{
        source_url: item.canonical_url,
        source_identity: sourceIdentity,
        fetch_status: array(modelComputeAudit?.source_events).find((event) => event.source_id === candidate.source_id)?.status || "unknown",
        body_sha256: metadata.release_body_hash,
        body_excerpt_sha256: metadata.release_body_excerpt_sha256,
        body_excerpt_truncated: metadata.release_body_excerpt_truncated,
        authority_scope: "official release occurrence and bounded release description only",
      }],
      key_points: claims,
      evidence_gaps: [
        "human-release-semantic-review-required",
        "no-complete-performance-configuration-and-matched-baseline",
        "release-occurrence-does-not-prove-capability-uplift",
      ],
    };
  }
  if (snapshot) {
    const generic = buildGenericModelDossier(item, snapshot);
    return {
      ...generic,
      profile: "generic-official-compute-article-v1",
      evidence_status: "source-excerpts-awaiting-compute-configuration-review",
      evidence_gaps: [
        "compute-event-and-version-identity-requires-human-review",
        "hardware-precision-batch-model-software-and-baseline-required",
        "no-independent-system-reproduction",
      ],
    };
  }
  return {
    profile: "unprofiled-compute-system",
    evidence_status: "manual-profile-required",
    primary_sources: [],
    key_points: [],
    evidence_gaps: ["compute-claim-configuration-profile-not-yet-reviewed"],
  };
}

function mechanismRecordForItem(item, mechanismAudit) {
  return [...array(mechanismAudit?.daily_current_window_records), ...array(mechanismAudit?.records)]
    .find((record) => record?.canonical_url === item.canonical_url
      || String(item.story_aliases || "").includes(record?.canonical_id));
}

function mechanismSeed(record) {
  const identity = [record?.canonical_id, record?.canonical_url, record?.title, ...array(record?.seed_ids), ...array(record?.source_ids)].join(" ").toLowerCase();
  if (identity.includes("claude-constitution") || identity.includes("anthropic-constitution")) return "claude-constitution";
  if (identity.includes("ouro")) return "ouro-looplm";
  if (identity.includes("coconut")) return "coconut-continuous-thought";
  return "";
}

function nestedPolicyDiff(value, depth = 0) {
  if (!value || depth > 5) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = nestedPolicyDiff(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const before = value.before_excerpt || value.before_text || value.previous_excerpt || "";
  const after = value.after_excerpt || value.after_text || value.current_excerpt || "";
  if (before || after) return { before, after };
  for (const [key, entry] of Object.entries(value)) {
    if (/diff|change|metadata/i.test(key)) {
      const found = nestedPolicyDiff(entry, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function buildConstitutionDossier(item, record, semanticReviewAudit) {
  const diff = nestedPolicyDiff(record.source_metadata);
  const policyClaim = semanticClaimForTopic(semanticReviewAudit, "claude-constitution", "official-text-change");
  const learnedClaim = semanticClaimForTopic(semanticReviewAudit, "claude-constitution", "learned-implementation");
  const sourceIdentity = record.canonical_id || `content-sha256:${record.source_content_hash}`;
  const keyPoints = [];
  if (diff) {
    const excerpt = [`Before: ${diff.before || "(new text)"}`, `After: ${diff.after || "(removed text)"}`].join("\n");
    keyPoints.push(evidenceClaim({
      topic: "intended-behavior-text-delta",
      layer: "B0",
      statement: "Claude Constitution 的版本化正文出现可定位文本变化；它描述的是公开 intended behavior，而不是模型内部权重或 circuit 的直接观测。",
      excerpt,
      ceiling: policyClaim?.evidence_ceiling_when_met || "G3-intended-policy-change-only",
      state: "versioned-policy-diff-human-semantic-review-required",
      boundary: "文本 diff 只能证明规范表达发生变化；语义重要性、训练采用情况、行为服从率和权重实现均需独立证据。",
      sourceUrl: item.canonical_url,
      sourceIdentity,
    }));
  }
  return {
    profile: "claude-constitution-versioned-policy-v1",
    evidence_status: keyPoints.length ? "source-audited-manual-review" : "policy-occurrence-without-semantic-diff",
    primary_sources: [{
      source_url: item.canonical_url,
      source_identity: sourceIdentity,
      evidence_grade: record.evidence_grade,
      artifact_types: array(record.artifact_types),
      authority_scope: "official versioned intended-behavior text only",
    }],
    key_points: keyPoints,
    evidence_gaps: [
      ...(diff ? [] : ["versioned-policy-before-after-diff-not-found"]),
      ...(array(learnedClaim?.missing_requirements).map((requirement) => requirement.required_next || requirement.label)),
      "policy-text-does-not-prove-learned-weight-implementation",
      "no-independent-intervention-ablation-or-compliance-rate",
    ],
  };
}

function buildOuroDossier(item, record, semanticReviewAudit) {
  const authored = semanticClaimForTopic(semanticReviewAudit, "ouro-looplm", "authored-mechanism");
  const adaptive = semanticClaimForTopic(semanticReviewAudit, "ouro-looplm", "adaptive-halting-compute-savings");
  const family = semanticClaimForTopic(semanticReviewAudit, "ouro-looplm", "official-model-family");
  const causal = semanticClaimForTopic(semanticReviewAudit, "ouro-looplm", "causal-generalization");
  const paper = array(authored?.evidence).find((entry) => /^arxiv:/i.test(entry?.observed_identity || ""));
  const artifact = array(authored?.evidence).find((entry) => entry?.ref === "production:ouro-model")
    || array(family?.evidence).find((entry) => sourceUrlForEvidence(entry, "") === item.canonical_url);
  const counter = array(causal?.evidence).find((entry) => entry?.evidence_polarity === "mixed" && entry?.healthy === true);
  const keyPoints = [];
  if (paper) keyPoints.push(diligenceEvidenceClaim({
    evidence: paper,
    topic: "looped-recurrent-depth",
    layer: "M1/M3",
    statement: "Ouro 作者论文把循环深度作为 test-time latent compute，并配合 exit-weighted 训练；这里仅保留作者架构主张，不把循环次数直接等同于通用推理能力。",
    ceiling: authored?.evidence_ceiling_when_met || "G2-author-attributed-no-adaptive-compute-claim",
    state: authored?.claim_verdict || "author-attributed-manual-review",
    fallbackUrl: item.canonical_url,
    boundary: paper.does_not_prove,
  }));
  if (artifact) keyPoints.push(diligenceEvidenceClaim({
    evidence: artifact,
    topic: "released-model-and-post-loop-selection",
    layer: "M3/artifact",
    statement: "公开权重、config 与推理代码可追溯；发布实现先运行预设 recurrent loops，再对已有 hidden state 做后验选择或混合，因此不能写成已实现动态提前停止。",
    ceiling: "T4-official-artifact-availability-only",
    state: artifact.healthy ? "artifact-observed-human-review-required" : "artifact-observed-from-stale-cache",
    fallbackUrl: item.canonical_url,
    boundary: artifact.does_not_prove,
  }));
  if (counter) keyPoints.push(diligenceEvidenceClaim({
    evidence: counter,
    topic: "independent-recurrence-boundary",
    layer: "M4",
    statement: "不同作者组已提供与 Ouro 直接相关或同类 recurrent-depth 的诊断，但当前证据只约束 readout、稳定性和局部干预边界，尚不能证明或否定循环深度的普遍因果作用。",
    ceiling: "G2-independent-diagnostic-boundary",
    state: "mixed-evidence-human-review-required",
    fallbackUrl: item.canonical_url,
    boundary: counter.does_not_prove,
  }));
  return {
    profile: "ouro-looped-latent-reasoning-v1",
    evidence_status: authored?.claim_verdict === "source-supported-with-ceiling" && keyPoints.length >= 2
      ? "source-audited-manual-review" : "partial-evidence",
    primary_sources: keyPoints.map((claim) => ({
      source_url: claim.source_url,
      source_identity: claim.source_identity,
      authority_scope: claim.evidence_ceiling,
    })),
    key_points: keyPoints,
    evidence_gaps: [
      ...array(authored?.missing_requirements).map((requirement) => requirement.required_next || requirement.label),
      ...array(adaptive?.missing_requirements).map((requirement) => requirement.required_next || requirement.label),
      "no-released-recurrent-forward-short-circuit-or-matched-latency-result",
      "public-inference-artifacts-do-not-reproduce-the-training-stack",
      "model-card-config-paper-discrepancies-require-human-resolution",
    ],
  };
}

function buildCoconutDossier(item, record, semanticReviewAudit) {
  const authored = semanticClaimForTopic(semanticReviewAudit, "coconut-continuous-thought", "authored-mechanism");
  const faithfulness = semanticClaimForTopic(semanticReviewAudit, "coconut-continuous-thought", "faithful-reasoning");
  const paper = array(authored?.evidence).find((entry) => /^arxiv:/i.test(entry?.observed_identity || ""));
  const code = array(authored?.evidence).find((entry) => entry?.ref === "production:coconut-code");
  const counter = array(faithfulness?.evidence).find((entry) => entry?.evidence_polarity === "mixed" && entry?.healthy === true);
  const keyPoints = [];
  if (paper) keyPoints.push(diligenceEvidenceClaim({
    evidence: paper,
    topic: "continuous-hidden-state-feedback",
    layer: "M1/M3",
    statement: "Coconut 将前一步最后一层 hidden state 作为下一步输入 embedding 回灌，使中间计算不必先离散成自然语言 token；这是作者报告的计算机制。",
    ceiling: authored?.evidence_ceiling_when_met || "G2-author-attributed",
    state: authored?.claim_verdict || "author-attributed-manual-review",
    fallbackUrl: item.canonical_url,
    boundary: paper.does_not_prove,
  }));
  if (code) keyPoints.push(diligenceEvidenceClaim({
    evidence: code,
    topic: "official-implementation-identity",
    layer: "M3/artifact",
    statement: "Meta FAIR 官方实现与 commit 身份可追溯，可用于核对 hidden-state feedback 路径；代码存在不等于已有低成本、完整、结果一致的复现。",
    ceiling: "T4-official-code-availability-only",
    state: code.healthy ? "artifact-observed-human-review-required" : "artifact-unhealthy",
    fallbackUrl: item.canonical_url,
    boundary: code.does_not_prove,
  }));
  if (counter) keyPoints.push(diligenceEvidenceClaim({
    evidence: counter,
    topic: "latent-state-faithfulness-boundary",
    layer: "M4",
    statement: "后续干预研究显示 hidden state 的功能使用与“内容忠实、逐步可解释”必须分开；同范数随机替换等结果不支持简单的完整推理轨迹叙事。",
    ceiling: "G2-scoped-intervention-boundary",
    state: "mixed-counterevidence-human-review-required",
    fallbackUrl: item.canonical_url,
    boundary: counter.does_not_prove,
  }));
  return {
    profile: "coconut-continuous-latent-thought-v1",
    evidence_status: authored?.claim_verdict === "source-supported-with-ceiling" && keyPoints.length >= 2
      ? "source-audited-manual-review" : "partial-evidence",
    primary_sources: keyPoints.map((claim) => ({
      source_url: claim.source_url,
      source_identity: claim.source_identity,
      authority_scope: claim.evidence_ceiling,
    })),
    key_points: keyPoints,
    evidence_gaps: [
      ...array(faithfulness?.missing_requirements).map((requirement) => requirement.required_next || requirement.label),
      "latent-state-function-does-not-establish-faithful-or-interpretable-reasoning",
      "small-backbone-or-synthetic-results-do-not-generalize-to-frontier-models",
      "independent-cross-backbone-hidden-state-reproduction-missing",
    ],
  };
}

function abstractSentence(summary, pattern) {
  return String(summary || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .find((sentence) => pattern.test(sentence))
    ?.trim() || "";
}

function buildT2MLRDossier(item, record) {
  const sourceIdentity = `${record.canonical_id}@v${record.arxiv_version || record.arxiv_version_observed || "unknown"}`;
  const profiles = [
    {
      topic: "autoregressive-hidden-state-bottleneck",
      layer: "M3",
      pattern: /autoregressive decoding[\s\S]*compresses[\s\S]*token space/i,
      statement: "论文把瓶颈定位在跨 token 的状态丢失：自回归解码反复把丰富的隐藏计算压回离散 token 空间，使中间推理状态难以沿时间持续。",
      boundary: "这是论文的问题设定，不是对所有 Transformer 推理失败原因的独立因果证明。",
    },
    {
      topic: "cross-token-middle-layer-recurrence",
      layer: "M1/M3",
      pattern: /fuses a cached middle layer representation[\s\S]*previous token[\s\S]*earlier layer/i,
      statement: "T²MLR 的核心计算路径是：缓存上一个 token 的中间层表征，并直接注入当前 token 的更早层；递归发生在时间轴与局部深度之间，而不是把整网对同一 token 重跑多轮。",
      boundary: "摘要能定位信息流设计，但尚不能确认缓存格式、梯度路径、训练稳定性和实际延迟开销。",
    },
    {
      topic: "localized-recurrence-scope",
      layer: "M1/M3",
      pattern: /localized middle-layer block[\s\S]*(?:20%|full-layer recurrence)/i,
      statement: "作者报告局部中层递归即可生效：只覆盖约 20% 网络的 recurrent block，结果往往优于全层递归；这提示有效潜在计算可能依赖层位而非循环覆盖范围。",
      boundary: "“局部优于全层”仍是作者实验结果，需要检查层位搜索空间、计算量匹配、方差与消融后才能形成机制因果结论。",
    },
    {
      topic: "pretrained-model-retrofit",
      layer: "M2/M3",
      pattern: /does not require pretraining from scratch[\s\S]*1\.7B/i,
      statement: "该路径不只面向从头训练：作者称可向既有 1.7B Transformer 加入 recurrent pathway，再短暂微调以改善数学推理。",
      boundary: "摘要没有给出完整微调 token、算力、数据、基线和多随机种子结果，不能据此判断迁移成本或规模外推。",
    },
  ];
  const keyPoints = profiles.flatMap((profile) => {
    const excerpt = abstractSentence(record.summary, profile.pattern);
    if (!excerpt) return [];
    return [evidenceClaim({
      topic: profile.topic,
      layer: profile.layer,
      statement: profile.statement,
      excerpt,
      ceiling: "G1-author-reported-paper-claim",
      state: "author-reported-not-independently-reproduced",
      boundary: profile.boundary,
      sourceUrl: record.canonical_url,
      sourceIdentity,
    })];
  });
  return {
    profile: "t2mlr-temporal-middle-layer-recurrence-v1",
    evidence_status: keyPoints.length === profiles.length ? "source-audited-manual-review" : "partial-evidence",
    primary_sources: [{
      source_url: record.canonical_url,
      source_identity: sourceIdentity,
      evidence_grade: record.evidence_grade,
      artifact_types: array(record.artifact_types),
      authority_scope: "author paper identity and abstract claims only",
    }],
    key_points: keyPoints,
    evidence_gaps: [
      "no-linked-code-model-data-or-results-in-current-snapshot",
      "no-full-training-inference-configuration-or-raw-results-in-current-dossier",
      "no-independent-reproduction-or-layer-location-intervention",
      "retrofitting-cost-and-scale-generalization-not-established",
    ],
  };
}

function buildMechanismDossier(item, mechanismAudit, semanticReviewAudit) {
  const record = mechanismRecordForItem(item, mechanismAudit);
  if (!record) return {
    profile: "mechanism-paper-abstract",
    evidence_status: "missing-mechanism-record",
    primary_sources: [],
    key_points: [],
    evidence_gaps: ["selected-mechanism-record-not-found"],
  };
  const seed = mechanismSeed(record);
  if (seed === "claude-constitution") return buildConstitutionDossier(item, record, semanticReviewAudit);
  if (seed === "ouro-looplm") return buildOuroDossier(item, record, semanticReviewAudit);
  if (seed === "coconut-continuous-thought") return buildCoconutDossier(item, record, semanticReviewAudit);
  if (/arxiv:2607\.15178/i.test(record.canonical_id)) return buildT2MLRDossier(item, record);
  const sourceIdentity = `${record.canonical_id}@v${record.arxiv_version || record.arxiv_version_observed || "unknown"}`;
  const claims = [];
  const mechanism = excerptAround(record.summary, /(?:we introduce|we propose|we present|architecture|mechanism)/i);
  if (mechanism) claims.push(evidenceClaim({
    topic: "paper-mechanism-delta",
    layer: record.primary_layer,
    statement: "论文摘要给出了可定位的模型机制变化；该条只保留作者主张，需结合正文、代码和消融确认计算图与因果解释。",
    excerpt: mechanism,
    ceiling: `${record.evidence_grade}-author-reported-paper-claim`,
    state: "author-reported-not-independently-reproduced",
    boundary: "摘要与论文身份不能替代代码、训练日志、同预算基线或独立干预复现。",
    sourceUrl: record.canonical_url,
    sourceIdentity,
  }));
  const result = excerptAround(record.summary, /(?:outperform|improv|result|demonstrat|show that)/i);
  if (result && result !== mechanism) claims.push(evidenceClaim({
    topic: "paper-reported-result",
    layer: record.primary_layer,
    statement: "论文报告了效果或行为变化，但当前日报只把它作为作者结果，不把摘要中的比较升级为独立验证。",
    excerpt: result,
    ceiling: `${record.evidence_grade}-author-reported-paper-result`,
    state: "author-reported-not-independently-reproduced",
    boundary: "需要检查实验规模、数据与参数预算、误差条、消融和公开 artifact 后再写强结论。",
    sourceUrl: record.canonical_url,
    sourceIdentity,
  }));
  return {
    profile: "mechanism-paper-abstract",
    evidence_status: claims.length ? "source-audited-manual-review" : "partial-evidence",
    primary_sources: [{
      source_url: record.canonical_url,
      source_identity: sourceIdentity,
      evidence_grade: record.evidence_grade,
      artifact_types: array(record.artifact_types),
      authority_scope: "author paper identity and abstract claims",
    }],
    key_points: claims,
    evidence_gaps: [
      ...(array(record.artifact_types).some((type) => type !== "paper") ? [] : ["no-linked-code-model-data-or-results-in-current-snapshot"]),
      "no-independent-reproduction-in-current-dossier",
    ],
  };
}

function snapshotForItem(item, officialSnapshots) {
  return array(officialSnapshots).find((snapshot) => snapshot.url === item.canonical_url);
}

export function buildTop3EvidenceDossier({
  top3Audit,
  techAudit,
  mechanismAudit,
  candidateAudit,
  modelComputeAudit = null,
  semanticReviewAudit = null,
  officialSnapshots = [],
  generatedAt,
  inputFingerprints = {},
}) {
  const observedAt = new Date(generatedAt || top3Audit?.generated_at || Date.now());
  if (!Number.isFinite(observedAt.getTime())) throw new Error("invalid dossier generation time");
  const dossiers = array(top3Audit?.selected_top3).map((item) => {
    let detail;
    if (item.primary_section === "new-model") {
      const snapshot = snapshotForItem(item, officialSnapshots);
      detail = snapshot && /kimi\.com\/blog\/kimi-k3/i.test(item.canonical_url)
        ? buildK3Dossier(item, snapshot)
        : snapshot ? buildGenericModelDossier(item, snapshot) : {
          profile: "unprofiled-model-release",
          evidence_status: "official-detail-snapshot-missing",
          primary_sources: [],
          key_points: [],
          evidence_gaps: ["model-specific-claim-profile-not-yet-reviewed"],
        };
    } else if (item.primary_section === "harness-eval") {
      detail = buildHarnessDossier(item, candidateAudit, techAudit);
    } else if (item.primary_section === "mechanism") {
      detail = buildMechanismDossier(item, mechanismAudit, semanticReviewAudit);
    } else {
      detail = buildComputeDossier(item, modelComputeAudit, snapshotForItem(item, officialSnapshots));
    }
    return {
      rank: item.rank,
      story_id: item.story_id,
      title: item.title,
      primary_section: item.primary_section,
      canonical_url: item.canonical_url,
      selection_score: item.score.total,
      source_lanes: array(item.source_lanes),
      ...detail,
      primary_verification_required: true,
      manual_review_only: true,
      claim_evidence_allowed: false,
      notification_eligible: false,
    };
  });
  const inputSnapshots = {
    top3_fingerprint: inputFingerprints.top3 || sha256(JSON.stringify(top3Audit)),
    tech_fingerprint: inputFingerprints.tech || sha256(JSON.stringify(techAudit)),
    mechanism_fingerprint: inputFingerprints.mechanism || sha256(JSON.stringify(mechanismAudit)),
    candidate_fingerprint: candidateAudit ? inputFingerprints.candidate || sha256(JSON.stringify(candidateAudit)) : null,
    model_compute_fingerprint: modelComputeAudit ? inputFingerprints.modelCompute || sha256(JSON.stringify(modelComputeAudit)) : null,
    semantic_review_fingerprint: semanticReviewAudit ? inputFingerprints.semanticReview || sha256(JSON.stringify(semanticReviewAudit)) : null,
  };
  const audit = {
    schema_version: 1,
    mode: "top3-claim-specific-evidence-dossier",
    generated_at: observedAt.toISOString(),
    status: dossiers.length && dossiers.every((item) => item.evidence_status === "source-audited-manual-review")
      ? "review-ready"
      : dossiers.length ? "partial-review-required" : "no-selected-stories",
    policy: TOP3_EVIDENCE_POLICY,
    input_snapshots: inputSnapshots,
    metrics: {
      selected_stories_read: array(top3Audit?.selected_top3).length,
      dossiers_created: dossiers.length,
      official_detail_snapshots_read: array(officialSnapshots).length,
      key_points_extracted: dossiers.reduce((sum, item) => sum + item.key_points.length, 0),
      evidence_gaps: dossiers.reduce((sum, item) => sum + item.evidence_gaps.length, 0),
    },
    official_snapshots: array(officialSnapshots).map((snapshot) => ({
      url: snapshot.url,
      status: snapshot.status,
      fetched_at: snapshot.fetched_at,
      response_bytes: snapshot.response_bytes,
      content_sha256: snapshot.content_sha256,
      normalized_text_sha256: snapshot.normalized_text_sha256,
      evidence_profile_text_sha256: sha256(snapshot.normalized_text),
    })),
    notification_policy: { enabled: false, eligible_records: 0 },
    publishing_policy: { enabled: false, eligible_records: 0 },
    external_actions: [],
    dossiers,
  };
  audit.report_fingerprint = sha256(JSON.stringify(audit));
  return audit;
}

export function renderTop3EvidenceReview(audit) {
  const lines = [
    `# Top 3 机制证据包 · ${audit.generated_at.slice(0, 10)}`,
    "",
    "> 只描述一手来源实际支持到哪里；所有条目仍需人工审阅，不通知、不发布。",
    "",
    `- 状态：\`${audit.status}\`；story：${audit.metrics.dossiers_created}；机制要点：${audit.metrics.key_points_extracted}；显式缺口：${audit.metrics.evidence_gaps}`,
    "- 外部动作：0；通知资格：0；发布资格：0",
    "",
  ];
  for (const dossier of audit.dossiers) {
    lines.push(`## ${dossier.rank}. ${dossier.title}`, "", `- 栏目：\`${dossier.primary_section}\`；选稿分：${dossier.selection_score}；证据状态：\`${dossier.evidence_status}\``, `- 一手入口：[${dossier.canonical_url}](${dossier.canonical_url})`, "");
    for (const point of dossier.key_points) {
      const excerptLabel = point.evidence_excerpt_kind === "source-diligence-contract" ? "尽调证据合同" : "一手摘录";
      lines.push(`### ${point.topic} · ${point.mechanism_layer}`, "", point.statement_zh, "", `- 证据上限：\`${point.evidence_ceiling}\`；状态：\`${point.verification_state}\``, `- 边界：${point.boundary}`, `- ${excerptLabel}：> ${point.evidence_excerpt.replaceAll("\n", " ")}`, `- 身份：\`${point.source_identity}\`；摘录 SHA256：\`${point.evidence_excerpt_sha256}\``, "");
    }
    lines.push("### 仍缺什么", "", ...dossier.evidence_gaps.map((gap) => `- ${gap}`), "");
  }
  return `${lines.join("\n")}\n`;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
  await writeFile(pending, content, { encoding: "utf8", flag: "wx" });
  await rename(pending, path);
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function responseTextBounded(response, maximum) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maximum) throw new Error(`response-body-too-large:${declared}>${maximum}`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximum) throw new Error(`response-body-too-large:${bytes}>${maximum}`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertAllowedDetailUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !ALLOWED_DETAIL_HOSTS.has(url.hostname.toLowerCase())) throw new Error(`detail-url-not-allowed:${value}`);
  return url.href;
}

export function isAllowedOfficialDetailUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_DETAIL_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function fetchOfficialDetail(item, { cacheDir, fetchImpl, now }) {
  const url = assertAllowedDetailUrl(item.canonical_url);
  const cachePath = resolve(cacheDir, `${sha256(url)}.json`);
  const cached = await readJson(cachePath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("official-detail-timeout")), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const headers = { accept: "text/html", "user-agent": "ai-research-daily-evidence/0.1 (selected-story primary-source review; no notification)" };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    if (cached?.last_modified) headers["if-modified-since"] = cached.last_modified;
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "follow" });
    let body;
    let status;
    if (response.status === 304 && cached?.body_base64) {
      body = Buffer.from(cached.body_base64, "base64").toString("utf8");
      status = "not-modified";
    } else {
      if (!response.ok) throw new Error(`official-detail-http-${response.status}`);
      body = await responseTextBounded(response, MAX_RESPONSE_BYTES);
      status = "fresh";
      await atomicWrite(cachePath, `${JSON.stringify({
        url,
        fetched_at: now.toISOString(),
        etag: response.headers.get("etag") || "",
        last_modified: response.headers.get("last-modified") || "",
        body_base64: Buffer.from(body, "utf8").toString("base64"),
      })}\n`);
    }
    const normalizedText = normalizeOfficialHtml(body);
    return {
      url,
      status,
      fetched_at: now.toISOString(),
      response_bytes: Buffer.byteLength(body),
      content_sha256: sha256(body),
      normalized_text_sha256: sha256(normalizedText),
      normalized_text: normalizedText,
    };
  } catch (error) {
    const cachedAt = Date.parse(cached?.fetched_at || "");
    const ageHours = Number.isFinite(cachedAt) ? (now.getTime() - cachedAt) / HOUR_MS : Number.POSITIVE_INFINITY;
    if (!cached?.body_base64 || !(ageHours >= 0 && ageHours <= STALE_CACHE_HOURS)) throw error;
    const body = Buffer.from(cached.body_base64, "base64").toString("utf8");
    const normalizedText = normalizeOfficialHtml(body);
    return {
      url,
      status: "stale-cache",
      fetched_at: cached.fetched_at,
      response_bytes: Buffer.byteLength(body),
      content_sha256: sha256(body),
      normalized_text_sha256: sha256(normalizedText),
      normalized_text: normalizedText,
      error: String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runTop3EvidenceDossier({
  top3Path = resolve("work/unified-top3-replay/audit.json"),
  techPath = resolve("work/tech-discovery-probe/audit.json"),
  mechanismPath = resolve("work/mechanism-watch/audit.json"),
  candidatePath = resolve("work/candidate-source-probe/audit.json"),
  modelComputePath = resolve("work/model-compute-source-probe/audit.json"),
  semanticReviewPath = resolve("work/semantic-review-dossiers/dossier.json"),
  outputPath = resolve("work/top3-evidence-dossier/audit.json"),
  reviewPath = resolve("work/top3-evidence-dossier/review.md"),
  cacheDir = resolve("work/top3-evidence-dossier/cache"),
  fetchImpl = fetch,
  now,
} = {}) {
  const readOptionalBody = async (path) => {
    try { return await readFile(path, "utf8"); } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const [top3Body, techBody, mechanismBody, candidateBody, modelComputeBody, semanticReviewBody] = await Promise.all([
    readFile(top3Path, "utf8"), readFile(techPath, "utf8"), readFile(mechanismPath, "utf8"), readOptionalBody(candidatePath), readFile(modelComputePath, "utf8"), readOptionalBody(semanticReviewPath),
  ]);
  const top3Audit = JSON.parse(top3Body);
  const techAudit = JSON.parse(techBody);
  const mechanismAudit = JSON.parse(mechanismBody);
  const candidateAudit = candidateBody ? JSON.parse(candidateBody) : null;
  const modelComputeAudit = JSON.parse(modelComputeBody);
  const semanticReviewAudit = semanticReviewBody ? JSON.parse(semanticReviewBody) : null;
  const observedAt = now || new Date();
  // Only first-party pages may enter the official-detail evidence lane. Trusted
  // analysis sources can still be selected, but they must not be relabelled as
  // official evidence or abort the entire daily run when their host differs.
  const detailItems = array(top3Audit.selected_top3).filter((item) =>
    ["new-model", "compute-system"].includes(item.primary_section)
    && isAllowedOfficialDetailUrl(item.canonical_url));
  const officialSnapshots = [];
  for (const item of detailItems.slice(0, TOP3_EVIDENCE_POLICY.maximum_detail_requests)) {
    officialSnapshots.push(await fetchOfficialDetail(item, { cacheDir, fetchImpl, now: observedAt }));
  }
  const audit = buildTop3EvidenceDossier({
    top3Audit, techAudit, mechanismAudit, candidateAudit, modelComputeAudit, semanticReviewAudit, officialSnapshots,
    generatedAt: observedAt.toISOString(),
    inputFingerprints: {
      top3: sha256(top3Body), tech: sha256(techBody), mechanism: sha256(mechanismBody), candidate: candidateBody ? sha256(candidateBody) : null, modelCompute: sha256(modelComputeBody), semanticReview: semanticReviewBody ? sha256(semanticReviewBody) : null,
    },
  });
  await atomicWrite(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
  await atomicWrite(reviewPath, renderTop3EvidenceReview(audit));
  return audit;
}

async function main() {
  const audit = await runTop3EvidenceDossier({
    top3Path: resolve(process.env.TOP3_EVIDENCE_TOP3_PATH || "work/unified-top3-replay/audit.json"),
    techPath: resolve(process.env.TOP3_EVIDENCE_TECH_PATH || "work/tech-discovery-probe/audit.json"),
    mechanismPath: resolve(process.env.TOP3_EVIDENCE_MECHANISM_PATH || "work/mechanism-watch/audit.json"),
    candidatePath: resolve(process.env.TOP3_EVIDENCE_CANDIDATE_PATH || "work/candidate-source-probe/audit.json"),
    modelComputePath: resolve(process.env.TOP3_EVIDENCE_MODEL_COMPUTE_PATH || "work/model-compute-source-probe/audit.json"),
    semanticReviewPath: resolve(process.env.TOP3_EVIDENCE_SEMANTIC_REVIEW_PATH || "work/semantic-review-dossiers/dossier.json"),
    outputPath: resolve(process.env.TOP3_EVIDENCE_OUTPUT_PATH || "work/top3-evidence-dossier/audit.json"),
    reviewPath: resolve(process.env.TOP3_EVIDENCE_REVIEW_PATH || "work/top3-evidence-dossier/review.md"),
    cacheDir: resolve(process.env.TOP3_EVIDENCE_CACHE_DIR || "work/top3-evidence-dossier/cache"),
  });
  process.stdout.write(`${JSON.stringify({ status: audit.status, dossiers: audit.metrics.dossiers_created, key_points: audit.metrics.key_points_extracted }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
