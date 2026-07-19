#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { candidateSources } from "./candidate-source-registry.mjs";
import { observedSourceIdentity } from "./source-identity.mjs";
import { ATTENTION_WINDOW_DAYS, diligenceSourceProfiles, diligenceTopics } from "./source-diligence-contracts.mjs";

const NETWORK_SUCCESS = new Set(["fresh", "not-modified"]);
const PRODUCTION_CHANGE_KINDS = new Set(["new", "updated"]);
const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];

function sourceEventMap(audit) {
  return new Map(array(audit?.source_events).map((event) => [event.source_id, event]));
}

function sourceRegistryMap(audit) {
  return new Map(array(audit?.source_registry).map((source) => [source.id, source]));
}

function productionSourceObservation(audit, sourceId) {
  const records = array(audit?.records).filter((record) => array(record.source_ids).includes(sourceId));
  const regressed = records.filter((record) => record.change === "source-regressed");
  const changed = records.filter((record) => PRODUCTION_CHANGE_KINDS.has(record.change) && record.concrete_mechanism_delta === true);
  const onboarded = array(audit?.onboarded_source_ids).includes(sourceId) || records.some((record) => record.change === "baseline");
  if (regressed.length) return {
    observation_state: "regressed",
    event_candidate: false,
    change_events: regressed.map((record) => ({ kind: "source-regression", source_id: sourceId, canonical_id: record.canonical_id || "", change: record.change })),
  };
  if (changed.length) return {
    observation_state: "changed",
    event_candidate: true,
    change_events: changed.map((record) => ({ kind: "production-record-change", source_id: sourceId, canonical_id: record.canonical_id || "", change: record.change })),
  };
  return { observation_state: onboarded ? "baseline" : "unchanged", event_candidate: false, change_events: [] };
}

function candidateSourceObservation(event, artifactId) {
  const observationState = event?.observation_state || "blocked";
  const structuredEvents = array(event?.change_events).filter((change) => {
    if (!artifactId || !change || typeof change !== "object") return true;
    const observedArtifact = change.artifact_id || change.paper_id || "";
    return !observedArtifact || observedArtifact === artifactId;
  });
  const eventCandidate = event?.event_candidate === true && observationState === "changed";
  const fallbackEvent = eventCandidate && !structuredEvents.length ? [{
    kind: event?.event_kind || "source-change",
    source_id: event?.source_id || "",
    artifact_id: artifactId,
    version_keys: array(event?.event_version_keys),
    review_flags: array(event?.event_review_flags),
  }] : [];
  return {
    observation_state: observationState,
    event_candidate: eventCandidate,
    change_events: eventCandidate ? [...structuredEvents, ...fallbackEvent] : [],
  };
}

function resolveSourceHealth(profile, productionAudit, candidateAudit) {
  const [namespace, identity] = profile.ref.split(":", 2);
  const [sourceId, artifactId = ""] = identity.split("#", 2);
  const audit = namespace === "production" ? productionAudit : namespace === "candidate" ? candidateAudit : null;
  const event = sourceEventMap(audit).get(sourceId);
  const registered = sourceRegistryMap(audit).has(sourceId);
  const semanticBlockers = array(event?.semantic_blockers);
  const warnings = array(event?.warnings);
  const reviewFlags = array(event?.review_flags);
  let artifactPresent = true;
  if (artifactId) artifactPresent = array(event?.snapshot?.papers).some((paper) => paper.id === artifactId);
  const networkHealthy = Boolean(event && NETWORK_SUCCESS.has(event.status));
  const contentPresent = Boolean(event && (event.items_parsed ?? 0) > 0 && artifactPresent);
  const observation = namespace === "production"
    ? productionSourceObservation(audit, sourceId)
    : candidateSourceObservation(event, artifactId);
  return {
    ...profile,
    namespace,
    source_id: sourceId,
    artifact_id: artifactId,
    registered,
    current_status: event?.status || "missing",
    network_healthy: networkHealthy,
    content_present: contentPresent,
    semantic_blockers: semanticBlockers,
    warnings,
    review_flags: reviewFlags,
    observed_identity: observedSourceIdentity(event, { artifactId }),
    healthy: registered && networkHealthy && contentPresent && semanticBlockers.length === 0,
    observation_state: observation.observation_state,
    event_candidate: observation.event_candidate,
    change_events: observation.change_events,
  };
}

