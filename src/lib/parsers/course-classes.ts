import * as cheerio from "cheerio";

export interface CourseClassOption {
  slNo: string;
  classGroup: string;
  courseCode: string;
  courseTitle: string;
  courseType: string;
  classId: string;
  slot: string;
  faculty: string;
  /** Params that must be passed to the view-detail endpoint in this exact order. */
  viewParams: {
    semSubId: string;
    erpId: string;
    classId: string;
  };
}

const VIEW_PARAM_RE = /processViewStudentCourseDetail\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/;

/**
 * Extracts the "Class Group ... Faculty" table plus its View buttons from the
 * `getCourseDetailsForCoursePage` / `processViewStudentCourseDetail` fragments.
 *
 * The response is the class list you must choose from before opening the class
 * detail view - Sl.No is not a class number, Class Id is.
 */
export function parseCourseClasses(html: string): CourseClassOption[] {
  const $ = cheerio.load(html);
  const classes: CourseClassOption[] = [];

  $("table").each((_, table) => {
    const $table = $(table);
    $table.find("tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 8) return;

      const view = $(row).find('button[onclick*="processViewStudentCourseDetail"]').first();
      if (view.length === 0) return;

      const onclick = view.attr("onclick") || "";
      const match = VIEW_PARAM_RE.exec(onclick);
      if (!match) return;

      const [, semSubId, erpId, classId] = match;
      classes.push({
        slNo: $(cells[0]).text().trim(),
        classGroup: $(cells[1]).text().trim(),
        courseCode: $(cells[2]).text().trim(),
        courseTitle: $(cells[3]).text().trim(),
        courseType: $(cells[4]).text().trim(),
        classId: $(cells[5]).text().trim() || classId,
        slot: $(cells[6]).text().trim(),
        faculty: $(cells[7]).text().trim(),
        viewParams: {
          semSubId,
          erpId,
          classId,
        },
      });
    });
  });

  return classes;
}
