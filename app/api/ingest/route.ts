import { ingestToken, upsertDigest, validateDigest } from "@/lib/digests";

export async function POST(request: Request) {
  const expected = ingestToken();
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !provided || provided !== expected) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const digest = validateDigest(await request.json());
    await upsertDigest(digest);
    return Response.json({ ok: true, date: digest.date });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "invalid digest" },
      { status: 400 },
    );
  }
}
