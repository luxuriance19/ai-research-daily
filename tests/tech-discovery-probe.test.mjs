import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { techDiscoverySources } from "../automation/tech-discovery-registry.mjs";
import {
  atomicWriteFile,
  classifyDailySections,
  createTechDiscoveryAudit,
  normalizedEventIdentity,
  parseGitHubTrending,
  parseRssDiscovery,
  runTechDiscoveryProbe,
  selectDailyCurrentWindowReview,
  selectHumanReviewQueue,
} from "../automation/run-tech-discovery-probe.mjs";
import { verifyTechDiscoveryProbe } from "../automation/verify-tech-discovery-probe.mjs";

const byId = (id) => techDiscoverySources.find((source) => source.id === id);
const cloneSource = (id, overrides = {}) => {
  const source = structuredClone(byId(id));
  return {
    ...source,
    ...overrides,
    limits: { ...source.limits, ...(overrides.limits || {}) },
  };
};
const response = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers });
const tempPaths = async () => {
  const root = await mkdtemp(join(tmpdir(), "tech-discovery-probe-"));
  return {
    root,
    outputPath: join(root, "audit.json"),
    statePath: join(root, "audit.json"),
    reviewPath: join(root, "review.md"),
    cacheDir: join(root, "cache"),
    candidateAuditPath: join(root, "candidate-audit.json"),
  };
};

test("RSS fixtures are bounded, formula-free discovery records mapped to the six AI daily sections", () => {
  const source = cloneSource("techmeme-feed", { limits: { max_items: 3 } });
  const fixture = `<?xml version="1.0"?>
    <rss><channel>
      <item><title>Moonshot releases new Kimi model weights</title><link>https://news.example/kimi?utm_source=rss</link><pubDate>Fri, 17 Jul 2026 08:00:00 GMT</pubDate><description>Official link still needs checking.</description></item>
      <item><title>NVIDIA unveils an AI GPU inference accelerator</title><link>https://news.example/gpu</link><pubDate>Fri, 17 Jul 2026 07:00:00 GMT</pubDate></item>
      <item><title>OpenAI acquires a research tooling company</title><link>https://news.example/company</link><pubDate>Fri, 17 Jul 2026 06:00:00 GMT</pubDate></item>
      <item><title>A recipe for sourdough</title><link>https://news.example/bread</link><pubDate>Fri, 17 Jul 2026 05:00:00 GMT</pubDate></item>
    </channel></rss>`;
  const items = parseRssDiscovery(source, fixture, { now: new Date("2026-07-17T10:00:00Z") });
  assert.equal(items.length, 3);
  assert.ok(items[0].daily_sections.includes("new-model"));
  assert.ok(items[1].daily_sections.includes("compute-chip"));
  assert.ok(items[2].daily_sections.includes("company-direction"));
  assert.equal(items[0].canonical_url, "https://news.example/kimi");
  assert.ok(items.every((item) => item.primary_verification_required));
  assert.ok(items.every((item) => item.primary_verified === false));
  assert.ok(items.every((item) => item.primary_bridge_state === "unverified-primary-required"));
  assert.deepEqual(classifyDailySections("A new circuit tracing interpretability method"), ["mechanism"]);
});

test("GitHub Trending bounded HTML only yields repository candidates and never treats stars as proof", () => {
  const source = cloneSource("github-trending-daily", { limits: { max_items: 2 } });
  const fixture = `
    <article class="Box-row"><h2><a href="/acme/latent-loop">acme / latent-loop</a></h2><p>Recurrent LLM reasoning harness</p><span itemprop="programmingLanguage">Python</span><a href="/acme/latent-loop/stargazers">12,340</a><span>1,234 stars today</span></article>
    <article class="Box-row"><h2><a href="/chips/fast-kernel">chips / fast-kernel</a></h2><p>GPU inference kernel for AI models</p><span>432 stars today</span></article>
    <article class="Box-row"><h2><a href="/ignored/third">ignored / third</a></h2><p>AI benchmark</p><span>99 stars today</span></article>`;
  const items = parseGitHubTrending(source, fixture, { now: new Date("2026-07-17T10:00:00Z") });
  assert.equal(items.length, 2);
  assert.equal(items[0].discovery_kind, "github-project");
  assert.equal(items[0].canonical_url, "https://github.com/acme/latent-loop");
  assert.equal(items[0].primary_identity_hint.owner_verified, false);
  assert.equal(items[0].claim_evidence_allowed, false);
  assert.equal(items[0].manual_review_only, true);
  assert.equal(items[0].primary_verified, false);
  assert.ok(items[0].daily_sections.includes("mechanism"));
  assert.ok(items[1].daily_sections.includes("compute-chip"));
});

