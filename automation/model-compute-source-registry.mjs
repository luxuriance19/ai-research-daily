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
  lane,
  role,
  authorityTier,
  independenceGroup,
  maxBytes,
  maxItems,
  requestBudget = 1,
  admission,
  identityBinding = "not-applicable",
  identityBindingEvidence = null,
  limitations,
}) => ({
  id,
  label,
  endpoint,
  canonical_url: canonicalUrl,
  format,
  lane,
  role,
  authority_tier: authorityTier,
  independence_group: independenceGroup,
  limits: {
    max_bytes: maxBytes,
    max_items: maxItems,
    request_budget: requestBudget,
  },
  admission,
  identity_binding: identityBinding,
  identity_binding_evidence: identityBindingEvidence,
  limitations,
  authentication: "public",
  fetch_mode: "isolated-network-shadow",
  onboarding_baseline_required: true,
  production_write_allowed: false,
  claim_evidence_allowed: false,
  can_raise_evidence_grade: false,
  can_change_availability_state: false,
  can_trigger_notification: false,
});

export const hfOrganizationIdentityBindings = deepFreeze({
  moonshotai: {
    namespace: "moonshotai",
    status: "primary-source-verified-pending-human-signoff",
    official_source_url: "https://www.kimi.com/blog/kimi-k2",
    official_source_title: "Kimi K2: Open Agentic Intelligence",
    direct_hf_target_url: "https://huggingface.co/moonshotai/Kimi-K2-Instruct-0905",
    extracted_markdown_sha256: "4a759eddaaeccc181b5547ea4b2d878e6fa06cf0f310d556cb87e487b32a6701",
    extracted_with: "defuddle parse --markdown",
    observed_at: "2026-07-18",
    human_signoff: null,
  },
  qwen: {
    namespace: "Qwen",
    status: "primary-source-verified-pending-human-signoff",
    official_source_url: "https://qwenlm.github.io/resources/",
    official_source_title: "Resources",
    direct_hf_target_url: "https://huggingface.co/Qwen",
    extracted_markdown_sha256: "d540bc4715eba88d7440fefa9018b8b209251a0a956364e0042991f9c411dd01",
    extracted_with: "defuddle parse --markdown",
    observed_at: "2026-07-18",
    human_signoff: null,
  },
  mistralai: {
    namespace: "mistralai",
    status: "primary-source-verified-pending-human-signoff",
    official_source_url: "https://mistral.ai/news/magistral/",
    official_source_title: "Magistral",
    direct_hf_target_url: "https://huggingface.co/mistralai/Magistral-Small-2506",
    extracted_markdown_sha256: "a8e9070505a26952c467ebc7339333e8f91a00137b585d2b709735120d3d33b9",
    extracted_with: "defuddle parse --markdown",
    observed_at: "2026-07-18",
    human_signoff: null,
  },
  "deepseek-ai": {
    namespace: "deepseek-ai",
    status: "primary-source-verified-pending-human-signoff",
    official_source_url: "https://api-docs.deepseek.com/zh-cn/news/news260424",
    official_source_title: "DeepSeek-V4 预览版：迈入百万上下文普惠时代",
    direct_hf_target_url: "https://huggingface.co/collections/deepseek-ai/deepseek-v4",
    extracted_markdown_sha256: "b96eddbaf4296eaa72168c10f71c006a8c34ec53afcc190ae6f35d529dd909a2",
    extracted_with: "defuddle parse --markdown",
    observed_at: "2026-07-18",
    human_signoff: null,
  },
  thinkingmachines: {
    namespace: "thinkingmachines",
    status: "primary-source-verified-pending-human-signoff",
    official_source_url: "https://thinkingmachines.ai/news/introducing-inkling/",
    official_source_title: "Inkling: Our open-weights model",
    direct_hf_target_url: "https://huggingface.co/thinkingmachines/inkling",
    extracted_markdown_sha256: "84cf73cff9aa62911085d70ac9329b86099f43ea8cef731f8d30ac40dadb761e",
    extracted_with: "defuddle parse --markdown",
    observed_at: "2026-07-18",
    human_signoff: null,
  },
});

