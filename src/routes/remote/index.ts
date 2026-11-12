/**
 * /api/remote/* — direct, mostly stateless scrapes of VIT hosts (VTOP,
 * LMS/Vitol, directory). One logical upstream call (or a fixed sequence),
 * credentials in the body, nothing persisted unless the route says so.
 */
import { Hono } from "hono";

import { loginRoute } from "./login";
import { whoamiRoute } from "./whoami";
import { attendanceRoute } from "./attendance";
import { attendanceHtmlparser2Route } from "./attendance-htmlparser2";
import { gradesRoute } from "./grades";
import { ffcsRoute } from "./ffcs";
import { financeRoute } from "./finance";
import { hostelRoute } from "./hostel";
import { odRoute } from "./od";
import { curriculumRoute } from "./curriculum";
import { syllabusRoute } from "./curriculum-syllabus";
import { curriculumDownloadRoute } from "./curriculum-download";
import { coursePageRoute } from "./course-page";
import { lmsDataRoute } from "./lms-data";
import { vitolDataRoute } from "./vitol-data";
import { transportRoute } from "./transport";
import { circularsRoute } from "./circulars";
import { circularsDownloadRoute } from "./circulars-download";
import { calendarRoute } from "./calendar";
import { bulkRoute } from "./bulk";

export const remoteRouter = new Hono();

remoteRouter.route("/", loginRoute);
remoteRouter.route("/", whoamiRoute);
remoteRouter.route("/", attendanceRoute);
remoteRouter.route("/", attendanceHtmlparser2Route);
remoteRouter.route("/", gradesRoute);
remoteRouter.route("/", ffcsRoute);
remoteRouter.route("/", financeRoute);
remoteRouter.route("/", hostelRoute);
remoteRouter.route("/", odRoute);
remoteRouter.route("/", curriculumRoute);
remoteRouter.route("/", syllabusRoute);
remoteRouter.route("/", curriculumDownloadRoute);
remoteRouter.route("/", coursePageRoute);
remoteRouter.route("/", lmsDataRoute);
remoteRouter.route("/", vitolDataRoute);
remoteRouter.route("/", transportRoute);
remoteRouter.route("/", circularsRoute);
remoteRouter.route("/", circularsDownloadRoute);
remoteRouter.route("/", calendarRoute);
remoteRouter.route("/", bulkRoute);