test("hardware and mechanism vocabulary stays paired with AI context for broad technology feeds", () => {
  const ventureBeat = cloneSource("venturebeat-ai-feed");
  const items = parseRssDiscovery(ventureBeat, `<rss><channel><item><title>Vendor releases a new open LLM model</title><link>https://venturebeat.example/model</link><pubDate>Fri, 17 Jul 2026 09:00:00 GMT</pubDate></item><item><title>AI training rack adds a CPU and HBM memory fabric</title><link>https://venturebeat.example/ai-rack</link><pubDate>Fri, 17 Jul 2026 08:00:00 GMT</pubDate></item><item><title>General purpose CPU server review</title><link>https://venturebeat.example/cpu</link><pubDate>Fri, 17 Jul 2026 07:00:00 GMT</pubDate></item></channel></rss>`, { now: new Date("2026-07-17T10:00:00Z") });
  assert.ok(items[0].daily_sections.includes("new-model"));
  assert.ok(items[1].daily_sections.includes("compute-chip"));
  assert.deepEqual(items[2].daily_sections, []);
  assert.deepEqual(classifyDailySections("A controlled RLHF post-training and knowledge distillation study"), ["mechanism"]);
  assert.deepEqual(classifyDailySections("Kimi K3: Open Frontier Intelligence"), ["new-model"]);
  assert.deepEqual(classifyDailySections("xai-org/grok-build, now open source agent harness"), ["harness"]);
});

test("Hacker News uses one topstories GET plus a bounded item fanout and baselines all first-seen stories", async () => {
  const paths = await tempPaths();
  const source = cloneSource("hacker-news-topstories", {
    limits: { max_items: 3, request_budget: 4, max_bytes: 20_000 },
  });
  const calls = [];
  const items = new Map([
    [101, { id: 101, type: "story", time: 1_784_280_000, score: 300, descendants: 120, title: "New open LLM model released", url: "https://lab.example/model" }],
    [102, { id: 102, type: "story", time: 1_784_279_000, score: 250, descendants: 80, title: "NVIDIA AI GPU compiler breakthrough", url: "https://chips.example/gpu" }],
    [103, { id: 103, type: "story", time: 1_784_278_000, score: 200, descendants: 60, title: "Agent harness evaluation SDK", url: "https://code.example/harness" }],
  ]);
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("topstories.json")) return response(JSON.stringify([101, 102, 103, 104, 105]));
    const id = Number(String(url).match(/item\/(\d+)\.json/)?.[1]);
    return response(JSON.stringify(items.get(id)));
  };
  const audit = await runTechDiscoveryProbe({
    sources: [source],
    ...paths,
    fetchImpl,
    now: new Date("2026-07-17T10:00:00Z"),
  });
  assert.equal(calls.length, 4);
  assert.equal(audit.source_events[0].requests_made, 4);
  assert.equal(audit.source_events[0].items_parsed, 3);
  assert.equal(audit.source_events[0].onboarding_baseline, true);
  assert.equal(audit.source_events[0].new_items, 0);
  assert.deepEqual(audit.human_review_queue, []);
  assert.deepEqual(verifyTechDiscoveryProbe(audit, [source]), { ok: true, errors: [] });
});

test("Latent Space is fetched directly on the fast path and remains human-review-only", async () => {
  const now = new Date("2026-07-17T10:30:00Z");
  const latentSource = cloneSource("latent-space-existing-snapshot");
  const paths = await tempPaths();
  const baseline = `<rss><channel><item><title>[AINews] A new open model released</title><link>https://www.latent.space/p/baseline-model</link><pubDate>Fri, 17 Jul 2026 08:30:00 GMT</pubDate></item></channel></rss>`;
  let networkCalls = 0;
  const audit = await runTechDiscoveryProbe({
    sources: [latentSource],
    ...paths,
    fetchImpl: async () => { networkCalls += 1; return response(baseline); },
    now,
  });
  assert.equal(networkCalls, 1);
  assert.equal(audit.metrics.onboarding_baselines, 1);
  assert.equal(audit.metrics.selected_for_human_review, 0);
  assert.ok(audit.source_events.every((event) => event.network_fresh && event.requests_made === 1));
  assert.deepEqual(verifyTechDiscoveryProbe(audit, [latentSource]), { ok: true, errors: [] });

  const changedFeed = baseline.replace("</channel>", `<item><title>[AINews] New agent harness evaluation benchmark released</title><link>https://www.latent.space/p/new-agent-eval</link><pubDate>Fri, 17 Jul 2026 10:15:00 GMT</pubDate></item></channel>`);
  const changed = await runTechDiscoveryProbe({
    sources: [latentSource],
    ...paths,
    fetchImpl: async () => response(changedFeed),
    now: new Date("2026-07-17T10:40:00Z"),
  });
  assert.equal(changed.metrics.new_discovery_candidates, 1);
  assert.equal(changed.human_review_queue.length, 1);
  assert.ok(changed.human_review_queue.every((item) => item.primary_verification_required && item.manual_review_only));
  assert.deepEqual(changed.notification_policy.records, []);
  assert.deepEqual(changed.external_actions, []);
  assert.deepEqual(verifyTechDiscoveryProbe(changed, [latentSource]), { ok: true, errors: [] });
});

