import { listDigests } from "@/lib/digests";

export async function GET() {
  const digests = await listDigests();
  return Response.json({ digests });
}
