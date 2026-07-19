import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  replayConstitutionTree,
  replayEditorialOnly,
  replayEvaluationComparability,
  replayPaperArtifact,
  replayReleaseBackfill,
  replayRepositoryMetadata,
  runAcceptanceReplays,
} from "../automation/replay-source-acceptance.mjs";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/source-acceptance-replays.json", import.meta.url), "utf8"));

test("a new dated constitution file is detected even when the tracked raw file is unchanged", () => {
  const result = replayConstitutionTree(fixtures.constitution);
  assert.equal(result.change_detected, true);
  assert.deepEqual(result.added_dated_files, ["20260701-constitution.md"]);
  assert.equal(result.tracked_content_changed, false);
  assert.equal(result.semantic_source_failure, "canonical-path-stale");
  assert.equal(result.auto_select_canonical, false);
  assert.equal(result.disposition, "human-review-required");
  assert.equal(result.notification_eligible, false);
});
test("an Ouro paper revision becomes one story update without duplicating an unchanged model artifact", () => {
  const result = replayPaperArtifact(fixtures.ouro);
  assert.equal(result.canonical_story_id, "arxiv:2510.25741");
  assert.equal(result.previous_version, 4);
  assert.equal(result.current_version, 5);
  assert.equal(result.paper_changed, true);
  assert.equal(result.artifact_changed, false);
  assert.deepEqual(result.changed_components, ["paper"]);
  assert.equal(result.story_update_count, 1);
  assert.equal(result.duplicate_artifact_event, false);
  assert.equal(result.notification_eligible, false);
});

test("a Coconut repository pushed_at change is ignored when the main commit is unchanged", () => {
  const result = replayRepositoryMetadata(fixtures.coconut);
  assert.equal(result.pushed_at_changed, true);
  assert.equal(result.default_branch_head_changed, false);
  assert.deepEqual(result.ignored_fields, ["pushed_at"]);
  assert.equal(result.change_detected, false);
  assert.equal(result.disposition, "no-change");
});

test("paginated release backfill preserves a stable Codex release behind an alpha-heavy feed window", () => {
  const result = replayReleaseBackfill(fixtures.releases);
  assert.equal(result.prerelease_count, 12);
  assert.equal(result.stable_count, 2);
  assert.equal(result.latest_stable.tag_name, "0.144.5");
  assert.equal(result.stable_recovered_by_backfill, true);
  assert.equal(result.semantic_source_failure, "feed-window-saturated");
  assert.deepEqual(result.prerelease_groups, { core: 9, rust: 2, python: 1 });
  assert.equal(result.notification_eligible, false);
});

test("task or scorer changes break evaluation comparability while UI-only changes do not count", () => {
  const result = replayEvaluationComparability(fixtures.evaluation);
  assert.equal(result.primary_layer, "E1");
  assert.equal(result.comparability_break, true);
  assert.equal(result.previous_results_comparable, false);
  assert.ok(result.changes.some((change) => change.field === "task_versions.mgsm_direct"));
  assert.ok(result.changes.some((change) => change.field === "scorer_hash"));
  assert.deepEqual(result.ignored_fields, ["ui_version"]);
  assert.equal(result.notification_eligible, false);
});

test("high editorial attention without a primary artifact remains an unverified hotspot", () => {
  const result = replayEditorialOnly(fixtures.editorial);
  assert.deepEqual(result.independent_editorial_groups, ["hacker-news", "latent-space"]);
  assert.equal(result.primary_artifact_count, 0);
  assert.equal(result.disposition, "pending-verification");
  assert.equal(result.allowed_section, "unverified-hotspot");
  assert.equal(result.evidence_grade_upgrade, false);
  assert.equal(result.notification_eligible, false);
});

test("the aggregate replay audit passes without exposing external actions", () => {
  const audit = runAcceptanceReplays(fixtures);
  assert.equal(audit.mode, "offline-source-acceptance-replay");
  assert.equal(audit.status, "passed");
  assert.ok(Object.values(audit.checks).every(Boolean));
  assert.equal(audit.notification_policy.enabled, false);
  assert.deepEqual(audit.notification_policy.external_actions, []);
  assert.ok(Object.values(audit.results).every((result) => result.notification_eligible === false));
});
