import * as cheerio from "cheerio";
import type { Element } from "domhandler";

export interface ParsedVtopPage {
  title: string;
  selectOptions: Record<string, { value: string; text: string; selected: boolean }[]>;
  tables: { caption?: string; headers: string[]; rows: Record<string, string>[] }[];
  keyValuePairs: Record<string, string>;
  formFields: Record<string, string>;
  hiddenFields: Record<string, string>;
  messages: { warning?: string; error?: string; success?: string };
}

export function parseVtopHtml(html: string): ParsedVtopPage {
  const $ = cheerio.load(html);
  const result: ParsedVtopPage = {
    title: "",
    selectOptions: {},
    tables: [],
    keyValuePairs: {},
    formFields: {},
    hiddenFields: {},
    messages: {},
  };

  result.title = $("h3.box-title").first().text().trim() || $("title").first().text().trim();

  $("input[type=hidden]").each((_, el) => {
    const name = $(el).attr("name") || $(el).attr("id") || "";
    const val = $(el).attr("value") || "";
    if (name) result.hiddenFields[name] = val;
  });

  $("select").each((_, el) => {
    const name = $(el).attr("name") || $(el).attr("id") || "select";
    const options: { value: string; text: string; selected: boolean }[] = [];
    $(el).find("option").each((_, opt) => {
      options.push({
        value: $(opt).attr("value") || "",
        text: $(opt).text().trim(),
        selected: $(opt).attr("selected") !== undefined,
      });
    });
    if (options.length > 0) result.selectOptions[name] = options;
  });

  $("input:not([type=hidden]), textarea").each((_, el) => {
    const name = $(el).attr("name") || $(el).attr("id") || "";
    const val = $(el).attr("value") || $(el).text().trim() || "";
    if (name) result.formFields[name] = val;
  });

  $("table").each((ti, table) => {
    const $table = $(table);
    const caption = $table.find("caption").first().text().trim() || undefined;
    const headers: string[] = [];
    const rows: Record<string, string>[] = [];

    // Find the header row: Look for the first row with multiple <th> or multiple <td> without massive colspans
    let $headerRow: cheerio.Cheerio<Element> | null = null;
    let headerRowIndex = 0;
    const trElements = $table.find("tr").toArray();
    for (let idx = 0; idx < trElements.length; idx++) {
      if ($headerRow) break;
      const tr = trElements[idx];
      const $tr = $(tr);
      const ths = $tr.find("th");
      const tds = $tr.find("td");
      // If it has actual <th> tags, it's likely the header
      if (ths.length > 1) {
        $headerRow = $tr;
        headerRowIndex = idx;
        break;
      }
      // Otherwise, if it has multiple <td>s and isn't just a title row (like <td colspan="10">)
      if (tds.length > 1) {
        let hasLargeColspan = false;
        const tdArray = tds.toArray();
        for (const td of tdArray) {
          if (parseInt($(td).attr("colspan") || "1", 10) > 3) {
            hasLargeColspan = true;
            break;
          }
        }
        if (!hasLargeColspan) {
          $headerRow = $tr;
          headerRowIndex = idx;
          break;
        }
      }
    }

    if (!$headerRow) return; // No valid header row found

    $headerRow.find("th, td").each((_: number, cell: unknown) => {
      const text = $(cell as Element).text().trim().replace(/\s+/g, " ");
      if (text) headers.push(text);
      else headers.push(`col${headers.length}`);
    });

    $table.find("tr").slice(headerRowIndex + 1).each((_: number, row: unknown) => {
      const rowData: Record<string, string> = {};
      let hasData = false;
      $(row as Element).find("td").each((i: number, cell: unknown) => {
        const text = $(cell as Element).text().trim().replace(/\s+/g, " ");
        if (text) {
          rowData[headers[i] || `col${i}`] = text;
          hasData = true;
        }
      });
      if (hasData) rows.push(rowData);
    });

    if (headers.length > 0 && rows.length > 0) {
      result.tables.push({ caption, headers, rows });
    }
  });

  $("table").first().find("tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length === 2) {
      const label = $(cells[0]).text().trim().replace(/\s+/g, " ");
      const value = $(cells[1]).text().trim();
      if (label && value && label !== value && !label.startsWith("<")) {
        result.keyValuePairs[camelCase(label)] = value;
      }
    }
  });

  const warning = $("input#warning, input[name=warning]").val() as string;
  const error = $("input#error, input[name=error]").val() as string;
  const success = $("input#success, input[name=success]").val() as string;
  if (warning) result.messages.warning = warning;
  if (error) result.messages.error = error;
  if (success) result.messages.success = success;

  return result;
}

function camelCase(str: string): string {
  return str.replace(/(?:^\w|[A-Z]|[-\s]\w)/g, (match, idx) =>
    idx === 0 ? match.toLowerCase() : match.toUpperCase()
  ).replace(/[-\s]/g, "");
}
