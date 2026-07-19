import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAndVerifyMechanismWatch } from "../automation/run-and-verify-mechanism-watch.mjs";

test("mechanism verifier failure preserves prior identity history and report", async () => {
  const root = await mkdtemp(join(tmpdir(), "mechanism-gate-"));
  const output = join(root, "audit.json");
  const review = join(root, "review.md");
  await writeFile(output, "old-audit\n");
  await writeFile(review, "old-review\n");
  let calls = 0;
  const code = runAndVerifyMechanismWatch({
    cwd: root,
    environment: { OUTPUT_PATH: output, STATE_PATH: output, REVIEW_PATH: review },
    spawnImpl: (_node, _args, options) => {
      calls += 1;
      if (calls === 1) {
        writeFileSync(options.env.OUTPUT_PATH, "new-invalid-audit\n");
        writeFileSync(options.env.REVIEW_PATH, "new-review\n");
        return { status: 0 };
      }
      return { status: 23 };
    },
  });
  assert.equal(code, 23);
  assert.equal(await readFile(output, "utf8"), "old-audit\n");
  assert.equal(await readFile(review, "utf8"), "old-review\n");
});
