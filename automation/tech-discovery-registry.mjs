const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const source = ({
  id,
  label,
  endpoint,
  canonicalUrl,
  format,
  role,
  authorityTier,
  independenceGroup,
  topicScope,
  authorityPrior,
  attentionPrior,
  freshnessHalfLifeHours,
  fetchabilityPrior,
  maxAgeHours,
  maxItems,
  maxBytes,
  requestBudget,
  attentionMetric,
  limitations,
  fetchMode = "network-shadow",
  managedBy = "tech-discovery-registry",
  existingSourceIds = [],
  endpoints = [],
}) => ({
  id,
  label,
  endpoint,
  canonical_url: canonicalUrl,
  format,
  role,
  authority_tier: authorityTier,
  independence_group: independenceGroup,
  topic_scope: topicScope,
  queue_priors: {
    authority: authorityPrior,
    attention: attentionPrior,
    fetchability: fetchabilityPrior,
  },
  freshness_half_life_hours: freshnessHalfLifeHours,
  limits: {
    max_age_hours: maxAgeHours,
    max_items: maxItems,
    max_bytes: maxBytes,
    request_budget: requestBudget,
  },
  attention_metric: attentionMetric,
  limitations,
  fetch_mode: fetchMode,
  managed_by: managedBy,
  existing_source_ids: existingSourceIds,
  endpoints,
  authentication: "public",
  discovery_only: true,
  claim_evidence_allowed: false,
  can_satisfy_claim_requirement: false,
  can_raise_evidence_grade: false,
  can_change_claim_status: false,
  can_trigger_notification: false,
  onboarding_baseline_required: true,
});

export const TECH_DISCOVERY_POLICY = deepFreeze({
  schema_version: 1,
  mode: "shadow-discovery-attention-only",
  score_purpose: "human-review-queue-priority-only",
  dimension_weights: {
    authority: 0.20,
    attention: 0.40,
    freshness: 0.25,
    fetchability: 0.15,
  },
  max_sources_per_independence_group: 1,
  max_selected_signals: 5,
  representative_score_attention_cap: 5,
  claim_evidence_delta: 0,
  changes_production_ranking: false,
  writes_production_state: false,
  affects_production_source_health: false,
  notification_eligible: false,
  external_actions: [],
  primary_bridge_required: true,
  allowed_primary_identities: [
    "arxiv-version",
    "doi-or-openreview-id",
    "git-release-or-commit-sha",
    "huggingface-revision",
    "official-versioned-document",
  ],
});

