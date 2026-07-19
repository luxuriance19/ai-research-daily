import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const DATED_CONSTITUTION = /^\d{8}-constitution\.md$/;
const PRERELEASE_TAG = /(?:^|[-_.])(alpha|beta|rc|dev|nightly)(?:[-_.]?\d+)?(?:$|[-_.])/i;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function byPath(files) {
  return new Map(asArray(files).map((file) => [file.path, file]));
}

function arxivIdentity(paper) {
  const raw = String(paper?.id || paper?.url || "");
  const match = raw.match(/(?:abs\/)?(\d{4}\.\d{4,5})(?:v(\d+))?/i);
  if (!match) throw new Error(`invalid arXiv identity: ${raw}`);
  return {
    id: match[1],
    version: Number(paper?.version || match[2] || 1),
  };
}

function releaseKey(release) {
  return String(release?.id || release?.tag_name || release?.name || "");
}

function releaseTime(release) {
  const value = Date.parse(release?.published_at || release?.created_at || "");
  return Number.isFinite(value) ? value : 0;
}

function releaseStream(release) {
  const tag = String(release?.tag_name || release?.name || "").toLowerCase();
  if (tag.startsWith("python-")) return "python";
  if (tag.startsWith("rust-")) return "rust";
  return "core";
}

function isPrerelease(release) {
  return release?.prerelease === true || PRERELEASE_TAG.test(String(release?.tag_name || release?.name || ""));
}

export function replayConstitutionTree({ previous, current, tracked_path: trackedPath }) {
  const previousFiles = byPath(previous?.files);
  const currentFiles = byPath(current?.files);
  const addedDatedFiles = [...currentFiles.keys()]
    .filter((path) => DATED_CONSTITUTION.test(path) && !previousFiles.has(path))
    .sort();
  const previousTracked = previousFiles.get(trackedPath);
  const currentTracked = currentFiles.get(trackedPath);
  const trackedChanged = Boolean(previousTracked && currentTracked && previousTracked.sha !== currentTracked.sha);
  const headChanged = previous?.head_sha !== current?.head_sha;
  const canonicalPathStale = headChanged && addedDatedFiles.length > 0 && !trackedChanged;

  return {
    replay: "constitution-new-dated-file",
    change_detected: headChanged && (addedDatedFiles.length > 0 || trackedChanged),
    added_dated_files: addedDatedFiles,
    tracked_path: trackedPath,
    tracked_content_changed: trackedChanged,
    semantic_source_failure: canonicalPathStale ? "canonical-path-stale" : null,
    disposition: canonicalPathStale ? "human-review-required" : trackedChanged ? "semantic-diff-review-required" : "no-change",
    auto_select_canonical: false,
    notification_eligible: false,
  };
}

export function replayPaperArtifact({ previous_paper: previousPaper, current_paper: currentPaper, previous_artifact: previousArtifact, current_artifact: currentArtifact }) {
  const previous = arxivIdentity(previousPaper);
  const current = arxivIdentity(currentPaper);
  if (previous.id !== current.id) throw new Error(`paper identity changed from ${previous.id} to ${current.id}`);

  const versionRegressed = current.version < previous.version;
  const paperChanged = current.version > previous.version
    || currentPaper?.content_sha256 !== previousPaper?.content_sha256;
  const artifactChanged = currentArtifact?.revision_sha !== previousArtifact?.revision_sha;
  const changedComponents = [paperChanged && "paper", artifactChanged && "artifact"].filter(Boolean);

  return {
    replay: "paper-revision-artifact-unchanged",
    canonical_story_id: `arxiv:${current.id}`,
    previous_version: previous.version,
    current_version: current.version,
    paper_changed: paperChanged,
    artifact_changed: artifactChanged,
    changed_components: changedComponents,
    story_update_count: changedComponents.length > 0 ? 1 : 0,
    duplicate_artifact_event: false,
    semantic_source_failure: versionRegressed ? "paper-version-regressed" : null,
    disposition: versionRegressed ? "source-degraded" : paperChanged ? "human-review-required" : artifactChanged ? "artifact-review-required" : "no-change",
    notification_eligible: false,
  };
}

export function replayRepositoryMetadata({ previous, current }) {
  const headChanged = previous?.default_branch_head_sha !== current?.default_branch_head_sha;
  const pushedAtChanged = previous?.pushed_at !== current?.pushed_at;
  return {
    replay: "repository-pushed-at-without-main-commit",
    default_branch_head_changed: headChanged,
    pushed_at_changed: pushedAtChanged,
    ignored_fields: pushedAtChanged && !headChanged ? ["pushed_at"] : [],
    change_detected: headChanged,
    disposition: headChanged ? "code-review-required" : "no-change",
    notification_eligible: false,
  };
}