const hfOrganization = (organization) => {
  const binding = hfOrganizationIdentityBindings[organization.toLowerCase()];
  if (!binding) throw new Error(`missing-HF-organization-binding: ${organization}`);
  return source({
  id: `hf-org-${organization.toLowerCase()}`,
  label: `Hugging Face official-organization candidate: ${organization}`,
  endpoint: `https://huggingface.co/api/models?author=${encodeURIComponent(organization)}&sort=createdAt&direction=-1&limit=5`,
  canonicalUrl: `https://huggingface.co/${organization}`,
  format: "huggingface-model-list-json",
  lane: "new-model",
  role: "official-organization-artifact-discovery",
  authorityTier: "T4",
  independenceGroup: `hf-${organization.toLowerCase()}`,
  maxBytes: 100_000,
  maxItems: 5,
  admission: {
    status: "shadow-admitted",
    reviewed_at: "2026-07-18",
    robots_url: "https://huggingface.co/robots.txt",
    robots_decision: "allow-public-api",
  },
  identityBinding: binding.status,
  identityBindingEvidence: binding,
  limitations: [
    "namespace-name-alone-does-not-prove-official-ownership",
    "adapter-quantization-tokenizer-and-ordinary-finetune-must-be-excluded",
    "repository-creation-does-not-prove-a-frontier-model-release",
  ],
  });
};

const githubRelease = ({ id, label, repo, independenceGroup }) => source({
  id,
  label,
  endpoint: `https://api.github.com/repos/${repo}/releases?per_page=3&page=1`,
  canonicalUrl: `https://github.com/${repo}/releases`,
  format: "github-rest-releases-json",
  lane: "compute-system",
  role: "official-version-discovery",
  authorityTier: "T4",
  independenceGroup,
  maxBytes: 500_000,
  maxItems: 3,
  admission: {
    status: "shadow-admitted",
    reviewed_at: "2026-07-18",
    robots_url: "https://github.com/robots.txt",
    robots_decision: "use-official-rest-api-not-atom",
  },
  limitations: [
    "release-occurrence-does-not-prove-a-technical-delta",
    "ordinary-patch-compatibility-and-dependency-releases-must-be-excluded",
    "shared-anonymous-api-budget-requires-etag-and-rate-limit-stop",
  ],
});

export const MODEL_COMPUTE_SHADOW_POLICY = deepFreeze({
  schema_version: 1,
  mode: "shadow-model-compute-source-admission",
  collector_groups: ["model-release", "compute-system"],
  daily_endpoint_count: 16,
  max_total_requests_per_run: 16,
  github_rest_request_budget: 4,
  github_rate_limit_stop_remaining: 10,
  conditional_requests_required_after_baseline: true,
  atomic_state_commit_required: true,
  source_failures_are_isolated: true,
  changes_production_registry: false,
  writes_production_state: false,
  affects_existing_source_health: false,
  claim_evidence_allowed: false,
  availability_promotion_allowed: false,
  notification_eligible: false,
  external_actions: [],
  forbidden_endpoint_patterns: ["releases.atom", "*.atom"],
});

