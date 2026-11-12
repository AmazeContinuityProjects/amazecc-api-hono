import * as cheerio from "cheerio";
import type { Element } from "domhandler";

export interface CurriculumCategory {
  code: string;
  name: string;
  credits: number;
  maxCredits: number;
}

export interface CurriculumBasketItem {
  code: string;
  name: string;
  credits: number;
  type?: string;
}

export interface CurriculumBasket {
  title: string;
  credits: number;
  items: CurriculumBasketItem[];
}

export interface CategoryDetail {
  code: string;
  name: string;
  baskets: CurriculumBasket[];
}

export interface CurriculumData {
  title: string;
  totalCredits: number;
  categories: CurriculumCategory[];
  details: CategoryDetail[];
}

export function parseCurriculum(html: string): CurriculumData {
  const $ = cheerio.load(html);
  const result: CurriculumData = {
    title: $("h3").first().text().trim(),
    totalCredits: 0,
    categories: [],
    details: [],
  };

  const totalText = $("span:contains('Total Credits:')").text().trim();
  const totalMatch = totalText.match(/Total Credits:\s*(\d+)/);
  if (totalMatch) result.totalCredits = parseInt(totalMatch[1]);

  $(".categoty-card").each((_, card) => {
    const $card = $(card);
    const onclick = $card.find("[onclick]").attr("onclick") || "";
    const codeMatch = onclick.match(/categoryOnClick\('([^']+)'\)/);
    const code = codeMatch ? codeMatch[1] : $card.find(".symbol-label").first().text().trim().split("\n")[0].trim();
    const name = $card.find(".text-sm").text().trim();
    const creditText = $card.find("small:contains('Credit:')").parent().text();
    const maxCreditText = $card.find("small:contains('Max. Credit:')").parent().text();
    const credits = parseInt(creditText.match(/Credit:\s*(\d+)/)?.[1] || "0");
    const maxCredits = parseInt(maxCreditText.match(/Max.\s*Credit:\s*(\d+)/)?.[1] || "0");

    result.categories.push({ code, name, credits, maxCredits });
    result.details.push({ code, name, baskets: [] });
  });

  return result;
}

export function extractPageCsrf(html: string): string | null {
  const $ = cheerio.load(html);
  const val = $('input[name="_csrf"]').first().val();
  return typeof val === "string" ? val : null;
}

