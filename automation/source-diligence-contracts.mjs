const source = (
  ref,
  label,
  authorityTier,
  independenceGroup,
  claimScope,
  proves,
  doesNotProve,
  {
    polarity = "supporting",
    resultIndependenceGroup = independenceGroup,
    artifactOwner = independenceGroup,
    paperCodeMatch = "not-assessed",
    manualRiskFlags = [],
  } = {},
) => ({
  ref,
  label,
  authority_tier: authorityTier,
  independence_group: independenceGroup,
  result_independence_group: resultIndependenceGroup,
  artifact_owner: artifactOwner,
  evidence_polarity: polarity,
  paper_code_match: paperCodeMatch,
  manual_risk_flags: manualRiskFlags,
  claim_scope: claimScope,
  proves,
  does_not_prove: doesNotProve,
});

export const diligenceSourceProfiles = Object.freeze([
  source("production:openai-model-spec", "OpenAI Model Spec commit stream", "T4", "openai", "official-version-occurrence", "An official Model Spec repository commit occurred.", "That content or intended policy changed; repository commits can explicitly contain no content update."),
  source("production:openai-model-spec-text", "OpenAI Model Spec canonical text", "T4", "openai", "official-policy-text", "The current official intended-behavior text and exact content hash exist.", "Production-model compliance, training causality, or learned circuits."),
  source("candidate:openai-model-spec-tree", "OpenAI Model Spec repository version index", "T4", "openai", "official-version-index", "Required canonical/release files and dated public HTML versions exist at an exact repository tree identity.", "Which textual change is semantically material or implemented by a model."),
  source("candidate:openai-model-spec-changelog", "OpenAI Model Spec changelog", "T4", "openai", "official-release-semantics", "Official release notes and their exact blob identity exist.", "That every commit changes policy or that deployed models fully reflect the release."),
  source("candidate:openai-model-spec-version-manifest", "OpenAI Model Spec public version manifest", "T4", "openai", "official-public-version-pointer", "The current public version date and exact manifest blob exist.", "Semantic materiality, model compliance, or an independent confirmation; the dated public page currently exposes a newer-version banner that is not reconciled by the manifest or repository.", { manualRiskFlags: ["public-page-newer-version-banner-conflicts-with-manifest"] }),

  source("production:anthropic-constitution", "Claude Constitution commit stream", "T4", "anthropic", "official-version-occurrence", "An official repository commit occurred.", "That the textual change is semantically material or implemented in model weights."),
  source("production:anthropic-constitution-text", "Claude Constitution canonical text", "T4", "anthropic", "official-policy-text", "The current official intended-behavior text and its exact content hash.", "Learned circuits, compliance rate, or causal training effect."),
  source("candidate:claude-constitution-tree", "Claude Constitution repository tree", "T4", "anthropic", "official-version-index", "A new dated Constitution file exists even if the old raw path is unchanged.", "Which file is canonical or whether its policy meaning changed."),
  source("candidate:claude-constitution-readme", "Claude Constitution declared current-version pointer", "T4", "anthropic", "official-public-version-pointer", "The repository README declares the current Constitution month at an exact blob identity.", "That a dated file is canonical when the pointer does not name it, or that the policy meaning changed."),
  source("candidate:model-spec-midtraining-arxiv#2605.02087", "Model Spec Midtraining paper version", "T3", "model-spec-midtraining-authors", "authored-controlled-training-study", "The authors report controlled open-model experiments in which spec-conditioned midtraining changes out-of-distribution alignment behavior.", "That Anthropic uses this exact recipe for Claude, that Claude weights implement a Constitution, or an independently reproduced causal effect."),
  source("candidate:model-spec-midtraining-commits", "Model Spec Midtraining paper-linked code", "T4", "model-spec-midtraining-authors", "paper-linked-training-code", "The paper-linked repository and immutable commit stream expose training, data-generation, spec, and evaluation code paths.", "A licensed turnkey reproduction, raw run logs, or independence from the paper authors; the repository has no detected license."),
  source("candidate:model-spec-midtraining-model", "Model Spec Midtraining Qwen3-32B adapter", "T4", "model-spec-midtraining-authors", "paper-linked-model-artifact", "A public, ungated MIT-tagged adapter revision and required adapter files exist.", "The paper's full multi-seed result, a base-model redistribution right, or a Claude checkpoint."),
  source("candidate:model-spec-midtraining-dataset", "Model Spec Midtraining philosophy-spec dataset", "T4", "model-spec-midtraining-authors", "paper-linked-training-data", "A public, ungated MIT-tagged synthetic midtraining dataset revision exists.", "All generation inputs, judge behavior, evaluation transcripts, or an independent reproduction."),

  source("candidate:latent-reasoning-arxiv-seeds#2510.25741", "Ouro paper version", "T3", "ouro-authors", "authored-research-claim", "The authors' current architecture, method, experiments, and limitations.", "Independent causal validity or production behavior; the paper explicitly substitutes observational proxies because it cannot intervene on the latent process.", { manualRiskFlags: ["observational-faithfulness-proxy-only"] }),
  source("production:ouro-model", "ByteDance Ouro model artifact", "T4", "bytedance-seed", "official-artifact", "An official model revision, configuration, model card, released weights, and post-loop state-selection code exist.", "Training-code completeness, adaptive recurrent-forward short-circuiting, measured FLOP/latency savings, or general causal claims about recurrence; the 2.6B card conflicts with its config and the paper, and the referenced LICENSE file is absent.", { resultIndependenceGroup: "ouro-authors", artifactOwner: "bytedance-seed", manualRiskFlags: ["released-code-runs-all-recurrent-loops-before-state-selection", "official-model-card-config-paper-conflict", "license-file-missing-despite-license-metadata", "observational-faithfulness-proxy-only"] }),
  source("candidate:ouro-family-1-4b-model", "ByteDance Ouro 1.4B model artifact", "T4", "bytedance-seed", "official-family-artifact", "A public, ungated 1.4B base-model revision and required inference files exist.", "The 7.7T-token training run, training code, recurrence causality, or a repository-level license artifact; metadata says Apache-2.0 but the referenced LICENSE file is absent.", { resultIndependenceGroup: "ouro-authors", artifactOwner: "bytedance-seed", manualRiskFlags: ["license-file-missing-despite-license-metadata"] }),
  source("candidate:ouro-family-1-4b-thinking-model", "ByteDance Ouro 1.4B Thinking artifact", "T4", "bytedance-seed", "official-family-artifact", "A public, ungated 1.4B Thinking revision and required inference files exist.", "A scientifically independent result, general reasoning gain, or a repository-level license artifact; metadata says Apache-2.0 but the referenced LICENSE file is absent.", { resultIndependenceGroup: "ouro-authors", artifactOwner: "bytedance-seed", manualRiskFlags: ["license-file-missing-despite-license-metadata"] }),
  source("candidate:ouro-family-2-6b-model", "ByteDance Ouro 2.6B uniform family artifact", "T4", "bytedance-seed", "official-family-artifact", "A public, ungated 2.6B base-model revision and the declared inference files exist.", "Independent validation or a complete training stack; the model card says 24 layers and 2.6T CT annealing while the same revision config and paper report 48 layers and 1.4T, and the referenced LICENSE file is absent.", { resultIndependenceGroup: "ouro-authors", artifactOwner: "bytedance-seed", manualRiskFlags: ["official-model-card-config-paper-conflict", "license-file-missing-despite-license-metadata"] }),
  source("candidate:ouro-family-2-6b-thinking-model", "ByteDance Ouro 2.6B Thinking artifact", "T4", "bytedance-seed", "official-family-artifact", "A public, ungated 2.6B Thinking revision and required inference files exist.", "That hidden loops causally produce generalizable gains or that the license artifact is complete; metadata says Apache-2.0 but the referenced LICENSE file is absent.", { resultIndependenceGroup: "ouro-authors", artifactOwner: "bytedance-seed", manualRiskFlags: ["license-file-missing-despite-license-metadata"] }),
  source("candidate:latent-reasoning-arxiv-seeds#2605.26733", "STARS recurrent-depth study", "T3", "stars-authors", "independent-category-test", "A different author group reports mixed stability evidence about recurrent-depth models.", "A direct reproduction or refutation of the exact Ouro checkpoint; the public repository does not expose the paper-scale training path, checkpoints, logs, or result package.", { polarity: "mixed", paperCodeMatch: "blocked", manualRiskFlags: ["paper-scale-training-path-missing", "public-code-paper-algorithm-mismatch-review"] }),
  source("candidate:readout-blind-spot-arxiv#2606.24898", "Readout Blind Spot paper version", "T3", "readout-blind-spot-authors", "independent-direct-checkpoint-diagnostic", "An independent group reports controlled readout, scale-clamp, and published Ouro checkpoint diagnostics.", "That recurrence itself is globally causal, stable across architectures, or production-serving behavior.", { polarity: "mixed" }),
  source("candidate:readout-blind-spot-commits", "Readout Blind Spot paper-linked code", "T4", "readout-blind-spot-authors", "paper-linked-intervention-code", "The paper-linked repository exposes evaluation and scale-sensitivity entry points at an immutable commit.", "A runnable published-Ouro scale intervention: the checked script exits and points to a notebooks/ouro_scale_sensitivity.ipynb path absent from the repository; raw logs and trained comparison checkpoints are also missing.", { polarity: "mixed", paperCodeMatch: "blocked", manualRiskFlags: ["canonical-scale-notebook-missing", "published-ouro-intervention-path-not-runnable"] }),

  source("candidate:latent-reasoning-arxiv-seeds#2412.06769", "Coconut paper version", "T3", "coconut-authors", "authored-research-claim", "The authors' current continuous-thought method and experiments.", "That latent states form a complete or faithful causal reasoning trace."),
  source("production:coconut-code", "Meta FAIR Coconut code", "T4", "meta-fair", "official-artifact", "The official implementation and its commit identity exist.", "A cheap turnkey reproduction or official pretrained checkpoint.", { resultIndependenceGroup: "coconut-authors", artifactOwner: "meta-fair" }),
  source("candidate:latent-reasoning-arxiv-seeds#2512.21711", "Latent-token critique paper", "T3", "latent-token-critique-authors", "independent-critical-claim", "An independent group reports shortcut and faithfulness concerns.", "A verified refutation without code, data, logs, and cross-setting reproduction.", { polarity: "counter" }),
  source("candidate:switch-latent-reasoning-arxiv#2606.13106", "SWITCH hidden-state recurrence paper", "T3", "lark-ai-lab-switch", "paper-linked-coconut-style-intervention-study", "The authors report zero, random-same-norm, skip, and normal hidden-state interventions for a Coconut-style recurrent model; same-norm random replacement does not support a simple content-specific faithfulness claim.", "A direct intervention on the published Coconut checkpoint, specific hidden-content necessity, or cross-model independent validation.", { polarity: "mixed", manualRiskFlags: ["post-selected-subset-must-not-replace-full-result", "same-norm-random-competition-explanation"] }),
  source("candidate:switch-latent-reasoning-commits", "SWITCH paper-linked code", "T4", "lark-ai-lab-switch", "paper-linked-intervention-code", "The public MIT repository exposes three-stage training, evaluation, and latent-intervention code paths.", "Paper-exact launcher defaults, locked dependencies, public raw intervention logs, or an independent reproduction; README commands and launcher defaults do not match the published CLI and paper settings.", { manualRiskFlags: ["readme-cli-schema-mismatch", "paper-launcher-default-mismatch", "raw-intervention-logs-missing"] }),
  source("candidate:switch-latent-reasoning-model", "SWITCH Phase 3 Qwen3-8B adapter", "T4", "lark-ai-lab-switch", "paper-linked-model-artifact", "A public ungated MIT Qwen3-8B adapter revision exists.", "Generalization beyond the released scale, English math, or the paper's full raw results."),
  source("candidate:switch-latent-reasoning-dataset", "SWITCH math training dataset", "T4", "lark-ai-lab-switch", "paper-linked-training-data", "Public ungated MIT train/test and SFT/GRPO files exist at an immutable revision.", "A working hosted viewer, immutable dependency environment, or public trajectories and intervention outputs."),
  source("candidate:latent-cot-dynamics-arxiv#2607.09698", "Latent CoT dynamical-systems paper", "T3", "latent-cot-dynamics-authors", "independent-direct-trajectory-study", "A different author group reports trajectory geometry and perturbation diagnostics directly on COCONUT and CODI checkpoints.", "A faithful step-by-step semantic trace, cross-backbone/domain validity, or a complete causal explanation; the paper/code Lyapunov definitions require reconciliation.", { polarity: "mixed", paperCodeMatch: "blocked", manualRiskFlags: ["paper-code-lyapunov-definition-mismatch"] }),
  source("candidate:latent-cot-dynamics-commits", "Latent CoT dynamical-systems code and result logs", "T4", "latent-cot-dynamics-authors", "paper-linked-trajectory-analysis-artifact", "The paper-linked commit exposes inference/analysis/perturbation code, configs, tests, six run logs, result plots, manifests, and hashes for omitted HDF5 caches.", "A paper-consistent Lyapunov implementation, redistributable project-code license, the omitted raw HDF5 hidden states, cross-backbone/domain runs, or independent result replication.", { polarity: "mixed", paperCodeMatch: "blocked", manualRiskFlags: ["paper-code-lyapunov-definition-mismatch", "raw-hidden-state-chain-missing"] }),
  source("candidate:latent-cot-vanilla-coconut-model", "Vanilla COCONUT checkpoint used by Latent CoT dynamics", "T4", "modalitydance-latent-checkpoints", "paper-used-model-artifact", "A public ungated MIT-tagged GPT-2-small COCONUT checkpoint revision and required model files exist.", "An official Meta FAIR checkpoint, a different backbone, or validation beyond GSM8K.", { resultIndependenceGroup: "latent-cot-dynamics-authors" }),
  source("candidate:latent-cot-vanilla-codi-model", "Vanilla CODI checkpoint used by Latent CoT dynamics", "T4", "modalitydance-latent-checkpoints", "paper-used-model-artifact", "A public ungated MIT-tagged GPT-2-small CODI checkpoint revision and required model files exist.", "An official upstream guarantee, a different backbone, or validation beyond GSM8K.", { resultIndependenceGroup: "latent-cot-dynamics-authors" }),
  source("candidate:latent-cot-simcot-coconut-model", "SIM-CoT COCONUT checkpoint used by Latent CoT dynamics", "T4", "internlm-simcot-authors", "paper-used-model-artifact", "A public ungated MIT-tagged SIM-CoT COCONUT checkpoint revision exists and the paper-linked bootstrap documents its translation.", "A turnkey Transformers checkpoint without translation, cross-backbone validation, or the dynamical paper's omitted HDF5 trajectories; the model-card result placeholders remain unverified.", { resultIndependenceGroup: "latent-cot-dynamics-authors", manualRiskFlags: ["model-card-results-placeholder-unverified"] }),
  source("candidate:latent-cot-simcot-codi-model", "SIM-CoT CODI checkpoint used by Latent CoT dynamics", "T4", "internlm-simcot-authors", "paper-used-model-artifact", "A public ungated MIT-tagged SIM-CoT CODI safetensors revision exists and the paper-linked bootstrap documents its translation.", "Cross-backbone validation, independent result reproduction, or the dynamical paper's omitted HDF5 trajectories; the model-card result placeholders remain unverified.", { resultIndependenceGroup: "latent-cot-dynamics-authors", manualRiskFlags: ["model-card-results-placeholder-unverified"] }),
  source("candidate:latent-cot-thinking-arxiv#2602.00449", "Latent-CoT step-by-step mechanistic study", "T3", "latent-cot-thinking-authors", "authored-scoped-mechanistic-stress-test", "The authors report patching, probing, checkpoints, and sequentiality tests on their small synthetic CODI-style setting.", "A direct test of the published Coconut checkpoint, natural-language reasoning, large models, or cross-backbone validity."),
  source("candidate:latent-cot-thinking-commits", "Latent-CoT step-by-step paper-linked artifacts", "T4", "latent-cot-thinking-authors", "paper-linked-scoped-stress-test-artifact", "An immutable repository commit stream exposes training/evaluation code, synthetic data, checkpoints, result files, and analysis notebooks.", "A licensed multi-seed reproduction; the repository has no detected root license and publishes one reported seed."),

  source("candidate:hidden-decoding-arxiv#2607.08186", "Hidden Decoding at Scale paper", "T3", "tencent-hidden-decoding-authors", "authored-new-architecture-claim", "The authors report stream expansion and stream-factorized attention as a latent-compute scaling architecture.", "Independent frontier-scale gains or reproducibility of the unreleased 80B/617B experiments."),
  source("candidate:hidden-decoding-commits", "Sequential Hidden Decoding paper-linked repository", "T4", "tencent-hidden-decoding-authors", "paper-linked-inference-code", "The author repository exposes an immutable inference patch and paper-linked documentation.", "Training code, paper-scale weights, raw logs, or unrestricted licensing; the custom license includes a territorial limitation."),
  source("candidate:hidden-decoding-model", "Sequential Hidden Decoding Qwen3-8B n4 model", "T4", "tencent-hidden-decoding-authors", "paper-linked-demonstration-model", "A public ungated 8B demonstration-model revision with custom modeling code and weights exists.", "The main 80B/617B paper models, their training recipe, or the reported frontier-scale result."),

  source("candidate:anthropic-circuit-tracing-methods-page", "Circuit Tracing methods page", "T3", "anthropic-circuit-tracing-authors", "primary-method-document", "The published replacement-model and attribution-graph method, including stated limits.", "Complete faithfulness of the replacement model or all model internals.", { resultIndependenceGroup: "anthropic-circuit-tracing-lineage", artifactOwner: "anthropic" }),
  source("candidate:anthropic-circuit-tracing-biology-page", "Biology of a Large Language Model page", "T3", "anthropic-circuit-tracing-authors", "primary-study-document", "The authors' traced examples, interventions, and reported observations.", "Generalization across models, prompts, or independent replications.", { resultIndependenceGroup: "anthropic-circuit-tracing-lineage", artifactOwner: "anthropic" }),
  source("production:anthropic-attribution-frontend", "Anthropic attribution frontend", "T4", "anthropic", "official-artifact-version", "The official visualization artifact and a code commit changed.", "A new causal discovery or a scientific result.", { resultIndependenceGroup: "anthropic-circuit-tracing-lineage", artifactOwner: "anthropic" }),
  source("production:circuit-tracer-releases", "Circuit-Tracer paper-linked releases", "T4", "circuit-tracer-authors", "paper-linked-tooling-version", "A public implementation release with attribution, visualization, and intervention tooling exists.", "An independent scientific replication; the paper has author overlap with Anthropic and originated in the Anthropic Fellows Program.", { resultIndependenceGroup: "anthropic-circuit-tracing-lineage", artifactOwner: "circuit-tracer-authors" }),
  source("candidate:pando-arxiv#2604.11061", "Pando interpretability method stress test", "T3", "pando-authors", "independent-model-organism-method-test", "A different group reports a controlled model-organism comparison of interpretability methods under absent or misleading explanations.", "Failure of Circuit-Tracer on Claude or natural behavior, general SAE failure, or complete causal coverage."),
  source("candidate:pando-artifact-tree", "Pando paper-linked artifact tree", "T4", "pando-authors", "paper-linked-method-test-code", "The required evaluation, Circuit-Tracer adapter, reproducibility, table, and license files exist at an exact tree identity.", "The paper's result independently rerun outside the author group or a natural-model conclusion."),
  source("candidate:pando-evaluation-results", "Pando bounded cached evaluation results", "T4", "pando-authors", "paper-linked-result-artifact", "A bounded public and ungated cached-result zip exists at an immutable HF revision.", "A dataset license, the mutable 1000+ README scope, or the unpacked 38,078-file dataset as an unattended source."),
  source("candidate:mib-arxiv#2504.13151", "MIB mechanistic interpretability benchmark", "T3", "mib-interpbench-overlap-lineage", "independent-localization-benchmark", "The authors report fixed benchmark evaluations of circuit and causal-variable localization methods.", "Claude attribution-graph completeness, natural behavior coverage, or cross-model/OOD validity."),
  source("candidate:mib-circuit-track-tree", "MIB circuit-track artifact tree", "T4", "mib-interpbench-overlap-lineage", "paper-linked-localization-benchmark-code", "Required attribution, evaluation, metrics, replication, license, and InterpBench adapter files exist at an exact tree identity.", "An independent lineage from InterpBench; the projects share authors."),
  source("candidate:interpbench-arxiv#2407.14494", "InterpBench semi-synthetic benchmark", "T3", "mib-interpbench-overlap-lineage", "semi-synthetic-ground-truth-benchmark", "The authors report semi-synthetic transformer ground-truth evaluation for interpretability techniques.", "Natural frontier-model circuits or independence from MIB authors."),
  source("candidate:interpbench-models", "InterpBench ground-truth model artifacts", "T4", "mib-interpbench-overlap-lineage", "ground-truth-model-artifact", "Public CC-BY-4.0 model, edge, configuration, metadata, and benchmark-case files exist at an immutable revision.", "Generalization beyond the released semi-synthetic cases."),

  source("production:codex-releases", "OpenAI Codex releases", "T4", "openai", "official-harness-version", "A Codex harness release occurred.", "That a model's intrinsic capability improved."),
  source("production:claude-code-releases", "Anthropic Claude Code releases", "T4", "anthropic", "official-harness-version", "A Claude Code harness release occurred.", "That a model's intrinsic capability improved."),
  source("candidate:openai-agents-sdk-releases", "OpenAI Agents SDK releases", "T4", "openai", "official-harness-version", "An Agents SDK release and stable tag occurred.", "A controlled capability uplift."),
  source("candidate:claude-agent-sdk-releases", "Claude Agent SDK releases", "T4", "anthropic", "official-harness-version", "A Claude Agent SDK release and stable tag occurred.", "A controlled capability uplift."),
  source("candidate:claude-agent-sdk-changelog", "Claude Agent SDK changelog", "T4", "anthropic", "versioned-harness-semantics", "The official versioned changelog file and exact blob identity exist.", "That a prose entry is material, complete, or improves a fixed model."),
  source("candidate:google-adk-releases", "Google ADK releases", "T4", "google", "official-harness-version", "An ADK release and stable tag occurred.", "A controlled capability uplift."),
  source("candidate:google-adk-changelog", "Google ADK changelog", "T4", "google", "versioned-harness-semantics", "The official versioned changelog file and exact blob identity exist.", "That a prose entry is material, complete, or improves a fixed model."),
  source("candidate:microsoft-agent-framework-releases", "Microsoft Agent Framework releases", "T4", "microsoft", "official-harness-version", "An Agent Framework release and runtime-specific tag occurred.", "A controlled capability uplift."),
  source("candidate:harness-updating-arxiv#2605.30621", "Harness Updating vs Benefit paper", "T3", "a-evolve-harness-authors", "authored-controlled-harness-study", "The authors report a factorial agent/evolver comparison with a fixed initial harness, task stream, evolution budget, prompt template, and turn limit across three benchmarks.", "Independent replication, paper result logs, or a model-intrinsic capability change."),
  source("candidate:harness-updating-commits", "Harness Updating vs Benefit paper branch", "T4", "a-evolve-harness-authors", "paper-linked-controlled-harness-code", "The immutable paper branch exposes benchmark adapters, harness states, fixed configs, solve/evolve loops, and reproduction commands.", "A licensed turnkey reproduction, raw paper run logs, frozen proprietary model snapshots, or an independent rerun.", { manualRiskFlags: ["repository-license-missing", "raw-result-logs-missing", "proprietary-model-snapshot-not-frozen"] }),
  source("candidate:rethinking-harness-evolution-arxiv#2607.12227", "Rethinking Harness Evolution study", "T3", "rethinking-harness-evolution-authors", "independent-category-counterevidence-study", "A different group reports a matched-budget held-out test that challenges broad harness-evolution benefit in an AHE/Terminal-Bench setting.", "A direct rerun of arXiv:2605.30621; tasks, initial harness, updater, budget, grader, and metrics are not aligned.", { polarity: "counter" }),
  source("candidate:rethinking-harness-evolution-commits", "Rethinking Harness Evolution code", "T4", "rethinking-harness-evolution-authors", "paper-linked-counterevidence-code", "The paper-linked repository exposes code, configurations, and run entry points at an immutable commit identity.", "Complete raw results, trajectories, harness snapshots, a root license, frozen proprietary model versions, or a direct Harness Updating rerun.", { polarity: "counter", manualRiskFlags: ["repository-license-missing", "raw-results-and-trajectories-missing", "proprietary-model-snapshot-not-frozen"] }),

  source("production:inspect-ai-releases", "Inspect AI releases", "T4", "uk-ai-security-institute", "official-eval-version", "An evaluation-harness release occurred.", "That old and new benchmark scores remain comparable."),
  source("candidate:inspect-ai-changelog", "Inspect AI changelog", "T4", "uk-ai-security-institute", "versioned-evaluation-semantics", "A versioned official changelog records task, scorer, model, or sandbox changes.", "The exact code diff, score impact, or cross-version comparability."),
  source("candidate:inspect-evals-releases", "Inspect Evals task-suite releases", "T4", "uk-ai-security-institute", "official-eval-suite-version", "An official Inspect Evals task-suite release and stable tag occurred.", "That Inspect AI itself changed, that a scorer fix has a measured score impact, or that the mutable release record resolves the tag to a frozen commit.", { manualRiskFlags: ["release-tag-commit-not-resolved", "upstream-release-record-mutable"] }),
  source("candidate:inspect-evals-task-versioning", "Inspect Evals task comparability policy", "T4", "uk-ai-security-institute", "versioned-task-comparability-policy", "The official N-X task-version policy and exact blob identity define which changes break fair score comparability.", "That every task follows the policy or the magnitude of any score change."),
  source("candidate:inspect-evals-changelog", "Inspect Evals task changelog", "T4", "uk-ai-security-institute", "versioned-eval-task-semantics", "An exact official changelog blob records task, scorer, grader, dataset, prompt, or template changes.", "The code diff, measured score effect, or a rerun of old baselines."),
  source("production:lm-eval-releases", "lm-evaluation-harness releases", "T4", "eleutherai", "official-eval-version", "An evaluation-harness release occurred.", "That task, scorer, adapter, and grader semantics are unchanged."),
  source("candidate:lm-eval-task-commits", "lm-evaluation-harness task-scoped commits", "T4", "eleutherai", "task-path-version-stream", "A commit touched the official task subtree and its immutable SHA exists.", "Whether scoring semantics changed or prior results must be rerun."),
  source("candidate:helm-releases", "Stanford HELM releases", "T4", "stanford-crfm", "official-eval-version", "A HELM release occurred.", "That scenario or schema changes preserve score comparability."),
  source("candidate:helm-changelog", "Stanford HELM changelog", "T4", "stanford-crfm", "versioned-evaluation-semantics", "The official versioned changelog and blob identity exist.", "That every scenario, metric, or schema change is fully enumerated or score-neutral."),
  source("production:metr", "METR evaluation research feed", "T3", "metr", "independent-evaluation-research", "METR published an evaluation study or methodology update.", "A versioned task/config artifact for every reported result."),
  source("candidate:long-horizon-terminal-bench-arxiv#2607.08964", "Long-Horizon-Terminal-Bench paper", "T3", "long-horizon-terminal-bench-authors", "authored-benchmark-study", "The authors report a long-horizon terminal benchmark, dense graders, model settings, and stated results.", "A single shared harness for every model or independently reproduced scores; v2 covers 15 models and contains an internal Codex-versus-Terminus-2 comparability conflict.", { manualRiskFlags: ["paper-shared-harness-statement-conflict", "raw-runs-missing"] }),
  source("candidate:long-horizon-terminal-bench-commits", "Long-Horizon-Terminal-Bench repository", "T4", "long-horizon-terminal-bench-authors", "paper-linked-task-grader-artifact", "The public Apache-2.0 repository exposes task manifests, containers, graders, and runnable configs.", "Published raw jobs, trajectories, per-run results, or direct comparability of leaderboard scores.", { manualRiskFlags: ["raw-jobs-trajectories-results-missing", "shared-harness-comparability-unresolved"] }),
  source("candidate:long-horizon-terminal-bench-dataset", "Long-Horizon-Terminal-Bench dataset", "T4", "long-horizon-terminal-bench-authors", "paper-linked-benchmark-data", "A public ungated Apache-2.0 dataset revision contains task data and evaluation configuration.", "Frozen leaderboard runs, harness equivalence, or a score reproduction."),
]);

