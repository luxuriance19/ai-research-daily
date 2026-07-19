import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runAndVerifySemanticReview } from "../automation/run-and-verify-semantic-review-dossiers.mjs";
import { runAndVerifySourceDiligence } from "../automation/run-and-verify-source-diligence.mjs";
import { runAndVerifySourceReadiness } from "../automation/run-and-verify-source-promotion-readiness.mjs";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const WEBSITE_DIR = resolve(TEST_DIR, "..");
const ROOT_DIR = resolve(WEBSITE_DIR, "..");

const gates = [
  ["source-diligence", runAndVerifySourceDiligence, "run-source-diligence.mjs", "verify-source-diligence.mjs"],
  ["semantic-review", runAndVerifySemanticReview, "run-semantic-review-dossiers.mjs", "verify-semantic-review-dossiers.mjs"],
  ["source-readiness", runAndVerifySourceReadiness, "run-source-promotion-readiness.mjs", "verify-source-promotion-readiness.mjs"],
];

test("network-free report gates verify staged output before promotion", () => {
  for (const [name, run, runner, verifier] of gates) {
    const stages = [];
    const code = run({
      spawnImpl: (_node, args, options) => {
        stages.push({ file: basename(args[0]), report: args[1], options });
        return { status: 0 };
      },
      nodePath: "/node",
      cwd: "/tmp",
      environment: {},
      promoteImpl: () => { stages.push({ file: "promote" }); },
      unlinkImpl: () => {},
    });
    assert.equal(code, 0, name);
    assert.equal(stages[0].file, runner, name);
    assert.equal(stages[1].file, verifier, name);
    assert.match(stages[1].report, /\.pending$/, name);
    assert.equal(stages[0].options.shell, false, name);
    assert.equal(stages[2].file, "promote", name);
  }
});

test("a verifier failure preserves the previous readiness report", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-readiness-gate-"));
  const output = join(root, "readiness.json");
  const review = join(root, "readiness.md");
  await writeFile(output, "old-report\n");
  await writeFile(review, "old-review\n");
  let calls = 0;
  const code = runAndVerifySourceReadiness({
    spawnImpl: (_node, _args, options) => {
      calls += 1;
      if (calls === 1) {
        writeFileSync(options.env.SOURCE_PROMOTION_READINESS_PATH, "invalid-report\n");
        writeFileSync(options.env.SOURCE_PROMOTION_READINESS_MARKDOWN_PATH, "invalid-review\n");
        return { status: 0 };
      }
      return { status: 31 };
    },
    nodePath: "/node",
    cwd: root,
    environment: {
      SOURCE_PROMOTION_READINESS_PATH: output,
      SOURCE_PROMOTION_READINESS_MARKDOWN_PATH: review,
    },
  });
  assert.equal(code, 31);
  assert.equal(await readFile(output, "utf8"), "old-report\n");
  assert.equal(await readFile(review, "utf8"), "old-review\n");
});

test("diligence, semantic review, and readiness LaunchAgents use verified no-shell gates", () => {
  const cases = [
    ["install_source_diligence_launchd.py", "run-and-verify-source-diligence.mjs", "8", "50"],
    ["install_semantic_review_launchd.py", "run-and-verify-semantic-review-dossiers.mjs", "8", "55"],
    ["install_source_readiness_launchd.py", "run-and-verify-source-promotion-readiness.mjs", "8", "58"],
  ];
  for (const [script, gate, hour, minute] of cases) {
    const output = execFileSync("python3", [
      resolve(ROOT_DIR, "scripts", script),
      "--dry-run",
    ], { cwd: ROOT_DIR, encoding: "utf8" });
    assert.match(output, new RegExp(gate.replaceAll(".", "\\.")), script);
    assert.doesNotMatch(output, /GEMINI|GOOGLE|OPENAI|CLOUDFLARE|WECHAT|TOKEN|SECRET/i, script);
    assert.match(output, new RegExp(`<key>Hour<\\/key>\\s*<integer>${hour}<\\/integer>`), script);
    assert.match(output, new RegExp(`<key>Minute<\\/key>\\s*<integer>${minute}<\\/integer>`), script);
  }
});

test("evidence-gap Scout runs after the rescheduled diligence chain", () => {
  const output = execFileSync("python3", [
    resolve(ROOT_DIR, "scripts", "install_evidence_gap_scout_launchd.py"),
    "--dry-run",
  ], { cwd: ROOT_DIR, encoding: "utf8" });
  assert.match(output, /run-evidence-gap-scout\.mjs/);
  assert.match(output, /<key>Hour<\/key>\s*<integer>9<\/integer>/);
  assert.match(output, /<key>Minute<\/key>\s*<integer>5<\/integer>/);
  assert.doesNotMatch(output, /GEMINI|GOOGLE|OPENAI|CLOUDFLARE|WECHAT|TOKEN|SECRET/i);
});
