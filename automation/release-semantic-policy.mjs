const RELEASE_SEMANTIC_PATTERNS = Object.freeze({
  "context-session-memory": [
    /\b(context (?:management|window|policy)|session(?:s| lifecycle| state)?|memory|compaction|conversation history|checkpoint(?:ing)?)\b/i,
  ],
  "tools-sandbox-permissions": [
    /\b(tool(?:s| call| calling| interface)?|mcp|model context protocol|sandbox|permission|approval|computer use|handoff)\b/i,
  ],
  "reliability-orchestration": [
    /\b(retr(?:y|ies)|resume|resumable|recovery|background task|concurren(?:cy|t)|parallel(?:ism| attempts?)|subagent|multi[- ]agent|fault toleran(?:ce|t))\b/i,
  ],
  "observability-safety-cost": [
    /\b(tracing|trace export|telemetry|token usage|cost tracking|guardrail|safety|security|timeout|rate limit)\b/i,
  ],
  "evaluation-semantics": [
    /\b(evaluator|grader|scorer|scoring|task version|dataset version|benchmark config|evaluation config|metric|contamination|reward hacking|answer extraction|pass criteria)\b/i,
  ],
  "protocol-runtime-contract": [
    /\b(protocol|runtime|breaking change|schema|serialization|streaming|event model|lifecycle hook)\b/i,
  ],
});

function clean(value, limit = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * Deterministic prioritization only. A match means the bounded official release
 * excerpt contains a Harness/Eval semantic-review cue; it is not a capability,
 * safety, or score-comparability claim.
 */
export function analyzeReleaseSemanticDelta(value) {
  const text = clean(value);
  const matchedCategories = Object.entries(RELEASE_SEMANTIC_PATTERNS)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(text)))
    .map(([category]) => category);
  return {
    review_basis: "bounded-official-release-text-lexical-prioritization-only",
    excerpt_chars: text.length,
    has_semantic_delta_cue: matchedCategories.length > 0,
    matched_categories: matchedCategories,
    human_semantic_review_required: true,
    capability_uplift_proven: false,
    score_comparability_proven: false,
  };
}