function createSourceReviewQueue(sourceHealth) {
  const queue = new Map();
  for (const source of sourceHealth) {
    if (!source.semantic_blockers.length && !source.warnings.length && !source.review_flags.length) continue;
    const key = `${source.namespace}:${source.source_id}`;
    const current = queue.get(key) || {
      ref: key,
      label: source.label,
      current_status: source.current_status,
      observed_identity: source.observed_identity,
      semantic_blockers: [],
      warnings: [],
      review_flags: [],
      disposition: "human-source-review-required",
      affects_claim_status_automatically: false,
      notification_eligible: false,
    };
    current.semantic_blockers.push(...source.semantic_blockers);
    current.warnings.push(...source.warnings);
    current.review_flags.push(...source.review_flags);
    queue.set(key, current);
  }
  return [...queue.values()].map((item) => ({
    ...item,
    semantic_blockers: [...new Set(item.semantic_blockers)].sort(),
    warnings: [...new Set(item.warnings)].sort(),
    review_flags: [...new Set(item.review_flags)].sort(),
  })).sort((left, right) => left.ref.localeCompare(right.ref));
}

function evaluateRequirement(requirement, sourceHealth) {
  const byRef = new Map(sourceHealth.map((source) => [source.ref, source]));
  const sources = requirement.source_refs.map((ref) => byRef.get(ref) || { ref, healthy: false, independence_group: "missing", current_status: "missing" });
  const acceptedPolarities = new Set(requirement.accepted_polarities || ["supporting"]);
  const eligible = (source) => source.healthy && acceptedPolarities.has(source.evidence_polarity || "supporting");
  const healthy = sources.filter(eligible);
  const resultGroups = [...new Set(healthy.map((source) => source.result_independence_group || source.independence_group))].sort();
  const sourceGroups = [...new Set(healthy.map((source) => source.independence_group))].sort();
  const artifactOwners = [...new Set(healthy.map((source) => source.artifact_owner || source.independence_group))].sort();
  const alternativeSets = array(requirement.alternative_source_sets);
  const evaluatedAlternativeSets = alternativeSets.map((refs) => {
    const setSources = refs.map((ref) => byRef.get(ref) || { ref, healthy: false, independence_group: "missing", result_independence_group: "missing", current_status: "missing" });
    const setHealthy = setSources.filter(eligible);
    const setResultGroups = [...new Set(setHealthy.map((source) => source.result_independence_group || source.independence_group))].sort();
    return {
      source_refs: refs,
      observed_healthy: setHealthy.length,
      observed_result_independence_groups: setResultGroups,
      passed: setHealthy.length === refs.length
        && setHealthy.length >= requirement.min_healthy
        && setResultGroups.length >= requirement.min_independence_groups,
    };
  });
  const counterPolarityObserved = requirement.evidence_role !== "counterevidence"
    || healthy.some((source) => ["counter", "mixed"].includes(source.evidence_polarity));
  const matchingAlternativeSets = evaluatedAlternativeSets.filter((set) => set.passed);
  const passed = (alternativeSets.length
    ? matchingAlternativeSets.length > 0
    : healthy.length >= requirement.min_healthy && resultGroups.length >= requirement.min_independence_groups)
    && counterPolarityObserved;
  const activeSourceRefs = alternativeSets.length && matchingAlternativeSets.length
    ? [...new Set(matchingAlternativeSets.flatMap((set) => set.source_refs))]
    : requirement.source_refs;
  return {
    ...requirement,
    observed_healthy: healthy.length,
    observed_independence_groups: resultGroups,
    observed_result_independence_groups: resultGroups,
    observed_source_independence_groups: sourceGroups,
    observed_artifact_owners: artifactOwners,
    scientific_result_lineage_count: resultGroups.length,
    counter_polarity_observed: counterPolarityObserved,
    evaluated_alternative_source_sets: evaluatedAlternativeSets,
    matching_alternative_source_sets: matchingAlternativeSets.map((set) => set.source_refs),
    active_source_refs: activeSourceRefs,
    passed,
    source_statuses: sources.map((source) => ({
      ref: source.ref,
      healthy: source.healthy,
      eligible_for_requirement: eligible(source),
      status: source.current_status,
      evidence_polarity: source.evidence_polarity || "supporting",
      independence_group: source.independence_group || "missing",
      result_independence_group: source.result_independence_group || source.independence_group || "missing",
    })),
  };
}

