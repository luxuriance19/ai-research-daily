#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.cloudflare.com/client/v4";

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  if (response.ok) return { response, body: await response.json() };
  return { response, body: null };
}

export async function ensureCloudflarePagesProject({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
  projectName = process.env.CLOUDFLARE_PAGES_PROJECT || "frontier-signals-ai-daily",
  productionBranch = "main",
  fetchImpl = fetch,
} = {}) {
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required");
  if (!/^[a-z0-9-]+$/.test(projectName)) throw new Error("invalid Cloudflare Pages project name");

  const encodedAccount = encodeURIComponent(accountId);
  const encodedProject = encodeURIComponent(projectName);
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${apiToken}`,
  };
  const projectUrl = `${API_ROOT}/accounts/${encodedAccount}/pages/projects/${encodedProject}`;
  const existing = await requestJson(fetchImpl, projectUrl, { headers });
  if (existing.response.ok) {
    return { status: "existing", project_name: projectName };
  }
  if (existing.response.status !== 404) {
    throw new Error(`Cloudflare Pages lookup failed with HTTP ${existing.response.status}`);
  }

  const collectionUrl = `${API_ROOT}/accounts/${encodedAccount}/pages/projects`;
  const created = await requestJson(fetchImpl, collectionUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: projectName, production_branch: productionBranch }),
  });
  if (!created.response.ok) {
    throw new Error(`Cloudflare Pages creation failed with HTTP ${created.response.status}`);
  }
  return { status: "created", project_name: projectName };
}

async function main() {
  const result = await ensureCloudflarePagesProject();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Cloudflare Pages setup failed"}\n`);
    process.exitCode = 1;
  });
}
