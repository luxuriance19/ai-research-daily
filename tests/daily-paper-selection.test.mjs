import assert from "node:assert/strict";
import test from "node:test";
import { selectLatestCompleteBatch } from "../automation/daily-paper-selection.mjs";

const item = (id, date, upvotes = 0) => ({ paper: { id, submittedOnDailyAt: `${date}T00:00:00Z`, upvotes } });

test("uses the newest complete HF batch when the latest batch is still incomplete", () => {
  const rows = Array.from({ length: 5 }, (_, index) => item(`complete-${index}`, "2026-07-17", index));
  rows.push(...Array.from({ length: 4 }, (_, index) => item(`incomplete-${index}`, "2026-07-18", 100 + index)));

  const selected = selectLatestCompleteBatch(rows, 5);

  assert.equal(selected.latestDate, "2026-07-18");
  assert.equal(selected.latestCount, 4);
  assert.equal(selected.selectedDate, "2026-07-17");
  assert.equal(selected.papers.length, 5);
});

test("fails closed when no complete HF batch is available", () => {
  const rows = Array.from({ length: 4 }, (_, index) => item(String(index), "2026-07-18", index));
  assert.throws(() => selectLatestCompleteBatch(rows, 5), /latest 2026-07-18 has 4 unique papers/);
});
