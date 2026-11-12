import * as cheerio from "cheerio";

export interface BankInfoData {
  fields: Record<string, { value: string; label: string }>;
  bankDetails: {
    bankName: string | null;
    branch: string | null;
    address: string | null;
  } | null;
}

export function parseBankInfo(html: string): BankInfoData {
  const $ = cheerio.load(html);
  const result: BankInfoData = {
    fields: {},
    bankDetails: null,
  };

  const form = $("#bankInfoStudentForm");
  const fieldLabels: Record<string, string> = {};

  form.find("table tr").each((_, row) => {
    const label = $(row).find("td").first().text().trim().replace(/\s+/g, " ");
    const input = $(row).find("input, select").first();
    const name = input.attr("name");
    if (name) fieldLabels[name] = label;
  });

  form.find("input, select").each((_, el) => {
    const name = $(el).attr("name");
    if (!name) return;
    const tag = ($(el).prop("tagName") || "").toLowerCase();
    const value =
      tag === "select"
        ? String($(el).val() || "")
        : String($(el).attr("value") || $(el).val() || "");
    result.fields[name] = {
      value: value.trim(),
      label: (fieldLabels[name] || name).trim(),
    };
  });

  const bankDetailsDiv = $("#ifscCodeBkFrag");
  if (bankDetailsDiv.length) {
    const lines: string[] = [];
    bankDetailsDiv.find("b").each((_, el) => {
      const t = $(el).text().trim();
      if (t) lines.push(t);
    });
    if (lines.length > 0) {
      result.bankDetails = {
        bankName: lines[0] || null,
        branch: lines[1] || null,
        address: lines[2] || null,
      };
    }
  }

  return result;
}