test("official Harness releases require a bounded semantic delta and SDK names never become model launches", async () => {
  const paths = await tempPaths();
  const now = new Date("2026-07-17T10:30:00Z");
  const releaseSource = cloneSource("official-github-releases-existing-snapshots");
  const audit = await runTechDiscoveryProbe({
    sources: [releaseSource],
    ...paths,
    fetchImpl: async (url) => {
      const repository = String(url).match(/repos\/([^/]+\/[^/]+)\/releases/)?.[1] || "unknown/repo";
      const isClaude = repository === "anthropics/claude-agent-sdk-python";
      return response(JSON.stringify([{
        id: repository.length,
        tag_name: "v1.0.0",
        name: "v1.0.0",
        draft: false,
        prerelease: false,
        immutable: true,
        published_at: "2026-07-17T08:00:00Z",
        created_at: "2026-07-17T07:00:00Z",
        html_url: `https://github.com/${repository}/releases/tag/v1.0.0`,
        target_commitish: "main",
        body: isClaude
          ? "Adds resumable background tasks, session compaction, sandbox approvals, &amp; tracing. "
          : "Maintenance patch and dependency refresh.",
      }]));
    },
    now,
  });
  const claude = audit.source_events[0].items.find((item) => item.existing_source_id === "direct:anthropics/claude-agent-sdk-python");
  assert.deepEqual(claude.daily_sections, ["harness"]);
  assert.match(claude.summary_for_discovery_only, /& tracing/);
  assert.equal(claude.release_semantic_review.has_semantic_delta_cue, true);
  assert.equal(audit.daily_current_window_review.length, 1);
  assert.equal(audit.daily_current_window_review[0].existing_source_id, "direct:anthropics/claude-agent-sdk-python");
  assert.equal(audit.daily_current_window_review[0].release_semantic_delta_ready, true);
  assert.equal(audit.daily_editorial_exclusions.length, 5);
  assert.ok(audit.daily_editorial_exclusions.every((item) => item.exclusion_reason === "release-without-semantic-delta"));
  assert.deepEqual(verifyTechDiscoveryProbe(audit, [releaseSource]), { ok: true, errors: [] });

  const fabricated = structuredClone(audit);
  fabricated.source_events[0].items.find((item) => item.existing_source_id === "direct:anthropics/claude-agent-sdk-python")
    .release_semantic_review.has_semantic_delta_cue = false;
  assert.ok(verifyTechDiscoveryProbe(fabricated, [releaseSource]).errors.some((error) => error.includes("semantic review projection mismatch")));
});

test("a bounded network-verified release cache may retain editorial review but never a change candidate", async () => {
  const paths = await tempPaths();
  const releaseSource = cloneSource("official-github-releases-existing-snapshots");
  const fetchSuccess = async (url) => {
    const repository = String(url).match(/repos\/([^/]+\/[^/]+)\/releases/)?.[1] || "unknown/repo";
    const isInspect = repository === "UKGovernmentBEIS/inspect_evals";
    return response(JSON.stringify([{
      id: repository.length,
      tag_name: "v1.0.0",
      name: "v1.0.0",
      draft: false,
      prerelease: false,
      immutable: true,
      published_at: "2026-07-17T08:00:00Z",
      html_url: `https://github.com/${repository}/releases/tag/v1.0.0`,
      target_commitish: "main",
      body: isInspect ? "Adds a new benchmark, scorer contract, and task version." : "Maintenance patch.",
    }]));
  };
  const first = await runTechDiscoveryProbe({
    sources: [releaseSource],
    ...paths,
    fetchImpl: fetchSuccess,
    now: new Date("2026-07-17T10:00:00Z"),
  });
  assert.equal(first.source_events[0].status, "fresh");
  assert.equal(first.daily_current_window_review.length, 1);

  const retained = await runTechDiscoveryProbe({
    sources: [releaseSource],
    ...paths,
    fetchImpl: async () => response("rate limited", { status: 403 }),
    now: new Date("2026-07-17T11:00:00Z"),
  });
  const event = retained.source_events[0];
  assert.equal(event.status, "stale-cache");
  assert.equal(event.fresh_for_change_detection, false);
  assert.equal(event.editorial_cache_usable, true);
  assert.equal(event.new_items, 0);
  assert.deepEqual(event.queue_candidates, []);
  assert.equal(retained.daily_current_window_review.length, 1);
  assert.equal(retained.daily_current_window_review[0].change_candidate, false);
  assert.equal(retained.daily_current_window_review[0].daily_snapshot_state, "contains-retained-network-verified-cache");
  assert.ok(retained.daily_current_window_review[0].source_records.every((item) => item.daily_snapshot_state === "retained-network-verified-cache"));
  assert.deepEqual(verifyTechDiscoveryProbe(retained, [releaseSource]), { ok: true, errors: [] });
});

test("Interconnects and Simon Willison are direct bounded feeds with no publication authority", async () => {
  const paths = await tempPaths();
  const now = new Date("2026-07-17T10:30:00Z");
  const sources = [
    cloneSource("interconnects-existing-snapshot"),
    cloneSource("simon-willison-existing-snapshot"),
  ];
  let networkCalls = 0;
  const audit = await runTechDiscoveryProbe({
    sources,
    ...paths,
    fetchImpl: async (url) => {
      networkCalls += 1;
      const simon = String(url).includes("simonwillison.net");
      return response(`<rss><channel><item><title>${simon ? "A reproducible look at a new agent SDK release" : "A field guide to RLHF post-training and distillation"}</title><link>${simon ? "https://simonwillison.net/2026/Jul/17/agent-sdk/" : "https://www.interconnects.ai/p/post-training"}</link><pubDate>Fri, 17 Jul 2026 08:20:00 GMT</pubDate></item></channel></rss>`);
    },
    now,
  });
  assert.equal(networkCalls, 2);
  assert.equal(audit.metrics.reused_snapshot_sources, 0);
  assert.equal(audit.metrics.onboarding_baselines, 2);
  assert.equal(audit.metrics.selected_for_human_review, 0);
  assert.ok(audit.source_events.every((event) => event.requests_made === 1 && event.network_fresh));
  assert.ok(audit.source_events.flatMap((event) => event.items).every((item) => item.primary_verified === false));
  assert.deepEqual(audit.notification_policy.records, []);
  assert.deepEqual(verifyTechDiscoveryProbe(audit, sources), { ok: true, errors: [] });
});

