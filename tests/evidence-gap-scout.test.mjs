import assert from "node:assert/strict";
import test from "node:test";
import { evidenceGapScoutSources } from "../automation/evidence-gap-scout-registry.mjs";
import { createEvidenceGapScoutAudit, isRetryableScoutError, parseCitationGraph, renderEvidenceGapScoutReview } from "../automation/run-evidence-gap-scout.mjs";
import { verifyEvidenceGapScout } from "../automation/verify-evidence-gap-scout.mjs";

const source = evidenceGapScoutSources[0];
const circuitTracerSource = evidenceGapScoutSources.find((item) => item.id === "semantic-scholar-circuit-tracer-citations");
const nlahSource = evidenceGapScoutSources.find((item) => item.id === "semantic-scholar-nlah-citations");
const citationBody = JSON.stringify({
  offset: 0,
  next: 100,
  data: [{ citingPaper: {
    paperId: "paper-1",
    title: "Independent Ouro Stress Test",
    externalIds: { ArXiv: "2607.12345" },
    publicationDate: "2026-07-16",
    authors: [{ name: "Researcher A" }],
    url: "https://www.semanticscholar.org/paper/paper-1",
    citationCount: 0,
    referenceCount: 42,
  }}],
});

function candidateAudit() {
  return {
    generated_at: "2026-07-17T04:00:00.000Z",
    source_registry: [{ id: "latent-space-feed", role: "editorial-discovery", independence_group: "latent-space" }],
    source_events: [{
      source_id: "latent-space-feed",
      status: "fresh",
      snapshot: { items: [{
        id: "story-1",
        title: "Codex agent harness deep dive",
        url: "https://www.latent.space/p/story-1",
        published_at: "2026-07-16T00:00:00.000Z",
        artifact_links: [
          { url: "https://github.com/openai/codex", candidate_type: "code-or-release-candidate", link_context: "Codex repository" },
          { url: "https://www.anthropic.com/news/funding", candidate_type: "official-article-candidate", link_context: "funding" },
        ],
      }] },
    }],
  };
}

function sourceEvents(leads) {
  return evidenceGapScoutSources.map((item) => ({
    source_id: item.id,
    status: "fresh",
    warnings: [],
    leads: item.id === source.id ? leads : [],
  }));
}

test("transient fetch failures are retryable but semantic body-limit failures are not", () => {
  assert.equal(isRetryableScoutError(new TypeError("fetch failed")), true);
  assert.equal(isRetryableScoutError(Object.assign(new Error("rate limited"), { status: 429 })), true);
  assert.equal(isRetryableScoutError(Object.assign(new Error("server failure"), { status: 503 })), true);
  assert.equal(isRetryableScoutError(new Error("response-body-too-large")), false);
});

test("Semantic Scholar citation records remain non-exhaustive T1 leads", () => {
  const parsed = parseCitationGraph(source, citationBody);
  assert.equal(parsed.items_parsed, 1);
  assert.deepEqual(parsed.warnings, ["citation-window-non-exhaustive"]);
  assert.equal(parsed.leads[0].primary_candidate_url, "https://arxiv.org/abs/2607.12345");
  assert.equal(parsed.leads[0].source_window_exhaustive, false);
  assert.equal(parsed.leads[0].seed_scope, source.seed_scope);
  assert.equal(parsed.leads[0].title_scope_match, true);
  assert.equal(parsed.leads[0].review_hint_only, true);
  assert.equal(parsed.leads[0].primary_verified, false);
  assert.equal(parsed.leads[0].notification_eligible, false);
});

test("title scope matching only prioritizes review and never upgrades evidence", () => {
  const unrelated = JSON.stringify({
    offset: 0,
    data: [{ citingPaper: {
      paperId: "paper-unrelated",
      title: "Unrelated Policy Study",
      externalIds: { ArXiv: "2607.00001" },
      publicationDate: "2026-07-16",
      authors: [],
    } }],
  });
  const parsed = parseCitationGraph(source, unrelated);
  assert.equal(parsed.leads[0].title_scope_match, false);
  const audit = createEvidenceGapScoutAudit({
    now: new Date("2026-07-17T04:00:00.000Z"),
    sourceEvents: sourceEvents(parsed.leads),
    candidateAudit: candidateAudit(),
  });
  assert.equal(audit.citation_leads[0].review_queue_priority, "citation-only");
  assert.equal(audit.citation_leads[0].authority_tier, "T1");
  assert.equal(audit.citation_leads[0].claim_status_changed, false);
});

