import assert from "node:assert/strict";
import test from "node:test";
import {
  TECH_DISCOVERY_POLICY,
  getTechDiscoverySource,
  scoreTechDiscoverySignal,
  selectIndependentDiscoverySignals,
  techDiscoverySources,
  validateTechDiscoveryRegistry,
} from "../automation/tech-discovery-registry.mjs";

test("the tech discovery registry is isolated from claims, ranking authority, notifications, and credentials", () => {
  assert.deepEqual(validateTechDiscoveryRegistry(), { ok: true, errors: [] });
  assert.equal(TECH_DISCOVERY_POLICY.claim_evidence_delta, 0);
  assert.equal(TECH_DISCOVERY_POLICY.changes_production_ranking, false);
  assert.equal(TECH_DISCOVERY_POLICY.writes_production_state, false);
  assert.equal(TECH_DISCOVERY_POLICY.affects_production_source_health, false);
  assert.equal(TECH_DISCOVERY_POLICY.notification_eligible, false);
  assert.deepEqual(TECH_DISCOVERY_POLICY.external_actions, []);
  assert.equal(TECH_DISCOVERY_POLICY.representative_score_attention_cap, 5);
  assert.ok(techDiscoverySources.every((source) => ["T1", "T2"].includes(source.authority_tier)));
  assert.ok(techDiscoverySources.every((source) => source.discovery_only && !source.claim_evidence_allowed));
  assert.ok(techDiscoverySources.every((source) => !source.can_satisfy_claim_requirement && !source.can_raise_evidence_grade));
  assert.ok(techDiscoverySources.every((source) => !source.can_change_claim_status && !source.can_trigger_notification));
  assert.ok(techDiscoverySources.every((source) => source.authentication === "public"));
});

test("the requested communities and technology publications have explicit bounded contracts", () => {
  const expected = [
    "github-trending-daily",
    "hacker-news-topstories",
    "techmeme-feed",
    "mit-technology-review-feed",
    "ieee-spectrum-ai-feed",
    "ars-technica-technology-lab-feed",
    "venturebeat-ai-feed",
    "interconnects-existing-snapshot",
    "simon-willison-existing-snapshot",
    "latent-space-existing-snapshot",
    "official-github-releases-existing-snapshots",
  ];
  assert.deepEqual(techDiscoverySources.map((source) => source.id), expected);
  for (const source of techDiscoverySources) {
    assert.ok(source.limits.max_items <= 40);
    assert.ok(source.limits.max_age_hours <= 96);
    assert.ok(source.limits.max_bytes <= 1_000_000);
    assert.ok(source.limits.request_budget <= 41);
    assert.ok(source.limitations.length > 0);
  }
});

test("unattended endpoints honor the current robots and content-use admission decisions", () => {
  const github = getTechDiscoverySource("github-trending-daily");
  assert.equal(github.endpoint, "https://github.com/trending");
  assert.equal(new URL(github.endpoint).search, "");
  const endpoints = techDiscoverySources.map((source) => source.endpoint).join("\n");
  for (const excludedHost of ["lobste.rs", "theregister.com", "the-decoder.com", "servethehome.com"]) {
    assert.ok(!endpoints.includes(excludedHost), `${excludedHost} must remain manual-watchlist-only`);
  }
});

