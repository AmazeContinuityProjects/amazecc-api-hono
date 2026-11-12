import { parseDocument } from "htmlparser2";
import { selectAll } from "css-select";
import { textContent } from "domutils";
import type { AnyNode, Element } from "domhandler";
import { vtopPostForm, readText, cookieHeader, formParams } from "./vtop";

import { courseItem } from "../types/data/attendance";

function textOf(node: AnyNode | undefined | null): string {
    return node ? textContent(node).replace(/\r\n/g, "\n").trim() : "";
}

function getCells(row: AnyNode): Element[] {
    return selectAll("td", row) as Element[];
}

export function parseTimetableHtml(html: string): courseItem[] {
    const doc = parseDocument(html);
    const courseInfo: courseItem[] = [];

    const tables = selectAll("table.table", doc);
    for (const table of tables) {
        const rows = selectAll("tr", table);
        for (const row of rows) {
            const cells = getCells(row);
            if (cells.length === 0) continue;

            const slotVenueCell = textOf(cells[7]);
            const courseCell = textOf(cells[2]);
            const isLab = slotVenueCell.startsWith("L");
            const courseCodeBase = courseCell.split(" ")[0] || "";

            courseInfo.push({
                slNo: textOf(cells[0]),
                course: courseCell,
                courseCode: isLab ? courseCodeBase + "(L)" : courseCodeBase + "(T)",
                LTPJC: textOf(cells[3]),
                category: textOf(cells[4]),
                classId: textOf(cells[6]),
                slotVenue: slotVenueCell,
                facultyDetails: textOf(cells[8]),
            });
        }
    }

    return courseInfo;
}

export default async function fetchTimetable(
    cookies: string | string[],
    authorizedID: string,
    csrf: string,
    semesterId: string
): Promise<courseItem[]> {
    const res = await vtopPostForm(
        "/vtop/processViewTimeTable",
        formParams({
            authorizedID: String(authorizedID),
            semesterSubId: String(semesterId ?? ""),
            _csrf: String(csrf),
            x: Date.now().toString(),
        }),
        { cookies: cookieHeader({ cookies }), timeoutMs: 20_000 }
    );

    return parseTimetableHtml(await readText(res));
}