test("a DOI-backed seed uses an immutable verified paper identity", () => {
  assert.equal(circuitTracerSource.seed_paper_id, "DOI:10.18653/v1/2025.blackboxnlp-1.14");
  assert.equal(circuitTracerSource.seed_identity_kind, "doi");
  assert.equal(circuitTracerSource.primary_seed_url, "https://aclanthology.org/2025.blackboxnlp-1.14/");
  assert.match(circuitTracerSource.url, /DOI%3A10\.18653%2Fv1%2F2025\.blackboxnlp-1\.14\/citations/);
  assert.match(circuitTracerSource.seed_scope, /not-complete-model-biological-faithfulness/);
});

test("the NLAH seed pins its paper-linked runtime while preserving the capability boundary", () => {
  assert.equal(nlahSource.seed_paper_id, "ARXIV:2603.25723");
  assert.equal(nlahSource.seed_identity_kind, "arxiv");
  assert.match(nlahSource.seed_scope, /not-general-capability-uplift/);
  assert.deepEqual(nlahSource.seed_artifact, {
    url: "https://github.com/curated-skills/LinguaClaw",
    revision: "01232139ee8b2642dad240ce4e9488eab25b953c",
    license: "MIT",
    role: "paper-linked-runtime-and-harness-policy-artifact",
    reproduction_status: "paper-reproduction-scripts-trajectories-and-benchmark-platform-not-yet-published",
  });
  assert.match(nlahSource.url, /ARXIV%3A2603\.25723\/citations/);
  const review = renderEvidenceGapScoutReview(createEvidenceGapScoutAudit({
    now: new Date("2026-07-17T04:00:00.000Z"),
    sourceEvents: sourceEvents([]),
    candidateAudit: candidateAudit(),
  }));
  assert.match(review, /paper-linked-runtime-and-harness-policy-artifact @ 01232139ee8b/);
  assert.match(review, /paper-reproduction-scripts-trajectories-and-benchmark-platform-not-yet-published/);
});

test("a newly registered seed gets its own onboarding baseline", () => {
  const parsed = parseCitationGraph(source, citationBody);
  const first = createEvidenceGapScoutAudit({
    now: new Date("2026-07-17T04:00:00.000Z"),
    sourceEvents: sourceEvents(parsed.leads),
    candidateAudit: candidateAudit(),
  });
  const newSource = {
    ...source,
    id: "future-scout-source",
    seed_id: "future-seed",
    seed_scope: "future-seed-scope",
  };
  const newLead = {
    ...parsed.leads[0],
    identity: "arxiv:2607.77777",
    source_id: newSource.id,
    seed_id: newSource.seed_id,
    seed_scope: newSource.seed_scope,
  };
  const secondSources = [...evidenceGapScoutSources, newSource];
  const secondEvents = [
    ...sourceEvents(parsed.leads),
    { source_id: newSource.id, status: "fresh", warnings: [], leads: [newLead] },
  ];
  const second = createEvidenceGapScoutAudit({
    now: new Date("2026-07-18T04:00:00.000Z"),
    sourceEvents: secondEvents,
    candidateAudit: candidateAudit(),
    previousAudit: first,
    sources: secondSources,
  });
  const onboarded = second.citation_leads.find((lead) => lead.source_id === newSource.id);
  assert.equal(onboarded.baseline_only, true);
  assert.equal(onboarded.new_since_previous, false);
});

