import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  promoteStagedCandidateProbe,
  runAndVerifyCandidateSourceProbe,
} from "../automation/run-and-verify-candidate-source-probe.mjs";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const WEBSITE_DIR = resolve(TEST_DIR, "..");
const ROOT_DIR = resolve(WEBSITE_DIR, "..");

test("candidate scheduler gate runs verifier only after runner success and propagates failures", () => {
  const invocations = [];
  const noCommit = () => {};
  const runnerFailure = (command, args, options) => {
    invocations.push({ command, args, options });
    return { status: 17, error: undefined, signal: null };
  };
  assert.equal(runAndVerifyCandidateSourceProbe({ spawnImpl: runnerFailure, nodePath: "/node", environment: {}, promoteImpl: noCommit }), 17);
  assert.equal(invocations.length, 1);
  assert.equal(basename(invocations[0].args[0]), "run-candidate-source-probe.mjs");
  assert.equal(invocations[0].options.shell, false);

  invocations.length = 0;
  const verifierFailure = (command, args, options) => {
    invocations.push({ command, args, options });
    return { status: invocations.length === 1 ? 0 : 23, error: undefined, signal: null };
  };
  assert.equal(runAndVerifyCandidateSourceProbe({ spawnImpl: verifierFailure, nodePath: "/node", environment: {}, promoteImpl: noCommit }), 23);
  assert.equal(invocations.length, 2);
  assert.equal(basename(invocations[1].args[0]), "verify-candidate-source-probe.mjs");
  assert.match(invocations[1].args[1], /\.audit\.json\.audit\..+\.pending$/);
  assert.equal(invocations[0].options.env.CANDIDATE_PROBE_STATE_PATH, resolve(WEBSITE_DIR, "work/candidate-source-probe/audit.json"));
  assert.notEqual(invocations[0].options.env.CANDIDATE_PROBE_OUTPUT_PATH, invocations[0].options.env.CANDIDATE_PROBE_STATE_PATH);
  assert.equal(invocations[1].options.env.CANDIDATE_PROBE_OUTPUT_PATH, invocations[1].args[1]);

  invocations.length = 0;
  const success = (command, args, options) => {
    invocations.push({ command, args, options });
    return { status: 0, error: undefined, signal: null };
  };
  let promoted = null;
  assert.equal(runAndVerifyCandidateSourceProbe({
    spawnImpl: success,
    nodePath: "/node",
    environment: { CANDIDATE_PROBE_OUTPUT_PATH: "/tmp/candidate-audit.json" },
    promoteImpl: (paths) => { promoted = paths; },
  }), 0);
  assert.equal(invocations[1].args[1], promoted.stagedAuditPath);
  assert.equal(promoted.finalOutputPath, "/tmp/candidate-audit.json");

  let collisionSpawned = false;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(runAndVerifyCandidateSourceProbe({
      spawnImpl: () => { collisionSpawned = true; return { status: 0 }; },
      cwd: "/tmp",
      environment: {
        CANDIDATE_PROBE_OUTPUT_PATH: "same.json",
        CANDIDATE_PROBE_STATE_PATH: "same.json",
        CANDIDATE_PROBE_REVIEW_PATH: "same.json",
      },
    }), 1);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(collisionSpawned, false);
});

test("candidate promotion commits state last and verifier failure preserves prior state", async () => {
  const root = await mkdtemp(join(tmpdir(), "candidate-source-gate-"));
  const finalOutputPath = join(root, "published-audit.json");
  const finalStatePath = join(root, "state.json");
  const finalReviewPath = join(root, "review.md");
  const stagedAuditPath = join(root, ".audit.pending");
  const stagedReviewPath = join(root, ".review.pending");
  await writeFile(finalStatePath, "old-state\n");
  await writeFile(finalOutputPath, "old-output\n");
  await writeFile(finalReviewPath, "old-review\n");
  await writeFile(stagedAuditPath, "new-state\n");
  await writeFile(stagedReviewPath, "new-review\n");

  const commitOrder = [];
  promoteStagedCandidateProbe({
    stagedAuditPath,
    stagedReviewPath,
    finalOutputPath,
    finalStatePath,
    finalReviewPath,
    atomicWriteImpl: (path, content) => {
      commitOrder.push(path);
      writeFileSync(path, content);
    },
  });
  assert.deepEqual(commitOrder, [finalReviewPath, finalOutputPath, finalStatePath]);
  assert.equal(await readFile(finalStatePath, "utf8"), "new-state\n");
  assert.equal(await readFile(finalOutputPath, "utf8"), "new-state\n");
  assert.equal(await readFile(finalReviewPath, "utf8"), "new-review\n");

  await writeFile(finalStatePath, "valid-old-state\n");
  await writeFile(finalReviewPath, "valid-old-review\n");
  let failedInvocationCount = 0;
  let failedStagedAuditPath = "";
  let failedStagedReviewPath = "";
  const verifierFailure = (_command, _args, options) => {
    failedInvocationCount += 1;
    if (failedInvocationCount === 1) {
      failedStagedAuditPath = options.env.CANDIDATE_PROBE_OUTPUT_PATH;
      failedStagedReviewPath = options.env.CANDIDATE_PROBE_REVIEW_PATH;
      writeFileSync(options.env.CANDIDATE_PROBE_OUTPUT_PATH, "invalid-new-state\n");
      writeFileSync(options.env.CANDIDATE_PROBE_REVIEW_PATH, "invalid-new-review\n");
      return { status: 0 };
    }
    return { status: 9 };
  };
  assert.equal(runAndVerifyCandidateSourceProbe({
    spawnImpl: verifierFailure,
    nodePath: "/node",
    cwd: root,
    environment: {
      CANDIDATE_PROBE_OUTPUT_PATH: finalStatePath,
      CANDIDATE_PROBE_STATE_PATH: finalStatePath,
      CANDIDATE_PROBE_REVIEW_PATH: finalReviewPath,
    },
  }), 9);
  assert.equal(await readFile(finalStatePath, "utf8"), "valid-old-state\n");
  assert.equal(await readFile(finalReviewPath, "utf8"), "valid-old-review\n");
  await assert.rejects(readFile(failedStagedAuditPath), { code: "ENOENT" });
  await assert.rejects(readFile(failedStagedReviewPath), { code: "ENOENT" });
});

test("candidate LaunchAgent points at the no-shell runner-verifier gate", () => {
  const output = execFileSync("python3", [
    resolve(ROOT_DIR, "scripts/install_candidate_probe_launchd.py"),
    "--dry-run",
  ], { cwd: ROOT_DIR, encoding: "utf8" });
  assert.match(output, /run-and-verify-candidate-source-probe\.mjs/);
  assert.doesNotMatch(output, /<string>[^<]*run-candidate-source-probe\.mjs<\/string>/);
  assert.match(output, /<key>Hour<\/key>\s*<integer>8<\/integer>/);
  assert.match(output, /<key>Minute<\/key>\s*<integer>40<\/integer>/);
});
