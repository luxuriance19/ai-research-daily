import { env } from "cloudflare:workers";
import seedDigest from "@/data/seed.json";
import type { Digest } from "./types";

type RuntimeEnv = {
  DB?: D1Database;
  INGEST_TOKEN?: string;
};

const schemaSql = `CREATE TABLE IF NOT EXISTS digests (
  date TEXT PRIMARY KEY NOT NULL,
  generated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

function runtimeEnv(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

export function ingestToken(): string | undefined {
  return runtimeEnv().INGEST_TOKEN;
}

async function database(): Promise<D1Database | null> {
  const db = runtimeEnv().DB;
  if (!db) return null;
  await db.prepare(schemaSql).run();
  return db;
}

function parseDigest(value: string): Digest | null {
  try {
    return validateDigest(JSON.parse(value));
  } catch {
    return null;
  }
}

export function validateDigest(value: unknown): Digest {
  if (!value || typeof value !== "object") throw new Error("digest must be an object");
  const digest = value as Partial<Digest>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(digest.date ?? "")) throw new Error("invalid digest date");
  if (!Array.isArray(digest.papers) || digest.papers.length !== 5) {
    throw new Error("digest must contain exactly five papers");
  }
  const ids = new Set(digest.papers.map((paper) => paper.id));
  if (ids.size !== 5) throw new Error("paper IDs must be unique");
  if (!digest.companies || typeof digest.companies !== "object") {
    throw new Error("companies are required");
  }
  return digest as Digest;
}

export async function upsertDigest(digest: Digest): Promise<void> {
  const db = await database();
  if (!db) throw new Error("database is unavailable");
  await db
    .prepare(
      `INSERT INTO digests (date, generated_at, payload_json, updated_at)
       VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
       ON CONFLICT(date) DO UPDATE SET
         generated_at = excluded.generated_at,
         payload_json = excluded.payload_json,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(digest.date, digest.generated_at, JSON.stringify(digest))
    .run();
}

export async function listDigests(limit = 45): Promise<Digest[]> {
  try {
    const db = await database();
    if (!db) return [seedDigest as Digest];
    const result = await db
      .prepare("SELECT payload_json FROM digests ORDER BY date DESC LIMIT ?1")
      .bind(limit)
      .all<{ payload_json: string }>();
    const records = result.results
      .map((row) => parseDigest(row.payload_json))
      .filter((digest): digest is Digest => digest !== null);
    if (!records.some((digest) => digest.date === (seedDigest as Digest).date)) {
      records.push(seedDigest as Digest);
    }
    return records.sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [seedDigest as Digest];
  }
}