test("the same paper is tracked as a distinct citation relation for each seed", () => {
  const parsed = parseCitationGraph(source, citationBody);
  const first = createEvidenceGapScoutAudit({
    now: new Date("2026-07-17T04:00:00.000Z"),
    sourceEvents: sourceEvents(parsed.leads),
    candidateAudit: candidateAudit(),
  });
  const secondSource = evidenceGapScoutSources[1];
  const secondRelation = {
    ...parsed.leads[0],
    source_id: secondSource.id,
    seed_id: secondSource.seed_id,
    seed_scope: secondSource.seed_scope,
    topic_id: secondSource.topic_id,
  };
  const events = sourceEvents(parsed.leads).map((event) => event.source_id === secondSource.id
    ? { ...event, leads: [secondRelation] }
    : event);
  const second = createEvidenceGapScoutAudit({
    now: new Date("2026-07-18T04:00:00.000Z"),
    sourceEvents: events,
    candidateAudit: candidateAudit(),
    previousAudit: first,
  });
  const relation = second.citation_leads.find((lead) => lead.source_id === secondSource.id);
  assert.equal(relation.baseline_only, false);
  assert.equal(relation.new_since_previous, true);
});

test("future publication metadata stays visible but cannot become a new lead", () => {
  const parsed = parseCitationGraph(source, citationBody);
  const first = createEvidenceGapScoutAudit({
    now: new Date("2026-07-16T04:00:00.000Z"),
    sourceEvents: sourceEvents([]),
    candidateAudit: candidateAudit(),
  });
  const futureLead = { ...parsed.leads[0], publication_date: "2026-08-01" };
  const second = createEvidenceGapScoutAudit({
    now: new Date("2026-07-17T04:00:00.000Z"),
    sourceEvents: sourceEvents([futureLead]),
    candidateAudit: candidateAudit(),
    previousAudit: first,
  });
  assert.equal(second.citation_leads[0].future_publication_date, true);
  assert.equal(second.citation_leads[0].review_queue_priority, "metadata-anomaly");
  assert.equal(second.citation_leads[0].new_since_previous, false);
  assert.equal(second.metrics.future_dated_citation_leads, 1);
});

test("first scout run is onboarding baseline and a later unseen paper is only a new review lead", () => {
  const parsed = parseCitationGraph(source, citationBody);
  const first = createEvidenceGapScoutAudit({
    now: new Date("2026-07-17T04:00:00.000Z"),
    sourceEvents: sourceEvents(parsed.leads),
    candidateAudit: candidateAudit(),
  });
  assert.equal(first.citation_leads[0].baseline_only, true);
  assert.equal(first.citation_leads[0].new_since_previous, false);
  const nextLead = { ...parsed.leads[0], identity: "arxiv:2607.54321", title: "A second study" };
  const second = createEvidenceGapScoutAudit({
    now: new Date("2026-07-18T04:00:00.000Z"),
    sourceEvents: sourceEvents([...parsed.leads, nextLead]),
    candidateAudit: candidateAudit(),
    previousAudit: first,
  });
  assert.equal(second.citation_leads.find((lead) => lead.identity === nextLead.identity).new_since_previous, true);
  assert.equal(second.metrics.claim_status_changes, 0);
  assert.equal(second.notification_policy.eligible, false);
});

test("a T2 editorial link is an unverified artifact candidate and cannot change a claim", () => {
  const audit = createEvidenceGapScoutAudit({
    now: new Date("2026-07-17T04:00:00.000Z"),
    sourceEvents: sourceEvents([]),
    candidateAudit: candidateAudit(),
  });
  assert.equal(audit.editorial_artifact_leads.length, 1);
  assert.equal(audit.metrics.editorial_artifact_links_scanned, 2);
  assert.equal(audit.editorial_artifact_leads[0].authority_tier, "T2");
  assert.equal(audit.editorial_artifact_leads[0].artifact_authority_verified, false);
  assert.equal(audit.editorial_artifact_leads[0].claim_status_changed, false);
});

test("scout verifier rejects notification or evidence promotion paths", () => {
  const audit = createEvidenceGapScoutAudit({
    now: new Date("2026-07-17T04:00:00.000Z"),
    sourceEvents: sourceEvents([]),
    candidateAudit: candidateAudit(),
  });
  assert.deepEqual(verifyEvidenceGapScout(audit), { ok: true, errors: [] });
  const invalid = structuredClone(audit);
  invalid.notification_policy.enabled = true;
  invalid.authority_policy.can_raise_evidence_grade = true;
  invalid.source_registry[0].seed_scope = "";
  const result = verifyEvidenceGapScout(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("notifications must remain disabled"));
  assert.ok(result.errors.includes("discovery must not affect claim status or evidence grade"));
  assert.ok(result.errors.includes(`scout source seed boundary missing: ${source.id}`));
});
