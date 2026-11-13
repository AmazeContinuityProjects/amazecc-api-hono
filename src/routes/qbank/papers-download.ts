import { getDbPool } from "../../lib/db";
import { getWorkerEnv } from "../../env";
import { AwsClient } from "aws4fetch";

/** Port of src/app/api/qbank/papers/download/[paperId]/route.ts. Public. */
export async function GET(req: Request, ctx: { params: Promise<{ paperId: string }> }) {
  try {
    const { paperId } = await ctx.params;
    const pool = getDbPool();

    const { rows } = await pool.query(`SELECT * FROM papers_archive WHERE source_id = $1`, [paperId]);
    if (rows.length === 0) {
      return Response.json({ error: "Paper not found" }, { status: 404 });
    }

    const env = getWorkerEnv();
    const region = env.B2_REGION;
    const endpoint = env.B2_ENDPOINT?.replace(/\/+$/, "");
    const accessKeyId = env.B2_ACCESS_KEY_ID;
    const secretAccessKey = env.B2_SECRET_ACCESS_KEY;
    const bucket = env.B2_BUCKET_NAME;
    if (!region || !endpoint || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error("B2/R2 storage is not configured (B2_REGION, B2_ENDPOINT, B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY, B2_BUCKET_NAME)");
    }

    const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region });
    const key = `papers/${paperId}.pdf`;
    const s3Res = await client.fetch(`${endpoint}/${bucket}/${key}`);
    if (!s3Res.ok || !s3Res.body) {
      return Response.json({ error: "File not found in storage" }, { status: 404 });
    }

    const paper = rows[0];
    const filename = `${paper.course_code || "paper"}_${paper.exam_year || "year"}_${paper.exam_semester || "sem"}.pdf`.replace(/[^a-zA-Z0-9_.-]/g, "_");

    return new Response(s3Res.body, {
      headers: {
        "Content-Disposition": `inline; filename="${filename}"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error: unknown) {
    console.error("Paper download error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
