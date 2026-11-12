import * as cheerio from "cheerio";

export interface DayboarderData {
  title: string;
  fields: Record<string, { value: string; type: string; label: string; options?: { value: string; text: string; selected: boolean }[] }>;
}

export function parseDayboarder(html: string): DayboarderData {
  const $ = cheerio.load(html);
  const result: DayboarderData = {
    title: $("h3.box-title").first().text().trim(),
    fields: {},
  };

  const fieldLabels: Record<string, string> = {};
  $(".form-group").each((_, group) => {
    const $group = $(group);
    const label = $group.find("label").text().trim();
    const input = $group.find("input, select").first();
    const name = input.attr("name");
    if (name && label) fieldLabels[name] = label;
  });

  $("input, select").each((_, el) => {
    const name = $(el).attr("name");
    if (!name || name === "_csrf" || name === "authorizedID") return;
    const label = fieldLabels[name] || name;
    if (el.tagName.toLowerCase() === "select") {
      const options: { value: string; text: string; selected: boolean }[] = [];
      $(el).find("option").each((_, opt) => {
        options.push({
          value: $(opt).attr("value") || $(opt).text().trim(),
          text: $(opt).text().trim(),
          selected: $(opt).attr("selected") !== undefined,
        });
      });
      result.fields[name] = { type: "select", value: $(el).val() as string || "", label, options };
    } else {
      result.fields[name] = {
        type: $(el).attr("type") || "text",
        value: $(el).attr("value") || "",
        label,
      };
    }
  });

  return result;
}