export function parseCurriculumCategoryView(html: string): CurriculumBasket[] {
  const $ = cheerio.load(html);
  const baskets: CurriculumBasket[] = [];

  $("script, style").remove();

  // Strategy 1: Bootstrap tabs layout — nav-tabs + tab-content
  const tabButtons = $(".nav-tabs button, .nav-tabs a, [role=tab]");
  if (tabButtons.length > 0) {
    tabButtons.each((_, btn) => {
      const $btn = $(btn);
      const title = $btn.text().trim();
      if (!title) return;
      const targetId = $btn.attr("data-bs-target") || $btn.attr("href") || "";
      const paneId = targetId.replace(/^#/, "");
      let $pane = paneId ? $(`#${paneId}`) : $();
      if (!$pane.length) {
        const idx = tabButtons.toArray().indexOf(btn);
        $pane = $(".tab-pane").eq(idx);
      }
      const $table = $pane.find("table").first();
      if ($table.length && $table.find("tr").length > 1) {
        baskets.push(parseTable($, $table, title));
      }
    });
  }

  // Strategy 2: Card-based layout
  if (baskets.length === 0) {
    $(".card, .panel, [class*=card]").each((_, el) => {
      const $el = $(el);
      const headerText = $el.find(">.card-header, >.panel-heading, >.card-heading, >.header").first().text().trim();
      const $table = $el.find(">.card-body table, >.panel-body table, >.body table, table").first();
      if ($table.length && $table.find("tr").length > 1) {
        baskets.push(parseTable($, $table, headerText || `Group ${baskets.length + 1}`));
      }
    });
  }

  // Strategy 3: Headings followed by table
  if (baskets.length === 0) {
    $("h4, h5, h6, strong.heading, .section-title, .group-label").each((_, el) => {
      const title = $(el).text().trim();
      if (!title) return;
      let $table = $(el).nextAll("table").first();
      if (!$table.length) $table = $(el).parent().find("table").first();
      if ($table.length && $table.find("tr").length > 1) {
        if (!baskets.some(b => b.title === title)) {
          baskets.push(parseTable($, $table, title));
        }
      }
    });
  }

  // Strategy 4: Direct tables
  if (baskets.length === 0) {
    $("table").each((_, tableEl) => {
      const $table = $(tableEl);
      if ($table.find("tr").length <= 1) return;
      const caption = $table.find("caption").first().text().trim();
      const firstRowCells = $table.find("tr").first().find("td, th");
      let title = caption;
      if (!title && firstRowCells.length === 1 && firstRowCells.attr("colspan")) {
        title = firstRowCells.text().trim();
      }
      if (!title) {
        const prev = $table.prev();
        if (prev.length) title = prev.text().trim();
      }
      baskets.push(parseTable($, $table, title || `Basket ${baskets.length + 1}`));
    });
  }

  return baskets;
}

function parseTable($: cheerio.CheerioAPI, $table: cheerio.Cheerio<Element>, title: string): CurriculumBasket {
  const items: CurriculumBasketItem[] = [];

  // First, build a map of dtr-data values per row from DataTables responsive details
  // Each <li class="dtr-details"> contains <li> with dtr-title & dtr-data spans
  const dtrRows: Record<number, Record<string, string>> = {};

  // Detect DataTables responsive row details
  $table.find("ul.dtr-details, .dtr-details").each((_, ul) => {
    const $ul = $(ul);
    const rowIdx = parseInt($ul.closest("tr").data("dt-row")?.toString() || "-1");
    if (rowIdx < 0) return;
    if (!dtrRows[rowIdx]) dtrRows[rowIdx] = {};
    $ul.find("li").each((_, li) => {
      const $li = $(li);
      const colIdx = parseInt($li.attr("data-dtr-index") || "-1");
      const titleText = $li.find(".dtr-title").text().trim().toLowerCase();
      const dataText = $li.find(".dtr-data").text().trim();
      if (colIdx >= 0) dtrRows[rowIdx][titleText] = dataText;
    });
  });

  // Parse the table header
  const $headerRow = $table.find("tr").first();
  const headers: string[] = [];
  const firstRowIsHeader = $headerRow.find("th").length > 0 ||
    ($headerRow.find("td").length === 1 && $headerRow.find("td").attr("colspan"));

  $headerRow.find("th, td").each((_, cell) => {
    const text = $(cell).text().trim();
    const colspan = $(cell).attr("colspan");
    if (text && !colspan && headers.length < 10) headers.push(text);
  });

  // Map column indices
  let codeIdx = -1, nameIdx = -1, creditIdx = -1, typeIdx = -1;
  headers.forEach((h, i) => {
    const hLower = h.toLowerCase();
    if (/course\s*(code|no)|s\.?no|#|code|paper\s*code/i.test(hLower)) codeIdx = i;
    else if (/course\s*name|subject|title|paper/i.test(hLower)) nameIdx = i;
    else if (/credit|cr/i.test(hLower)) creditIdx = i;
    else if (/type|category|mode/i.test(hLower)) typeIdx = i;
  });

  // Parse data rows
  $table.find("tr").each((ri, row) => {
    if (ri === 0 && firstRowIsHeader) return;
    const cells = $(row).find("td");
    if (cells.length < 1) return;
    if (cells.length === 1 && $(cells[0]).attr("colspan")) return;

    const cellTexts = cells.map((_, cell) => $(cell).text().trim()).get();

    // Get dtr-data for this row
    const dtrIdx = parseInt($(row).data("dt-row")?.toString() || "-1");
    const dtrData = dtrIdx >= 0 ? dtrRows[dtrIdx] : undefined;

    let courseCode = "", courseName = "", courseType = "", creditsStr = "";

    // Priority: dtr-data values are most reliable (responsive detail rows)
    if (dtrData) {
      // Map dtr titles to fields
      for (const [key, val] of Object.entries(dtrData)) {
        if (/course\s*(code|no)|code/i.test(key)) courseCode = val;
        else if (/course\s*name|subject|paper/i.test(key)) courseName = val;
        else if (/credit|cr/i.test(key)) creditsStr = val;
        else if (/type|category|mode/i.test(key)) courseType = val;
      }
    }

    // Fallback: standard table cells
    if (!courseCode && codeIdx >= 0 && cellTexts[codeIdx]) courseCode = cellTexts[codeIdx];
    if (!courseName && nameIdx >= 0 && cellTexts[nameIdx]) courseName = cellTexts[nameIdx];
    if (!creditsStr && creditIdx >= 0 && cellTexts[creditIdx]) creditsStr = cellTexts[creditIdx];
    if (!courseType && typeIdx >= 0 && cellTexts[typeIdx]) courseType = cellTexts[typeIdx];

    // Auto-detect if still missing
    if (!courseCode && !courseName) {
      if (cellTexts[0] && /^[A-Z0-9]{2,}$/.test(cellTexts[0].replace(/\s/g, ""))) courseCode = cellTexts[0];
      if (!courseName && cellTexts.length >= 2) courseName = cellTexts[1] || cellTexts[0] || "";
      if (!courseCode && !courseName) return;
    }
    if (!creditsStr) {
      for (const t of cellTexts) {
        if (/^\d+(\.\d+)?$/.test(t)) { creditsStr = t; break; }
      }
    }

    const credits = parseFloat(creditsStr) || 0;
    items.push({ code: courseCode, name: courseName, credits, type: courseType || undefined });
  });

  const totalCredits = items.reduce((s, r) => s + r.credits, 0);
  return { title: title || "Courses", credits: totalCredits, items };
}