export function replayReleaseBackfill({ pages, feed_window_size: feedWindowSize = 10 }) {
  const firstWindow = asArray(pages?.[0]).slice(0, feedWindowSize);
  const unique = new Map();
  for (const release of asArray(pages).flatMap((page) => asArray(page))) {
    const key = releaseKey(release);
    if (key && !unique.has(key)) unique.set(key, release);
  }
  const releases = [...unique.values()].sort((a, b) => releaseTime(b) - releaseTime(a));
  const stable = releases.filter((release) => !isPrerelease(release));
  const prereleases = releases.filter(isPrerelease);
  const firstWindowStableKeys = new Set(firstWindow.filter((release) => !isPrerelease(release)).map(releaseKey));
  const latestStable = stable[0] || null;
  const stableRecoveredByBackfill = Boolean(latestStable && !firstWindowStableKeys.has(releaseKey(latestStable)));

  return {
    replay: "high-cadence-prerelease-backfill",
    fetched_pages: asArray(pages).length,
    unique_releases: releases.length,
    prerelease_count: prereleases.length,
    stable_count: stable.length,
    latest_stable: latestStable ? {
      tag_name: latestStable.tag_name,
      published_at: latestStable.published_at,
      stream: releaseStream(latestStable),
    } : null,
    stable_recovered_by_backfill: stableRecoveredByBackfill,
    semantic_source_failure: stableRecoveredByBackfill ? "feed-window-saturated" : null,
    prerelease_groups: Object.fromEntries(Object.entries(Object.groupBy(prereleases, releaseStream)).map(([stream, items]) => [stream, items.length])),
    disposition: latestStable ? "stable-review-required" : "no-stable-release-found",
    notification_eligible: false,
  };
}

export function replayEvaluationComparability({ previous, current }) {
  const changes = [];
  const previousTasks = previous?.task_versions || {};
  const currentTasks = current?.task_versions || {};
  for (const task of [...new Set([...Object.keys(previousTasks), ...Object.keys(currentTasks)])].sort()) {
    if (previousTasks[task] !== currentTasks[task]) {
      changes.push({ field: `task_versions.${task}`, before: previousTasks[task] ?? null, after: currentTasks[task] ?? null });
    }
  }
  for (const field of ["scorer_hash", "grader_version", "dataset_revision", "environment_revision"]) {
    if (previous?.[field] !== current?.[field]) changes.push({ field, before: previous?.[field] ?? null, after: current?.[field] ?? null });
  }
  const comparabilityFields = new Set(["scorer_hash", "grader_version", "dataset_revision", "environment_revision"]);
  const comparabilityBreak = changes.some((change) => change.field.startsWith("task_versions.") || comparabilityFields.has(change.field));

  return {
    replay: "evaluation-task-or-scorer-change",
    changes,
    ignored_fields: previous?.ui_version !== current?.ui_version ? ["ui_version"] : [],
    comparability_break: comparabilityBreak,
    previous_results_comparable: !comparabilityBreak,
    primary_layer: "E1",
    disposition: comparabilityBreak ? "rerun-and-human-review-required" : "no-comparability-change",
    notification_eligible: false,
  };
}

export function replayEditorialOnly({ editorial_signals: editorialSignals, primary_artifacts: primaryArtifacts }) {
  const groups = [...new Set(asArray(editorialSignals).map((signal) => signal.independence_group).filter(Boolean))].sort();
  const hasPrimary = asArray(primaryArtifacts).length > 0;
  return {
    replay: "high-attention-without-primary-artifact",
    independent_editorial_groups: groups,
    primary_artifact_count: asArray(primaryArtifacts).length,
    disposition: hasPrimary ? "primary-evidence-review-required" : "pending-verification",
    allowed_section: hasPrimary ? "mechanism-candidate" : "unverified-hotspot",
    evidence_grade_upgrade: false,
    notification_eligible: false,
  };
}

export function runAcceptanceReplays(fixtures) {
  const results = {
    constitution: replayConstitutionTree(fixtures.constitution),
    ouro: replayPaperArtifact(fixtures.ouro),
    coconut: replayRepositoryMetadata(fixtures.coconut),
    releases: replayReleaseBackfill(fixtures.releases),
    evaluation: replayEvaluationComparability(fixtures.evaluation),
    editorial: replayEditorialOnly(fixtures.editorial),
  };
  const checks = {
    constitution_requires_human_canonical_selection: results.constitution.semantic_source_failure === "canonical-path-stale"
      && results.constitution.auto_select_canonical === false,
    ouro_merges_revision_without_duplicate_artifact: results.ouro.paper_changed
      && !results.ouro.artifact_changed
      && results.ouro.story_update_count === 1
      && !results.ouro.duplicate_artifact_event,
    coconut_ignores_repository_pushed_at: results.coconut.pushed_at_changed
      && !results.coconut.default_branch_head_changed
      && !results.coconut.change_detected,
    stable_release_survives_prerelease_flood: results.releases.stable_recovered_by_backfill
      && Boolean(results.releases.latest_stable),
    evaluation_breaks_comparability: results.evaluation.comparability_break
      && !results.evaluation.previous_results_comparable,
    editorial_attention_cannot_replace_primary_evidence: results.editorial.primary_artifact_count === 0
      && results.editorial.disposition === "pending-verification"
      && !results.editorial.evidence_grade_upgrade,
  };
  return {
    schema_version: 1,
    mode: "offline-source-acceptance-replay",
    generated_from: fixtures.provenance,
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    checks,
    notification_policy: {
      enabled: false,
      external_actions: [],
      statement: "Offline replays cannot publish, message, mutate collector state, or create a WeChat draft.",
    },
    results,
  };
}

async function main() {
  const fixturePath = process.argv[2] || new URL("../tests/fixtures/source-acceptance-replays.json", import.meta.url);
  const body = await readFile(fixturePath, "utf8");
  const audit = runAcceptanceReplays(JSON.parse(body));
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  if (audit.status !== "passed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