const requirement = (
  id,
  label,
  sourceRefs,
  minHealthy = 1,
  minIndependenceGroups = 1,
  requiredNext = "",
  {
    alternativeSourceSets = [],
    evidenceRole = "supporting",
    acceptedPolarities = evidenceRole === "supporting" ? ["supporting"] : ["supporting", "mixed", "counter"],
  } = {},
) => ({
  id,
  label,
  source_refs: sourceRefs,
  min_healthy: minHealthy,
  min_independence_groups: minIndependenceGroups,
  required_next: requiredNext,
  alternative_source_sets: alternativeSourceSets,
  evidence_role: evidenceRole,
  accepted_polarities: acceptedPolarities,
});

const counterRequirement = (id, label, sourceRefs, minHealthy = 1, minIndependenceGroups = 1, requiredNext = "") => requirement(
  id,
  label,
  sourceRefs,
  minHealthy,
  minIndependenceGroups,
  requiredNext,
  { evidenceRole: "counterevidence" },
);

const claim = (
  id,
  label,
  kind,
  evidenceCeiling,
  requirements,
  { humanReviewRequired = false, causal = false, counterevidenceRequirements = [] } = {},
) => ({
  id,
  label,
  kind,
  evidence_ceiling_when_met: evidenceCeiling,
  requirements,
  counterevidence_requirements: counterevidenceRequirements,
  event_required: ["versioned-policy", "official-release", "versioned-harness-semantics", "versioned-evaluation-semantics"].includes(kind),
  human_review_required: humanReviewRequired,
  causal_claim: causal,
  notification_eligible: false,
});

