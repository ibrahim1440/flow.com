import { NextResponse } from "@/lib/api-response";
import { mockReceivePresignedPut } from "@/lib/services/customers/file-store";

/**
 * PUT /api/system/blob-mock?x=/?pathname=…&vercel-blob-… — the LOCAL stand-in for Vercel Blob's
 * presigned upload, for builds started with CUSTOMER_FILES_BLOB_MOCK_DIR (tests, local previews) and
 * built with NEXT_PUBLIC_VERCEL_BLOB_API_URL=http://<host>/api/system/blob-mock?x= (the SDK appends
 * "/?pathname=…"; the "?x=" keeps the path free of the trailing "/" Next would redirect). 404 everywhere else, and always on Vercel (VERCEL=1).
 * No session: as at Blob, the presigned signature is the authorization (services/customers/file-store.ts
 * mockReceivePresignedPut checks it, the pathname, the expiry, size, type and no overwrite).
 */
export async function PUT(request: Request) {
  const env = process.env;
  if (!env.CUSTOMER_FILES_BLOB_MOCK_DIR?.trim() || env.VERCEL === "1") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = new Uint8Array(await request.arrayBuffer());
  const r = await mockReceivePresignedPut(env, new URL(request.url), request.headers, body);
  return NextResponse.json(r.body, { status: r.status });
}