test("GitHub Trending onboarding is not news; only a subsequently unseen project enters the human queue", async () => {
  const paths = await tempPaths();
  const source = cloneSource("github-trending-daily", { limits: { max_items: 4 } });
  const baselineHtml = `<article class="Box-row"><h2><a href="/old/model-kit">old/model-kit</a></h2><p>Open LLM model toolkit</p><span>400 stars today</span></article>`;
  const changedHtml = `${baselineHtml}<article class="Box-row"><h2><a href="/new/latent-agent">new/latent-agent</a></h2><p>New recurrent LLM agent harness</p><span>900 stars today</span></article>`;
  const first = await runTechDiscoveryProbe({
    sources: [source],
    ...paths,
    fetchImpl: async () => response(baselineHtml),
    now: new Date("2026-07-17T09:00:00Z"),
  });
  assert.equal(first.source_events[0].observation_state, "onboarding-baseline");
  assert.equal(first.human_review_queue.length, 0);

  const second = await runTechDiscoveryProbe({
    sources: [source],
    ...paths,
    fetchImpl: async () => response(changedHtml),
    now: new Date("2026-07-17T10:00:00Z"),
  });
  assert.equal(second.source_events[0].new_items, 1);
  assert.equal(second.human_review_queue.length, 1);
  assert.equal(second.human_review_queue[0].canonical_url, "https://github.com/new/latent-agent");
  assert.equal(second.human_review_queue[0].queue_state, "pending-human-primary-verification");
  assert.equal(second.human_review_queue[0].automatic_promotion, false);
  assert.deepEqual(verifyTechDiscoveryProbe(second, [source]), { ok: true, errors: [] });
});

test("selection is capped at five, deduplicates normalized stories, and counts one item per independence group", () => {
  const sourceIds = [
    "github-trending-daily",
    "hacker-news-topstories",
    "techmeme-feed",
    "mit-technology-review-feed",
    "ieee-spectrum-ai-feed",
    "ars-technica-technology-lab-feed",
    "venturebeat-ai-feed",
  ];
  const events = sourceIds.map((sourceId, index) => {
    const item = {
      source_id: sourceId,
      source_story_key: `source-${index}`,
      canonical_story_key: index === 6 ? "story-0" : `story-${index}`,
      independence_group: index === 5 ? "shared-editorial-group" : index === 4 ? "shared-editorial-group" : `group-${index}`,
      discovery_kind: "editorial-story",
      title: `AI discovery ${index}`,
      canonical_url: `https://example.com/${index}`,
      published_at: "2026-07-17T09:00:00Z",
      age_hours: 1,
      observed_attention: 1 - index * 0.03,
      daily_sections: ["mechanism"],
      ai_relevant: true,
      within_source_window: true,
      primary_verification_required: true,
      requires_primary_verification: true,
      manual_review_only: true,
      automatic_promotion: false,
      claim_evidence_allowed: false,
      claim_evidence_delta: 0,
      notification_eligible: false,
      queue_state: "pending-human-primary-verification",
      is_new: true,
    };
    return { source_id: sourceId, queue_candidates: [item] };
  });
  const queue = selectHumanReviewQueue(events);
  assert.equal(queue.length, 5);
  assert.equal(new Set(queue.map((item) => item.independence_group)).size, 5);
  assert.equal(new Set(queue.map((item) => item.canonical_story_key)).size, 5);
  const audit = createTechDiscoveryAudit({
    now: new Date("2026-07-17T10:00:00Z"),
    sources: sourceIds.map((id) => cloneSource(id)),
    sourceEvents: events.map((event) => ({ ...event, fresh_for_change_detection: true })),
  });
  assert.equal(audit.human_review_queue.length, 5);
  assert.deepEqual(audit.notification_policy.records, []);
  assert.deepEqual(audit.external_actions, []);
});

