import * as cheerio from "cheerio";

export interface AcknowledgementData {
  title?: string;
  applicationNo: string;
  registerNo: string;
  name: string;
  programme: string;
  campus: string;
  branch: string;
  documents: { serialNo: string; documentName: string; status: string }[];
}

export function parseAcknowledgement(html: string): AcknowledgementData {
  const $ = cheerio.load(html);
  const title = $("h3.box-title, .box-title, h2, h3").first().text().replace(/\s+/g, " ").trim();
  const result: AcknowledgementData = {
    ...(title ? { title } : {}),
    applicationNo: "",
    registerNo: "",
    name: "",
    programme: "",
    campus: "",
    branch: "",
    documents: [],
  };

  const setField = (key: string, val: string) => {
    const k = key.replace(/\s+/g, " ").trim().toLowerCase();
    const v = val.replace(/\s+/g, " ").trim();
    if (!k || !v) return;
    if (k.includes("application no")) result.applicationNo = v;
    else if (k.includes("register no")) result.registerNo = v;
    else if (k.includes("name")) result.name = v;
    else if (k.includes("programme")) result.programme = v;
    else if (k.includes("campus")) result.campus = v;
    else if (k.includes("branch")) result.branch = v;
  };

  $("table").first().find("tr").each((_, row) => {
    const cells = $(row).find("td, th").toArray().map((c) => $(c).text().trim());
    // VTOP often renders student info as [label, value, label, value] per row.
    for (let i = 0; i + 1 < cells.length; i += 2) {
      setField(cells[i], cells[i + 1]);
    }
  });

  $("table").eq(1).find("tr").each((_, row) => {
    const cells = $(row).find("td, th").toArray().map((c) => $(c).text().replace(/\s+/g, " ").trim());
    if (cells.length < 3) return;
    const serialNo = (cells[0] || "").replace(/\.$/, "").trim();
    const documentName = cells[1] || "";
    const status = cells[cells.length - 1] || "";
    if (!serialNo || !documentName) return;
    if (/^s\.?\s*no$/i.test(serialNo) || /document name/i.test(documentName)) return;
    result.documents.push({ serialNo, documentName, status });
  });

  return result;
}
