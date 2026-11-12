import * as cheerio from "cheerio";

export interface FacultyInfoData {
  title: string;
  searchField: { name: string; placeholder: string } | null;
}

export function parseFacultyInfo(html: string): FacultyInfoData {
  const $ = cheerio.load(html);
  return {
    title: $("h3.box-title").first().text().trim(),
    searchField: {
      name: $("#searchEmployee").attr("name") || "searchEmployee",
      placeholder: $("#searchEmployee").attr("placeholder") || "",
    },
  };
}