test("cross-publication event identity prefers primary hints and otherwise normalizes title wording", () => {
  const officialHint = normalizedEventIdentity({
    title: "OpenAI Agents SDK v2 is available",
    canonical_url: "https://github.com/openai/openai-agents-python/releases/tag/v2.0.0",
    primary_identity_hint: {
      kind: "git-release-or-commit-sha",
      repository: "openai/openai-agents-python",
      release_id: "99123",
      tag_name: "v2.0.0",
    },
  });
  const mediaArtifact = normalizedEventIdentity({
    title: "A publication uses completely different release wording",
    canonical_url: "https://media.example/agents-sdk-two",
    artifact_links: ["https://github.com/openai/openai-agents-python/releases/tag/v2.0.0?utm_source=story"],
  });
  assert.equal(officialHint.key, mediaArtifact.key);
  assert.equal(officialHint.basis, "primary-identity-hint");
  assert.equal(mediaArtifact.basis, "primary-artifact-link");

  const artifactFeedSource = cloneSource("techmeme-feed");
  const artifactFeedItem = parseRssDiscovery(artifactFeedSource, `<rss><channel><item><title>Agents SDK coverage with unrelated wording</title><link>https://media.example/agents-sdk</link><pubDate>Fri, 17 Jul 2026 09:00:00 GMT</pubDate><description><![CDATA[See https://github.com/openai/openai-agents-python/releases/tag/v2.0.0?utm_source=feed and ignore https://media.example/related.]]></description></item></channel></rss>`, { now: new Date("2026-07-17T10:00:00Z") })[0];
  assert.equal(artifactFeedItem.canonical_story_key, officialHint.key);
  assert.deepEqual(artifactFeedItem.artifact_links, ["https://github.com/openai/openai-agents-python/releases/tag/v2.0.0"]);

  const techmeme = cloneSource("techmeme-feed");
  const mit = cloneSource("mit-technology-review-feed");
  const first = parseRssDiscovery(techmeme, `<rss><channel><item><title>OpenAI announces a new Foo model</title><link>https://one.example/foo</link><pubDate>Fri, 17 Jul 2026 09:00:00 GMT</pubDate></item></channel></rss>`, { now: new Date("2026-07-17T10:00:00Z") })[0];
  const second = parseRssDiscovery(mit, `<rss><channel><item><title>The new Foo model announced by OpenAI</title><link>https://two.example/foo-analysis</link><pubDate>Fri, 17 Jul 2026 09:00:00 GMT</pubDate></item></channel></rss>`, { now: new Date("2026-07-17T10:00:00Z") })[0];
  assert.equal(first.canonical_story_key, second.canonical_story_key);
  const queue = selectHumanReviewQueue([
    { source_id: techmeme.id, queue_candidates: [{ ...first, is_new: true, queue_state: "pending-human-primary-verification" }] },
    { source_id: mit.id, queue_candidates: [{ ...second, is_new: true, queue_state: "pending-human-primary-verification" }] },
  ]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].primary_verified, false);

  const immutableArtifactWins = normalizedEventIdentity({
    title: "xai grok build agent harness is open source",
    canonical_url: "https://analysis.example/grok-build",
    artifact_links: [
      "https://github.com/xai-org/grok-build",
      "https://github.com/xai-org/grok-build/commit/b189869b7755d2b482969acf6c92da3ecfeffd36",
    ],
  });
  assert.equal(immutableArtifactWins.basis, "primary-artifact-link");
  assert.equal(immutableArtifactWins.fingerprint, "git-commit:xai-org/grok-build@b189869b7755d2b482969acf6c92da3ecfeffd36");
});

test("daily editorial review rejects title-only hype and a lone Trending repository but keeps independently bridged repository attention", () => {
  const now = new Date("2026-07-17T10:00:00Z");
  const trendingSource = cloneSource("github-trending-daily", { limits: { max_items: 2 } });
  const mediaSource = cloneSource("techmeme-feed", { limits: { max_items: 2 } });
  const trending = parseGitHubTrending(trendingSource, `<article class="Box-row"><h2><a href="/acme/agent-core">acme/agent-core</a></h2><p>AI agent harness runtime</p><span>900 stars today</span></article>`, { now })[0];
  const titleOnly = parseRssDiscovery(mediaSource, `<rss><channel><item><title>Enterprises discover an enormous AI agent security gap</title><link>https://media.example/security-gap</link><pubDate>Fri, 17 Jul 2026 09:00:00 GMT</pubDate></item></channel></rss>`, { now })[0];
  const singleSource = selectDailyCurrentWindowReview([
    { source_id: trendingSource.id, fresh_for_change_detection: true, items: [trending] },
    { source_id: mediaSource.id, fresh_for_change_detection: true, items: [titleOnly] },
  ]);
  assert.deepEqual(singleSource, []);

  const mediaBridge = parseRssDiscovery(mediaSource, `<rss><channel><item><title>acme agent-core AI agent harness runtime</title><link>https://media.example/agent-core</link><pubDate>Fri, 17 Jul 2026 09:00:00 GMT</pubDate><description><![CDATA[Repository: https://github.com/acme/agent-core]]></description></item></channel></rss>`, { now })[0];
  assert.equal(mediaBridge.canonical_story_key, trending.canonical_story_key);
  const bridged = selectDailyCurrentWindowReview([
    { source_id: trendingSource.id, fresh_for_change_detection: true, items: [trending] },
    { source_id: mediaSource.id, fresh_for_change_detection: true, items: [mediaBridge] },
  ]);
  assert.equal(bridged.length, 1);
  assert.equal(bridged[0].editorial_identity_ready, false);
  assert.equal(bridged[0].multi_source_attention_ready, true);
  assert.equal(bridged[0].independent_attention_groups, 2);
  assert.equal(bridged[0].primary_verified, false);
  assert.equal(bridged[0].notification_eligible, false);
});

