import * as cheerio from "cheerio";

export interface SemesterOption {
  value: string;
  text: string;
  selected: boolean;
}

export interface CoursePageData {
  title: string;
  semesters: SemesterOption[];
  formFields: Record<string, { value: string; type: string; label: string; options?: { value: string; text: string; selected: boolean }[] }>;
}

export function parseCoursePage(html: string): CoursePageData {
  const $ = cheerio.load(html);
  const result: CoursePageData = {
    title: $("strong.fw-bold.h3").first().text().trim(),
    semesters: [],
    formFields: {},
  };

  $("#semesterSubId option").each((_, opt) => {
    const value = $(opt).attr("value") || "";
    if (value) {
      result.semesters.push({
        value,
        text: $(opt).text().trim(),
        selected: $(opt).attr("selected") !== undefined,
      });
    }
  });

  const fieldLabels: Record<string, string> = {};
  $(".form-group .form-label.fw-bold").each((_, el) => {
    const label = $(el).text().trim();
    const select = $(el).closest(".form-group").next().find("select").first();
    const name = select.attr("name");
    if (name && label) fieldLabels[name] = label;
  });

  $("select").each((_, el) => {
    const name = $(el).attr("name");
    if (!name || name === "semesterSubId") return;
    const options: { value: string; text: string; selected: boolean }[] = [];
    $(el).find("option").each((_, opt) => {
      const val = $(opt).attr("value") || "";
      if (val) {
        options.push({
          value: val,
          text: $(opt).text().trim(),
          selected: $(opt).attr("selected") !== undefined,
        });
      }
    });
    result.formFields[name] = {
      type: "select",
      value: $(el).val() as string || "",
      label: fieldLabels[name] || name,
      options,
    };
  });

  return result;
}