test("editorial discovery fetches public feeds while the bounded official release bundle is self-contained", () => {
  const latent = getTechDiscoverySource("latent-space-existing-snapshot");
  assert.equal(latent.endpoint, "https://www.latent.space/feed");
  assert.equal(latent.format, "rss-or-atom");
  assert.equal(latent.fetch_mode, "network-shadow");
  assert.equal(latent.managed_by, "tech-discovery-registry");
  assert.deepEqual(latent.existing_source_ids, []);
  assert.equal(latent.limits.request_budget, 3);

  const interconnects = getTechDiscoverySource("interconnects-existing-snapshot");
  assert.equal(interconnects.endpoint, "https://www.interconnects.ai/feed");
  assert.equal(interconnects.fetch_mode, "network-shadow");
  assert.deepEqual(interconnects.existing_source_ids, []);
  assert.equal(interconnects.limits.request_budget, 3);

  const simon = getTechDiscoverySource("simon-willison-existing-snapshot");
  assert.equal(simon.endpoint, "https://simonwillison.net/atom/everything/");
  assert.equal(simon.fetch_mode, "network-shadow");
  assert.deepEqual(simon.existing_source_ids, []);
  assert.equal(simon.limits.request_budget, 3);

  const releases = getTechDiscoverySource("official-github-releases-existing-snapshots");
  assert.equal(releases.authority_tier, "T1");
  assert.equal(releases.fetch_mode, "network-shadow");
  assert.equal(releases.format, "github-release-bundle");
  assert.equal(releases.endpoints.length, 6);
  assert.ok(releases.limits.request_budget >= releases.endpoints.length);
  assert.ok(releases.endpoints.some((endpoint) => endpoint.includes("claude-agent-sdk-python")));
  assert.ok(releases.endpoints.some((endpoint) => endpoint.includes("inspect_evals")));
  assert.ok(releases.limitations.some((item) => item.includes("release-occurrence-does-not-prove")));
});

test("discovery scoring changes review priority but never evidence or notification state", () => {
  const quiet = scoreTechDiscoverySignal({ sourceId: "hacker-news-topstories", observedAttention: 0.1, ageHours: 4 });
  const hot = scoreTechDiscoverySignal({ sourceId: "hacker-news-topstories", observedAttention: 0.95, ageHours: 4 });
  assert.ok(hot.queue_priority > quiet.queue_priority);
  assert.equal(hot.score_purpose, "human-review-queue-priority-only");
  assert.equal(hot.representative_score_attention_cap, 5);
  assert.equal(hot.claim_evidence_delta, 0);
  assert.equal(hot.notification_eligible, false);
});

test("stale community or media items are excluded rather than revived by popularity", () => {
  const stale = scoreTechDiscoverySignal({ sourceId: "github-trending-daily", observedAttention: 1, ageHours: 37 });
  assert.equal(stale.eligible_for_review_queue, false);
  assert.equal(stale.queue_priority, 0);
  assert.equal(stale.reason, "outside-source-freshness-window");
  assert.equal(stale.claim_evidence_delta, 0);
});

test("selection counts at most one signal from each editorial or community independence group", () => {
  const selection = selectIndependentDiscoverySignals([
    { sourceId: "hacker-news-topstories", observedAttention: 1, ageHours: 1, story: "first-HN-post" },
    { sourceId: "hacker-news-topstories", observedAttention: 0.9, ageHours: 2, story: "duplicate-HN-post" },
    { sourceId: "latent-space-existing-snapshot", observedAttention: 0.8, ageHours: 4, story: "latent-space" },
    { sourceId: "venturebeat-ai-feed", observedAttention: 0.7, ageHours: 4, story: "venturebeat" },
  ]);
  assert.equal(selection.selected.length, 3);
  assert.equal(selection.selected.filter((item) => item.score.independence_group === "hacker-news").length, 1);
  assert.equal(new Set(selection.distinct_independence_groups).size, 3);
  assert.equal(selection.claim_evidence_delta, 0);
  assert.equal(selection.notification_eligible, false);
  assert.deepEqual(selection.external_actions, []);
});

test("the validator fails closed if a discovery source is promoted into claim evidence", () => {
  const mutated = structuredClone(techDiscoverySources);
  mutated[0].claim_evidence_allowed = true;
  mutated[0].authority_tier = "T4";
  const result = validateTechDiscoveryRegistry(mutated);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("invalid discovery tier: github-trending-daily"));
  assert.ok(result.errors.includes("claim_evidence_allowed boundary violated: github-trending-daily"));
});
