#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = resolve(AUTOMATION_DIR, "..");
const HEALTHY_STATUSES = new Set(["fresh", "not-modified", "reused-fresh-snapshot"]);
const MAX_HISTORY_DAYS = 14;
const REQUIRED_REVIEW_DAYS = 7;

const list = (value) => Array.isArray(value) ? value : [];
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

function shanghaiDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid generated_at: ${value}`);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function recordSourceIds(record) {
  return new Set([
    record?.source_id,
    record?.existing_source_id,
    ...list(record?.source_ids),
    ...list(record?.source_records).map((item) => item?.source_id),
  ].filter(Boolean));
}

function countAttributions(records, sourceId) {
  return list(records).filter((record) => recordSourceIds(record).has(sourceId)).length;
}

function sourceRole(lane, source) {
  if (lane === "technology-attention") {
    return String(source.role || "").includes("official") ? "official-release-discovery" : "attention-only";
  }
  if (lane === "model-compute") {
    if (source.role === "community-attention-fallback") return "attention-only";
    if (String(source.role || "").includes("official")) return "official-discovery";
    return "artifact-discovery";
  }
  if (source.lane === "paper-discovery") return "attention-paper-discovery";
  if (source.lane === "paper-primary") return "primary-paper-index";
  if (source.official === true) return "official-primary-or-contract";
  return "research-or-artifact-discovery";
}

function priorHistory(previous, sourceId, reportDate) {
  if (!previous) return [];
  if (previous.mode !== "discovery-source-quality-scorecard") throw new Error("invalid previous source scorecard mode");
  const prior = list(previous.sources).find((source) => source.id === sourceId);
  const seen = new Set();
  return list(prior?.daily_history)
    .filter((day) => typeof day?.date === "string" && day.date <= reportDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((day) => !seen.has(day.date) && seen.add(day.date))
    .slice(-MAX_HISTORY_DAYS);
}

function consecutiveHealthyDays(history) {
  let count = 0;
  let expected = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const day = history[index];
    if (day.health !== "healthy") break;
    const parsed = Date.parse(`${day.date}T00:00:00.000Z`);
    if (!Number.isFinite(parsed)) break;
    if (expected !== null && parsed !== expected - 86_400_000) break;
    expected = parsed;
    count += 1;
  }
  return count;
}

function appendDailyHistory(previous, sourceId, reportDate, current) {
  const history = priorHistory(previous, sourceId, reportDate).filter((day) => day.date !== reportDate);
  history.push({ date: reportDate, ...current });
  return history.slice(-MAX_HISTORY_DAYS);
}

function nativeObservationDays(lane, sourceId, audits) {
  if (lane === "technology-attention") {
    return list(audits.tech.source_history).find((item) => item.source_id === sourceId)?.consecutive_fresh_days ?? null;
  }
  if (lane === "model-compute") {
    return list(audits.model.source_histories).find((item) => item.source_id === sourceId)?.consecutive_clean_days ?? null;
  }
  return null;
}

function laneRecords(lane, audits) {
  if (lane === "mechanism") return {
    current: audits.mechanism.daily_current_window_records,
    exclusions: [],
  };
  if (lane === "technology-attention") return {
    current: audits.tech.daily_current_window_review,
    exclusions: audits.tech.daily_editorial_exclusions,
  };
  return {
    current: audits.model.daily_current_window_review,
    exclusions: audits.model.daily_editorial_exclusions,
  };
}

function eventMetrics(lane, event) {
  if (lane === "mechanism") return {
    items_parsed: Number(event?.items_parsed || 0),
    ai_items: null,
    queue_candidates: null,
  };
  if (lane === "technology-attention") return {
    items_parsed: Number(event?.items_parsed || 0),
    ai_items: Number(event?.ai_items || 0),
    queue_candidates: Number(event?.queue_candidates || 0),
  };
  return {
    items_parsed: list(event?.items).length,
    ai_items: null,
    queue_candidates: Number(event?.current_window_items || 0),
  };
}

function buildLaneSources(lane, audit, audits, previous, reportDate) {
  const events = new Map(list(audit.source_events).map((event) => [event.source_id, event]));
  const records = laneRecords(lane, audits);
  return list(audit.source_registry).map((source) => {
    const event = events.get(source.id) || {};
    const health = HEALTHY_STATUSES.has(event.status) ? "healthy" : "degraded";
    const currentWindow = countAttributions(records.current, source.id);
    const exclusions = countAttributions(records.exclusions, source.id);
    const eligible = countAttributions(audits.top.eligible_candidates, source.id);
    const selected = countAttributions(audits.top.selected_top3, source.id);
    const parsed = eventMetrics(lane, event);
    const dailyHistory = appendDailyHistory(previous, source.id, reportDate, {
      health,
      status: event.status || "missing",
      items_parsed: parsed.items_parsed,
      current_window_attributions: currentWindow,
      editorial_exclusion_attributions: exclusions,
      eligible_candidate_attributions: eligible,
      selected_top3_attributions: selected,
    });
    const qualityDays = consecutiveHealthyDays(dailyHistory);
    const nativeDays = nativeObservationDays(lane, source.id, audits);
    const reviewReady = health === "healthy" && qualityDays >= REQUIRED_REVIEW_DAYS;
    const recommendation = health !== "healthy"
      ? "repair-before-role-review"
      : reviewReady
        ? "await-human-role-review"
        : selected > 0
          ? "retain-current-role-high-signal-observation"
          : "continue-silent-observation";
    return {
      id: source.id,
      label: source.label,
      lane,
      quality_role: sourceRole(lane, source),
      configured_tier: source.tier || source.authority_tier || null,
      official: source.official === true || String(source.role || "").includes("official"),
      discovery_only: source.discovery_only === true || lane !== "mechanism",
      health: {
        state: health,
        source_status: event.status || "missing",
        network_fresh: event.network_fresh ?? (HEALTHY_STATUSES.has(event.status) ? true : false),
        error: event.error || null,
      },
      observation: {
        scorecard_consecutive_healthy_days: qualityDays,
        native_source_history_days: nativeDays,
        required_days_for_role_review: REQUIRED_REVIEW_DAYS,
        ready_for_human_role_review: reviewReady,
      },
      today: {
        ...parsed,
        current_window_attributions: currentWindow,
        editorial_exclusion_attributions: exclusions,
        eligible_candidate_attributions: eligible,
        selected_top3_attributions: selected,
      },
      recommendation,
      automatic_role_change: false,
      notification_eligible: false,
      daily_history: dailyHistory,
    };
  });
}

function reportFingerprint(report) {
  const clone = structuredClone(report);
  delete clone.report_fingerprint;
  return sha256(JSON.stringify(clone));
}

export function buildSourceQualityScorecard({ mechanism, tech, model, top, previous = null }) {
  const audits = { mechanism, tech, model, top };
  const generatedValues = [mechanism.generated_at, tech.generated_at, model.generated_at, top.generated_at];
  const generatedAt = new Date(Math.max(...generatedValues.map((value) => Date.parse(value)))).toISOString();
  const reportDate = shanghaiDate(generatedAt);
  const sources = [
    ...buildLaneSources("mechanism", mechanism, audits, previous, reportDate),
    ...buildLaneSources("technology-attention", tech, audits, previous, reportDate),
    ...buildLaneSources("model-compute", model, audits, previous, reportDate),
  ].sort((left, right) => left.lane.localeCompare(right.lane) || left.id.localeCompare(right.id));
  if (sources.length !== 48 || new Set(sources.map((source) => source.id)).size !== 48) {
    throw new Error(`source quality scorecard requires exactly 48 unique discovery sources; received ${sources.length}`);
  }
  const report = {
    schema_version: 1,
    mode: "discovery-source-quality-scorecard",
    generated_at: generatedAt,
    report_date: reportDate,
    status: sources.some((source) => source.health.state !== "healthy") ? "degraded" : "ok",
    policy: {
      authority_and_attention_separate: true,
      minimum_silent_days_for_role_review: REQUIRED_REVIEW_DAYS,
      automatic_pruning_enabled: false,
      automatic_promotion_enabled: false,
      ranking_impact: "none",
      notification_enabled: false,
      publishing_enabled: false,
      human_decision_required: true,
    },
    input_snapshots: {
      mechanism: mechanism.generated_at,
      technology_attention: tech.generated_at,
      model_compute: model.generated_at,
      unified_top3: top.generated_at,
    },
    summary: {
      registered_sources: sources.length,
      healthy_sources: sources.filter((source) => source.health.state === "healthy").length,
      degraded_sources: sources.filter((source) => source.health.state !== "healthy").length,
      attention_only_sources: sources.filter((source) => source.quality_role.includes("attention")).length,
      current_window_endpoint_attributions: sources.reduce((sum, source) => sum + source.today.current_window_attributions, 0),
      editorial_exclusion_endpoint_attributions: sources.reduce((sum, source) => sum + source.today.editorial_exclusion_attributions, 0),
      eligible_candidate_contributors: sources.filter((source) => source.today.eligible_candidate_attributions > 0).length,
      selected_top3_contributors: sources.filter((source) => source.today.selected_top3_attributions > 0).length,
      selected_stories: list(top.selected_top3).length,
      selected_story_ids: list(top.selected_top3).map((story) => story.story_id).sort(),
      ready_for_human_role_review: sources.filter((source) => source.observation.ready_for_human_role_review).length,
      automatic_role_changes: 0,
      notification_eligible_records: 0,
    },
    sources,
  };
  report.report_fingerprint = reportFingerprint(report);
  return report;
}

export function verifySourceQualityScorecard(report) {
  const errors = [];
  if (report?.mode !== "discovery-source-quality-scorecard") errors.push("invalid scorecard mode");
  if (list(report?.sources).length !== 48 || new Set(list(report?.sources).map((source) => source.id)).size !== 48) errors.push("scorecard must contain 48 unique sources");
  if (report?.policy?.authority_and_attention_separate !== true) errors.push("authority and attention must remain separate");
  if (report?.policy?.automatic_pruning_enabled !== false || report?.policy?.automatic_promotion_enabled !== false) errors.push("automatic source role changes must remain disabled");
  if (report?.policy?.ranking_impact !== "none") errors.push("scorecard must not affect ranking");
  if (report?.policy?.notification_enabled !== false || report?.policy?.publishing_enabled !== false) errors.push("scorecard notification and publishing must remain disabled");
  if (report?.summary?.automatic_role_changes !== 0 || report?.summary?.notification_eligible_records !== 0) errors.push("scorecard cannot expose automatic actions");
  if (list(report?.summary?.selected_story_ids).length !== report?.summary?.selected_stories || new Set(list(report?.summary?.selected_story_ids)).size !== report?.summary?.selected_stories) errors.push("scorecard selected story identities invalid");
  for (const source of list(report?.sources)) {
    if (source.automatic_role_change !== false || source.notification_eligible !== false) errors.push(`source action boundary violated: ${source.id}`);
    const dates = list(source.daily_history).map((day) => day.date);
    if (dates.length > MAX_HISTORY_DAYS || dates.some((date, index) => index > 0 && date <= dates[index - 1])) errors.push(`invalid source history: ${source.id}`);
    if (dates.some((date) => date > report.report_date)) errors.push(`future source history: ${source.id}`);
    const expectedDays = consecutiveHealthyDays(source.daily_history);
    if (source.observation?.scorecard_consecutive_healthy_days !== expectedDays) errors.push(`source stability mismatch: ${source.id}`);
    if (source.observation?.ready_for_human_role_review !== (source.health?.state === "healthy" && expectedDays >= REQUIRED_REVIEW_DAYS)) errors.push(`source review gate mismatch: ${source.id}`);
  }
  if (report?.report_fingerprint !== reportFingerprint(report)) errors.push("scorecard fingerprint mismatch");
  return { ok: errors.length === 0, errors };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.pending`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