function claimEventStatus(requirements, counterevidence, sourceHealth) {
  const byRef = new Map(sourceHealth.map((source) => [source.ref, source]));
  const activeRefs = [...new Set([
    ...requirements.flatMap((requirement) => requirement.active_source_refs),
    ...counterevidence.filter((requirement) => requirement.passed).flatMap((requirement) => requirement.active_source_refs),
  ])];
  const sources = activeRefs.map((ref) => byRef.get(ref)).filter(Boolean);
  if (sources.some((source) => source.observation_state === "regressed")) return "blocked-regression";
  if (sources.some((source) => !source.healthy || source.observation_state === "blocked" || source.semantic_blockers.length > 0)) return "blocked-source-anomaly";
  if (sources.some((source) => source.event_candidate)) return "human-review-required";
  if (sources.some((source) => source.observation_state === "baseline")) return "baseline";
  return "no-event";
}

function evaluateClaim(claim, sourceHealth) {
  const requirements = claim.requirements.map((requirement) => evaluateRequirement(requirement, sourceHealth));
  const counterevidence = array(claim.counterevidence_requirements).map((requirement) => evaluateRequirement(requirement, sourceHealth));
  const requirementsPassed = requirements.every((requirement) => requirement.passed);
  const coverageStatus = !requirementsPassed ? "evidence-gap" : claim.human_review_required ? "human-review-required" : "source-ready";
  const eventStatus = claimEventStatus(requirements, counterevidence, sourceHealth);
  const counterevidenceAvailable = counterevidence.some((requirement) => requirement.passed);
  const claimVerdict = !requirementsPassed
    ? "not-established"
    : claim.event_required && ["baseline", "no-event"].includes(eventStatus)
      ? "no-current-event"
      : claim.human_review_required || counterevidenceAvailable || eventStatus === "human-review-required"
        ? "pending-human-review"
        : "source-supported-with-ceiling";
  const byRef = new Map(sourceHealth.map((source) => [source.ref, source]));
  const eventEvidence = [...new Set([
    ...requirements.flatMap((requirement) => requirement.active_source_refs),
    ...counterevidence.flatMap((requirement) => requirement.active_source_refs),
  ])].map((ref) => byRef.get(ref)).filter((source) => source?.event_candidate).map((source) => ({
    ref: source.ref,
    observed_identity: source.observed_identity,
    change_events: source.change_events,
  }));
  return {
    ...claim,
    requirements,
    supporting_requirements: requirements,
    counterevidence_requirements: counterevidence,
    requirements_passed: requirementsPassed,
    supporting_requirements_passed: requirementsPassed,
    counterevidence_available: counterevidenceAvailable,
    counterevidence_status: counterevidenceAvailable ? "available-human-review-required" : "none-or-incomplete",
    coverage_status: coverageStatus,
    status: coverageStatus,
    event_status: eventStatus,
    event_evidence: eventEvidence,
    claim_verdict: claimVerdict,
    attention_used_for_status: false,
    notification_eligible: false,
  };
}

function attentionLevel(groupCount) {
  if (groupCount >= 3) return "A3";
  if (groupCount === 2) return "A2";
  if (groupCount === 1) return "A1";
  return "A0";
}

function evaluateAttention(topic, candidateAudit, now) {
  const eventMap = sourceEventMap(candidateAudit);
  const cutoff = now.getTime() - ATTENTION_WINDOW_DAYS * 86_400_000;
  const patterns = topic.attention_patterns.map((pattern) => new RegExp(pattern, "i"));
  const matches = [];
  for (const source of candidateSources.filter((candidate) => candidate.role === "editorial-discovery")) {
    const event = eventMap.get(source.id);
    if (!event || !NETWORK_SUCCESS.has(event.status) || array(event.semantic_blockers).length) continue;
    for (const item of array(event.snapshot?.items)) {
      const publishedAt = Date.parse(item.published_at || "");
      if (!Number.isFinite(publishedAt) || publishedAt < cutoff || publishedAt > now.getTime() + 300_000) continue;
      if (!patterns.some((pattern) => pattern.test(item.title || ""))) continue;
      matches.push({
        source_id: source.id,
        independence_group: source.independence_group,
        title: item.title,
        url: item.url,
        published_at: item.published_at,
      });
    }
  }
  const groups = [...new Set(matches.map((match) => match.independence_group))].sort();
  return {
    level: attentionLevel(groups.length),
    window_days: ATTENTION_WINDOW_DAYS,
    distinct_editorial_groups: groups,
    matched_items: matches.sort((left, right) => right.published_at.localeCompare(left.published_at)),
    affects_evidence_grade: false,
    affects_claim_status: false,
    use: "queue-priority-only",
  };
}