export const diligenceTopics = Object.freeze([
  {
    id: "openai-model-spec",
    title: "OpenAI Model Spec / intended behavior",
    layers: ["B0"],
    attention_patterns: ["openai.{0,20}model spec", "model spec", "instruction hierarchy"],
    claims: [
      claim("official-text-change", "官方 Model Spec 文本或公开版本发生变化", "versioned-policy", "G3 for intended-policy change only", [
        requirement("version-index", "commit stream 与 repository version index", ["production:openai-model-spec", "candidate:openai-model-spec-tree"], 2),
        requirement("canonical-text", "canonical 正文", ["production:openai-model-spec-text"]),
        requirement("release-semantics", "官方 CHANGELOG 与 public version manifest", ["candidate:openai-model-spec-changelog", "candidate:openai-model-spec-version-manifest"], 2),
      ], { humanReviewRequired: true }),
      claim("learned-implementation", "生产模型权重实际实现了 Model Spec 的底层机制", "causal-model-mechanism", "G3 minimum", [
        requirement("independent-causal-test", "公开权重/训练对照、干预、行为遵从率与独立复现", [], 1, 1, "官方文本、eval dataset 或同一机构 artifact 不能替代生产权重上的独立因果验证。"),
      ], { causal: true, humanReviewRequired: true }),
    ],
  },
  {
    id: "claude-constitution",
    title: "Claude Constitution / intended behavior",
    layers: ["B0", "M4"],
    attention_patterns: ["claude.{0,20}constitution", "model spec", "constitutional ai"],
    claims: [
      claim("official-text-change", "官方 Constitution 文本或 canonical 文件发生变化", "versioned-policy", "G3 for intended-policy change only", [
        requirement("version-index", "repository tree 与 README current-version pointer 必须同时健康", ["candidate:claude-constitution-tree", "candidate:claude-constitution-readme"], 2),
        requirement("commit-stream", "官方 commit stream", ["production:anthropic-constitution"]),
        requirement("canonical-text", "canonical 正文", ["production:anthropic-constitution-text"]),
      ], { humanReviewRequired: true }),
      claim("learned-implementation", "模型权重实际实现了 Constitution 的底层机制", "causal-model-mechanism", "G3 minimum", [
        requirement("independent-causal-test", "独立 intervention/ablation 与行为服从率", [], 1, 1, "需要公开的因果干预、训练/权重对照和独立复现；官方文本 diff 不能替代。"),
      ], { causal: true, humanReviewRequired: true }),
    ],
  },
  {
    id: "model-spec-midtraining",
    title: "Model Spec Midtraining / learned policy internalization",
    layers: ["M2", "M4"],
    attention_patterns: ["model spec midtraining", "spec-conditioned midtraining", "learned policy internalization"],
    claims: [
      claim("spec-midtraining-open-model-control", "规范文本经 midtraining 改变开放模型 OOD 对齐行为的作者受控实验与 artifact 可追溯", "authored-controlled-training-mechanism", "G2 author-attributed, open-model scope only", [
        requirement("paper", "最新论文版本", ["candidate:model-spec-midtraining-arxiv#2605.02087"]),
        requirement("code", "论文关联训练与评测代码", ["candidate:model-spec-midtraining-commits"]),
        requirement("model", "公开 adapter revision", ["candidate:model-spec-midtraining-model"]),
        requirement("data", "公开 midtraining dataset revision", ["candidate:model-spec-midtraining-dataset"]),
      ]),
      claim("learned-internalization", "规范文本被内化为可定位、可干预的 learned internal mechanism", "causal-model-mechanism", "G3 minimum", [
        requirement("authored-open-model-control", "作者开放模型的论文、代码、adapter 与数据", ["candidate:model-spec-midtraining-arxiv#2605.02087", "candidate:model-spec-midtraining-commits", "candidate:model-spec-midtraining-model", "candidate:model-spec-midtraining-dataset"], 4),
        requirement("internal-mechanism-validation", "训练前后内部表征/参数机制、因果干预与独立复现", [], 1, 1, "行为 OOD 对照不能单独证明规范已被内化为特定表征、权重机制或 circuit；需要训练前后内部分析、干预和独立结果复现。"),
      ], { causal: true, humanReviewRequired: true }),
    ],
  },
  {
    id: "ouro-looplm",
    title: "Ouro / looped latent reasoning",
    layers: ["M1", "M2", "M3"],
    attention_patterns: ["\\bouro\\b", "looped language model", "latent reasoning", "recurrent depth"],
    claims: [
      claim("authored-mechanism", "Ouro 作者报告的循环架构、exit-weighted 训练与发布代码的后验状态选择", "authored-mechanism", "G2 author-attributed; no adaptive-compute claim", [
        requirement("paper", "最新论文版本", ["candidate:latent-reasoning-arxiv-seeds#2510.25741"]),
        requirement("artifact", "官方 config/weights/model card", ["production:ouro-model"]),
      ]),
      claim("adaptive-halting-compute-savings", "发布实现会在达到退出阈值时中止 recurrent forward 并节省 FLOPs 或端到端延迟", "runtime-control-mechanism", "G2 requires released control-flow evidence and measurements", [
        requirement("control-flow-and-benchmark", "真实 loop short-circuit、matched output/quality 对照及 wall-clock/FLOPs 原始结果", [], 1, 1, "当前发布 modeling_ouro.py 先执行全部 recurrent loops，再选择或混合先前 hidden state；没有可验证的提前停止和计算节省结果。"),
      ], { humanReviewRequired: true }),
      claim("official-model-family", "Ouro 四个官方 base/thinking artifact 可按同一公开文件合同追溯", "official-artifact-family", "T4 artifact availability only", [
        requirement("family-revisions", "1.4B/2.6B 与对应 Thinking 的四个独立 revision", [
          "candidate:ouro-family-1-4b-model",
          "candidate:ouro-family-1-4b-thinking-model",
          "candidate:ouro-family-2-6b-model",
          "candidate:ouro-family-2-6b-thinking-model",
        ], 4),
      ]),
      claim("causal-generalization", "循环深度本身稳定地产生可泛化能力提升", "causal-model-mechanism", "G3 minimum", [
        requirement("full-result-reproduction", "公开训练日志、对照 checkpoint 与跨深度/架构复跑", [], 1, 1, "Readout Blind Spot 已补直接 checkpoint 诊断与代码，但未发布原始日志或训练后的对照 checkpoint；1.4B 仍是 scale sanity check，不是完整因果复现。"),
      ], {
        causal: true,
        humanReviewRequired: true,
        counterevidenceRequirements: [
          counterRequirement("independent-category-test", "不同作者组的 recurrence 稳定性混合证据", ["candidate:latent-reasoning-arxiv-seeds#2605.26733"]),
          counterRequirement("direct-checkpoint-diagnostic", "针对 Ouro checkpoint 的独立诊断论文与代码", ["candidate:readout-blind-spot-arxiv#2606.24898", "candidate:readout-blind-spot-commits"], 2),
        ],
      }),
    ],
  },
  {
    id: "coconut-continuous-thought",
    title: "Coconut / continuous latent thought",
    layers: ["M1", "M2", "M3", "M4"],
    attention_patterns: ["\\bcoconut\\b", "continuous thought", "latent token"],
    claims: [
      claim("authored-mechanism", "Coconut 作者报告的 hidden-state feedback 计算机制", "authored-mechanism", "G2 author-attributed", [
        requirement("paper", "最新论文版本", ["candidate:latent-reasoning-arxiv-seeds#2412.06769"]),
        requirement("artifact", "官方实现", ["production:coconut-code"]),
      ]),
      claim("sequentiality-stress-test", "小型 CODI-style 合成任务上的 latent step 顺序性干预与公开 artifact", "scoped-mechanistic-stress-test", "G2 author-attributed, synthetic small-model scope only", [
        requirement("paper-and-artifact", "论文与 paper-linked code/checkpoint/result 路径", ["candidate:latent-cot-thinking-arxiv#2602.00449", "candidate:latent-cot-thinking-commits"], 2),
      ], { humanReviewRequired: true }),
      claim("faithful-reasoning", "latent state 是忠实、可解释的底层推理轨迹", "causal-model-mechanism", "G3 minimum", [
        requirement("independent-cross-model-validation", "公开原始 hidden-state、跨 backbone/领域复跑与独立结果复现", [], 1, 1, "Latent CoT Dynamics 已补直接 COCONUT/CODI 代码、运行日志、模型 revision 与 perturbation 路径，但只覆盖 GPT-2-small/GSM8K；HDF5 hidden states 被 gitignore，项目代码无根 license，也没有跨 backbone/domain 的不同作者复跑。"),
      ], {
        causal: true,
        humanReviewRequired: true,
        counterevidenceRequirements: [
          counterRequirement("independent-critique", "不同作者组的反证/压力测试", ["candidate:latent-reasoning-arxiv-seeds#2512.21711"]),
          counterRequirement("switch-intervention-boundary", "SWITCH 的 Coconut-style 干预论文与 artifact", ["candidate:switch-latent-reasoning-arxiv#2606.13106", "candidate:switch-latent-reasoning-commits", "candidate:switch-latent-reasoning-model", "candidate:switch-latent-reasoning-dataset"], 4),
          counterRequirement("direct-coconut-trajectory-diagnostic", "Latent CoT Dynamics 的论文、代码、运行日志与固定模型 revision", ["candidate:latent-cot-dynamics-arxiv#2607.09698", "candidate:latent-cot-dynamics-commits", "candidate:latent-cot-vanilla-coconut-model", "candidate:latent-cot-vanilla-codi-model", "candidate:latent-cot-simcot-coconut-model", "candidate:latent-cot-simcot-codi-model"], 6),
        ],
      }),
    ],
  },
  {
    id: "hidden-decoding",
    title: "Sequential Hidden Decoding / parallel hidden streams",
    layers: ["M1", "M3"],
    attention_patterns: ["hidden decoding", "latent computation scaling", "parallel hidden streams", "stream-factorized attention"],
    claims: [
      claim("authored-mechanism", "作者报告的 token stream expansion 与 stream-factorized attention 机制及 8B 演示 artifact", "authored-mechanism", "G2 author-attributed, demonstration scale", [
        requirement("paper", "最新论文版本", ["candidate:hidden-decoding-arxiv#2607.08186"]),
        requirement("code", "论文关联 inference patch", ["candidate:hidden-decoding-commits"]),
        requirement("demonstration-model", "公开 8B 演示权重", ["candidate:hidden-decoding-model"]),
      ]),
      claim("frontier-scale-reproduction", "80B/617B 主实验的增益可由公开 artifact 独立复现", "causal-model-mechanism", "G3 minimum", [
        requirement("paper-scale-artifacts", "主实验权重、训练代码、数据配方与原始日志", [], 1, 1, "当前公开的是 Qwen3-8B 演示模型和 inference patch，不是论文 80B/617B 主实验 artifact。"),
        requirement("independent-rerun", "不同作者组的同预算 baseline 重跑", [], 1, 1, "需要固定 token/compute/data/baseline 的独立复跑。"),
      ], { causal: true, humanReviewRequired: true }),
    ],
  },
  {
    id: "circuit-tracing",
    title: "Circuit Tracing / model internals",
    layers: ["M4"],
    attention_patterns: ["circuit tracing", "mechanistic interpretability", "attribution graph", "sparse autoencoder", "\\bsae(?:s)?\\b", "transcoder"],
    claims: [
      claim("published-method", "Circuit Tracing 方法、案例与官方 artifact 的作者报告", "authored-mechanism", "G2 author-attributed", [
        requirement("primary-documents", "methods 与 biology 主文", ["candidate:anthropic-circuit-tracing-methods-page", "candidate:anthropic-circuit-tracing-biology-page"], 2),
        requirement("official-artifact", "官方 attribution artifact", ["production:anthropic-attribution-frontend"]),
      ]),
      claim("method-benchmark-boundaries", "公开工件对 MI localization 方法进行 model-organism、半合成或固定 benchmark 边界测试", "scoped-method-evaluation", "G2 limited to tested synthetic/model-organism/task-model settings", [
        requirement("pando-method-stress-test", "Pando 论文、required artifact tree 与 bounded cached results", ["candidate:pando-arxiv#2604.11061", "candidate:pando-artifact-tree", "candidate:pando-evaluation-results"], 3),
        requirement("mib-localization-benchmark", "MIB 论文与 circuit-track required artifact tree", ["candidate:mib-arxiv#2504.13151", "candidate:mib-circuit-track-tree"], 2),
        requirement("interpbench-ground-truth-benchmark", "InterpBench 论文与 ground-truth model revision", ["candidate:interpbench-arxiv#2407.14494", "candidate:interpbench-models"], 2),
        requirement("distinct-external-lineages", "Pando 与 MIB/InterpBench 两个外部谱系；MIB/InterpBench 作者重叠只计一组", [
          "candidate:pando-arxiv#2604.11061",
          "candidate:pando-artifact-tree",
          "candidate:pando-evaluation-results",
          "candidate:mib-arxiv#2504.13151",
          "candidate:mib-circuit-track-tree",
          "candidate:interpbench-arxiv#2407.14494",
          "candidate:interpbench-models",
        ], 7, 2),
      ], { humanReviewRequired: true }),
      claim("complete-causal-logic", "attribution graph 完整揭示模型底层因果逻辑", "causal-model-mechanism", "G3/G4", [
        requirement("primary-documents", "主文与方法限制", ["candidate:anthropic-circuit-tracing-methods-page", "candidate:anthropic-circuit-tracing-biology-page"], 2),
        requirement("paper-linked-tooling", "论文关联的外部实现与干预工具", ["production:circuit-tracer-releases"]),
        requirement("independent-result-validation", "独立 replacement fidelity、ablation、跨 prompt/model/OOD 结果", [], 1, 1, "独立代码 release 不等于独立科学验证；需结果级干预、完整性和 OOD 证据。"),
      ], { causal: true, humanReviewRequired: true }),
    ],
  },
  {
    id: "agent-harness",
    title: "Agent harness progress",
    layers: ["H1"],
    attention_patterns: ["agent harness", "agent sdk", "claude code", "\\bcodex\\b", "agent framework", "\\badk\\b", "model context protocol", "\\bmcp\\b"],
    claims: [
      claim("version-progress", "官方 agent harness/SDK 发布了新版本", "official-release", "T4 for release occurrence", [
        requirement("official-release", "至少一个健康的官方 release stream", ["production:codex-releases", "production:claude-code-releases", "candidate:openai-agents-sdk-releases", "candidate:claude-agent-sdk-releases", "candidate:google-adk-releases", "candidate:microsoft-agent-framework-releases"]),
      ]),
      claim("semantic-delta", "版本化说明中出现可定位的 context、tool、sandbox、session 或 tracing 变化", "versioned-harness-semantics", "T4 for artifact change; semantic importance requires review", [
        requirement("same-project-release-and-changelog", "同一项目的 official release 与 versioned changelog 必须成对健康", ["candidate:claude-agent-sdk-releases", "candidate:claude-agent-sdk-changelog", "candidate:google-adk-releases", "candidate:google-adk-changelog"], 2, 1, "不能用 Claude release 与 Google changelog（或反向组合）拼成一条语义变化。", {
          alternativeSourceSets: [
            ["candidate:claude-agent-sdk-releases", "candidate:claude-agent-sdk-changelog"],
            ["candidate:google-adk-releases", "candidate:google-adk-changelog"],
          ],
        }),
      ], { humanReviewRequired: true }),
      claim("capability-uplift", "Harness 改动使固定模型的能力提升", "controlled-system-comparison", "G3 minimum", [
        requirement("paper-linked-controlled-protocol", "固定 initial harness、task stream、prompt、evolution budget 与 turn limit 的论文和代码", ["candidate:harness-updating-arxiv#2605.30621", "candidate:harness-updating-commits"], 2),
        requirement("independent-controlled-rerun", "固定 model/task/environment/budget/grader 的独立前后复跑与原始日志", [], 1, 1, "Harness Updating 已提供作者组的固定协议与 paper branch；Rethinking Harness Evolution 是不同 AHE/Terminal-Bench 协议的类别反证，不是对 2605.30621 的直接复跑。两者都缺完整 raw trajectories/results 与可冻结 closed-model snapshots。"),
      ], {
        causal: true,
        humanReviewRequired: true,
        counterevidenceRequirements: [
          counterRequirement("independent-category-counterevidence", "同类 harness-evolution 设定的独立 matched-budget 反证论文与代码（不是直接复跑）", ["candidate:rethinking-harness-evolution-arxiv#2607.12227", "candidate:rethinking-harness-evolution-commits"], 2),
        ],
      }),
    ],
  },
  {
    id: "evaluation-harness",
    title: "Evaluation harness progress",
    layers: ["E1"],
    attention_patterns: ["evaluation harness", "eval harness", "lm-eval", "inspect ai", "\\bhelm\\b", "grader", "benchmark", "\\bevals?\\b"],
    claims: [
      claim("version-progress", "官方 evaluation harness 发布了新版本", "official-release", "T4 for release occurrence", [
        requirement("official-release", "至少一个健康的官方 release stream", ["production:inspect-ai-releases", "production:lm-eval-releases", "candidate:helm-releases"]),
      ]),
      claim("semantic-delta", "task、scorer、adapter、grader 或 schema 出现可定位的版本变化", "versioned-evaluation-semantics", "T4 for artifact change; comparability impact requires review", [
        requirement("same-project-release-and-semantics", "同一项目的 release 与 changelog/task commit 必须成对健康", ["production:inspect-ai-releases", "candidate:inspect-ai-changelog", "production:lm-eval-releases", "candidate:lm-eval-task-commits", "candidate:helm-releases", "candidate:helm-changelog"], 2, 1, "不能跨 Inspect、lm-eval 与 HELM 拼接 release 和语义入口。", {
          alternativeSourceSets: [
            ["production:inspect-ai-releases", "candidate:inspect-ai-changelog"],
            ["production:lm-eval-releases", "candidate:lm-eval-task-commits"],
            ["candidate:helm-releases", "candidate:helm-changelog"],
          ],
        }),
      ], { humanReviewRequired: true }),
      claim("inspect-evals-versioned-comparability", "Inspect Evals task suite 的 release、N-X 可比性规则与具体变更记录可配对", "versioned-evaluation-semantics", "T4 artifact chain only; no measured score effect", [
        requirement("release", "Inspect Evals 官方 stable release", ["candidate:inspect-evals-releases"]),
        requirement("task-version-policy", "N-X task comparability policy", ["candidate:inspect-evals-task-versioning"]),
        requirement("release-change-record", "版本化 task/scorer/grader changelog", ["candidate:inspect-evals-changelog"]),
      ], { humanReviewRequired: true }),
      claim("long-horizon-benchmark-artifact", "长时终端 benchmark 的 task、container、grader 与 dataset artifact 可追溯", "authored-benchmark-artifact", "G2 artifact availability only", [
        requirement("paper", "最新论文版本", ["candidate:long-horizon-terminal-bench-arxiv#2607.08964"]),
        requirement("repository", "论文关联 task/grader/config repository", ["candidate:long-horizon-terminal-bench-commits"]),
        requirement("dataset", "公开 benchmark dataset revision", ["candidate:long-horizon-terminal-bench-dataset"]),
      ]),
      claim("score-comparability", "新旧评测分数仍可直接比较或发生可信反转", "evaluation-comparability", "G3 minimum", [
        requirement("shared-harness", "所有模型使用完全相同且版本固定的 harness", [], 1, 1, "LHTB 论文实验段说明 GPT-5.3 使用 Codex 而非 Terminus-2；当前不能声称全模型共用同一 harness。"),
        requirement("version-diff", "task/scorer/adapter/grader 版本 diff", [], 1, 1, "需回取 CHANGELOG/task schema 并保存评分逻辑 diff。"),
        requirement("rerun", "相同模型与环境的 baseline 重跑日志", [], 1, 1, "LHTB repository 将 jobs 目录排除且未公开逐次运行、trajectory 或 raw result；没有同设置重跑，不能把分数变化归因于模型或 harness。"),
      ], { causal: true, humanReviewRequired: true }),
    ],
  },
]);

export const ATTENTION_WINDOW_DAYS = 14;
