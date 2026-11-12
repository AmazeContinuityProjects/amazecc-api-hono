/**
 * POST /api/remote/course-page — course page + AJAX cascading dropdowns
 * (course → slot → faculty → details). One VTOP session in, parsed page and
 * detail fragments out.
 */
import { Hono } from "hono";
import { vtopPostForm, readText, cookieHeader, formParams } from "../../lib/vtop";
import { parseCoursePage } from "../../lib/parsers/course-page";
import { parseVtopHtml } from "../../lib/parsers/auto-parse";
import { parseCourseClasses } from "../../lib/parsers/course-classes";

export const coursePageRoute = new Hono();

const REFERER = "https://vtopcc.vit.ac.in/vtop/academics/common/StudentCoursePage";

coursePageRoute.post("/course-page", async (c) => {
  try {
    const { cookies, authorizedID, csrf, formData } = (await c.req.json().catch(() => ({}))) as {
      cookies?: string | string[];
      authorizedID?: string;
      csrf?: string;
      formData?: any;
    };
    const cookieValue = cookieHeader({ cookies });
    if (!csrf || !authorizedID) {
      return c.json({ error: "Missing csrf or authorizedID" }, 400);
    }

    const post = (path: string, body: Record<string, string> | string, timeoutMs = 20_000) =>
      vtopPostForm(path, typeof body === "string" ? body : formParams(body), {
        cookies: cookieValue,
        timeoutMs,
        headers: { Referer: REFERER },
      });
    const menu = (extra: Record<string, string> = {}) =>
      formParams({
        verifyMenu: "true",
        authorizedID: String(authorizedID),
        _csrf: String(csrf),
        nocache: Date.now().toString(),
        ...extra,
      });

    const pageResp = await post("/vtop/academics/common/StudentCoursePage", menu());
    const pageHtml = await readText(pageResp);

    if (formData) {
      const { semesterSubId, courseCode, slotId, faculty } = formData;
      const ts = Date.now().toString();

      let ajaxUrl: string;
      let ajaxParams: Record<string, string>;

      if (formData.viewDetail) {
        await post(
          "/vtop/getCourseForCoursePage",
          formParams({
            _csrf: String(csrf),
            paramReturnId: "getCourseForCoursePage",
            semSubId: formData.semSubId || "",
            authorizedID: String(authorizedID),
            x: ts,
          })
        ).then((r) => r.text());
        if (formData.slotId && formData.faculty) {
          await post(
            "/vtop/getSlotIdForCoursePage",
            formParams({
              _csrf: String(csrf),
              classId: formData.classId,
              praType: "source",
              paramReturnId: "getSlotIdForCoursePage",
              semSubId: formData.semSubId || "",
              authorizedID: String(authorizedID),
              x: ts,
            })
          ).then((r) => r.text());
          await post(
            "/vtop/getFacultyForCoursePage",
            formParams({
              _csrf: String(csrf),
              classId: formData.classId,
              slotId: formData.slotId,
              praType: "source",
              paramReturnId: "getFacultyForCoursePage",
              semSubId: formData.semSubId || "",
              authorizedID: String(authorizedID),
              x: ts,
            })
          ).then((r) => r.text());
        }
        ajaxUrl = "/vtop/processViewStudentCourseDetail";
        ajaxParams = {
          _csrf: String(csrf),
          semSubId: formData.semSubId,
          erpId: formData.erpId,
          classId: formData.classId,
          authorizedID: String(authorizedID),
          x: ts,
        };
      } else if (semesterSubId && !courseCode) {
        ajaxUrl = "/vtop/getCourseForCoursePage";
        ajaxParams = {
          _csrf: String(csrf),
          paramReturnId: "getCourseForCoursePage",
          semSubId: String(semesterSubId),
          authorizedID: String(authorizedID),
          x: ts,
        };
      } else if (courseCode && !slotId) {
        ajaxUrl = "/vtop/getSlotIdForCoursePage";
        ajaxParams = {
          _csrf: String(csrf),
          classId: String(courseCode),
          praType: "source",
          paramReturnId: "getSlotIdForCoursePage",
          semSubId: String(semesterSubId ?? ""),
          authorizedID: String(authorizedID),
          x: ts,
        };
      } else if (slotId && !faculty) {
        ajaxUrl = "/vtop/getFacultyForCoursePage";
        ajaxParams = {
          _csrf: String(csrf),
          classId: String(courseCode),
          slotId: String(slotId),
          praType: "source",
          paramReturnId: "getFacultyForCoursePage",
          semSubId: String(semesterSubId ?? ""),
          authorizedID: String(authorizedID),
          x: ts,
        };
      } else if (faculty) {
        await post(
          "/vtop/getCourseForCoursePage",
          formParams({
            _csrf: String(csrf),
            paramReturnId: "getCourseForCoursePage",
            semSubId: String(semesterSubId ?? ""),
            authorizedID: String(authorizedID),
            x: ts,
          })
        ).then((r) => r.text());
        await post(
          "/vtop/getSlotIdForCoursePage",
          formParams({
            _csrf: String(csrf),
            classId: String(courseCode),
            praType: "source",
            paramReturnId: "getSlotIdForCoursePage",
            semSubId: String(semesterSubId ?? ""),
            authorizedID: String(authorizedID),
            x: ts,
          })
        ).then((r) => r.text());
        await post(
          "/vtop/getFacultyForCoursePage",
          formParams({
            _csrf: String(csrf),
            classId: String(courseCode),
            slotId: String(slotId),
            praType: "source",
            paramReturnId: "getFacultyForCoursePage",
            semSubId: String(semesterSubId ?? ""),
            authorizedID: String(authorizedID),
            x: ts,
          })
        ).then((r) => r.text());

        ajaxUrl = "/vtop/getCourseDetailsForCoursePage";
        ajaxParams = {
          _csrf: String(csrf),
          classId: String(courseCode),
          slotId: String(slotId),
          faculty: String(faculty),
          praType: "source",
          paramReturnId: "getCourseDetailsForCoursePage",
          semSubId: String(semesterSubId ?? ""),
          authorizedID: String(authorizedID),
          x: ts,
        };
      } else {
        return c.json({ error: "Invalid formData" }, 400);
      }

      const dataResp = await post(ajaxUrl, ajaxParams);
      const dataHtml = await readText(dataResp);

      if (formData.viewDetail || ajaxUrl === "/vtop/getCourseDetailsForCoursePage") {
        const parsed = parseVtopHtml(dataHtml);
        const classOptions = parseCourseClasses(dataHtml);
        return c.json({
          success: true,
          ...parsed,
          results: {
            ...parsed,
            classOptions,
          },
        });
      }

      const parsed = parseVtopHtml(dataHtml);
      return c.json({ success: true, results: parsed });
    }

    const data = parseCoursePage(pageHtml);
    return c.json({ success: true, ...data });
  } catch (err: unknown) {
    console.error("course-page error:", err instanceof Error ? err.message : String(err));
    return c.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});
