import * as cheerio from "cheerio";

export interface ProctorData {
  title: string;
  photoBase64: string | null;
  details: Record<string, string>;
}

export function parseProctor(html: string): ProctorData {
  const $ = cheerio.load(html);
  const result: ProctorData = {
    title: $("h3.box-title b").first().text().trim(),
    photoBase64: null,
    details: {},
  };

  const img = $("table.table img[src^='data:']").first();
  if (img.length) {
    result.photoBase64 = img.attr("src") || null;
  }

  $("table.table tr").each((_, row) => {
    const cells = $(row).find("td");
    const labelCell = cells.first();
    const valueCell = cells.eq(1);
    if (cells.length >= 2 && labelCell.length && valueCell.length) {
      const label = labelCell.text().trim().replace(/\s+/g, " ");
      const value = valueCell.text().trim();
      if (label && value) {
        if (label.toLowerCase().includes("faculty name")) {
          result.details["name"] = value;
        } else if (label.toLowerCase().includes("faculty email")) {
          result.details["email"] = value;
        } else if (label.toLowerCase().includes("faculty mobile") || label.toLowerCase().includes("mobile number")) {
          result.details["phone"] = value;
        } else if (label.toLowerCase().includes("faculty designation") || label.toLowerCase().includes("designation")) {
          result.details["designation"] = value;
        } else {
          result.details[camelCase(label)] = value;
        }
      }
    }
  });

  return result;
}

function camelCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^./, (c) => c.toLowerCase());
}
