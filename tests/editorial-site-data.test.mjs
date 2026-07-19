import assert from "node:assert/strict";
import test from "node:test";
import { buildEditorialSiteData } from "../automation/editorial-site-data.mjs";

test("reader projection keeps four sections and hides low-level evaluation patches", () => {
  const digest = {
    date: "2026-07-17",
    papers: [
      { id: "2607.14952", title: "LongStraw", summary: "long-context reinforcement learning", upvotes: 172, arxiv_url: "https://arxiv.org/abs/2607.14952", hf_url: "https://huggingface.co/papers/2607.14952" },
      { id: "2607.15257", title: "SearchOS-V1", summary: "agent search harness", upvotes: 58, arxiv_url: "https://arxiv.org/abs/2607.15257", hf_url: "https://huggingface.co/papers/2607.15257" },
    ],
  };
  const modelCompute = {
    daily_editorial_candidates: [{ title: "Kimi K3", url: "https://www.kimi.com/blog/kimi-k3", identity: "k3", published_at: "2026-07-16T16:00:00.000Z", kind: "official-model-announcement-index-item" }],
  };
  const techDiscovery = {
    daily_current_window_review: [
      { title: "UKGovernmentBEIS/inspect_evals v0.15.0", canonical_url: "https://example.com/inspect", daily_sections: ["evaluation"] },
      { title: "openai/openai-agents-python v0.18.3", canonical_url: "https://example.com/agents", published_at: "2026-07-17T03:39:51.000Z", normalized_event_fingerprint: "agents", daily_sections: ["harness"] },
    ],
  };
  const output = buildEditorialSiteData({ digest, modelCompute, techDiscovery, mechanismRadar: { cards: [] }, generatedAt: "2026-07-19T02:00:00.000Z" });
  assert.deepEqual(output.sections.map((section) => section.id), ["model-companies", "hardware", "constitution-analysis", "harness"]);
  const visible = JSON.stringify(output.sections);
  assert.match(visible, /Kimi K3/);
  assert.match(visible, /OpenAI Agents SDK/);
  assert.match(visible, /LongStraw/);
  assert.match(visible, /angle_label/);
  assert.match(visible, /caveat_label/);
  assert.doesNotMatch(visible, /inspect_evals/i);
  assert.doesNotMatch(visible, /为什么值得看|需要保留的边界/);
  assert.doesNotMatch(output.lead, /不是.+而是/);
  assert.equal(output.reading_notes.omitted_evaluation_patch, true);
  assert.equal(output.notification_enabled, false);
});