export async function runSourceQualityProjection({
  mechanismPath = resolve(WEBSITE_DIR, "work/mechanism-watch/audit.json"),
  techPath = resolve(WEBSITE_DIR, "work/tech-discovery-probe/audit.json"),
  modelPath = resolve(WEBSITE_DIR, "work/model-compute-source-probe/audit.json"),
  topPath = resolve(WEBSITE_DIR, "work/unified-top3-replay/audit.json"),
  outputPath = resolve(WEBSITE_DIR, "data/source-quality-latest.json"),
} = {}) {
  const [mechanism, tech, model, top] = await Promise.all([readJson(mechanismPath), readJson(techPath), readJson(modelPath), readJson(topPath)]);
  let previous = null;
  try {
    previous = await readJson(outputPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const report = buildSourceQualityScorecard({ mechanism, tech, model, top, previous });
  const verification = verifySourceQualityScorecard(report);
  if (!verification.ok) throw new Error(`source quality scorecard rejected: ${verification.errors.join("; ")}`);
  await atomicJson(outputPath, report);
  return report;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  runSourceQualityProjection().then((report) => {
    process.stdout.write(`${JSON.stringify({ status: report.status, sources: report.summary.registered_sources, healthy: report.summary.healthy_sources, selected_contributors: report.summary.selected_top3_contributors, review_ready: report.summary.ready_for_human_role_review }, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
