#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const MINIMUM_SILENT_DAYS = 7;
const MAX_MANUAL_REVIEW_SHORTLIST = 12;
const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const unique = (items) => [...new Set(items)];
const sortedUnique = (items) => unique(items.filter((item) => item !== "")).sort((left, right) => String(left).localeCompare(String(right)));

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function sourceIdFromRef(ref) {
  return /^(production|candidate):([^#]+)/.exec(ref || "")?.[2] || "";
}

function namespaceFromRef(ref) {
  return /^(production|candidate):/.exec(ref || "")?.[1] || "";
}

function artifactIdFromRef(ref) {
  return String(ref || "").split("#")[1] || "";
}

export function identityQuality(identity) {
  const value = String(identity || "");
  if (!value || value.startsWith("unavailable:")) return "unavailable";
  if (/^(arxiv:[^;]+v\d+|git-(commit|blob|tree):[a-f0-9]{7,}|model:[^;]+; revision:[a-f0-9]{7,}|dataset:[^;]+; revision:[a-f0-9]{7,})/.test(value)) {
    return "upstream-immutable";
  }
  if (/^(response-sha256:|document-sha256:|github-release-snapshot:)/.test(value)) return "content-addressed-snapshot";
  return "mutable-pointer";
}

function inputSnapshot(document) {
  return {
    mode: document?.mode || "unknown",
    generated_at: document?.generated_at || "",
    content_sha256: sha256(document),
  };
}

export function assertSnapshotChain({ productionAudit, candidateAudit, sourceDiligence, semanticDossier }) {
  const errors = [];
  if (sourceDiligence?.input_snapshots?.production_generated_at !== productionAudit?.generated_at) errors.push("source diligence production snapshot mismatch");
  if (sourceDiligence?.input_snapshots?.candidate_generated_at !== candidateAudit?.generated_at) errors.push("source diligence candidate snapshot mismatch");
  if (semanticDossier?.input_snapshots?.source_diligence_generated_at !== sourceDiligence?.generated_at) errors.push("semantic dossier diligence snapshot mismatch");
  if (semanticDossier?.input_snapshots?.candidate_probe_generated_at !== candidateAudit?.generated_at) errors.push("semantic dossier candidate snapshot mismatch");
  if (errors.length) throw new Error(errors.join("; "));
}

function compactRequirement(requirement) {
  return {
    id: requirement.id,
    label: requirement.label,
    evidence_role: requirement.evidence_role || "supporting",
    accepted_polarities: array(requirement.accepted_polarities),
    source_refs: array(requirement.source_refs),
    alternative_source_sets: array(requirement.alternative_source_sets).map((set) => array(set)),
    min_healthy: requirement.min_healthy,
    min_independence_groups: requirement.min_independence_groups,
    observed_healthy: requirement.observed_healthy,
    observed_result_independence_groups: array(requirement.observed_result_independence_groups),
    scientific_result_lineage_count: requirement.scientific_result_lineage_count ?? array(requirement.observed_result_independence_groups).length,
    passed: requirement.passed === true,
    required_next: requirement.required_next || "",
  };
}

function dossierClaimMap(semanticDossier) {
  const claims = new Map();
  for (const reviewPackage of array(semanticDossier?.packages)) {
    for (const claim of array(reviewPackage?.claims)) claims.set(`${claim.topic_id}/${claim.claim_id}`, { reviewPackage, claim });
  }
  return claims;
}

function bindingIndex(sourceDiligence, semanticDossier) {
  const dossierClaims = dossierClaimMap(semanticDossier);
  const byRef = new Map();
  const add = (ref, binding) => {
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(binding);
  };
  for (const topic of array(sourceDiligence?.topics)) {
    for (const claim of array(topic?.claims)) {
      const joined = dossierClaims.get(`${topic.id}/${claim.id}`);
      if (!joined) throw new Error(`missing semantic dossier claim: ${topic.id}/${claim.id}`);
      const visit = (requirement, evidenceRole) => {
        for (const ref of array(requirement.source_refs)) {
          add(ref, {
            package_id: joined.reviewPackage.id,
            topic_id: topic.id,
            claim_id: claim.id,
            requirement_id: requirement.id,
            evidence_role: evidenceRole,
            requirement_passed: requirement.passed === true,
            claim_status: claim.coverage_status || claim.status,
            claim_verdict: claim.claim_verdict,
          });
        }
      };
      for (const requirement of array(claim.requirements)) visit(requirement, "supporting");
      for (const requirement of array(claim.counterevidence_requirements)) visit(requirement, "counterevidence");
    }
  }
  return byRef;
}

function registryMetadata(namespace, sourceId, productionRegistry, candidateRegistry) {
  const registered = namespace === "production" ? productionRegistry.get(sourceId) : candidateRegistry.get(sourceId);
  if (!registered) return null;
  if (namespace === "production") {
    return {
      label: registered.label,
      role: registered.lane || registered.artifactType || "production-source",
      format: registered.format,
      canonical_url: registered.canonical_url || registered.url,
      authentication: registered.authentication,
      lanes: sortedUnique([registered.defaultLayer, registered.lane]),
      registry_tier: registered.tier,
    };
  }
  return {
    label: registered.label,
    role: registered.role,
    format: registered.format,
    canonical_url: registered.canonical_url || registered.url,
    authentication: registered.authentication,
    lanes: array(registered.lanes),
    registry_tier: "shadow",
  };
}

function artifactAssessment(profiles) {
  const paperCodeMatches = sortedUnique(profiles.map((profile) => profile.paper_code_match || "not-assessed"));
  const manualRiskFlags = sortedUnique(profiles.flatMap((profile) => array(profile.manual_risk_flags)));
  const completeness = paperCodeMatches.includes("blocked")
    ? "blocked"
    : manualRiskFlags.length
      ? "risk-flagged"
      : "not-assessed";
  return {
    completeness,
    completeness_claimed: false,
    paper_code_matches: paperCodeMatches,
    manual_risk_flags: manualRiskFlags,
  };
}

function candidateStability(history) {
  const observedDays = history?.criteria?.minimum_observation_days?.observed
    ?? history?.consecutive_network_success_days
    ?? 0;
  return {
    scope: "per-source",
    observed_network_success_dates: array(history?.observed_network_success_dates),
    consecutive_network_success_days: history?.consecutive_network_success_days ?? 0,
    observed_days: observedDays,
    required_days: MINIMUM_SILENT_DAYS,
    passed: observedDays >= MINIMUM_SILENT_DAYS,
    per_source_status: history ? "measured" : "missing",
    human_source_review_observed: history?.criteria?.human_source_review?.observed === true,
  };
}

function productionStability(productionAudit) {
  return {
    scope: "global-only",
    global_observed_silent_dates: array(productionAudit?.notification_gate?.observed_silent_dates),
    global_consecutive_silent_days: productionAudit?.notification_gate?.consecutive_silent_days ?? 0,
    per_source_status: "not-measured",
    observed_days: null,
    required_days: MINIMUM_SILENT_DAYS,
    passed: null,
    human_source_review_observed: false,
  };
}

function sourceReadiness({ namespace, healthy, observationState, semanticBlockers, identityQualities, stability, artifact, warnings, reviewFlags, bindings }) {
  if (namespace === "production") {
    const blockers = ["per-source-stability-not-evidenced"];
    if (!healthy) blockers.push("source-unhealthy");
    for (const blocker of semanticBlockers) blockers.push(`semantic-blocker:${blocker}`);
    if (["source-regressed", "identity-regressed", "regressed"].includes(observationState)) blockers.push("source-identity-regressed");
    if (identityQualities.includes("unavailable")) blockers.push("immutable-identity-missing");
    if (!bindings.length) blockers.push("no-claim-contract-binding");
    if (identityQualities.some((quality) => quality !== "upstream-immutable")) blockers.push("immutable-upstream-identity-not-exposed");
    if (artifact.completeness !== "not-assessed") blockers.push("artifact-risk-review-required");
    if (warnings.length) blockers.push("source-warning-review-required");
    if (reviewFlags.length) blockers.push("source-review-flag-unresolved");
    return { readiness_state: "existing-production", blockers: sortedUnique(blockers) };
  }
  const blockers = [];
  const hardBlocked = !healthy
    || semanticBlockers.length > 0
    || ["source-regressed", "identity-regressed"].includes(observationState)
    || identityQualities.includes("unavailable");
  if (!healthy) blockers.push("source-unhealthy");
  for (const blocker of semanticBlockers) blockers.push(`semantic-blocker:${blocker}`);
  if (["source-regressed", "identity-regressed"].includes(observationState)) blockers.push("source-identity-regressed");
  if (identityQualities.includes("unavailable")) blockers.push("immutable-identity-missing");
  if (identityQualities.some((quality) => quality !== "upstream-immutable")) blockers.push("immutable-upstream-identity-not-exposed");
  if (!stability.passed) blockers.push("minimum-silent-days-not-met");
  if (!stability.human_source_review_observed) blockers.push("human-source-review-not-completed");
  if (artifact.completeness !== "not-assessed") blockers.push("artifact-risk-review-required");
  if (warnings.length) blockers.push("source-warning-review-required");
  if (reviewFlags.length) blockers.push("source-review-flag-unresolved");
  blockers.push("matching-external-decision-ledger-missing");
  return {
    readiness_state: hardBlocked ? "blocked" : stability.passed ? "await-human-source-review" : "observing",
    blockers: sortedUnique(blockers),
  };
}

function hasHardReadinessBlocker(source) {
  const blockers = array(source?.promotion_review?.blockers);
  return source?.promotion_review?.readiness_state === "blocked"
    || blockers.includes("source-unhealthy")
    || blockers.includes("source-identity-regressed")
    || blockers.includes("immutable-identity-missing")
    || blockers.some((blocker) => blocker.startsWith("semantic-blocker:"));
}

export function sourceFingerprint(source) {
  return sha256({
    endpoint_key: source.endpoint_key,
    artifact_refs: source.artifact_refs,
    artifact_identities: source.artifact_identities,
    identity_qualities: source.identity_qualities,
    current_collection_tier: source.current_collection_tier,
    registry: source.registry,
    authority_tiers: source.authority_tiers,
    claim_scopes: source.claim_scopes,
    independence_groups: source.independence_groups,
    result_lineage_ids: source.result_lineage_ids,
    artifact_owners: source.artifact_owners,
    health: source.health,
    stability: source.stability,
    artifact_assessment: source.artifact_assessment,
    bindings: source.bindings,
    proves: source.proves,
    does_not_prove: source.does_not_prove,
    promotion_review: {
      readiness_state: source.promotion_review?.readiness_state,
      blockers: source.promotion_review?.blockers,
      automatic_promotion: source.promotion_review?.automatic_promotion,
    },
    notification_eligible: source.notification_eligible,
  });
}

function buildSources({ productionAudit, candidateAudit, sourceDiligence, semanticDossier }) {
  const productionRegistry = new Map(array(productionAudit?.source_registry).map((source) => [source.id, source]));
  const candidateRegistry = new Map(array(candidateAudit?.source_registry).map((source) => [source.id, source]));
  const productionEvents = new Map(array(productionAudit?.source_events).map((event) => [event.source_id, event]));
  const candidateHistory = new Map(array(candidateAudit?.source_history).map((history) => [history.source_id, history]));
  const bindingsByRef = bindingIndex(sourceDiligence, semanticDossier);
  const grouped = new Map();
  for (const profile of array(sourceDiligence?.source_profiles)) {
    const namespace = profile.namespace || namespaceFromRef(profile.ref);
    const sourceId = profile.source_id || sourceIdFromRef(profile.ref);
    const endpointKey = `${namespace}:${sourceId}`;
    if (!grouped.has(endpointKey)) grouped.set(endpointKey, { namespace, sourceId, profiles: [] });
    grouped.get(endpointKey).profiles.push(profile);
  }
  const sources = [];
  for (const [endpointKey, group] of grouped) {
    const { namespace, sourceId, profiles } = group;
    const registry = registryMetadata(namespace, sourceId, productionRegistry, candidateRegistry);
    const history = candidateHistory.get(sourceId);
    const productionEvent = productionEvents.get(sourceId);
    const semanticBlockers = sortedUnique([
      ...profiles.flatMap((profile) => array(profile.semantic_blockers)),
      ...array(history?.semantic_blockers),
    ]);
    const warnings = sortedUnique([
      ...profiles.flatMap((profile) => array(profile.warnings)),
      ...array(history?.warnings),
    ]);
    const reviewFlags = sortedUnique([
      ...profiles.flatMap((profile) => array(profile.review_flags)),
      ...array(history?.review_flags),
    ]);
    const artifactRefs = profiles.map((profile) => profile.ref).sort();
    const artifactIdentities = profiles.map((profile) => ({
      ref: profile.ref,
      artifact_id: profile.artifact_id || artifactIdFromRef(profile.ref),
      observed_identity: profile.observed_identity,
      identity_quality: identityQuality(profile.observed_identity),
    })).sort((left, right) => left.ref.localeCompare(right.ref));
    const bindings = artifactRefs.flatMap((ref) => array(bindingsByRef.get(ref)).map((binding) => ({ ref, ...binding })))
      .sort((left, right) => `${left.ref}/${left.topic_id}/${left.claim_id}/${left.requirement_id}`.localeCompare(`${right.ref}/${right.topic_id}/${right.claim_id}/${right.requirement_id}`));
    const artifact = artifactAssessment(profiles);
    const stability = namespace === "candidate" ? candidateStability(history) : productionStability(productionAudit);
    const statuses = sortedUnique([
      ...profiles.map((profile) => profile.current_status || "missing"),
      history?.current_status || "",
      productionEvent?.status || "",
    ]);
    const healthy = profiles.every((profile) => profile.healthy === true)
      && semanticBlockers.length === 0
      && (namespace !== "candidate" || Boolean(history));
    const observationState = history?.observation_state || profiles[0]?.observation_state || "unknown";
    const readiness = sourceReadiness({
      namespace,
      healthy,
      observationState,
      semanticBlockers,
      identityQualities: artifactIdentities.map((item) => item.identity_quality),
      stability,
      artifact,
      warnings,
      reviewFlags,
      bindings,
    });
    const currentTier = namespace === "production"
      ? `production-${registry?.registry_tier || "unknown"}`
      : "shadow";
    const row = {
      endpoint_key: endpointKey,
      namespace,
      source_id: sourceId,
      current_collection_tier: currentTier,
      registry: registry || {
        label: profiles[0]?.label || sourceId,
        role: "missing-registry-entry",
        format: "unknown",
        canonical_url: "",
        authentication: "unknown",
        lanes: [],
        registry_tier: "unknown",
      },
      artifact_refs: artifactRefs,
      artifact_identities: artifactIdentities,
      identity_qualities: sortedUnique(artifactIdentities.map((item) => item.identity_quality)),
      authority_tiers: sortedUnique(profiles.map((profile) => profile.authority_tier)),
      claim_scopes: sortedUnique(profiles.map((profile) => profile.claim_scope)),
      independence_groups: sortedUnique(profiles.map((profile) => profile.independence_group)),
      result_lineage_ids: sortedUnique(profiles.map((profile) => profile.result_independence_group)),
      artifact_owners: sortedUnique(profiles.map((profile) => profile.artifact_owner)),
      health: {
        healthy,
        statuses,
        observation_state: observationState,
        semantic_blockers: semanticBlockers,
        warnings,
        review_flags: reviewFlags,
      },
      stability,
      artifact_assessment: artifact,
      bindings,
      proves: sortedUnique(profiles.map((profile) => profile.proves)),
      does_not_prove: sortedUnique(profiles.map((profile) => profile.does_not_prove)),
      promotion_review: {
        readiness_state: readiness.readiness_state,
        blockers: readiness.blockers,
        human_reviewed: false,
        decision: null,
        reviewer: null,
        reviewed_at: null,
        reviewed_source_fingerprint: null,
        target_tier: null,
        automatic_promotion: false,
      },
      notification_eligible: false,
    };
    row.source_fingerprint = sourceFingerprint(row);
    sources.push(row);
  }
  return sources.sort((left, right) => left.endpoint_key.localeCompare(right.endpoint_key));
}

function buildDiscoverySources(candidateAudit, evidenceSources) {
  const evidenceIds = new Set(evidenceSources.filter((source) => source.namespace === "candidate").map((source) => source.source_id));
  const history = new Map(array(candidateAudit?.source_history).map((item) => [item.source_id, item]));
  return array(candidateAudit?.source_registry)
    .filter((source) => source.role === "editorial-discovery" && !evidenceIds.has(source.id))
    .map((source) => ({
      source_id: source.id,
      label: source.label,
      current_collection_tier: "shadow",
      role: source.role,
      authority_tier: source.authority_tier,
      canonical_url: source.canonical_url,
      lanes: array(source.lanes),
      current_status: history.get(source.id)?.current_status || "missing",
      observed_days: history.get(source.id)?.criteria?.minimum_observation_days?.observed ?? 0,
      claim_evidence_allowed: false,
      affects_evidence_grade: false,
      affects_claim_status: false,
      automatic_promotion: false,
      notification_eligible: false,
    }))
    .sort((left, right) => left.source_id.localeCompare(right.source_id));
}

function authorityRank(source) {
  return Math.max(0, ...array(source.authority_tiers).map((tier) => Number(String(tier).replace(/^T/, "")) || 0));
}

function reviewCandidate(source) {
  const topicIds = sortedUnique(source.bindings.map((binding) => binding.topic_id));
  const claimIds = sortedUnique(source.bindings.map((binding) => `${binding.topic_id}/${binding.claim_id}`));
  const reviewFocus = sortedUnique([
    ...array(source.artifact_assessment?.manual_risk_flags),
    ...array(source.health?.warnings),
    ...array(source.health?.review_flags),
    ...array(source.does_not_prove).map((item) => `proof-boundary:${item}`),
  ]);
  return {
    endpoint_key: source.endpoint_key,
    source_id: source.source_id,
    label: source.registry.label,
    canonical_url: source.registry.canonical_url,
    authority_tiers: source.authority_tiers,
    topic_ids: topicIds,
    claim_ids: claimIds,
    observed_days: source.stability.observed_days,
    identity_qualities: source.identity_qualities,
    artifact_completeness: source.artifact_assessment.completeness,
    review_focus: reviewFocus,
    source_fingerprint: source.source_fingerprint,
    human_decision: null,
    automatic_promotion: false,
    notification_eligible: false,
  };
}

function compareReviewCandidates(left, right) {
  const leftClean = left.artifact_completeness === "not-assessed" && left.review_focus.every((item) => item.startsWith("proof-boundary:"));
  const rightClean = right.artifact_completeness === "not-assessed" && right.review_focus.every((item) => item.startsWith("proof-boundary:"));
  if (leftClean !== rightClean) return leftClean ? -1 : 1;
  if (left.topic_ids.length !== right.topic_ids.length) return right.topic_ids.length - left.topic_ids.length;
  if (left.claim_ids.length !== right.claim_ids.length) return right.claim_ids.length - left.claim_ids.length;
  const authorityDifference = authorityRank(right) - authorityRank(left);
  if (authorityDifference) return authorityDifference;
  return left.endpoint_key.localeCompare(right.endpoint_key);
}

export function buildManualReviewShortlist(sources, topicIds, limit = MAX_MANUAL_REVIEW_SHORTLIST) {
  const candidates = sources
    .filter((source) => source.namespace === "candidate"
      && source.promotion_review.readiness_state === "await-human-source-review"
      && source.bindings.length > 0)
    .map(reviewCandidate)
    .sort(compareReviewCandidates);
  const selected = [];
  const selectedKeys = new Set();
  for (const topicId of topicIds) {
    const candidate = candidates.find((item) => item.topic_ids.includes(topicId) && !selectedKeys.has(item.endpoint_key));
    if (!candidate || selected.length >= limit) continue;
    selected.push(candidate);
    selectedKeys.add(candidate.endpoint_key);
  }
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (selectedKeys.has(candidate.endpoint_key)) continue;
    selected.push(candidate);
    selectedKeys.add(candidate.endpoint_key);
  }
  return {
    maximum_items: limit,
    eligible_endpoints: candidates.length,
    deferred_endpoints: Math.max(0, candidates.length - selected.length),
    selection_is_review_priority_not_promotion: true,
    items: selected,
  };
}

export function bundleFingerprint(bundle) {
  const payload = { ...bundle };
  delete payload.bundle_fingerprint;
  return sha256(payload);
}

function buildBundles(sourceDiligence, semanticDossier) {
  const dossierClaims = dossierClaimMap(semanticDossier);
  const profiles = new Map(array(sourceDiligence?.source_profiles).map((profile) => [profile.ref, profile]));
  const bundles = [];
  for (const topic of array(sourceDiligence?.topics)) {
    for (const claim of array(topic?.claims)) {
      const joined = dossierClaims.get(`${topic.id}/${claim.id}`);
      if (!joined) throw new Error(`missing dossier packet: ${topic.id}/${claim.id}`);
      const supporting = array(claim.requirements).map(compactRequirement);
      const counterevidence = array(claim.counterevidence_requirements).map(compactRequirement);
      const sourceRefs = sortedUnique([...supporting, ...counterevidence].flatMap((requirement) => requirement.source_refs));
      const resultLineages = sortedUnique(sourceRefs.map((ref) => profiles.get(ref)?.result_independence_group || ""));
      const lineageSupport = resultLineages.map((lineageId) => ({
        result_lineage_id: lineageId,
        source_refs: sourceRefs.filter((ref) => profiles.get(ref)?.result_independence_group === lineageId),
        counts_as_one_scientific_result_lineage: true,
      }));
      const bundle = {
        bundle_id: `${topic.id}/${claim.id}`,
        package_id: joined.reviewPackage.id,
        topic_id: topic.id,
        topic_title: topic.title,
        layers: array(topic.layers),
        claim_id: claim.id,
        claim_label: claim.label,
        claim_kind: claim.kind,
        causal_claim: claim.causal_claim === true,
        coverage_status: claim.coverage_status || claim.status,
        event_required: claim.event_required === true,
        event_status: claim.event_status,
        event_evidence: array(claim.event_evidence),
        claim_verdict: claim.claim_verdict,
        evidence_ceiling_when_met: claim.evidence_ceiling_when_met,
        supporting_requirements: supporting,
        counterevidence_requirements: counterevidence,
        source_refs: sourceRefs,
        result_lineages: lineageSupport,
        independent_reproduction_claimed_by_source_count: false,
        counterevidence_available: claim.counterevidence_available === true,
        attention: {
          level: topic.attention?.level || "A0",
          used_as_evidence: false,
        },
        permitted_summary: joined.claim.permitted_summary,
        prohibited_conclusions: array(joined.claim.prohibited_conclusions),
        notification_ceiling_after_all_gates: joined.claim.notification_ceiling_after_all_gates,
        notification: {
          eligible: false,
          priority: null,
          blockers: array(joined.claim.notification?.blockers),
        },
        semantic_packet_fingerprint: joined.claim.packet_fingerprint,
      };
      bundle.bundle_fingerprint = bundleFingerprint(bundle);
      bundles.push(bundle);
    }
  }
  return bundles;
}

export function reportFingerprint(report) {
  const payload = { ...report };
  delete payload.report_fingerprint;
  return sha256(payload);
}

export function createSourcePromotionReadiness({ productionAudit, candidateAudit, sourceDiligence, semanticDossier, now = new Date() }) {
  assertSnapshotChain({ productionAudit, candidateAudit, sourceDiligence, semanticDossier });
  const sources = buildSources({ productionAudit, candidateAudit, sourceDiligence, semanticDossier });
  const discoverySources = buildDiscoverySources(candidateAudit, sources);
  const sourceBundles = buildBundles(sourceDiligence, semanticDossier);
  const candidateSources = sources.filter((source) => source.namespace === "candidate");
  const topicIds = array(sourceDiligence?.topics).map((topic) => topic.id);
  const manualReviewShortlist = buildManualReviewShortlist(sources, topicIds);
  const report = {
    schema_version: 1,
    generated_at: now.toISOString(),
    mode: "source-promotion-readiness",
    status: sources.some(hasHardReadinessBlocker)
      ? "blocked-sources-present"
      : candidateSources.some((source) => source.promotion_review.readiness_state === "observing")
        ? "observing"
        : "await-human-source-review",
    input_snapshots: {
      production_audit: inputSnapshot(productionAudit),
      candidate_audit: inputSnapshot(candidateAudit),
      source_diligence: inputSnapshot(sourceDiligence),
      semantic_dossier: inputSnapshot(semanticDossier),
    },
    scope: {
      topic_ids: topicIds,
      claim_specific_source_selection: true,
      separates_endpoints_from_artifact_bindings: true,
      excludes_language_style_analysis: true,
      includes_attention_as_evidence: false,
    },
    policy: {
      minimum_silent_days: MINIMUM_SILENT_DAYS,
      source_ready_claim_is_not_source_promotion: true,
      health_is_not_reproducibility: true,
      production_tier_is_existing_state_not_reproved_readiness: true,
      production_per_source_stability_required_for_future_reassessment: true,
      external_human_decision_ledger_required: true,
      result_lineage_not_source_count: true,
      automatic_promotions: [],
    },
    metrics: {
      topics: array(sourceDiligence?.topics).length,
      claim_bundles: sourceBundles.length,
      artifact_bindings: array(sourceDiligence?.source_profiles).length,
      evidence_endpoints: sources.length,
      production_core_endpoints: sources.filter((source) => source.current_collection_tier === "production-core").length,
      production_supplemental_endpoints: sources.filter((source) => source.current_collection_tier === "production-supplemental").length,
      shadow_endpoints: candidateSources.length,
      unbound_evidence_endpoints: sources.filter((source) => source.bindings.length === 0).length,
      discovery_only_endpoints: discoverySources.length,
      blocked_endpoints: sources.filter(hasHardReadinessBlocker).length,
      observing_endpoints: sources.filter((source) => source.promotion_review.readiness_state === "observing").length,
      await_human_source_review_endpoints: sources.filter((source) => source.promotion_review.readiness_state === "await-human-source-review").length,
      manual_review_shortlist_endpoints: manualReviewShortlist.items.length,
      ready_for_manual_promotion_endpoints: sources.filter((source) => source.promotion_review.readiness_state === "ready-for-manual-promotion").length,
      existing_production_endpoints: sources.filter((source) => source.promotion_review.readiness_state === "existing-production").length,
      endpoints_with_artifact_risk: sources.filter((source) => source.artifact_assessment.completeness !== "not-assessed").length,
      upstream_immutable_identity_endpoints: sources.filter((source) => source.identity_qualities.every((quality) => quality === "upstream-immutable")).length,
      human_decisions_recorded: 0,
      notification_eligible_records: 0,
    },
    notification_policy: {
      enabled: false,
      eligible: false,
      priority: null,
      external_actions: [],
    },
    discovery_sources: discoverySources,
    manual_review_shortlist: manualReviewShortlist,
    sources,
    source_bundles: sourceBundles,
  };
  report.report_fingerprint = reportFingerprint(report);
  return report;
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function renderSourcePromotionReadiness(report) {
  const lines = [
    `# 高质量来源晋级准备度 · ${report.generated_at.slice(0, 10)}`,
    "",
    "> 这是四份已验证快照的只读派生报告。它不写 registry、不代替人工判断，也不生成通知；source-ready 只描述 claim 覆盖，绝不等于来源已晋级。",
    "",
    "## 结论",
    "",
    `- 状态：\`${report.status}\`；主题 ${report.metrics.topics}；claim bundles ${report.metrics.claim_bundles}。`,
    `- 证据 endpoint ${report.metrics.evidence_endpoints}：production core ${report.metrics.production_core_endpoints}、production supplemental ${report.metrics.production_supplemental_endpoints}、shadow ${report.metrics.shadow_endpoints}。`,
    `- Shadow 观察中 ${report.metrics.observing_endpoints}；待人审 ${report.metrics.await_human_source_review_endpoints}；可进入人工晋级决定 ${report.metrics.ready_for_manual_promotion_endpoints}。`,
    `- 人工复核短清单 ${report.metrics.manual_review_shortlist_endpoints}/${report.manual_review_shortlist.eligible_endpoints}；最多 ${report.manual_review_shortlist.maximum_items} 条，选择仅表示复核优先级，不表示晋级。`,
    `- Artifact 风险 endpoint ${report.metrics.endpoints_with_artifact_risk}；无 claim 绑定 endpoint ${report.metrics.unbound_evidence_endpoints}；发现层 ${report.metrics.discovery_only_endpoints}。`,
    "- 人工决定 0；自动晋级 0；通知资格 0；外部动作 0。",
    "",
    "## 人工复核短清单",
    "",
    "> 这里只列满 7 个自然日、已绑定具体 claim 且没有健康硬阻断的来源。空表表示尚未到人工签字阶段；完整证据仍保留在下方矩阵。",
    "",
    "| 来源 | Authority | 主题 | Claim | 身份 | Artifact | 复核重点 |",
    "|---|---|---|---:|---|---|---|",
  ];
  for (const source of report.manual_review_shortlist.items) {
    lines.push(`| [${markdownCell(source.label)}](${source.canonical_url}) | ${source.authority_tiers.join(", ")} | ${source.topic_ids.join(", ")} | ${source.claim_ids.length} | ${source.identity_qualities.join(", ")} | ${source.artifact_completeness} | ${markdownCell(source.review_focus.join("；") || "仅确认来源身份与证明边界")} |`);
  }
  if (!report.manual_review_shortlist.items.length) lines.push("| 尚未有来源满足七日门槛 | - | - | 0 | - | - | 继续静默观察 | ");
  lines.push(
    "",
    "## 发现层（不参与证据）",
    "",
    "| 来源 | Authority | 当前状态 | 观察日 | 允许用途 |",
    "|---|---|---|---:|---|",
  );
  for (const source of report.discovery_sources) {
    lines.push(`| ${markdownCell(source.label)} | ${source.authority_tier} | ${source.current_status} | ${source.observed_days}/7 | 只排序人工队列；不得提高 evidence grade |`);
  }
  lines.push(
    "",
    "## Endpoint 晋级矩阵",
    "",
    "| Endpoint | 当前 tier | 准备度 | 稳定性 | 身份质量 | Artifact | 明示风险 | 阻断 |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const source of report.sources) {
    const stability = source.stability.scope === "per-source"
      ? `${source.stability.observed_days}/${source.stability.required_days}`
      : "逐源未测";
    lines.push(`| ${markdownCell(source.registry.label)} | ${source.current_collection_tier} | ${source.promotion_review.readiness_state} | ${stability} | ${source.identity_qualities.join(", ")} | ${source.artifact_assessment.completeness} | ${markdownCell(source.artifact_assessment.manual_risk_flags.join("；") || "-")} | ${markdownCell(source.promotion_review.blockers.join("；"))} |`);
  }
  lines.push("", "## Claim-specific source bundles", "");
  for (const bundle of report.source_bundles) {
    lines.push(
      `### ${bundle.topic_title} · ${bundle.claim_label}`,
      "",
      `- 覆盖：\`${bundle.coverage_status}\`；事件：\`${bundle.event_status}\`；verdict：\`${bundle.claim_verdict}\`。`,
      `- 上限：${bundle.evidence_ceiling_when_met}`,
      `- 结果谱系：${bundle.result_lineages.map((lineage) => `${lineage.result_lineage_id}（${lineage.source_refs.length} 个 artifact，仍计 1 条结果谱系）`).join("；") || "无"}`,
      `- 当前允许表述：${bundle.permitted_summary}`,
      `- 通知阻断：${bundle.notification.blockers.join("、")}`,
      "",
      "| 轴 | Requirement | 通过 | 来源 | 下一证据 |",
      "|---|---|---|---|---|",
    );
    for (const requirement of [...bundle.supporting_requirements, ...bundle.counterevidence_requirements]) {
      lines.push(`| ${requirement.evidence_role} | ${markdownCell(requirement.label)} | ${requirement.passed ? "是" : "否"} | ${markdownCell(requirement.source_refs.join(", ") || "无")} | ${markdownCell(requirement.required_next || "-")} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runSourcePromotionReadiness({
  productionAuditPath = process.env.PRODUCTION_AUDIT_PATH || "work/mechanism-watch/audit.json",
  candidateAuditPath = process.env.CANDIDATE_PROBE_OUTPUT_PATH || "work/candidate-source-probe/audit.json",
  sourceDiligencePath = process.env.SOURCE_DILIGENCE_OUTPUT_PATH || "work/source-diligence/coverage.json",
  semanticDossierPath = process.env.SEMANTIC_REVIEW_OUTPUT_PATH || "work/semantic-review-dossiers/dossier.json",
  outputPath = process.env.SOURCE_PROMOTION_READINESS_PATH || "work/source-promotion-readiness/readiness.json",
  markdownPath = process.env.SOURCE_PROMOTION_READINESS_MARKDOWN_PATH || "work/source-promotion-readiness/readiness.md",
  now = new Date(),
} = {}) {
  const [productionAudit, candidateAudit, sourceDiligence, semanticDossier] = await Promise.all([
    readJson(productionAuditPath),
    readJson(candidateAuditPath),
    readJson(sourceDiligencePath),
    readJson(semanticDossierPath),
  ]);
  const report = createSourcePromotionReadiness({ productionAudit, candidateAudit, sourceDiligence, semanticDossier, now });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, renderSourcePromotionReadiness(report));
  return report;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  runSourcePromotionReadiness().then((report) => console.log(JSON.stringify({
    mode: report.mode,
    status: report.status,
    ...report.metrics,
  }))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