test("the same canonical article URL reuses a stronger official identity discovered by another source", () => {
  const now = new Date("2026-07-17T10:00:00Z");
  const simonUrl = "https://simonwillison.net/2026/Jul/16/kimi-k3";
  const officialUrl = "https://www.kimi.com/blog/kimi-k3";
  const strongSource = cloneSource("simon-willison-existing-snapshot");
  const weakSource = cloneSource("hacker-news-topstories");
  const strong = parseRssDiscovery(strongSource, `<rss><channel><item><title>Kimi K3, and what we can learn from the benchmark</title><link>${simonUrl}</link><pubDate>Fri, 17 Jul 2026 09:00:00 GMT</pubDate><description><![CDATA[Official announcement: ${officialUrl}]]></description></item></channel></rss>`, { now })[0];
  const weak = parseRssDiscovery(weakSource, `<rss><channel><item><title>Kimi K3, and what we can learn from the benchmark</title><link>${simonUrl}</link><pubDate>Fri, 17 Jul 2026 09:00:00 GMT</pubDate></item></channel></rss>`, { now })[0];
  assert.notEqual(strong.canonical_story_key, weak.canonical_story_key);

  const audit = createTechDiscoveryAudit({
    now,
    sources: [strongSource, weakSource],
    sourceEvents: [
      { source_id: strongSource.id, fresh_for_change_detection: true, items: [strong], queue_candidates: [] },
      { source_id: weakSource.id, fresh_for_change_detection: true, items: [{ ...weak, is_new: true }], queue_candidates: [{ ...weak, is_new: true, queue_state: "pending-human-primary-verification" }] },
    ],
  });
  const reconciledWeak = audit.source_events[1].items[0];
  assert.equal(reconciledWeak.canonical_story_key, strong.canonical_story_key);
  assert.equal(reconciledWeak.normalized_event_identity_basis, "canonical-url-cross-source-bridge");
  assert.equal(reconciledWeak.normalized_event_fingerprint, strong.normalized_event_fingerprint);
  assert.equal(reconciledWeak.identity_bridge.source_id, strongSource.id);
  assert.equal(audit.daily_current_window_review.length, 1);
  assert.equal(audit.daily_editorial_exclusions.length, 0);
  assert.equal(audit.human_review_queue.length, 1);
  assert.equal(audit.human_review_queue[0].canonical_story_key, strong.canonical_story_key);
});