export function createSourceDiligenceAudit({ productionAudit, candidateAudit, now = new Date() }) {
  const sourceHealth = diligenceSourceProfiles.map((profile) => resolveSourceHealth(profile, productionAudit, candidateAudit));
  const sourceReviewQueue = createSourceReviewQueue(sourceHealth);
  const topics = diligenceTopics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    layers: topic.layers,
    claims: topic.claims.map((claim) => evaluateClaim(claim, sourceHealth)),
    attention: evaluateAttention(topic, candidateAudit, now),
    notification_eligible: false,
  }));
  const claims = topics.flatMap((topic) => topic.claims);
  const coverageStatus = claims.some((claim) => claim.coverage_status === "evidence-gap") ? "evidence-gaps-present" : "review-required";
  const eventStatuses = new Set(claims.map((claim) => claim.event_status));
  const eventStatus = eventStatuses.has("blocked-regression")
    ? "blocked-regression"
    : eventStatuses.has("blocked-source-anomaly")
      ? "blocked-source-anomaly"
      : eventStatuses.has("human-review-required")
        ? "human-review-required"
        : eventStatuses.has("baseline")
          ? "baseline"
          : "no-event";
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    mode: "source-diligence-audit",
    coverage_status: coverageStatus,
    status: coverageStatus,
    event_status: eventStatus,
    input_snapshots: {
      production_generated_at: productionAudit?.generated_at || "",
      candidate_generated_at: candidateAudit?.generated_at || "",
    },
    axis_policy: {
      authority: "claim-specific evidence ceiling; official release authority applies only to release occurrence",
      attention: "A0-A3 from distinct T2 editorial independence groups matching titles in a bounded window",
      authority_attention_merged: false,
      attention_can_raise_evidence_grade: false,
      attention_can_satisfy_claim_requirement: false,
      coverage_event_verdict_merged: false,
      healthy_coverage_is_current_event: false,
      counterevidence_can_satisfy_supporting_requirement: false,
      scientific_independence_uses_result_lineage: true,
    },
    isolation_policy: {
      reads_production_audit: true,
      writes_production_state: false,
      changes_production_registry: false,
      changes_ranking: false,
      automatic_promotions: [],
    },
    notification_policy: {
      enabled: false,
      eligible: false,
      external_actions: [],
      statement: "This report is due diligence only and cannot publish or message.",
    },
    metrics: {
      topics: topics.length,
      claims: claims.length,
      source_ready_claims: claims.filter((claim) => claim.status === "source-ready").length,
      human_review_required_claims: claims.filter((claim) => claim.status === "human-review-required").length,
      evidence_gap_claims: claims.filter((claim) => claim.status === "evidence-gap").length,
      claims_with_current_event_candidates: claims.filter((claim) => claim.event_status === "human-review-required").length,
      baseline_claims_without_events: claims.filter((claim) => claim.event_status === "baseline").length,
      claims_without_events: claims.filter((claim) => claim.event_status === "no-event").length,
      blocked_source_anomaly_claims: claims.filter((claim) => claim.event_status === "blocked-source-anomaly").length,
      blocked_regression_claims: claims.filter((claim) => claim.event_status === "blocked-regression").length,
      source_supported_with_ceiling_claims: claims.filter((claim) => claim.claim_verdict === "source-supported-with-ceiling").length,
      pending_human_review_verdicts: claims.filter((claim) => claim.claim_verdict === "pending-human-review").length,
      not_established_verdicts: claims.filter((claim) => claim.claim_verdict === "not-established").length,
      no_current_event_verdicts: claims.filter((claim) => claim.claim_verdict === "no-current-event").length,
      claims_with_counterevidence: claims.filter((claim) => claim.counterevidence_available).length,
      causal_claims: claims.filter((claim) => claim.causal_claim).length,
      causal_claims_source_ready: claims.filter((claim) => claim.causal_claim && claim.status === "source-ready").length,
      healthy_profiled_sources: sourceHealth.filter((source) => source.healthy).length,
      profiled_sources: sourceHealth.length,
      source_review_queue_records: sourceReviewQueue.length,
      notification_eligible_records: 0,
    },
    source_profiles: sourceHealth,
    source_review_queue: sourceReviewQueue,
    topics,
  };
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function claimSummary(claim) {
  const missing = claim.requirements.filter((requirement) => !requirement.passed).map((requirement) => requirement.required_next || requirement.label);
  return missing.length
    ? `${claim.coverage_status}/${claim.event_status}/${claim.claim_verdict}: ${missing.join("；")}`
    : `${claim.coverage_status}/${claim.event_status}/${claim.claim_verdict}: ceiling ${claim.evidence_ceiling_when_met}`;
}