export const techDiscoverySources = deepFreeze([
  source({
    id: "github-trending-daily",
    label: "GitHub Trending daily",
    endpoint: "https://github.com/trending",
    canonicalUrl: "https://github.com/trending",
    format: "bounded-html",
    role: "community-discovery",
    authorityTier: "T1",
    independenceGroup: "github-trending",
    topicScope: ["model-release", "compute-system", "model-mechanism", "agent-harness", "evaluation-harness"],
    authorityPrior: 0.25,
    attentionPrior: 0.90,
    freshnessHalfLifeHours: 18,
    fetchabilityPrior: 0.55,
    maxAgeHours: 36,
    maxItems: 25,
    maxBytes: 750_000,
    requestBudget: 3,
    attentionMetric: "rank-and-stars-today-within-the-daily-page",
    limitations: [
      "no-official-structured-trending-api",
      "rank-mixes-apps-tutorials-datasets-and-research-artifacts",
      "repository-popularity-does-not-establish-a-release-or-research-claim",
    ],
  }),
  source({
    id: "hacker-news-topstories",
    label: "Hacker News top stories",
    endpoint: "https://hacker-news.firebaseio.com/v0/topstories.json",
    canonicalUrl: "https://news.ycombinator.com/",
    format: "json-id-list-plus-bounded-items",
    role: "community-discovery",
    authorityTier: "T1",
    independenceGroup: "hacker-news",
    topicScope: ["model-release", "compute-system", "model-mechanism", "agent-harness", "evaluation-harness"],
    authorityPrior: 0.30,
    attentionPrior: 0.95,
    freshnessHalfLifeHours: 18,
    fetchabilityPrior: 0.90,
    maxAgeHours: 48,
    maxItems: 40,
    maxBytes: 250_000,
    requestBudget: 41,
    attentionMetric: "age-normalized-points-and-comments-percentile",
    limitations: [
      "general-technology-community-not-ai-specific",
      "discussion-popularity-does-not-verify-open-status-performance-or-mechanism",
      "item-fanout-must-remain-bounded",
    ],
  }),
  source({
    id: "techmeme-feed",
    label: "Techmeme RSS",
    endpoint: "https://www.techmeme.com/feed.xml",
    canonicalUrl: "https://www.techmeme.com/",
    format: "rss-or-atom",
    role: "aggregator-discovery",
    authorityTier: "T1",
    independenceGroup: "techmeme",
    topicScope: ["model-release", "compute-system", "ai-company-direction"],
    authorityPrior: 0.35,
    attentionPrior: 0.75,
    freshnessHalfLifeHours: 18,
    fetchabilityPrior: 0.85,
    maxAgeHours: 48,
    maxItems: 40,
    maxBytes: 300_000,
    requestBudget: 3,
    attentionMetric: "front-page-and-cluster-prominence",
    limitations: [
      "aggregation-and-syndication-do-not-count-as-independent-confirmation",
      "stronger-for-company-chip-product-and-policy-news-than-model-internals",
    ],
  }),
  source({
    id: "mit-technology-review-feed",
    label: "MIT Technology Review feed (AI filtered)",
    endpoint: "https://www.technologyreview.com/feed/",
    canonicalUrl: "https://www.technologyreview.com/topic/artificial-intelligence/",
    format: "rss-or-atom",
    role: "editorial-discovery",
    authorityTier: "T2",
    independenceGroup: "mit-technology-review",
    topicScope: ["model-release", "compute-system", "model-mechanism", "ai-company-direction"],
    authorityPrior: 0.80,
    attentionPrior: 0.55,
    freshnessHalfLifeHours: 36,
    fetchabilityPrior: 0.90,
    maxAgeHours: 96,
    maxItems: 30,
    maxBytes: 750_000,
    requestBudget: 3,
    attentionMetric: "ai-topic-match-and-editorial-prominence",
    limitations: [
      "site-wide-feed-requires-strict-ai-and-technical-scope-filtering",
      "editorial-analysis-must-link-back-to-primary-artifacts",
    ],
  }),
  source({
    id: "ieee-spectrum-ai-feed",
    label: "IEEE Spectrum artificial intelligence feed",
    endpoint: "https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss",
    canonicalUrl: "https://spectrum.ieee.org/artificial-intelligence/",
    format: "rss-or-atom",
    role: "editorial-discovery",
    authorityTier: "T2",
    independenceGroup: "ieee-spectrum",
    topicScope: ["compute-system", "chip-technology", "model-mechanism", "robotics"],
    authorityPrior: 0.80,
    attentionPrior: 0.50,
    freshnessHalfLifeHours: 36,
    fetchabilityPrior: 0.85,
    maxAgeHours: 96,
    maxItems: 30,
    maxBytes: 600_000,
    requestBudget: 3,
    attentionMetric: "technical-topic-match-and-editorial-prominence",
    limitations: [
      "broad-engineering-coverage-needs-ai-bottom-layer-filtering",
      "reported-vendor-performance-needs-configured-primary-results",
    ],
  }),
  source({
    id: "ars-technica-technology-lab-feed",
    label: "Ars Technica Technology Lab feed (AI filtered)",
    endpoint: "https://feeds.arstechnica.com/arstechnica/technology-lab",
    canonicalUrl: "https://arstechnica.com/ai/",
    format: "rss-or-atom",
    role: "editorial-discovery",
    authorityTier: "T2",
    independenceGroup: "ars-technica",
    topicScope: ["model-release", "compute-system", "agent-harness", "ai-security"],
    authorityPrior: 0.70,
    attentionPrior: 0.70,
    freshnessHalfLifeHours: 24,
    fetchabilityPrior: 0.70,
    maxAgeHours: 72,
    maxItems: 30,
    maxBytes: 750_000,
    requestBudget: 3,
    attentionMetric: "ai-topic-match-and-article-discussion-count",
    limitations: [
      "section-feed-is-broader-than-ai",
      "product-policy-and-security-stories-can-outnumber-research-or-mechanism-items",
    ],
  }),
  source({
    id: "venturebeat-ai-feed",
    label: "VentureBeat AI feed",
    endpoint: "https://venturebeat.com/category/ai/feed/",
    canonicalUrl: "https://venturebeat.com/category/ai/",
    format: "rss-or-atom",
    role: "editorial-discovery",
    authorityTier: "T2",
    independenceGroup: "venturebeat",
    topicScope: ["model-release", "compute-system", "agent-harness", "ai-company-direction"],
    authorityPrior: 0.60,
    attentionPrior: 0.70,
    freshnessHalfLifeHours: 24,
    fetchabilityPrior: 0.85,
    maxAgeHours: 72,
    maxItems: 30,
    maxBytes: 600_000,
    requestBudget: 3,
    attentionMetric: "ai-section-rank-and-technical-scope-match",
    limitations: [
      "section-mixes-enterprise-products-business-and-technical-reporting",
      "reported-vendor-claims-require-versioned-primary-artifacts",
      "not-a-model-mechanism-evidence-source",
    ],
  }),
  source({
    id: "interconnects-existing-snapshot",
    label: "Interconnects feed (existing candidate snapshot)",
    endpoint: "candidate:interconnects-feed",
    canonicalUrl: "https://www.interconnects.ai/",
    format: "existing-shadow-snapshot",
    role: "editorial-discovery",
    authorityTier: "T2",
    independenceGroup: "interconnects",
    topicScope: ["model-release", "model-mechanism", "compute-system"],
    authorityPrior: 0.80,
    attentionPrior: 0.80,
    freshnessHalfLifeHours: 36,
    fetchabilityPrior: 0.75,
    maxAgeHours: 96,
    maxItems: 20,
    maxBytes: 1_000_000,
    requestBudget: 0,
    attentionMetric: "technical-editorial-scope-and-curator-prominence",
    limitations: [
      "author-analysis-and-reported-results-remain-t2-until-primary-bridged",
      "publication-cadence-is-lower-than-a-daily-news-feed",
    ],
    fetchMode: "reference-existing-snapshot",
    managedBy: "candidate-source-registry",
    existingSourceIds: ["interconnects-feed"],
  }),
  source({
    id: "simon-willison-existing-snapshot",
    label: "Simon Willison feed (existing candidate snapshot)",
    endpoint: "candidate:simon-willison-feed",
    canonicalUrl: "https://simonwillison.net/",
    format: "existing-shadow-snapshot",
    role: "editorial-discovery",
    authorityTier: "T2",
    independenceGroup: "simon-willison",
    topicScope: ["model-release", "agent-harness", "evaluation-harness", "ai-security"],
    authorityPrior: 0.80,
    attentionPrior: 0.85,
    freshnessHalfLifeHours: 24,
    fetchabilityPrior: 0.90,
    maxAgeHours: 72,
    maxItems: 30,
    maxBytes: 500_000,
    requestBudget: 0,
    attentionMetric: "technical-editorial-scope-and-reproducible-artifact-prominence",
    limitations: [
      "independent-analysis-does-not-replace-official-release-or-research-artifacts",
      "model-usage-and-product-observations-must-not-be-misclassified-as-model-mechanisms",
    ],
    fetchMode: "reference-existing-snapshot",
    managedBy: "candidate-source-registry",
    existingSourceIds: ["simon-willison-feed"],
  }),
  source({
    id: "latent-space-existing-snapshot",
    label: "Latent Space main feed (existing candidate snapshot)",
    endpoint: "candidate:latent-space-feed",
    canonicalUrl: "https://www.latent.space/",
    format: "existing-shadow-snapshot",
    role: "editorial-discovery",
    authorityTier: "T2",
    independenceGroup: "latent-space",
    topicScope: ["model-release", "compute-system", "model-mechanism", "agent-harness", "evaluation-harness"],
    authorityPrior: 0.75,
    attentionPrior: 0.90,
    freshnessHalfLifeHours: 24,
    fetchabilityPrior: 0.75,
    maxAgeHours: 96,
    maxItems: 20,
    maxBytes: 1_000_000,
    requestBudget: 0,
    attentionMetric: "newsletter-headline-and-curator-prominence",
    limitations: [
      "latent-space-and-ai-news-share-one-independence-group",
      "social-link-density-does-not-create-independent-evidence",
    ],
    fetchMode: "reference-existing-snapshot",
    managedBy: "candidate-source-registry",
    existingSourceIds: ["latent-space-feed"],
  }),
  source({
    id: "official-github-releases-existing-snapshots",
    label: "Known official GitHub release bundle",
    endpoint: "https://api.github.com/repos/UKGovernmentBEIS/inspect_evals/releases?per_page=10&page=1",
    canonicalUrl: "https://docs.github.com/en/rest/releases/releases",
    format: "github-release-bundle",
    role: "official-release-discovery",
    authorityTier: "T1",
    independenceGroup: "per-official-repository-owner",
    topicScope: ["agent-harness", "evaluation-harness"],
    authorityPrior: 0.40,
    attentionPrior: 0.65,
    freshnessHalfLifeHours: 18,
    fetchabilityPrior: 0.90,
    maxAgeHours: 72,
    maxItems: 30,
    maxBytes: 1_000_000,
    requestBudget: 8,
    attentionMetric: "stable-release-semantic-review-queue-only",
    limitations: [
      "the-bundle-is-one-logical-discovery-source-but-performs-six-bounded-official-api-requests",
      "release-occurrence-does-not-prove-capability-uplift-safety-benefit-or-score-comparability",
      "repository-ownership-must-be-verified-before-onboarding",
    ],
    fetchMode: "network-shadow",
    endpoints: [
      "https://api.github.com/repos/openai/openai-agents-python/releases?per_page=10&page=1",
      "https://api.github.com/repos/anthropics/claude-agent-sdk-python/releases?per_page=10&page=1",
      "https://api.github.com/repos/google/adk-python/releases?per_page=10&page=1",
      "https://api.github.com/repos/microsoft/agent-framework/releases?per_page=10&page=1",
      "https://api.github.com/repos/stanford-crfm/helm/releases?per_page=10&page=1",
      "https://api.github.com/repos/UKGovernmentBEIS/inspect_evals/releases?per_page=10&page=1",
    ],
  }),
]);

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export function getTechDiscoverySource(sourceId) {
  return techDiscoverySources.find((candidate) => candidate.id === sourceId) || null;
}

