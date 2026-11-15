/**
 * GET /api/koha/search?q=&idx=&offset=&count= — Koha OPAC catalog search.
 *
 * Reads the OPAC RSS feed (opac-search.pl?format=rss) and normalizes the
 * catalog results. Public catalog data; no credentials.
 *
 * NOT MOUNTED: webopaccc is unreachable from Cloudflare's egress (connection
 * blackhole, verified 2026-11-14). Render upstream serves this today.
 */
import { Hono } from "hono";
import { XMLParser } from "fast-xml-parser";
import { publicErrorMessage } from "../../lib/publicError";
import { kohaOrigin } from "../../lib/koha";

export const kohaSearchRouter = new Hono();

kohaSearchRouter.get("/search", async (c) => {
  const params = new URL(c.req.raw.url).searchParams;
  const q = params.get("q") || "";
  const idx = params.get("idx") || "kw";
  const offset = Number.parseInt(params.get("offset") || "0", 10) || 0;
  const count = Math.min(Number.parseInt(params.get("count") || "20", 10) || 20, 100);

  if (!q.trim()) {
    return Response.json({ success: true, books: [], total: 0 });
  }

  const search = new URLSearchParams({
    idx,
    q,
    count: String(count),
    offset: String(offset),
    sort_by: "relevance",
    format: "rss",
  });

  try {
    const res = await fetch(`${kohaOrigin()}/cgi-bin/koha/opac-search.pl?${search.toString()}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AmazeCC/1.0)" },
    });
    if (!res.ok) {
      throw new Error(`Koha returned ${res.status}`);
    }
    const xml = await res.text();

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      isArray: (tag) => ["item", "channel", "rss"].includes(tag),
    });
    const parsed = parser.parse(xml);
    const channel = parsed?.rss?.[0]?.channel?.[0] ?? {};
    const total = Number.parseInt(channel?.["opensearch:totalResults"] ?? "0", 10) || 0;
    const rawItems: Record<string, unknown>[] = (channel?.item ?? []) as Record<string, unknown>[];

    const books = rawItems.map((item) => {
      const title = String(item.title ?? "").trim();
      const link = String(item.link ?? "");
      const biblionumber = link.match(/biblionumber=(\d+)/)?.[1] ?? "";
      const identifier = String(item["dc:identifier"] ?? "").replace(/^ISBN:/i, "");
      const desc = String(item.description ?? "");

      let author = "";
      let publisher = "";
      let coverUrl = "";

      const imgMatch = desc.match(/<img\s+src="([^"]+)"[^>]*\/?>/i);
      if (imgMatch) coverUrl = imgMatch[1];

      const byMatch = desc.match(/By\s+(.+?)\.\s+([\s\S]+?)\s+(\d{4})\b/i);
      if (byMatch) {
        author = byMatch[1].trim();
        publisher = `${byMatch[2].trim()} ${byMatch[3]}`.replace(/\s+/g, " ");
      }

      return { biblionumber, title, author, publisher, isbn: identifier, coverUrl };
    });

    return Response.json({ success: true, books, total, query: q, offset, count });
  } catch (err: unknown) {
    console.error("[koha] search error:", err instanceof Error ? err.message : String(err));
    return Response.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
});