export const modelComputeShadowSources = deepFreeze([
  source({
    id: "kimi-research-index",
    label: "Kimi Research index",
    endpoint: "https://www.kimi.com/en/blog/",
    canonicalUrl: "https://www.kimi.com/en/blog/",
    format: "bounded-html-index",
    lane: "new-model",
    role: "official-announcement-discovery",
    authorityTier: "T3",
    independenceGroup: "moonshot-ai",
    maxBytes: 250_000,
    maxItems: 30,
    admission: {
      status: "shadow-admitted",
      reviewed_at: "2026-07-18",
      robots_url: "https://www.kimi.com/robots.txt",
      robots_decision: "blog-allowed-api-disallowed",
    },
    identityBinding: "official-domain-index-reviewed",
    limitations: [
      "content-hash-required-because-no-etag-or-last-modified-was-observed",
      "announcement-proves-author-claim-not-open-weights-or-performance",
    ],
  }),
  source({
    id: "thinking-machines-sitemap",
    label: "Thinking Machines official sitemap",
    endpoint: "https://thinkingmachines.ai/sitemap.xml",
    canonicalUrl: "https://thinkingmachines.ai/news/",
    format: "sitemap-xml",
    lane: "new-model",
    role: "official-announcement-discovery",
    authorityTier: "T3",
    independenceGroup: "thinking-machines",
    maxBytes: 100_000,
    maxItems: 50,
    admission: {
      status: "shadow-admitted",
      reviewed_at: "2026-07-18",
      robots_url: "https://thinkingmachines.ai/robots.txt",
      robots_decision: "no-applicable-disallow-observed",
    },
    identityBinding: "official-domain-index-reviewed",
    limitations: [
      "sitemap-lastmod-is-not-a-publication-date",
      "availability-must-be-checked-against-model-card-weights-and-license",
    ],
  }),
  source({
    id: "mistral-news-index",
    label: "Mistral official news index",
    endpoint: "https://mistral.ai/news/",
    canonicalUrl: "https://mistral.ai/news/",
    format: "bounded-html-index",
    lane: "new-model",
    role: "supplemental-official-announcement-discovery",
    authorityTier: "T3",
    independenceGroup: "mistral-ai",
    maxBytes: 900_000,
    maxItems: 30,
    admission: {
      status: "supplemental-shadow",
      reviewed_at: "2026-07-18",
      robots_url: "https://mistral.ai/robots.txt",
      robots_decision: "allow-public-news-index",
    },
    identityBinding: "official-domain-index-reviewed",
    limitations: [
      "large-index-without-observed-etag-or-last-modified",
      "must-not-become-a-single-point-of-failure",
    ],
  }),
  hfOrganization("moonshotai"),
  hfOrganization("Qwen"),
  hfOrganization("mistralai"),
  hfOrganization("deepseek-ai"),
  hfOrganization("thinkingmachines"),
  source({
    id: "hf-models-trending-fallback",
    label: "Hugging Face trending models fallback",
    endpoint: "https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=50",
    canonicalUrl: "https://huggingface.co/models?sort=trending",
    format: "huggingface-model-list-json",
    lane: "new-model",
    role: "attention-fallback-only",
    authorityTier: "T1",
    independenceGroup: "hugging-face-trending",
    maxBytes: 500_000,
    maxItems: 50,
    admission: {
      status: "shadow-admitted",
      reviewed_at: "2026-07-18",
      robots_url: "https://huggingface.co/robots.txt",
      robots_decision: "allow-public-api",
    },
    limitations: [
      "attention-cannot-upgrade-authority-or-availability",
      "quantizations-adapters-and-derivatives-are-common",
    ],
  }),
  source({
    id: "nvidia-developer-blog-atom",
    label: "NVIDIA Technical Blog feed",
    endpoint: "https://developer.nvidia.com/blog/feed/",
    canonicalUrl: "https://developer.nvidia.com/blog/",
    format: "rss-or-atom",
    lane: "compute-system",
    role: "official-technical-discovery",
    authorityTier: "T3",
    independenceGroup: "nvidia",
    maxBytes: 1_000_000,
    maxItems: 30,
    admission: {
      status: "shadow-admitted",
      reviewed_at: "2026-07-18",
      robots_url: "https://developer.nvidia.com/robots.txt",
      robots_decision: "allow-with-ai-input-content-signal",
    },
    limitations: [
      "vendor-article-proves-vendor-claim-not-independent-performance",
      "article-date-cannot-replace-the-underlying-product-event-date",
    ],
  }),
  source({
    id: "nvidia-newsroom-press-xml",
    label: "NVIDIA Newsroom press releases",
    endpoint: "https://nvidianews.nvidia.com/cats/press_release.xml",
    canonicalUrl: "https://nvidianews.nvidia.com/",
    format: "rss-or-atom",
    lane: "compute-system",
    role: "official-product-announcement-discovery",
    authorityTier: "T3",
    independenceGroup: "nvidia",
    maxBytes: 500_000,
    maxItems: 30,
    admission: {
      status: "shadow-admitted",
      reviewed_at: "2026-07-18",
      robots_url: "https://nvidianews.nvidia.com/robots.txt",
      robots_decision: "press-feed-allowed-file-path-disallowed",
    },
    limitations: [
      "filter-to-chip-interconnect-memory-rack-and-ai-systems",
      "exclude-partnership-financing-and-general-market-announcements",
    ],
  }),
  source({
    id: "rocm-release-history",
    label: "ROCm official release history",
    endpoint: "https://rocm.docs.amd.com/en/latest/release/versions.html",
    canonicalUrl: "https://rocm.docs.amd.com/en/latest/release/versions.html",
    format: "bounded-html-release-index",
    lane: "compute-system",
    role: "official-version-discovery",
    authorityTier: "T3",
    independenceGroup: "amd-rocm",
    maxBytes: 750_000,
    maxItems: 30,
    admission: {
      status: "shadow-admitted",
      reviewed_at: "2026-07-18",
      robots_url: "https://rocm.docs.amd.com/robots.txt",
      robots_decision: "public-release-history-allowed-hidden-previews-disallowed",
    },
    limitations: [
      "release-history-proves-version-identity-not-a-performance-claim",
      "technical-delta-requires-version-specific-release-notes",
    ],
  }),
  githubRelease({ id: "vllm-rest-releases", label: "vLLM GitHub releases", repo: "vllm-project/vllm", independenceGroup: "vllm" }),
  githubRelease({ id: "sglang-rest-releases", label: "SGLang GitHub releases", repo: "sgl-project/sglang", independenceGroup: "sglang" }),
  githubRelease({ id: "tensorrt-llm-rest-releases", label: "TensorRT-LLM GitHub releases", repo: "NVIDIA/TensorRT-LLM", independenceGroup: "nvidia" }),
  githubRelease({ id: "cutlass-rest-releases", label: "CUTLASS GitHub releases", repo: "NVIDIA/cutlass", independenceGroup: "nvidia" }),
]);