export function renderSourceDiligenceReview(audit) {
  const lines = [
    `# 模型底层来源尽调矩阵 · ${audit.generated_at.slice(0, 10)}`,
    "",
    "> 权威性决定一条 claim 最多能证明到哪里；关注度只决定人工查看顺序。两者永不相加，也不自动触发通知。",
    "",
    "## 结论",
    "",
    `- 主题：${audit.metrics.topics}；claims：${audit.metrics.claims}`,
    `- source-ready：${audit.metrics.source_ready_claims}；待人工语义复核：${audit.metrics.human_review_required_claims}；证据缺口：${audit.metrics.evidence_gap_claims}`,
    `- 当日事件状态：${audit.event_status}；变化候选 claims：${audit.metrics.claims_with_current_event_candidates}；baseline/no-event：${audit.metrics.baseline_claims_without_events}/${audit.metrics.claims_without_events}`,
    `- claim verdict：有上限支持 ${audit.metrics.source_supported_with_ceiling_claims}；待人审 ${audit.metrics.pending_human_review_verdicts}；未建立 ${audit.metrics.not_established_verdicts}；无当日事件 ${audit.metrics.no_current_event_verdicts}`,
    `- 底层因果 claims：${audit.metrics.causal_claims}；可直接 source-ready：${audit.metrics.causal_claims_source_ready}`,
    `- 已健康的定向来源：${audit.metrics.healthy_profiled_sources}/${audit.metrics.profiled_sources}`,
    `- 来源异常/语义复核队列：${audit.metrics.source_review_queue_records}（只排队，不自动改变 claim）`,
    "- 通知：关闭；外部动作：0。",
    "",
    "## 主题矩阵",
    "",
    "| 主题 | 层 | 可监控 claim | 更强/因果 claim | 关注度 |",
    "|---|---|---|---|---|",
  ];
  for (const topic of audit.topics) {
    const monitorable = topic.claims.filter((claim) => !claim.causal_claim).map(claimSummary).join("；");
    const stronger = topic.claims.filter((claim) => claim.causal_claim).map(claimSummary).join("；");
    lines.push(`| ${markdownCell(topic.title)} | ${topic.layers.join("/")} | ${markdownCell(monitorable)} | ${markdownCell(stronger)} | ${topic.attention.level}（${topic.attention.distinct_editorial_groups.length} 个独立编辑源） |`);
  }
  lines.push(
    "",
    "## 来源异常与语义复核队列",
    "",
    "> Warning、review flag 与 semantic blocker 必须保留原始对象身份。它们只进入人工来源复核，不能自行升级证据或触发通知。",
    "",
  );
  if (audit.source_review_queue.length) {
    lines.push(
      "| 来源 | 当前身份 | 状态 | blocker / warning / review flag |",
      "|---|---|---|---|",
    );
    for (const item of audit.source_review_queue) {
      const issues = [
        ...item.semantic_blockers.map((value) => `blocker:${value}`),
        ...item.warnings.map((value) => `warning:${value}`),
        ...item.review_flags.map((value) => `review:${value}`),
      ].join("；");
      lines.push(`| ${markdownCell(item.label)} | ${markdownCell(item.observed_identity)} | ${markdownCell(item.current_status)} | ${markdownCell(issues)} |`);
    }
  } else {
    lines.push("当前没有 blocker、warning 或 review flag；这不等于已完成人工准入。 ");
  }
  lines.push(
    "",
    "## Claim 级证据缺口",
    "",
  );
  for (const topic of audit.topics) {
    lines.push(`### ${topic.title}`,
      "");
    for (const claim of topic.claims) {
      lines.push(`- **${claim.label}** — coverage \`${claim.coverage_status}\`；event \`${claim.event_status}\`；verdict \`${claim.claim_verdict}\`；证据上限：${claim.evidence_ceiling_when_met}`);
      for (const requirement of claim.requirements) {
        const next = requirement.passed ? "已满足" : requirement.required_next || "缺少健康来源";
        const alternatives = requirement.alternative_source_sets.length ? `；同项目完整组合 ${requirement.matching_alternative_source_sets.length}/${requirement.alternative_source_sets.length}` : "";
        lines.push(`  - 支持证据 · ${requirement.label}: ${requirement.observed_healthy}/${requirement.min_healthy}，科学结果谱系 ${requirement.scientific_result_lineage_count}/${requirement.min_independence_groups}${alternatives}；${next}`);
      }
      for (const counterevidence of claim.counterevidence_requirements) {
        const state = counterevidence.passed ? "已观察，必须人工解释" : counterevidence.required_next || "未形成完整反证包";
        lines.push(`  - 反证/混合证据 · ${counterevidence.label}: ${counterevidence.observed_healthy}/${counterevidence.min_healthy}，科学结果谱系 ${counterevidence.scientific_result_lineage_count}/${counterevidence.min_independence_groups}；${state}；不计入支持 requirement`);
      }
    }
    if (topic.attention.matched_items.length) {
      lines.push(`- T2 关注匹配（只排队，不作证据）：${topic.attention.matched_items.map((item) => `[${markdownCell(item.title)}](${item.url})`).join("；")}`);
    } else {
      lines.push("- T2 关注匹配：近 14 天未在四个候选编辑源标题中命中；这不代表技术不重要。 ");
    }
    lines.push("");
  }
  lines.push(
    "## 来源权威边界",
    "",
    "| 来源 | 当前健康 | 当前不可变/快照身份 | 极性 / 科学结果谱系 | 权威/claim scope | 能证明 | 不能证明 |",
    "|---|---|---|---|---|---|---|",
  );
  for (const source of audit.source_profiles) {
    lines.push(`| ${markdownCell(source.label)} | ${source.healthy ? "是" : `否（${source.current_status}）`} | ${markdownCell(source.observed_identity)} | ${source.evidence_polarity} / ${source.result_independence_group} | ${source.authority_tier}/${source.claim_scope} | ${markdownCell(source.proves)} | ${markdownCell(source.does_not_prove)} |`);
  }
  lines.push(
    "",
    "## 人工复核边界",
    "",
    "- Constitution diff 只能成为 intended-policy 候选，不能推断权重中的实现。",
    "- Ouro/Coconut 的 G2 仅表示作者论文与官方 artifact 可追溯；底层因果措辞仍需独立 intervention/ablation。",
    "- Circuit Tracing 的独立实现 release 不是独立科学复现。",
    "- Harness release 证明版本发生，不证明固定模型能力提升；评测分数必须绑定 task、grader、budget 与重跑日志。",
    "- A0 不代表不重要，A3 也不代表真实；关注度始终不改变 claim 状态。",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runSourceDiligence({
  productionPath = process.env.MECHANISM_AUDIT_PATH || "work/mechanism-watch/audit.json",
  candidatePath = process.env.CANDIDATE_PROBE_OUTPUT_PATH || "work/candidate-source-probe/audit.json",
  outputPath = process.env.SOURCE_DILIGENCE_OUTPUT_PATH || "work/source-diligence/coverage.json",
  reviewPath = process.env.SOURCE_DILIGENCE_REVIEW_PATH || "work/source-diligence/coverage.md",
  now = new Date(),
} = {}) {
  const [productionAudit, candidateAudit] = await Promise.all([readJson(productionPath), readJson(candidatePath)]);
  const audit = createSourceDiligenceAudit({ productionAudit, candidateAudit, now });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
  await mkdir(dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, renderSourceDiligenceReview(audit));
  return audit;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  runSourceDiligence().then((audit) => console.log(JSON.stringify({
    mode: audit.mode,
    status: audit.status,
    topics: audit.metrics.topics,
    claims: audit.metrics.claims,
    evidence_gap_claims: audit.metrics.evidence_gap_claims,
    causal_claims_source_ready: audit.metrics.causal_claims_source_ready,
    notification_eligible_records: audit.metrics.notification_eligible_records,
  }))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
