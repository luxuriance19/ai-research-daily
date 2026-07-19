import assert from "node:assert/strict";
import test from "node:test";
import { ensureCloudflarePagesProject } from "../automation/ensure-cloudflare-pages.mjs";

function response(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

test("reuses an existing Cloudflare Pages project without creating another", async () => {
  const calls = [];
  const result = await ensureCloudflarePagesProject({
    accountId: "account-id",
    apiToken: "token-" + "x".repeat(30),
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(200, { success: true });
    },
  });
  assert.deepEqual(result, { status: "existing", project_name: "frontier-signals-ai-daily" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].method, undefined);
});

test("creates the fixed project only after a 404 lookup", async () => {
  const calls = [];
  const result = await ensureCloudflarePagesProject({
    accountId: "account-id",
    apiToken: "token-" + "x".repeat(30),
    fetchImpl: async (...args) => {
      calls.push(args);
      return calls.length === 1 ? response(404) : response(200, { success: true });
    },
  });
  assert.deepEqual(result, { status: "created", project_name: "frontier-signals-ai-daily" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    name: "frontier-signals-ai-daily",
    production_branch: "main",
  });
});

test("failure messages never include the API token or response body", async () => {
  const apiToken = "token-" + "x".repeat(30);
  await assert.rejects(
    ensureCloudflarePagesProject({
      accountId: "account-id",
      apiToken,
      fetchImpl: async () => response(403, { errors: [{ message: apiToken }] }),
    }),
    (error) => !error.message.includes(apiToken) && error.message === "Cloudflare Pages lookup failed with HTTP 403",
  );
});
