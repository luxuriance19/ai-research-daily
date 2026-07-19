#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evidenceGapScoutSources } from "./evidence-gap-scout-registry.mjs";

export function verifyEvidenceGapScout(audit) {
  const errors = [];
  if (audit?.schema_version !== 1) errors.push("schema_version must be 1");
  if (audit?.mode !== "evidence-gap-scout" || audit?.scope !== "discovery-leads-only") errors.push("scout mode and scope must remain discovery-only");
  if (audit?.notification_policy?.enabled !== false || audit?.notification_policy?.eligible !== false) errors.push("notifications must remain disabled");
  if (!Array.isArray(audit?.notification_policy?.external_actions) || audit.notification_policy.external_actions.length) errors.push("external_actions must be empty");
  if (audit?.metrics?.notification_eligible_records !== 0 || audit?.metrics?.claim_status_changes !== 0) errors.push("notifications and claim status changes must remain zero");
  if (audit?.authority_policy?.can_change_claim_status !== false || audit?.authority_policy?.can_raise_evidence_grade !== false) errors.push("discovery must not affect claim status or evidence grade");
  const isolation = audit?.isolation_policy || {};
  for (const field of ["affects_production_registry", "affects_production_health", "affects_source_diligence_claim_status", "writes_other_audit_state"]) if (isolation[field] !== false) errors.push(`${field} must be false`);
  if (!Array.isArray(isolation.automatic_promotions) || isolation.automatic_promotions.length) errors.push("automatic promotions must be empty");
  const dependencies = audit?.dependency_policy || {};
  for (const field of ["credentials_required", "semantic_scholar_key_required", "openalex_key_required", "cloudflare_credentials_required", "openai_membership_required"]) if (dependencies[field] !== false) errors.push(`${field} must be false`);

  const expectedIds = evidenceGapScoutSources.map((source) => source.id).sort();
  for (const key of ["source_registry", "source_events", "source_history"]) {
    const ids = (audit?.[key] || []).map((item) => item.id || item.source_id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) errors.push(`${key} must exactly cover scout registry`);
  }
  for (const source of audit?.source_registry || []) {
    if (source.discovery_only !== true || source.authority_tier !== "T1") errors.push(`scout source must remain T1 discovery-only: ${source.id}`);
    if (!source.seed_scope || !source.primary_seed_url || !source.seed_paper_id) errors.push(`scout source seed boundary missing: ${source.id}`);
    if (!Array.isArray(source.review_patterns) || !source.review_patterns.length || source.review_pattern_scope !== "title-queue-hint-only") errors.push(`scout source review hint boundary missing: ${source.id}`);
  }
  for (const history of audit?.source_history || []) {
    if (history.human_review_passed !== false || history.automatically_promoted !== false) errors.push(`source review boundary violated: ${history.source_id}`);
  }
  for (const lead of audit?.citation_leads || []) {
    if (lead.authority_tier !== "T1" || lead.discovery_only !== true || lead.primary_verified !== false) errors.push(`citation lead authority boundary violated: ${lead.identity}`);
    if (lead.claim_status_changed !== false || lead.notification_eligible !== false) errors.push(`citation lead action boundary violated: ${lead.identity}`);
    if (!lead.seed_scope) errors.push(`citation lead seed boundary missing: ${lead.identity}`);
    if (lead.future_publication_date === true && lead.new_since_previous === true) errors.push(`future-dated citation cannot be a new lead: ${lead.identity}`);
    if (lead.review_hint_only !== true || !["high", "medium", "citation-only", "metadata-anomaly"].includes(lead.review_queue_priority)) errors.push(`citation review hint boundary violated: ${lead.identity}`);
  }
  const futureDated = (audit?.citation_leads || []).filter((lead) => lead.future_publication_date === true).length;
  if (audit?.metrics?.future_dated_citation_leads !== futureDated) errors.push("future-dated citation metric mismatch");
  const titleMatched = (audit?.citation_leads || []).filter((lead) => lead.title_scope_match === true).length;
  const highPriority = (audit?.citation_leads || []).filter((lead) => lead.review_queue_priority === "high").length;
  const citationOnly = (audit?.citation_leads || []).filter((lead) => lead.review_queue_priority === "citation-only").length;
  if (audit?.metrics?.title_scope_matched_citation_leads !== titleMatched) errors.push("title-scope citation metric mismatch");
  if (audit?.metrics?.high_priority_review_leads !== highPriority) errors.push("high-priority review metric mismatch");
  if (audit?.metrics?.citation_only_leads !== citationOnly) errors.push("citation-only metric mismatch");
  for (const lead of audit?.editorial_artifact_leads || []) {
    if (lead.authority_tier !== "T2" || lead.artifact_authority_verified !== false) errors.push(`editorial lead authority boundary violated: ${lead.identity}`);
    if (lead.claim_status_changed !== false || lead.notification_eligible !== false) errors.push(`editorial lead action boundary violated: ${lead.identity}`);
  }
  return { ok: errors.length === 0, errors };
}

async function main() {
  const path = process.argv[2] || "work/evidence-gap-scout/audit.json";
  const audit = JSON.parse(await readFile(path, "utf8"));
  const result = verifyEvidenceGapScout(audit);
  if (!result.ok) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, mode: audit.mode, ...audit.metrics }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