export function scoreTechDiscoverySignal({ sourceId, observedAttention = 0, ageHours = 0 }) {
  const sourceDefinition = getTechDiscoverySource(sourceId);
  if (!sourceDefinition) throw new Error(`unknown tech discovery source: ${sourceId}`);
  const age = Math.max(0, Number(ageHours) || 0);
  if (age > sourceDefinition.limits.max_age_hours) {
    return {
      source_id: sourceId,
      independence_group: sourceDefinition.independence_group,
      eligible_for_review_queue: false,
      queue_priority: 0,
      reason: "outside-source-freshness-window",
      claim_evidence_delta: 0,
      notification_eligible: false,
    };
  }

  const freshness = 2 ** (-age / sourceDefinition.freshness_half_life_hours);
  const attention = 0.25 * sourceDefinition.queue_priors.attention + 0.75 * clamp01(observedAttention);
  const components = {
    authority: sourceDefinition.queue_priors.authority,
    attention,
    freshness,
    fetchability: sourceDefinition.queue_priors.fetchability,
  };
  const weighted = Object.entries(TECH_DISCOVERY_POLICY.dimension_weights)
    .reduce((total, [dimension, weight]) => total + components[dimension] * weight, 0);

  return {
    source_id: sourceId,
    independence_group: sourceDefinition.independence_group,
    eligible_for_review_queue: true,
    queue_priority: Math.round(weighted * 1000) / 10,
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Math.round(value * 1000) / 1000])),
    score_purpose: TECH_DISCOVERY_POLICY.score_purpose,
    representative_score_attention_cap: TECH_DISCOVERY_POLICY.representative_score_attention_cap,
    claim_evidence_delta: 0,
    notification_eligible: false,
  };
}

