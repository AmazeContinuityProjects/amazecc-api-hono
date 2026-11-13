import { requireSection } from"../../lib/auth";
import { getDbPool } from "../../lib/db";
import { getWorkerEnv } from "../../env";
import { storagePut, storageUnavailable } from "../../lib/storage";

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

/** Port of src/app/api/qbank/admin/import-to-storage/route.ts. */
export async function POST(req: Request) {
  const auth = await requireSection('qbank')(req);
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

    // Upload via the configured storage backend (R2 binding preferred, B2/S3 fallback)
    const key = `papers/${paperId}.pdf`;
    try {
      const ok = await storagePut(key, buffer, contentType);
      if (!ok) return storageUnavailable();
    } catch (uploadError: unknown) {
      console.error("Storage upload error:", uploadError);
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
