import { storageGet, storageMode, storageUnavailable } from "../../lib/storage";
import { ensureQbankInD1 } from "../../lib/qbankD1";

/** Port of src/app/api/qbank/papers/download/[paperId]/route.ts. Public. */
export async function GET(req: Request, ctx: { params: Promise<{ paperId: string }> }) {
  try {
    const { paperId } = await ctx.params;
    if (storageMode() === null) return storageUnavailable();

    const db = await ensureQbankInD1();
    const paper = await db.prepare(`SELECT * FROM papers_archive WHERE source_id = ?`)
      .bind(paperId).first<Record<string, any>>();
    if (!paper) {
      return Response.json({ error: "Paper not found" }, { status: 404 });
    }

    const { body, contentType } = (await storageGet(`papers/${paperId}.pdf`)) ?? {};
    if (!body) {
      return Response.json({ error: "File not found in storage" }, { status: 404 });
    }

    const filename = `${paper.course_code || "paper"}_${paper.exam_year || "year"}_${paper.exam_semester || "sem"}.pdf`.replace(/[^a-zA-Z0-9_.-]/g, "_");

    return new Response(body, {
      headers: {
        "Content-Disposition": `inline; filename="${filename}"`,
        "Content-Type": contentType ?? "application/pdf",
      },
    });
  } catch (error: unknown) {
    console.error("Paper download error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
