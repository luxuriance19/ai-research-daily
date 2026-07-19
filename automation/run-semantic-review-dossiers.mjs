#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  COMMON_REVIEW_CHECKS,
  SEMANTIC_REVIEW_MINIMUM_SILENT_DAYS,
  semanticReviewPackages,
  topicReviewGuidance,
} from "./semantic-review-contracts.mjs";

const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const unique = (items) => [...new Set(items)];
const stableSort = (items) => [...items].sort((left, right) => String(left).localeCompare(String(right)));

function candidateSourceId(ref) {
  const match = /^candidate:([^#]+)/.exec(ref || "");
  return match?.[1] || "";
}

function claimSourceBindings(claim) {
  const bindings = new Map();
  const add = (requirement, evidenceRole) => {
    for (const ref of array(requirement.source_refs)) {
      const current = bindings.get(ref) || { ref, evidence_role: evidenceRole, requirement_ids: [] };
      current.requirement_ids.push(requirement.id);
      if (current.evidence_role !== evidenceRole) current.evidence_role = "mixed-role";
      bindings.set(ref, current);
    }
  };
  for (const requirement of array(claim?.requirements)) add(requirement, "supporting");
  for (const requirement of array(claim?.counterevidence_requirements)) add(requirement, "counterevidence");
  return [...bindings.values()].map((binding) => ({ ...binding, requirement_ids: unique(binding.requirement_ids) }));
}

function historyBySourceId(candidateAudit) {
  return new Map(array(candidateAudit?.source_history).map((history) => [history.source_id, history]));
}

function candidateStability(sourceRefs, candidateAudit) {
  const histories = historyBySourceId(candidateAudit);
  const sourceIds = stableSort(unique(sourceRefs.map(candidateSourceId).filter(Boolean)));
  const sources = sourceIds.map((sourceId) => {
    const history = histories.get(sourceId);
    const observed = history?.criteria?.minimum_observation_days?.observed
      ?? history?.consecutive_network_success_days
      ?? 0;
    return {
      source_id: sourceId,
      observed_network_success_dates: array(history?.observed_network_success_dates),
      consecutive_network_success_days: history?.consecutive_network_success_days ?? 0,
      observed_days: observed,
      required_days: SEMANTIC_REVIEW_MINIMUM_SILENT_DAYS,
      minimum_silent_days_passed: observed >= SEMANTIC_REVIEW_MINIMUM_SILENT_DAYS,
      current_status: history?.current_status || "missing",
      semantic_blockers: array(history?.semantic_blockers),
      warnings: array(history?.warnings),
      review_flags: array(history?.review_flags),
      human_source_review_observed: history?.criteria?.human_source_review?.observed === true,
    };
  });
  return {
    applicable: sources.length > 0,
    required_days: SEMANTIC_REVIEW_MINIMUM_SILENT_DAYS,
    candidate_sources: sources,
    minimum_observed_days: sources.length ? Math.min(...sources.map((source) => source.observed_days)) : null,
    all_sources_meet_minimum_days: sources.length > 0 && sources.every((source) => source.minimum_silent_days_passed),
    all_sources_semantically_healthy: sources.length > 0 && sources.every((source) => source.semantic_blockers.length === 0),
    human_source_review_complete: sources.length > 0 && sources.every((source) => source.human_source_review_observed),
  };
}

export function claimPacketFingerprint(packet) {
  const payload = {
    topic_id: packet.topic_id,
    claim_id: packet.claim_id,
    source_status: packet.source_status,
    coverage_status: packet.coverage_status,
    event_status: packet.event_status,
    claim_verdict: packet.claim_verdict,
    event_evidence: packet.event_evidence,
    evidence_ceiling_when_met: packet.evidence_ceiling_when_met,
    evidence: packet.evidence.map((source) => ({
      ref: source.ref,
      evidence_role: source.evidence_role,
      evidence_polarity: source.evidence_polarity,
      healthy: source.healthy,
      observed_identity: source.observed_identity,
      authority_tier: source.authority_tier,
      independence_group: source.independence_group,
      result_independence_group: source.result_independence_group,
      paper_code_match: source.paper_code_match,
      manual_risk_flags: source.manual_risk_flags,
      claim_scope: source.claim_scope,
    })),
    missing_requirements: packet.missing_requirements.map((requirement) => ({
      id: requirement.id,
      required_next: requirement.required_next,
      source_refs: requirement.source_refs,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function evidenceRecord(binding, sourceProfiles) {
  const { ref, evidence_role: evidenceRole, requirement_ids: requirementIds } = binding;
  const source = sourceProfiles.get(ref);
  if (!source) {
    return {
      ref,
      evidence_role: evidenceRole,
      requirement_ids: requirementIds,
      label: "unprofiled source",
      authority_tier: "unavailable",
      independence_group: "unavailable",
      result_independence_group: "unavailable",
      artifact_owner: "unavailable",
      evidence_polarity: "unavailable",
      paper_code_match: "unavailable",
      manual_risk_flags: ["missing-source-profile"],
      claim_scope: "unavailable",
      healthy: false,
      current_status: "missing-profile",
      observed_identity: "unavailable:missing-source-profile",
      proves: "Nothing until the source receives a claim-specific profile.",
      does_not_prove: "Any claim.",
    };
  }
  return {
    ref: source.ref,
    evidence_role: evidenceRole,
    requirement_ids: requirementIds,
    label: source.label,
    authority_tier: source.authority_tier,
    independence_group: source.independence_group,
    result_independence_group: source.result_independence_group || source.independence_group,
    artifact_owner: source.artifact_owner || source.independence_group,
    evidence_polarity: source.evidence_polarity || "supporting",
    paper_code_match: source.paper_code_match || "not-assessed",
    manual_risk_flags: array(source.manual_risk_flags),
    claim_scope: source.claim_scope,
    healthy: source.healthy === true,
    current_status: source.current_status,
    observed_identity: source.observed_identity,
    proves: source.proves,
    does_not_prove: source.does_not_prove,
  };
}

function dispositionFor(claim, stability) {
  const coverageStatus = claim.coverage_status || claim.status;
  if (coverageStatus === "evidence-gap") return "hold-evidence-gap";
  if (claim.event_status === "blocked-regression") return "hold-source-regression";
  if (claim.event_status === "blocked-source-anomaly") return "hold-source-anomaly";
  if (claim.event_required && ["baseline", "no-event"].includes(claim.event_status)) return "monitor-no-change";
  if (!stability.all_sources_meet_minimum_days) return "await-stability-and-human-review";
  return "await-human-review";
}

function notificationBlockers(claim, stability, evidence) {
  const coverageStatus = claim.coverage_status || claim.status;
  const noCurrentEvent = claim.event_required && ["baseline", "no-event"].includes(claim.event_status);
  const blockers = noCurrentEvent
    ? ["no-change-observed", "notification-policy-disabled"]
    : ["human-semantic-review-not-completed", "notification-policy-disabled"];
  if (coverageStatus === "evidence-gap") blockers.push("claim-evidence-gap");
  if (claim.event_status === "blocked-regression") blockers.push("source-regression");
  if (claim.event_status === "blocked-source-anomaly") blockers.push("source-anomaly");
  if (!noCurrentEvent && stability.applicable && !stability.all_sources_meet_minimum_days) blockers.push("minimum-silent-days-not-met");
  if (!noCurrentEvent && stability.applicable && !stability.all_sources_semantically_healthy) blockers.push("candidate-source-semantic-health-failed");
  if (!noCurrentEvent && evidence.some((source) => !source.healthy)) blockers.push("required-source-unhealthy");
  return unique(blockers);
}

function permittedSummaryFor(claim) {
  const coverageStatus = claim.coverage_status || claim.status;
  if (coverageStatus === "evidence-gap") {
    return `当前不得把“${claim.label}”写成成立事实；只可说明仍缺哪些 claim-specific evidence，并单列已有反证或混合证据。`;
  }
  if (claim.event_required && ["baseline", "no-event"].includes(claim.event_status)) {
    return `来源覆盖可监测，但本轮没有结构化变化事件；不得把“${claim.label}”写成今天的新变化。`;
  }
  if (["blocked-source-anomaly", "blocked-regression"].includes(claim.event_status)) {
    return `来源存在异常或身份回退；在修复并复核前，不得把“${claim.label}”写成事实或变化。`;
  }
  if (claim.claim_verdict === "pending-human-review" || coverageStatus === "human-review-required") {
    return `来源链已到人工复核；在语义 review 完成前，不得把“${claim.label}”写成已确认结论。`;
  }
  return `${claim.label}；仅限 ${claim.evidence_ceiling_when_met}，并明确作者归因、实验对象、反证与缺口。`;
}

function createClaimPacket(topic, claim, sourceProfiles, candidateAudit) {
  const guidance = topicReviewGuidance[topic.id];
  if (!guidance) throw new Error(`missing semantic review guidance for topic: ${topic.id}`);
  const bindings = claimSourceBindings(claim);
  const sourceRefs = bindings.map((binding) => binding.ref);
  const evidence = bindings.map((binding) => evidenceRecord(binding, sourceProfiles));
  const supportingEvidence = evidence.filter((source) => source.evidence_role === "supporting");
  const counterevidence = evidence.filter((source) => source.evidence_role === "counterevidence");
  const stability = candidateStability(sourceRefs, candidateAudit);
  const missingRequirements = array(claim.requirements)
    .filter((requirement) => !requirement.passed)
    .map((requirement) => ({
      id: requirement.id,
      label: requirement.label,
      source_refs: array(requirement.source_refs),
      required_next: requirement.required_next || "Add healthy, claim-specific primary evidence.",
      observed_healthy: requirement.observed_healthy,
      observed_independence_groups: array(requirement.observed_independence_groups),
      observed_result_independence_groups: array(requirement.observed_result_independence_groups),
    }));
  const passedRequirements = array(claim.requirements)
    .filter((requirement) => requirement.passed)
    .map((requirement) => ({
      id: requirement.id,
      label: requirement.label,
      source_refs: array(requirement.source_refs),
      observed_healthy: requirement.observed_healthy,
      observed_independence_groups: array(requirement.observed_independence_groups),
      observed_result_independence_groups: array(requirement.observed_result_independence_groups),
    }));
  const counterevidenceRequirements = array(claim.counterevidence_requirements).map((requirement) => ({
    id: requirement.id,
    label: requirement.label,
    source_refs: array(requirement.source_refs),
    observed_healthy: requirement.observed_healthy,
    observed_result_independence_groups: array(requirement.observed_result_independence_groups),
    passed: requirement.passed === true,
    required_next: requirement.required_next || "Keep this evidence on the counter/mixed axis and review its scope manually.",
  }));
  const coverageStatus = claim.coverage_status || claim.status;
  const packet = {
    topic_id: topic.id,
    topic_title: topic.title,
    layers: array(topic.layers),
    claim_id: claim.id,
    claim_label: claim.label,
    claim_kind: claim.kind,
    source_status: coverageStatus,
    coverage_status: coverageStatus,
    event_required: claim.event_required === true,
    event_status: claim.event_status || "no-event",
    event_evidence: array(claim.event_evidence),
    claim_verdict: claim.claim_verdict || (coverageStatus === "evidence-gap" ? "not-established" : "pending-human-review"),
    causal_claim: claim.causal_claim === true,
    evidence_ceiling_when_met: claim.evidence_ceiling_when_met,
    attention_level: topic.attention?.level || "A0",
    attention_used_as_evidence: false,
    evidence,
    supporting_evidence: supportingEvidence,
    counterevidence,
    counterevidence_available: claim.counterevidence_available === true,
    counterevidence_requirements: counterevidenceRequirements,
    evidence_categories: {
      directly_inspectable_artifacts: evidence.filter((source) => source.authority_tier === "T4").map((source) => ({ ref: source.ref, evidence_role: source.evidence_role, observed_identity: source.observed_identity, fact: source.proves })),
      attributed_primary_claims: evidence.filter((source) => source.authority_tier === "T3").map((source) => ({ ref: source.ref, evidence_role: source.evidence_role, observed_identity: source.observed_identity, author_claim: source.proves })),
      limitations_and_non_proofs: evidence.map((source) => ({ ref: source.ref, limitation: source.does_not_prove })),
    },
    passed_requirements: passedRequirements,
    missing_requirements: missingRequirements,
    independence_groups: stableSort(unique(evidence.filter((source) => source.healthy).map((source) => source.independence_group))),
    result_independence_groups: stableSort(unique(evidence.filter((source) => source.healthy).map((source) => source.result_independence_group))),
    stability_gate: stability,
    review_checklist: [...COMMON_REVIEW_CHECKS, ...guidance.review_questions],
    permitted_summary: permittedSummaryFor(claim),
    prohibited_conclusions: unique([
      ...guidance.prohibited_conclusions,
      ...evidence.map((source) => source.does_not_prove),
    ]),
    notification_ceiling_after_all_gates: guidance.notification_ceiling,
    disposition: dispositionFor(claim, stability),
    human_review: {
      prepared_by_automation: true,
      constitutes_human_review: false,
      human_reviewed: false,
      decision: null,
      reviewer: null,
      reviewed_at: null,
      reviewed_packet_fingerprint: null,
      notes: [],
    },
    notification: {
      eligible: false,
      priority: null,
      blockers: notificationBlockers(claim, stability, evidence),
    },
  };
  packet.packet_fingerprint = claimPacketFingerprint(packet);
  return packet;
}

function packageReadiness(claims) {
  const candidateSources = new Map();
  for (const claim of claims) {
    for (const source of claim.stability_gate.candidate_sources) candidateSources.set(source.source_id, source);
  }
  const sources = [...candidateSources.values()].sort((left, right) => left.source_id.localeCompare(right.source_id));
  return {
    candidate_sources: sources.length,
    minimum_observed_days: sources.length ? Math.min(...sources.map((source) => source.observed_days)) : null,
    required_days: SEMANTIC_REVIEW_MINIMUM_SILENT_DAYS,
    all_sources_meet_minimum_days: sources.length > 0 && sources.every((source) => source.minimum_silent_days_passed),
    all_sources_semantically_healthy: sources.length > 0 && sources.every((source) => source.semantic_blockers.length === 0),
    human_source_review_complete: sources.length > 0 && sources.every((source) => source.human_source_review_observed),
  };
}

export function createSemanticReviewDossier({ sourceDiligence, candidateAudit, now = new Date() }) {
  const topicMap = new Map(array(sourceDiligence?.topics).map((topic) => [topic.id, topic]));
  const sourceProfiles = new Map(array(sourceDiligence?.source_profiles).map((source) => [source.ref, source]));
  const packages = semanticReviewPackages.map((reviewPackage) => {
    const topics = reviewPackage.topic_ids.map((topicId) => {
      const topic = topicMap.get(topicId);
      if (!topic) throw new Error(`missing diligence topic: ${topicId}`);
      return topic;
    });
    const claims = topics.flatMap((topic) => array(topic.claims).map((claim) => createClaimPacket(topic, claim, sourceProfiles, candidateAudit)));
    return {
      id: reviewPackage.id,
      title: reviewPackage.title,
      topic_ids: [...reviewPackage.topic_ids],
      layers: [...reviewPackage.layers],
      review_focus: reviewPackage.review_focus,
      readiness: packageReadiness(claims),
      metrics: {
        claims: claims.length,
        source_ready_claims: claims.filter((claim) => claim.source_status === "source-ready").length,
        human_review_required_claims: claims.filter((claim) => claim.source_status === "human-review-required").length,
        evidence_gap_claims: claims.filter((claim) => claim.source_status === "evidence-gap").length,
        no_change_claims: claims.filter((claim) => claim.event_required && ["baseline", "no-event"].includes(claim.event_status)).length,
        current_event_candidates: claims.filter((claim) => claim.event_status === "human-review-required").length,
        claims_with_counterevidence: claims.filter((claim) => claim.counterevidence_available).length,
        human_decisions_recorded: 0,
        notification_eligible_records: 0,
      },
      claims,
    };
  });
  const claims = packages.flatMap((reviewPackage) => reviewPackage.claims);
  const allSourcesMeetMinimumDays = packages.every((reviewPackage) => reviewPackage.readiness.all_sources_meet_minimum_days);
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    mode: "mechanism-semantic-review-dossier",
    status: allSourcesMeetMinimumDays ? "human-review-required" : "waiting-for-stability-and-human-review",
    input_snapshots: {
      source_diligence_generated_at: sourceDiligence?.generated_at || "",
      candidate_probe_generated_at: candidateAudit?.generated_at || "",
    },
    scope: {
      objective: "High-quality semantic due diligence for intended behavior, latent/recurrent model mechanisms, model internals, and harness progress.",
      excludes_language_style_analysis: true,
      includes_attention_as_evidence: false,
      topic_ids: packages.flatMap((reviewPackage) => reviewPackage.topic_ids),
    },
    review_policy: {
      minimum_silent_days: SEMANTIC_REVIEW_MINIMUM_SILENT_DAYS,
      packet_fingerprint_required: true,
      stale_human_decisions_invalid_after_source_change: true,
      automation_constitutes_human_review: false,
      automation_can_write_human_decision: false,
      automatic_promotions: [],
    },
    notification_policy: {
      enabled: false,
      eligible: false,
      external_actions: [],
      statement: "This dossier prepares human review only. It cannot publish, message, deploy, or create a WeChat draft.",
    },
    metrics: {
      review_packages: packages.length,
      topics: packages.reduce((count, reviewPackage) => count + reviewPackage.topic_ids.length, 0),
      claims: claims.length,
      source_ready_claims: claims.filter((claim) => claim.source_status === "source-ready").length,
      human_review_required_claims: claims.filter((claim) => claim.source_status === "human-review-required").length,
      evidence_gap_claims: claims.filter((claim) => claim.source_status === "evidence-gap").length,
      no_change_claims: claims.filter((claim) => claim.event_required && ["baseline", "no-event"].includes(claim.event_status)).length,
      current_event_candidates: claims.filter((claim) => claim.event_status === "human-review-required").length,
      claims_with_counterevidence: claims.filter((claim) => claim.counterevidence_available).length,
      claims_waiting_for_stability: claims.filter((claim) => claim.stability_gate.applicable && !claim.stability_gate.all_sources_meet_minimum_days).length,
      human_decisions_recorded: 0,
      notification_eligible_records: 0,
    },
    packages,
  };
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function renderSemanticReviewDossier(dossier) {
  const lines = [
    `# 模型底层语义人工复核包 · ${dossier.generated_at.slice(0, 10)}`,
    "",
    "> 这是机器准备的证据包，不是人工结论。每条结论绑定不可变身份与 fingerprint；来源变化后必须重新复核。通知、发布与外部动作全部关闭。",
    "",
    "## 当前门槛",
    "",
    `- 状态：\`${dossier.status}\`` ,
    `- 复核包：${dossier.metrics.review_packages}；主题：${dossier.metrics.topics}；claims：${dossier.metrics.claims}`,
    `- source-ready：${dossier.metrics.source_ready_claims}；待语义人审：${dossier.metrics.human_review_required_claims}；证据缺口：${dossier.metrics.evidence_gap_claims}`,
    `- 结构化变化候选：${dossier.metrics.current_event_candidates}；baseline/no-event：${dossier.metrics.no_change_claims}；含反证/混合证据：${dossier.metrics.claims_with_counterevidence}`,
    `- 尚未完成 7 日来源门槛的 claims：${dossier.metrics.claims_waiting_for_stability}`,
    "- 已记录人工决定：0；通知资格：0；外部动作：0。",
    "",
    "| 复核包 | 层 | 来源最少观察 | 7 日门槛 | claims |",
    "|---|---|---:|---|---:|",
  ];
  for (const reviewPackage of dossier.packages) {
    lines.push(`| ${markdownCell(reviewPackage.title)} | ${reviewPackage.layers.join("/")} | ${reviewPackage.readiness.minimum_observed_days ?? "n/a"}/${reviewPackage.readiness.required_days} | ${reviewPackage.readiness.all_sources_meet_minimum_days ? "通过" : "等待"} | ${reviewPackage.metrics.claims} |`);
  }
  for (const reviewPackage of dossier.packages) {
    lines.push("", `## ${reviewPackage.title}`, "", reviewPackage.review_focus, "");
    for (const claim of reviewPackage.claims) {
      lines.push(
        `### ${claim.topic_title} · ${claim.claim_label}`,
        "",
        `- 覆盖：\`${claim.coverage_status}\`；事件：\`${claim.event_status}\`；verdict：\`${claim.claim_verdict}\`；处置：\`${claim.disposition}\``,
        `- 证据上限：${claim.evidence_ceiling_when_met}；反证/混合证据：${claim.counterevidence_available ? "有，必须单列解释" : "无完整证据包"}`,
        `- fingerprint：\`${claim.packet_fingerprint}\``,
        `- 当前允许表述：${claim.permitted_summary}`,
        `- 通知阻断：${claim.notification.blockers.map((blocker) => `\`${blocker}\``).join("、")}`,
        "",
        "| 角色/极性 | 来源 | 身份 | 权威/范围/结果谱系 | 能证明 | 不能证明/风险 |",
        "|---|---|---|---|---|---|",
      );
      if (claim.evidence.length) {
        for (const source of claim.evidence) {
          const risks = [source.does_not_prove, ...source.manual_risk_flags, source.paper_code_match === "blocked" ? "paper/code match blocked" : ""].filter(Boolean).join("；");
          lines.push(`| ${source.evidence_role}/${source.evidence_polarity} | ${markdownCell(source.label)} | ${markdownCell(source.observed_identity)} | ${source.authority_tier}/${markdownCell(source.claim_scope)}/${markdownCell(source.result_independence_group)} | ${markdownCell(source.proves)} | ${markdownCell(risks)} |`);
        }
      } else {
        lines.push("| supporting | 当前没有满足该 claim 的来源 | unavailable | - | - | 不能发表为成立事实 | ");
      }
      if (claim.missing_requirements.length) {
        lines.push("", "缺失证据：");
        for (const requirement of claim.missing_requirements) lines.push(`- \`${requirement.id}\`：${requirement.required_next}`);
      }
      if (claim.counterevidence_requirements.length) {
        lines.push("", "反证/混合证据包（不计入正向 requirement）：");
        for (const requirement of claim.counterevidence_requirements) {
          lines.push(`- \`${requirement.id}\`：${requirement.passed ? "已形成，必须人工解释竞争机制与适用范围" : requirement.required_next}`);
        }
      }
      lines.push("", "人工复核问题：");
      for (const question of claim.review_checklist) lines.push(`- [ ] ${question}`);
      lines.push("", "禁止外推：");
      for (const conclusion of claim.prohibited_conclusions) lines.push(`- ${conclusion}`);
      lines.push("", "人工决定（必须由人填写并绑定上述 fingerprint）：`pending`", "");
    }
  }
  return `${lines.join("\n")}\n`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runSemanticReviewDossier({
  sourceDiligencePath = process.env.SOURCE_DILIGENCE_OUTPUT_PATH || "work/source-diligence/coverage.json",
  candidateAuditPath = process.env.CANDIDATE_PROBE_OUTPUT_PATH || "work/candidate-source-probe/audit.json",
  outputPath = process.env.SEMANTIC_REVIEW_OUTPUT_PATH || "work/semantic-review-dossiers/dossier.json",
  reviewPath = process.env.SEMANTIC_REVIEW_MARKDOWN_PATH || "work/semantic-review-dossiers/dossier.md",
  now = new Date(),
} = {}) {
  const [sourceDiligence, candidateAudit] = await Promise.all([readJson(sourceDiligencePath), readJson(candidateAuditPath)]);
  const dossier = createSemanticReviewDossier({ sourceDiligence, candidateAudit, now });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(dossier, null, 2)}\n`);
  await mkdir(dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, renderSemanticReviewDossier(dossier));
  return dossier;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  runSemanticReviewDossier().then((dossier) => console.log(JSON.stringify({
    mode: dossier.mode,
    status: dossier.status,
    review_packages: dossier.metrics.review_packages,
    topics: dossier.metrics.topics,
    claims: dossier.metrics.claims,
    evidence_gap_claims: dossier.metrics.evidence_gap_claims,
    claims_waiting_for_stability: dossier.metrics.claims_waiting_for_stability,
    human_decisions_recorded: dossier.metrics.human_decisions_recorded,
    notification_eligible_records: dossier.metrics.notification_eligible_records,
  }))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