test("Kimi K3 replay merges HN, Latent Space, and Simon into a current-window story without creating a change notification", async () => {
  const paths = await tempPaths();
  const now = new Date("2026-07-17T10:00:00Z");
  const officialUrl = "https://www.kimi.com/blog/kimi-k3";
  const officialIdentity = normalizedEventIdentity({
    title: "Kimi K3",
    canonical_url: officialUrl,
  });
  const latentIdentity = normalizedEventIdentity({
    title: "[AINews] Kimi K3 release",
    canonical_url: "https://www.latent.space/p/kimi-k3",
    artifact_links: [officialUrl],
  });
  const simonIdentity = normalizedEventIdentity({
    title: "Kimi K3",
    canonical_url: "https://simonwillison.net/2026/Jul/16/kimi-k3/",
    artifact_links: [
      "https://huggingface.co/deepseek-ai/deepseek-v4-pro",
      officialUrl,
    ],
  });
  assert.equal(officialIdentity.key, latentIdentity.key);
  assert.equal(officialIdentity.key, simonIdentity.key);
  assert.equal(officialIdentity.basis, "canonical-official-announcement");
  assert.equal(simonIdentity.basis, "artifact-official-announcement");
  assert.match(simonIdentity.fingerprint, /^official-announcement:kimi\.com\/blog\/kimi-k3$/);
  const unrelatedOfficialLink = normalizedEventIdentity({
    title: "DeepSeek V4 Pro model release",
    canonical_url: "https://media.example/deepseek-v4",
    artifact_links: [
      officialUrl,
      "https://huggingface.co/deepseek-ai/deepseek-v4-pro",
    ],
  });
  assert.equal(unrelatedOfficialLink.basis, "primary-artifact-link");
  assert.equal(unrelatedOfficialLink.fingerprint, "huggingface:deepseek-ai/deepseek-v4-pro");

  const sources = [
    cloneSource("hacker-news-topstories", { limits: { max_items: 1, request_budget: 2, max_bytes: 20_000 } }),
    cloneSource("latent-space-existing-snapshot"),
    cloneSource("simon-willison-existing-snapshot"),
  ];
  const hnItem = {
    id: 442001,
    type: "story",
    time: Date.parse("2026-07-16T14:46:05Z") / 1000,
    score: 1691,
    descendants: 992,
    title: "Kimi K3: new 2.8T MoE model",
    url: officialUrl,
  };
  const latentFeed = `<rss><channel><item><title>[AINews] Kimi K3: new 2.8T MoE model</title><link>https://www.latent.space/p/kimi-k3</link><pubDate>Fri, 17 Jul 2026 01:46:36 GMT</pubDate><description><![CDATA[Official Kimi K3 announcement: <a href="${officialUrl}">primary source</a>]]></description></item></channel></rss>`;
  const simonFeed = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Kimi K3 is a new MoE model with an agent harness caveat</title><link href="https://simonwillison.net/2026/Jul/16/kimi-k3/"/><updated>2026-07-16T20:19:30Z</updated><content type="html"><![CDATA[Unrelated <a href="https://huggingface.co/deepseek-ai/deepseek-v4-pro">model</a>; official <a href="${officialUrl}">Kimi K3 announcement</a>.]]></content></entry></feed>`;
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith("topstories.json")) return response(JSON.stringify([hnItem.id]));
    if (value.includes("hacker-news.firebaseio.com/v0/item/")) return response(JSON.stringify(hnItem));
    if (value.includes("latent.space")) return response(latentFeed);
    if (value.includes("simonwillison.net")) return response(simonFeed);
    throw new Error(`unexpected URL: ${value}`);
  };

  const first = await runTechDiscoveryProbe({
    sources,
    ...paths,
    fetchImpl,
    now,
  });
  assert.deepEqual(first.human_review_queue, []);
  assert.equal(first.metrics.daily_current_window_candidates, 3);
  assert.equal(first.metrics.daily_current_window_story_groups, 1);
  assert.equal(first.daily_current_window_review.length, 1);
  const story = first.daily_current_window_review[0];
  assert.equal(story.canonical_story_key, officialIdentity.key);
  assert.equal(story.canonical_url, officialUrl);
  assert.equal(story.independent_attention_groups, 3);
  assert.deepEqual(story.independence_groups, ["hacker-news", "latent-space", "simon-willison"]);
  assert.equal(story.change_candidate, false);
  assert.equal(story.onboarding_observed, true);
  assert.equal(story.primary_verified, false);
  assert.equal(story.claim_evidence_allowed, false);
  assert.equal(story.notification_eligible, false);
  assert.deepEqual(first.notification_policy.records, []);
  assert.deepEqual(first.external_actions, []);
  assert.deepEqual(verifyTechDiscoveryProbe(first, sources), { ok: true, errors: [] });

  const unchanged = await runTechDiscoveryProbe({
    sources,
    ...paths,
    fetchImpl,
    now: new Date("2026-07-17T10:10:00Z"),
  });
  assert.deepEqual(unchanged.human_review_queue, []);
  assert.equal(unchanged.daily_current_window_review.length, 1);
  assert.equal(unchanged.daily_current_window_review[0].change_candidate, false);
  assert.equal(unchanged.daily_current_window_review[0].onboarding_observed, false);
  assert.deepEqual(verifyTechDiscoveryProbe(unchanged, sources), { ok: true, errors: [] });

  const staleEvents = structuredClone(unchanged.source_events);
  staleEvents.forEach((event) => { event.fresh_for_change_detection = false; });
  assert.deepEqual(selectDailyCurrentWindowReview(staleEvents), []);
});

test("transient failures retry with audited exponential backoff, while permanent HTTP failures do not retry", async () => {
  const paths = await tempPaths();
  const source = cloneSource("venturebeat-ai-feed", {
    limits: { max_items: 5, max_bytes: 20_000, request_budget: 3 },
  });
  const feed = `<rss><channel><item><title>New open AI model released</title><link>https://decoder.example/model</link><pubDate>Fri, 17 Jul 2026 09:00:00 GMT</pubDate></item></channel></rss>`;
  const statuses = [503, 429, 200];
  const signals = [];
  const delays = [];
  const audit = await runTechDiscoveryProbe({
    sources: [source],
    ...paths,
    fetchImpl: async (_url, init) => {
      signals.push(init.signal);
      const status = statuses.shift();
      return status === 200 ? response(feed) : response("temporary", { status });
    },
    now: new Date("2026-07-17T10:00:00Z"),
    maxRetries: 2,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 100,
    retryJitterRatio: 0.4,
    randomImpl: () => 0.5,
    sleepImpl: async (delayMs) => { delays.push(delayMs); },
  });
  const event = audit.source_events[0];
  assert.equal(event.requests_made, 3);
  assert.equal(event.retries_made, 2);
  assert.deepEqual(event.retry_delays_ms, [10, 20]);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(event.transient_errors.length, 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  assert.ok(signals.every((signal) => signal.aborted === false));

  const permanentPaths = await tempPaths();
  let permanentAttempts = 0;
  const permanent = await runTechDiscoveryProbe({
    sources: [source],
    ...permanentPaths,
    fetchImpl: async () => {
      permanentAttempts += 1;
      return response("missing", { status: 404 });
    },
    now: new Date("2026-07-17T10:00:00Z"),
    maxRetries: 2,
    sleepImpl: async () => assert.fail("404 must not enter retry backoff"),
  });
  assert.equal(permanentAttempts, 1);
  assert.equal(permanent.source_events[0].requests_made, 1);
  assert.equal(permanent.source_events[0].retries_made, 0);
  assert.equal(permanent.source_events[0].status, "failed");
});

test("request, source, and whole-run deadlines bound fetches that never settle", async () => {
  const paths = await tempPaths();
  const firstSource = cloneSource("venturebeat-ai-feed", {
    limits: { max_items: 5, max_bytes: 20_000, request_budget: 2 },
  });
  const secondSource = cloneSource("techmeme-feed", {
    limits: { max_items: 5, max_bytes: 20_000, request_budget: 2 },
  });
  const signals = [];
  const startedAt = Date.now();
  const audit = await runTechDiscoveryProbe({
    sources: [firstSource, secondSource],
    ...paths,
    fetchImpl: async (_url, init) => {
      signals.push(init.signal);
      return new Promise(() => {});
    },
    now: new Date("2026-07-17T10:00:00Z"),
    requestTimeoutMs: 1_000,
    sourceTimeoutMs: 1_000,
    runTimeoutMs: 25,
    maxRetries: 1,
    retryBaseDelayMs: 0,
  });
  assert.ok(Date.now() - startedAt < 500, "the full probe must return before an ignored fetch promise");
  assert.equal(audit.source_events.length, 2);
  assert.ok(audit.source_events.every((event) => !event.fresh_for_change_detection));
  assert.ok(audit.source_events.every((event) => ["source-timeout", "run-timeout"].includes(event.status)));
  assert.ok(signals.length >= 1 && signals.length <= 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal && signal.aborted));
});