export function selectIndependentDiscoverySignals(signals, { limit = TECH_DISCOVERY_POLICY.max_selected_signals } = {}) {
  const ranked = signals
    .map((signal) => ({ ...signal, score: scoreTechDiscoverySignal(signal) }))
    .filter((signal) => signal.score.eligible_for_review_queue)
    .sort((left, right) => right.score.queue_priority - left.score.queue_priority || left.sourceId.localeCompare(right.sourceId));
  const selected = [];
  const usedGroups = new Set();
  for (const signal of ranked) {
    if (usedGroups.has(signal.score.independence_group)) continue;
    usedGroups.add(signal.score.independence_group);
    selected.push(signal);
    if (selected.length >= limit) break;
  }
  return {
    selected,
    distinct_independence_groups: [...usedGroups],
    claim_evidence_delta: 0,
    notification_eligible: false,
    external_actions: [],
  };
}

export function validateTechDiscoveryRegistry(sources = techDiscoverySources, policy = TECH_DISCOVERY_POLICY) {
  const errors = [];
  const ids = new Set();
  const weightTotal = Object.values(policy.dimension_weights || {}).reduce((total, value) => total + value, 0);
  if (Math.abs(weightTotal - 1) > 1e-9) errors.push("dimension weights must sum to 1");
  if (
    policy.claim_evidence_delta !== 0
    || policy.changes_production_ranking !== false
    || policy.writes_production_state !== false
    || policy.affects_production_source_health !== false
    || policy.notification_eligible !== false
    || policy.external_actions?.length
  ) {
    errors.push("global discovery boundary violated");
  }
  for (const candidate of sources) {
    if (ids.has(candidate.id)) errors.push(`duplicate source id: ${candidate.id}`);
    ids.add(candidate.id);
    if (!new Set(["T1", "T2"]).has(candidate.authority_tier)) errors.push(`invalid discovery tier: ${candidate.id}`);
    if (candidate.discovery_only !== true) errors.push(`source is not discovery-only: ${candidate.id}`);
    for (const field of ["claim_evidence_allowed", "can_satisfy_claim_requirement", "can_raise_evidence_grade", "can_change_claim_status", "can_trigger_notification"]) {
      if (candidate[field] !== false) errors.push(`${field} boundary violated: ${candidate.id}`);
    }
    if (candidate.authentication !== "public") errors.push(`credential dependency: ${candidate.id}`);
    if (!candidate.independence_group) errors.push(`missing independence group: ${candidate.id}`);
    if (!candidate.limits || candidate.limits.max_items < 1 || candidate.limits.max_age_hours < 1 || candidate.limits.request_budget < 0) {
      errors.push(`invalid limits: ${candidate.id}`);
    }
    for (const prior of Object.values(candidate.queue_priors || {})) {
      if (!Number.isFinite(prior) || prior < 0 || prior > 1) errors.push(`invalid queue prior: ${candidate.id}`);
    }
    if (candidate.fetch_mode.startsWith("reference-existing") && candidate.existing_source_ids.length === 0) {
      errors.push(`existing snapshot reference missing source ids: ${candidate.id}`);
    }
    if (candidate.fetch_mode.startsWith("reference-existing") && candidate.limits.request_budget !== 0) {
      errors.push(`existing snapshot reference must not refetch: ${candidate.id}`);
    }
    if (candidate.format === "github-release-bundle"
      && (candidate.endpoints.length < 1 || candidate.limits.request_budget < candidate.endpoints.length)) {
      errors.push(`GitHub release bundle endpoints exceed request budget: ${candidate.id}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
