import { requireAdminAuth } from "../../lib/auth";
import { getDbPool } from "../../lib/db";
import { getWorkerEnv } from "../../env";
import { AwsClient } from "aws4fetch";

const UA = "mozilla/5.0 (windows nt 10.0; win64; x64) applewebkit/537.36 (khtml, like gecko) chrome/91.0.4472.124 safari/537.36";

function getDirectDownloadUrl(url: string): string {
  if (url.includes("drive.google.com")) {
    const fileIdMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (fileIdMatch && fileIdMatch[1]) {
      return `https://docs.google.com/uc?export=download&id=${fileIdMatch[1]}`;
    }
  }
  return url;
}

function storageConfig() {
  const env = getWorkerEnv();
  const region = env.B2_REGION;
  const endpoint = env.B2_ENDPOINT;
  const accessKeyId = env.B2_ACCESS_KEY_ID;
  const secretAccessKey = env.B2_SECRET_ACCESS_KEY;
  const bucket = env.B2_BUCKET_NAME;
  if (!region || !endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("B2/R2 storage is not configured (B2_REGION, B2_ENDPOINT, B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY, B2_BUCKET_NAME)");
  }
  return { region, endpoint: endpoint.replace(/\/+$/, ""), accessKeyId, secretAccessKey, bucket };
}

/** Port of src/app/api/qbank/admin/import-to-storage/route.ts. */
export async function POST(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const { paperId } = (await req.json()) as any;
    if (!paperId) {
      return Response.json({ success: false, error: "paperId required" }, { status: 400 });
    }

    const pool = getDbPool();
    const { rows } = await pool.query(`SELECT * FROM papers_archive WHERE source_id = $1`, [paperId]);
    if (rows.length === 0) {
      return Response.json({ success: false, error: "Paper not found" }, { status: 404 });
    }

    const paper = rows[0];
    const remoteUrl = paper.file_url;
    if (!remoteUrl || remoteUrl === "DIRECT_JSON") {
      return Response.json({ success: false, error: "Paper does not have a downloadable file URL" }, { status: 400 });
    }

    const downloadUrl = getDirectDownloadUrl(remoteUrl);
    let response: Response;
    try {
      response = await fetch(downloadUrl, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`upstream responded ${response.status}`);
    } catch (downloadError: unknown) {
      console.error(`Failed to download file from ${downloadUrl}:`, downloadError);
      return Response.json(
        { success: false, error: `Failed to download file from remote host: ${(downloadError instanceof Error ? downloadError.message : String(downloadError))}` },
        { status: 502 }
      );
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "application/pdf";

    // Upload to R2/B2 (S3-compatible, path-style)
    const { region, endpoint, accessKeyId, secretAccessKey, bucket } = storageConfig();
    const key = `papers/${paperId}.pdf`;
    try {
      const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region });
      const putRes = await client.fetch(`${endpoint}/${bucket}/${key}`, {
        method: "PUT",
        body: buffer,
        headers: { "content-type": contentType },
      });
      if (!putRes.ok) throw new Error(`storage responded ${putRes.status}`);
    } catch (uploadError: unknown) {
      console.error("R2 storage upload error:", uploadError);
      return Response.json(
        { success: false, error: `Storage upload failed: ${(uploadError instanceof Error ? uploadError.message : String(uploadError))}` },
        { status: 500 }
      );
    }

    const proto = req.headers.get("x-forwarded-proto") || "https";
    const host = req.headers.get("host") || "hono.amazecc.com";
    const publicUrl = `${proto}://${host}/api/qbank/papers/download/${paperId}`;

    await pool.query(
      `UPDATE papers_archive
         SET file_url = $1, file_size = $2, storage_provider = 'R2', source_type = 'UPLOAD'
       WHERE source_id = $3`,
      [publicUrl, buffer.byteLength, paperId]
    );

    return Response.json({ success: true, fileUrl: publicUrl, fileSize: buffer.byteLength });
  } catch (error: unknown) {
    console.error("Import to storage error:", error);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
