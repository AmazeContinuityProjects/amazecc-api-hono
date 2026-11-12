import * as cheerio from "cheerio";

export interface SemesterOption {
  value: string;
  text: string;
  selected: boolean;
}

export interface FeedbackRow {
  feedbackType: string;
  midSemester: string;
  teeSemester: string;
}

export interface FeedbackStatusData {
  title: string;
  semesters: SemesterOption[];
  feedbackTable: FeedbackRow[];
}

export function parseFeedbackStatus(html: string): FeedbackStatusData {
  const $ = cheerio.load(html);
  const result: FeedbackStatusData = {
    title: $("h3.box-title").first().text().trim(),
    semesters: [],
    feedbackTable: [],
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

  $("table.table-bordered tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length >= 3) {
      result.feedbackTable.push({
        feedbackType: $(cells[0]).text().trim(),
        midSemester: $(cells[1]).text().trim(),
        teeSemester: $(cells[2]).text().trim(),
      });
    }
  });

  return result;
}
