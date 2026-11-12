import * as cheerio from "cheerio";

export function extractKeyValueTable($: cheerio.CheerioAPI, tableSelector = "table.table"): Record<string, string> {
  const result: Record<string, string> = {};
  $(tableSelector).first().find("tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length >= 2) {
      const label = $(cells[0]).text().trim().replace(/\s+/g, " ");
      const value = $(cells[1]).text().trim();
      if (label && value && !label.includes("<") && !value.includes("<")) {
        result[camelCase(label)] = value;
      }
    }
  });
  return result;
}

export function extractBase64Photo($: cheerio.CheerioAPI): string | null {
  const img = $("img[src^='data:']").first();
  return img.length ? img.attr("src") || null : null;
}

export function parseSimpleTable(html: string): { headers: string[]; rows: Record<string, string>[] } {
  const $ = cheerio.load(html);
  const headers: string[] = [];
  const rows: Record<string, string>[] = [];
  const $table = $("table").first();
  $table.find("tr").first().find("th, td").each((_, cell) => {
    headers.push($(cell).text().trim());
  });
  $table.find("tr").slice(1).each((_, row) => {
    const rowData: Record<string, string> = {};
    $(row).find("td").each((i, cell) => {
      rowData[headers[i] || `col${i}`] = $(cell).text().trim();
    });
    if (Object.keys(rowData).length > 0) rows.push(rowData);
  });
  return { headers, rows };
}

function camelCase(str: string): string {
  return str.replace(/(?:^\w|[A-Z]|[-_\s]\w)/g, (match, idx) =>
    idx === 0 ? match.toLowerCase() : match.toUpperCase()
  ).replace(/[-_\s]/g, "");
}
