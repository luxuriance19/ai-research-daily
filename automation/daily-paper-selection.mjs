const batchDate = (value) => {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
};

export function selectLatestCompleteBatch(items, count = 5) {
  const batches = new Map();
  for (const item of items || []) {
    const paper = item?.paper || item;
    const date = batchDate(paper?.submittedOnDailyAt);
    if (!paper?.id || !date) continue;
    if (!batches.has(date)) batches.set(date, new Map());
    batches.get(date).set(String(paper.id), paper);
  }
  const dates = [...batches.keys()].sort().reverse();
  if (!dates.length) throw new Error("Hugging Face returned no dated daily papers");
  const latestDate = dates[0];
  const selectedDate = dates.find((date) => batches.get(date).size >= count);
  if (!selectedDate) {
    throw new Error(`no complete Hugging Face batch; latest ${latestDate} has ${batches.get(latestDate).size} unique papers`);
  }
  return {
    selectedDate,
    latestDate,
    latestCount: batches.get(latestDate).size,
    papers: [...batches.get(selectedDate).values()],
  };
}
