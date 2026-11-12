import * as cheerio from "cheerio";
import "./common";

export interface HodDeanPerson {
  role: string;
  details: Record<string, string>;
  photoBase64: string | null;
}

export interface HodDeanData {
  title: string;
  people: HodDeanPerson[];
}

export function parseHodDean(html: string): HodDeanData {
  const $ = cheerio.load(html);
  const result: HodDeanData = {
    title: $("h3.box-title b").first().text().trim(),
    people: [],
  };

  const tables = $("table.table");
  const headers = $("h3.box-title b, h3.box-title");

  tables.each((i, table) => {
    const $table = $(table);
    const role = headers.eq(i + 1).text().trim() || `Person ${i + 1}`;
    const photo = $table.find("img[src^='data:']").first().attr("src") || null;
    const details: Record<string, string> = {};

    $table.find("tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length >= 2) {
        const label = $(cells[0]).text().trim().replace(/\s+/g, " ");
        const value = $(cells[1]).text().trim();
        if (label && value && !label.includes("<") && !value.includes("<")) {
          if (label.toLowerCase().includes("name of the faculty") || label.toLowerCase().includes("name of the dean")) {
            details["name"] = value;
          } else if (label.toLowerCase().includes("email")) {
            details["email"] = value;
          } else if (label.toLowerCase().includes("mobile") || label.toLowerCase().includes("phone")) {
            details["phone"] = value;
          } else if (label.toLowerCase().includes("designation")) {
            details["designation"] = value;
          } else if (label.toLowerCase().includes("cabin")) {
            details["cabin"] = value;
          } else {
            details[camelCase(label)] = value;
          }
        }
      }
    });

    result.people.push({ role, details, photoBase64: photo });
  });

  return result;
}

function camelCase(str: string): string {
  return str.replace(/(?:^\w|[A-Z]|[-_\s]\w)/g, (match, idx) =>
    idx === 0 ? match.toLowerCase() : match.toUpperCase()
  ).replace(/[-_\s]/g, "");
}
