#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isBoundPolicyTextDelta(metadata) {
  const diff = metadata?.line_diff;
  return diff?.status === "changed"
    && diff.changed === true
    && diff.requires_human_semantic_review === true
    && SHA256_PATTERN.test(diff.previous_sha256 || "")
    && SHA256_PATTERN.test(diff.current_sha256 || "")
    && diff.previous_sha256 !== diff.current_sha256
    && metadata?.content_sha256 === diff.current_sha256;
}

export function verifySilentAudit(audit) {
  const errors = [];
  if (audit?.schema_version !== 1) errors.push("unsupported schema_version");
  if (audit?.mode !== "silent-audit") errors.push("mode must be silent-audit");
  if (audit?.notification_policy?.enabled !== false) errors.push("notification policy must be disabled");
  if (!Array.isArray(audit?.notification_policy?.external_actions) || audit.notification_policy.external_actions.length) errors.push("external_actions must be empty");
  if (audit?.notification_gate?.eligible !== false) errors.push("notification gate must remain ineligible");
  if (audit?.metrics?.notification_eligible_records !== 0) errors.push("notification_eligible_records must be zero");
  if (!Array.isArray(audit?.source_registry) || audit.source_registry.some((source) => source.authentication !== "public")) errors.push("all registered sources must be public");
  if (!Array.isArray(audit?.records) || audit.records.some((record) => record.notification_eligible !== false)) errors.push("every record must be notification-ineligible");
  const allowedChanges = new Set(["baseline", "new", "unchanged", "updated", "enriched", "revision", "source-regressed"]);
  const registrySources = new Map((audit?.source_registry || []).map((source) => [source.id, source]));
  for (const record of audit?.records || []) {
    if (!/^[a-f0-9]{64}$/.test(record.source_content_hash || "")) errors.push(`record source_content_hash missing: ${record.canonical_id}`);
    if (!allowedChanges.has(record.change)) errors.push(`unsupported record change: ${record.canonical_id}`);
    if (["enriched", "source-regressed"].includes(record.change) && record.provisional_priority !== "none") errors.push(`non-content arXiv change has priority: ${record.canonical_id}`);
    if (record.canonical_id?.startsWith("arxiv:") && record.arxiv_version_observed != null
      && (!Number.isInteger(record.arxiv_version_observed) || record.arxiv_version_observed < 1)) errors.push(`invalid observed arXiv version: ${record.canonical_id}`);
    if (record.canonical_id?.startsWith("arxiv:") && record.arxiv_version_observed != null
      && record.arxiv_version < record.arxiv_version_observed) errors.push(`effective arXiv version regressed: ${record.canonical_id}`);
    const recordSources = new Map((record.sources || []).map((source) => [source.id, {
      artifactType: source.artifact_type || registrySources.get(source.id)?.artifactType,
      official: source.official ?? registrySources.get(source.id)?.official,
    }]));
    for (const sourceId of record.source_ids || []) {
      if (!recordSources.has(sourceId) && registrySources.has(sourceId)) {
        const source = registrySources.get(sourceId);
        recordSources.set(sourceId, { artifactType: source.artifactType, official: source.official });
      }
    }
    const commitSourceIds = new Set([...recordSources].filter(([, source]) => source.artifactType === "versioned-policy").map(([sourceId]) => sourceId));
    const textSourceIds = new Set([...recordSources].filter(([, source]) => source.artifactType === "versioned-policy-text").map(([sourceId]) => sourceId));
    const sourceMetadata = record.source_metadata || [];
    const textSnapshots = sourceMetadata.filter((metadata) => textSourceIds.has(metadata.source_id));
    const hasBoundTextDelta = textSnapshots.some((metadata) => recordSources.get(metadata.source_id)?.official === true && isBoundPolicyTextDelta(metadata));
    const hasEligibleBoundTextDelta = record.change === "updated" && hasBoundTextDelta;

    for (const metadata of sourceMetadata) {
      const artifactType = metadata.source_artifact_type || recordSources.get(metadata.source_id)?.artifactType;
      if (artifactType === "versioned-policy" && metadata.source_concrete_mechanism_delta !== false) {
        errors.push(`versioned policy commit cannot contribute a concrete delta: ${record.canonical_id}`);
      }
      if (artifactType === "versioned-policy-text") {
        const expectedConcrete = record.change === "updated"
          && recordSources.get(metadata.source_id)?.official === true
          && isBoundPolicyTextDelta(metadata);
        if (metadata.source_concrete_mechanism_delta !== expectedConcrete) errors.push(`versioned policy text source classification mismatch: ${record.canonical_id}`);
      }
    }

    const hasCommitArtifact = commitSourceIds.size > 0 || record.artifact_types?.includes("versioned-policy");
    const hasTextArtifact = textSourceIds.size > 0 || record.artifact_types?.includes("versioned-policy-text");
    if (hasCommitArtifact && !hasTextArtifact && record.concrete_mechanism_delta !== false) errors.push(`versioned policy commit record is concrete: ${record.canonical_id}`);
    if (hasCommitArtifact && !hasTextArtifact && record.provisional_priority !== "none") errors.push(`versioned policy commit record has provisional priority: ${record.canonical_id}`);
    if (hasTextArtifact && !textSnapshots.length) errors.push(`versioned policy text is missing snapshot evidence: ${record.canonical_id}`);
    if (textSnapshots.some((snapshot) => snapshot.line_diff?.requires_human_semantic_review !== true)) errors.push(`versioned policy diff bypasses human review: ${record.canonical_id}`);
    if (hasTextArtifact && record.concrete_mechanism_delta !== hasEligibleBoundTextDelta) errors.push(`versioned policy text concrete delta lacks bound changed identities: ${record.canonical_id}`);
    if ((hasCommitArtifact || hasTextArtifact) && ["baseline", "unchanged"].includes(record.change) && record.concrete_mechanism_delta !== false) {
      errors.push(`baseline or unchanged policy record is concrete: ${record.canonical_id}`);
    }
    if (record.provisional_priority === "P0") {
      if (record.primary_layer !== "B0" || !hasEligibleBoundTextDelta) errors.push(`P0 lacks an updated bound policy text diff: ${record.canonical_id}`);
      if (!record.blockers?.includes("human-semantic-diff-required")) errors.push(`P0 bypasses human semantic review: ${record.canonical_id}`);
    }
  }
  if (!Array.isArray(audit?.identity_history)) errors.push("identity_history must be an array");
  const historyIds = new Set();
  for (const identity of audit?.identity_history || []) {
    if (!identity.canonical_id || historyIds.has(identity.canonical_id)) errors.push(`duplicate or missing identity history key: ${identity.canonical_id || "unknown"}`);
    historyIds.add(identity.canonical_id);
    if (!/^[a-f0-9]{64}$/.test(identity.source_content_hash || "")) errors.push(`identity history source hash missing: ${identity.canonical_id}`);
    if (!Number.isFinite(Date.parse(identity.first_seen_at || "")) || !Number.isFinite(Date.parse(identity.last_seen_at || ""))) errors.push(`identity history timestamps invalid: ${identity.canonical_id}`);
    if (identity.arxiv_version != null && (!Number.isInteger(identity.arxiv_version) || identity.arxiv_version < 1)) errors.push(`identity history arXiv version invalid: ${identity.canonical_id}`);
  }
  if ((audit?.identity_history?.length || 0) > 5_000) errors.push("identity_history exceeds bounded limit");
  if (audit?.metrics?.identity_history_records !== audit?.identity_history?.length) errors.push("identity history metric mismatch");
  if (!Array.isArray(audit?.daily_current_window_records)) errors.push("daily_current_window_records must be an array");
  const dailyWindowIds = new Set();
  const currentRecordsById = new Map((audit?.records || []).map((record) => [record.canonical_id, record]));
  const freshSourceIds = new Set((audit?.source_events || []).filter((event) => event.status === "fresh").map((event) => event.source_id));
  const generatedAtMs = Date.parse(audit?.generated_at || "");
  for (const record of audit?.daily_current_window_records || []) {
    const id = record?.canonical_id;
    if (!id || dailyWindowIds.has(id)) errors.push(`duplicate or missing daily window key: ${id || "unknown"}`);
    dailyWindowIds.add(id);
    const publishedAtMs = Date.parse(record?.published_at || "");
    const ageHours = (generatedAtMs - publishedAtMs) / (60 * 60 * 1000);
    if (!Number.isFinite(ageHours) || ageHours < 0 || ageHours > 48) errors.push(`daily window record is outside 48 hours: ${id}`);
    if (record?.concrete_mechanism_delta !== true || !/^G[1-4]$/.test(String(record?.evidence_grade || ""))) errors.push(`daily window record lacks eligible mechanism evidence: ${id}`);
    if (record?.manual_review_only !== true || record?.primary_verification_required !== true
      || record?.claim_evidence_allowed !== false || record?.notification_eligible !== false) errors.push(`daily window safety boundary is open: ${id}`);
    if (record?.daily_window_state === "current-source") {
      if (record.fresh_for_change_detection !== true) errors.push(`current daily window record is not fresh: ${id}`);
      if (!currentRecordsById.has(id)) errors.push(`current daily window record is absent from current records: ${id}`);
      if (!(record.source_ids || []).some((sourceId) => freshSourceIds.has(sourceId))) errors.push(`current daily window record has no fresh source: ${id}`);
    } else if (record?.daily_window_state === "retained-from-prior-snapshot") {
      if (record.fresh_for_change_detection !== false || record.daily_change_candidate !== false) errors.push(`retained daily window record claims a fresh change: ${id}`);
      if (!Number.isFinite(Date.parse(record.retained_from_generated_at || "")) || Date.parse(record.retained_from_generated_at) > generatedAtMs) errors.push(`retained daily window provenance is invalid: ${id}`);
    } else {
      errors.push(`unsupported daily window state: ${id}`);
    }
  }
  if (audit?.metrics?.daily_current_window_records !== audit?.daily_current_window_records?.length) errors.push("daily current window metric mismatch");
  const qualityReview = audit?.quality_review;
  if (!qualityReview || qualityReview.selection !== "deterministic-daily-stratified-by-primary-layer") errors.push("daily quality review selection is missing");
  if (qualityReview?.date !== audit?.notification_gate?.observed_silent_dates?.at(-1)) errors.push("daily quality review date mismatch");
  if (qualityReview?.human_reviewed !== false || qualityReview?.can_satisfy_human_gate !== false) errors.push("collector must not self-complete human quality review");
  if (!Array.isArray(qualityReview?.human_decisions) || qualityReview.human_decisions.length) errors.push("collector must leave human quality decisions empty");
  if (!Array.isArray(qualityReview?.samples)) errors.push("daily quality review samples must be an array");
  if (qualityReview?.sampled_records !== qualityReview?.samples?.length) errors.push("daily quality review sample count mismatch");
  if (audit?.metrics?.quality_review_sample_records !== qualityReview?.samples?.length) errors.push("daily quality review metric mismatch");
  const recordsById = new Map((audit?.records || []).map((record) => [record.canonical_id, record]));
  const sampledIds = new Set();
  const sampledLayers = new Map();
  for (const sample of qualityReview?.samples || []) {
    const record = recordsById.get(sample.canonical_id);
    if (!record || !record.concrete_mechanism_delta) errors.push(`quality sample is not an eligible mechanism record: ${sample.canonical_id}`);
    if (sampledIds.has(sample.canonical_id)) errors.push(`duplicate daily quality sample: ${sample.canonical_id}`);
    sampledIds.add(sample.canonical_id);
    sampledLayers.set(sample.primary_layer, (sampledLayers.get(sample.primary_layer) || 0) + 1);
    if (sample.primary_layer !== record?.primary_layer) errors.push(`quality sample layer mismatch: ${sample.canonical_id}`);
    if (sample.human_reviewed !== false || sample.human_decision !== null) errors.push(`quality sample must remain pending human review: ${sample.canonical_id}`);
  }
  for (const [layer, count] of sampledLayers) if (count > qualityReview.per_layer_target) errors.push(`quality sample exceeds per-layer target: ${layer}`);
  const countedChanges = Object.values(audit?.metrics?.change_counts || {}).reduce((total, count) => total + Number(count || 0), 0);
  if (countedChanges !== audit?.records?.length) errors.push("record change metric mismatch");
  if (!Array.isArray(audit?.seed_graph) || audit.seed_graph.some((seed) => seed.notification_eligible !== false)) errors.push("every seed must be notification-ineligible");
  if (!Array.isArray(audit?.seed_health) || audit.seed_health.length !== audit?.seed_graph?.length) errors.push("seed health must cover every seed");
  if (audit?.seed_health?.some((seed) => !Array.isArray(seed.monitored_source_ids))) errors.push("seed health sources must be explicit");
  for (const key of ["gemini_required", "google_oauth_required", "openai_membership_required", "cloudflare_credentials_required"]) {
    if (audit?.dependency_policy?.[key] !== false) errors.push(`${key} must be false`);
  }
  if (!Number.isFinite(Date.parse(audit?.generated_at || ""))) errors.push("generated_at must be an ISO timestamp");
  if (audit?.source_events?.length !== audit?.source_registry?.length) errors.push("source event count must match registry count");
  if (errors.length) throw new Error(`unsafe mechanism audit:\n- ${errors.join("\n- ")}`);
  return {
    mode: audit.mode,
    status: audit.status,
    sources: audit.source_events.length,
    core_success_rate: audit.metrics.core_success_rate,
    silent_days: audit.notification_gate.consecutive_silent_days,
    gate_eligible: audit.notification_gate.eligible,
  };
}

export async function verifySilentAuditFile(path) {
  return verifySilentAudit(JSON.parse(await readFile(path, "utf8")));
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  const path = process.argv[2] || "work/mechanism-watch/audit.json";
  verifySilentAuditFile(path).then((summary) => {
    console.log(JSON.stringify(summary));
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
