import * as cheerio from "cheerio";
import { odDetails, odItem } from "../../types/data/od";

function clean(text: string): string {
  return text
    .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses the `#Details` fragment returned by
 * POST /vtop/searchStudentOdDetails (VTOP "Student OD Details").
 *
 * Table #example1 columns:
 *   Sl.No | Type | Reason | Basis | Date | Time | Remarks
 * Followed by an OD-count note + "Total Count : N" badge.
 * Empty state is a `.alert-warning` ("No records found.").
 */
export function parseOdDetails(html: string, semesterId: string): odDetails {
  const $ = cheerio.load(html);
  const records: odItem[] = [];

  $("#example1 tbody tr").each((_, row) => {
    const cols = $(row).find("td");
    if (cols.length < 7) return;
    records.push({
      slNo: clean(cols.eq(0).text()),
      type: clean(cols.eq(1).text()),
      reason: clean(cols.eq(2).text()),
      basis: clean(cols.eq(3).text()),
      date: clean(cols.eq(4).text()),
      time: clean(cols.eq(5).text()),
      remarks: clean(cols.eq(6).text()),
    });
  });

  const note = clean($("h5.fw-bold.text-primary").first().text()) || null;

  let totalCount = records.length;
  const badgeText = $("span.badge").first().text();
  const countMatch = badgeText.match(/Total\s*Count\s*:\s*(\d+)/i);
  if (countMatch) totalCount = parseInt(countMatch[1], 10);

  return { semesterId, totalCount, note, records };
}