export function getModelComputeShadowSource(sourceId) {
  return modelComputeShadowSources.find((item) => item.id === sourceId) || null;
}

export function validateModelComputeShadowRegistry(sources = modelComputeShadowSources) {
  const errors = [];
  const ids = new Set();
  for (const item of sources) {
    if (!item?.id || ids.has(item.id)) errors.push(`duplicate-or-missing-source-id: ${item?.id || "<missing>"}`);
    ids.add(item?.id);
    let endpoint;
    try {
      endpoint = new URL(item?.endpoint || "");
    } catch {
      errors.push(`invalid-endpoint: ${item?.id}`);
    }
    if (endpoint?.protocol !== "https:") errors.push(`non-public-https-endpoint: ${item?.id}`);
    if (/releases\.atom(?:$|\?)/i.test(item?.endpoint || "")) errors.push(`forbidden-github-atom-endpoint: ${item?.id}`);
    if (!new Set(["new-model", "compute-system"]).has(item?.lane)) errors.push(`invalid-lane: ${item?.id}`);
    if (item?.authentication !== "public") errors.push(`credential-dependency: ${item?.id}`);
    if (!(item?.limits?.max_bytes > 0 && item.limits.max_bytes <= 1_000_000)) errors.push(`unbounded-response: ${item?.id}`);
    if (!(item?.limits?.max_items > 0 && item.limits.max_items <= 50)) errors.push(`unbounded-item-count: ${item?.id}`);
    if (item?.limits?.request_budget !== 1) errors.push(`invalid-request-budget: ${item?.id}`);
    if (!item?.admission?.status || !item?.admission?.reviewed_at || !item?.admission?.robots_url) errors.push(`incomplete-admission-record: ${item?.id}`);
    if (item?.role === "official-organization-artifact-discovery") {
      const evidence = item?.identity_binding_evidence;
      if (item?.identity_binding !== "primary-source-verified-pending-human-signoff") errors.push(`HF-organization-binding-status-invalid: ${item?.id}`);
      if (!evidence || evidence.status !== item.identity_binding || evidence.human_signoff !== null) errors.push(`HF-organization-binding-evidence-invalid: ${item?.id}`);
      let officialSource;
      let hfTarget;
      try { officialSource = new URL(evidence?.official_source_url || ""); } catch {}
      try { hfTarget = new URL(evidence?.direct_hf_target_url || ""); } catch {}
      if (officialSource?.protocol !== "https:" || officialSource?.hostname === "huggingface.co") errors.push(`HF-organization-official-source-invalid: ${item?.id}`);
      const namespacePattern = new RegExp(`^/(?:collections/)?${String(evidence?.namespace || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`, "i");
      if (hfTarget?.protocol !== "https:" || hfTarget?.hostname !== "huggingface.co" || !namespacePattern.test(hfTarget.pathname)) errors.push(`HF-organization-target-namespace-mismatch: ${item?.id}`);
      if (!/^[a-f0-9]{64}$/.test(String(evidence?.extracted_markdown_sha256 || "")) || evidence?.extracted_with !== "defuddle parse --markdown" || !/^\d{4}-\d{2}-\d{2}$/.test(String(evidence?.observed_at || ""))) errors.push(`HF-organization-snapshot-invalid: ${item?.id}`);
    }
    for (const field of [
      "production_write_allowed",
      "claim_evidence_allowed",
      "can_raise_evidence_grade",
      "can_change_availability_state",
      "can_trigger_notification",
    ]) {
      if (item?.[field] !== false) errors.push(`${field}-boundary-violated: ${item?.id}`);
    }
    if (item?.onboarding_baseline_required !== true) errors.push(`onboarding-baseline-not-required: ${item?.id}`);
  }
  if (sources.length !== MODEL_COMPUTE_SHADOW_POLICY.daily_endpoint_count) errors.push(`unexpected-source-count: ${sources.length}`);
  if (sources.filter((item) => item.lane === "new-model").length !== 9) errors.push("new-model-source-count-must-be-9");
  if (sources.filter((item) => item.lane === "compute-system").length !== 7) errors.push("compute-system-source-count-must-be-7");
  return { ok: errors.length === 0, errors };
}