test("atomic writes preserve the previous valid file on rename failure and state/output same-path writes once", async () => {
  const paths = await tempPaths();
  const target = join(paths.root, "atomic.json");
  await writeFile(target, "{\"old\":true}\n");
  await assert.rejects(
    atomicWriteFile(target, "{\"new\":true}\n", {
      suffix: "forced-failure",
      renameImpl: async () => { throw new Error("forced-rename-failure"); },
    }),
    /forced-rename-failure/,
  );
  assert.equal(await readFile(target, "utf8"), "{\"old\":true}\n");
  assert.ok(!(await readdir(paths.root)).some((name) => name.includes("forced-failure")));

  const source = cloneSource("venturebeat-ai-feed", { limits: { max_items: 2, max_bytes: 20_000 } });
  const feed = `<rss><channel><item><title>New open AI model released</title><link>https://decoder.example/model</link><pubDate>Fri, 17 Jul 2026 09:00:00 GMT</pubDate></item></channel></rss>`;
  const writtenPaths = [];
  await runTechDiscoveryProbe({
    sources: [source],
    ...paths,
    fetchImpl: async () => response(feed),
    now: new Date("2026-07-17T10:00:00Z"),
    atomicWriteImpl: async (path, content) => {
      writtenPaths.push(path);
      await atomicWriteFile(path, content);
    },
  });
  assert.equal(writtenPaths.filter((path) => path === resolve(paths.outputPath)).length, 1);
  const savedAudit = await readFile(paths.outputPath, "utf8");
  assert.doesNotThrow(() => JSON.parse(savedAudit));
});

test("TTL cache fallback remains explicitly stale, creates no candidates, and expires closed", async () => {
  const paths = await tempPaths();
  const source = cloneSource("venturebeat-ai-feed", { limits: { max_items: 5, max_bytes: 20_000 } });
  const feed = `<rss><channel><item><title>New open AI model released</title><link>https://decoder.example/model</link><pubDate>Fri, 17 Jul 2026 09:00:00 GMT</pubDate></item></channel></rss>`;
  await runTechDiscoveryProbe({
    sources: [source],
    ...paths,
    fetchImpl: async () => response(feed),
    now: new Date("2026-07-17T09:30:00Z"),
    cacheTtlMs: 2 * 3_600_000,
  });
  const fallback = await runTechDiscoveryProbe({
    sources: [source],
    ...paths,
    fetchImpl: async () => { throw new Error("offline"); },
    now: new Date("2026-07-17T10:30:00Z"),
    cacheTtlMs: 2 * 3_600_000,
  });
  const event = fallback.source_events[0];
  assert.equal(event.status, "stale-cache");
  assert.equal(event.network_fresh, false);
  assert.equal(event.fresh_for_change_detection, false);
  assert.equal(event.cache_age_hours, 1);
  assert.equal(event.new_items, 0);
  assert.deepEqual(fallback.human_review_queue, []);
  assert.deepEqual(verifyTechDiscoveryProbe(fallback, [source]), { ok: true, errors: [] });

  const expired = await runTechDiscoveryProbe({
    sources: [source],
    ...paths,
    fetchImpl: async () => { throw new Error("still-offline"); },
    now: new Date("2026-07-17T12:00:01Z"),
    cacheTtlMs: 2 * 3_600_000,
  });
  assert.equal(expired.source_events[0].status, "failed");
  assert.equal(expired.source_events[0].items_parsed, 0);
  assert.equal(expired.metrics.selected_for_human_review, 0);
  assert.ok((await readFile(paths.reviewPath, "utf8")).includes("stale-cache"));
});

test("the verifier fails closed on notifications, duplicate independence groups, or missing primary verification", async () => {
  const paths = await tempPaths();
  const source = cloneSource("github-trending-daily");
  const audit = await runTechDiscoveryProbe({
    sources: [source],
    ...paths,
    fetchImpl: async () => response(`<article class="Box-row"><h2><a href="/base/ai-model">base/ai-model</a></h2><p>New LLM model</p></article>`),
    now: new Date("2026-07-17T10:00:00Z"),
  });
  const mutated = structuredClone(audit);
  mutated.notification_policy.enabled = true;
  mutated.external_actions.push("publish");
  mutated.source_events[0].items[0].primary_verification_required = false;
  const result = verifyTechDiscoveryProbe(mutated, [source]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("notification policy")));
  assert.ok(result.errors.some((error) => error.includes("external actions")));
  assert.ok(result.errors.some((error) => error.includes("mandatory primary verification")));
});
