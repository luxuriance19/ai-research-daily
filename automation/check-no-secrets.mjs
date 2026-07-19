import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "--all";

const blockedNames = [
  { name: "environment file", pattern: /(^|\/)\.env(?:\.|$)/i, allow: /\.(?:example|sample|template)$/i },
  { name: "Wrangler development secrets", pattern: /(^|\/)\.dev\.vars(?:\.|$)/i, allow: /\.(?:example|sample|template)$/i },
  { name: "private key or certificate bundle", pattern: /\.(?:pem|key|p12|pfx)$/i },
  { name: "private SSH key", pattern: /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i },
  { name: "credential JSON", pattern: /(^|\/)(?:credentials?|service-account|secrets?)[^/]*\.json$/i },
  { name: "local private configuration", pattern: /(^|\/)(?:config\.toml|wrangler\.local\.toml|config\.local\.[^/]+)$/i },
];

const tokenRules = [
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["OpenAI or Anthropic key", /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["Bearer credential", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["credential embedded in URL", /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];

const assignmentRule = /^\s*["']?([A-Za-z][A-Za-z0-9_.-]*(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|client[_-]?secret|app[_-]?secret|subscription[_-]?key|private[_-]?key|secret|password|cookie|session))["']?\s*[:=]\s*(.+?)\s*[,;]?\s*$/i;
const safeValue = /^(?:["']?(?:|true|false|null|undefined)["']?|\$\{\{.*\}\}|\$\{?[A-Z0-9_]+\}?|(?:process\.env|Deno\.env|os\.environ).*)$/i;
const placeholderValue = /(?:example|sample|placeholder|replace|redacted|dummy|your[_ -]|<[^>]+>|\*{4,}|secrets?\.|vars\.)/i;

function gitFiles() {
  const argsByMode = {
    "--staged": ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    "--tracked": ["ls-files", "--cached", "-z"],
    "--all": ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  };
  const args = argsByMode[mode];
  if (!args) {
    throw new Error(`Unsupported mode: ${mode}`);
  }
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function explicitFiles() {
  const requested = process.argv.slice(3);
  if (requested.length === 0) throw new Error("--paths requires at least one repository-relative path");
  const files = [];
  const visit = (absolute) => {
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("--paths may only scan files inside the repository");
    }
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute)) visit(path.join(absolute, entry));
      return;
    }
    files.push(relative);
  };
  for (const requestedPath of requested) visit(path.resolve(root, requestedPath));
  return files;
}

function historyFiles() {
  const commits = execFileSync("git", ["rev-list", "--all"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const records = [];
  for (const commit of commits) {
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", commit], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    for (const file of files) records.push({ commit, file });
  }
  return records;
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function scanText(file, text) {
  const findings = [];
  for (const [rule, pattern] of tokenRules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ file, line: lineNumber(text, match.index), rule });
    }
  }

  for (const [index, line] of text.split("\n").entries()) {
    const match = line.match(assignmentRule);
    if (!match) continue;
    const value = match[2].trim().replace(/^['"]|['"]$/g, "");
    if (value.length < 8 || safeValue.test(value) || placeholderValue.test(value)) continue;
    findings.push({ file, line: index + 1, rule: `literal value assigned to ${match[1]}` });
  }
  return findings;
}

function scanFile(file) {
  const normalized = file.split(path.sep).join("/");
  const filenameFinding = blockedNames.find(
    ({ pattern, allow }) => pattern.test(normalized) && !(allow?.test(normalized)),
  );
  if (filenameFinding) {
    return [{ file: normalized, line: null, rule: filenameFinding.name }];
  }

  const absolute = path.join(root, file);
  const stat = lstatSync(absolute);
  const buffer = stat.isSymbolicLink()
    ? Buffer.from(readlinkSync(absolute), "utf8")
    : readFileSync(absolute);
  if (buffer.subarray(0, 8192).includes(0)) return [];
  return scanText(normalized, buffer.toString("utf8"));
}

function scanHistory() {
  const findings = [];
  const scannedObjects = new Set();
  for (const { commit, file } of historyFiles()) {
    const normalized = file.split(path.sep).join("/");
    const filenameFinding = blockedNames.find(
      ({ pattern, allow }) => pattern.test(normalized) && !(allow?.test(normalized)),
    );
    if (filenameFinding) {
      findings.push({ file: `${commit.slice(0, 12)}:${normalized}`, line: null, rule: filenameFinding.name });
      continue;
    }
    const objectId = execFileSync("git", ["rev-parse", `${commit}:${file}`], { cwd: root, encoding: "utf8" }).trim();
    if (scannedObjects.has(objectId)) continue;
    scannedObjects.add(objectId);
    const buffer = execFileSync("git", ["cat-file", "blob", objectId], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 20 * 1024 * 1024,
    });
    if (buffer.subarray(0, 8192).includes(0)) continue;
    findings.push(
      ...scanText(`${commit.slice(0, 12)}:${normalized}`, buffer.toString("utf8")),
    );
  }
  return findings;
}

function selfTest() {
  const positive = [
    ["G" + "itHub", "TOKEN=" + "ghp_" + "a".repeat(36)],
    ["Cloudflare", "CLOUDFLARE_API_TOKEN=" + "a".repeat(40)],
    ["private key", "-----BEGIN " + "PRIVATE KEY-----"],
  ];
  const negative = [
    "CLOUDFLARE_API_TOKEN=${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "OPENAI_API_KEY=<replace-me>",
    "const token = process.env.GITHUB_TOKEN;",
  ];
  for (const [name, sample] of positive) {
    if (scanText("self-test", sample).length === 0) throw new Error(`missed ${name} sample`);
  }
  for (const sample of negative) {
    if (scanText("self-test", sample).length !== 0) throw new Error("placeholder false positive");
  }
  console.log("Secret scanner self-test passed.");
}

if (mode === "--self-test") {
  selfTest();
  process.exit(0);
}

const findings = mode === "--history"
  ? scanHistory()
  : [...new Set(mode === "--paths" ? explicitFiles() : gitFiles())].flatMap((file) => scanFile(file));
if (findings.length > 0) {
  console.error("Secret safety check failed. Values are intentionally redacted:");
  for (const { file, line, rule } of findings) {
    console.error(`- ${file}${line ? `:${line}` : ""} (${rule})`);
  }
  process.exit(1);
}

console.log(`Secret safety check passed (${mode}).`);
