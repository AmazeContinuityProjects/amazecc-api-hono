import { parseDocument } from "htmlparser2";
import { selectAll } from "css-select";
import { textContent } from "domutils";
import type { AnyNode, Element } from "domhandler";
import { vtopPostForm, readText, cookieHeader, formParams } from "./vtop";

import { CourseItem, CGPA } from "../types/data/marks";

function isElement(node: AnyNode): node is Element {
    return node.type === "tag" || node.type === "script" || node.type === "style";
}

function textOf(node: AnyNode | undefined | null): string {
    return node ? textContent(node).replace(/\r\n/g, "\n").trim() : "";
}

function getCells(row: AnyNode): Element[] {
    return selectAll("td", row) as Element[];
}

function nextElementSibling(el: Element): Element | null {
    let n: AnyNode | null | undefined = el.next;
    while (n) {
        if (n.type === "tag") return n as Element;
        n = n.next;
    }
    return null;
}

export function parseMarksHtml(
    html: string,
    courseCreditMap: Record<string, number>
): CourseItem[] {
    const doc = parseDocument(html);
    const courses: CourseItem[] = [];

    const rows = selectAll("table.customTable tr.tableContent", doc).filter(isElement);
    for (const row of rows) {
        const cols = getCells(row);
        if (cols.length < 9) continue;

        const courseCode = textOf(cols[2]);
        const slot = textOf(cols[7]);
        const isLab = slot.startsWith("L");

        const primaryKey = `${courseCode}(${isLab ? "L" : "T"})`;
        const creditsValue = courseCreditMap[primaryKey] ?? 0;

        const courseData: CourseItem = {
            slNo: textOf(cols[0]),
            classNbr: textOf(cols[1]),
            courseCode,
            credits: creditsValue,
            courseTitle: textOf(cols[3]),
            courseType: textOf(cols[4]),
            courseSystem: textOf(cols[5]),
            faculty: textOf(cols[6]).replace(/\s+/g, " "),
            slot,
            courseMode: textOf(cols[8]),
            assessments: [],
        };

        const nestedTableRow = nextElementSibling(row as any);
        if (nestedTableRow) {
            const assessmentRows = selectAll(
                "table.customTable-level1 tr.tableContent-level1",
                nestedTableRow as unknown as AnyNode
            );
            for (const assessmentRow of assessmentRows) {
                const assessmentCols = getCells(assessmentRow);
                if (assessmentCols.length < 7) continue;

                const getOutputText = (cell: Element | undefined) => {
                    if (!cell) return "";
                    const out = selectAll("output", cell)[0];
                    return textOf(out ?? cell);
                };

                courseData.assessments.push({
                    slNo: getOutputText(assessmentCols[0]),
                    title: getOutputText(assessmentCols[1]),
                    maxMark: getOutputText(assessmentCols[2]),
                    weightagePercent: getOutputText(assessmentCols[3]),
                    status: getOutputText(assessmentCols[4]),
                    scoredMark: getOutputText(assessmentCols[5]),
                    weightageMark: getOutputText(assessmentCols[6]),
                });
            }
        }

        if (courseData.assessments.length > 0) {
            courses.push(courseData);
        }
    }

    return courses;
}

export function parseCgpaHtml(html: string): CGPA {
    const cgpaDoc = parseDocument(html);
    const cgpa: CGPA = {};
    const items = selectAll(".list-group-item", cgpaDoc);
    for (const el of items) {
        const labelNode = selectAll("span.card-title", el)[0];
        const valueNode = selectAll("span.fontcolor3 span", el)[0];
        const label = textOf(labelNode);
        const value = textOf(valueNode);

        if (label.includes("Total Credits Required")) cgpa.creditsRequired = value;
        else if (label.includes("Earned Credits")) cgpa.creditsEarned = value;
        else if (label.includes("Current CGPA")) cgpa.cgpa = value;
        else if (label.includes("Non-graded Core Requirement"))
            cgpa.nonGradedRequirement = value;
    }
    return cgpa;
}

export async function getMarks(
    cookies: string[] | string,
    authorizedID: string,
    csrf: string,
    semesterId: string,
    courseCreditMap: Record<string, number>
): Promise<{ courses: CourseItem[]; cgpa: CGPA } | string> {
    try {
        const marksRes = await vtopPostForm(
            "/vtop/examinations/doStudentMarkView",
            formParams({
                authorizedID: String(authorizedID),
                semesterSubId: String(semesterId ?? ""),
                _csrf: String(csrf),
                x: Date.now().toString(),
            }),
            { cookies: cookieHeader({ cookies }), timeoutMs: 20_000 }
        );

        const courses = parseMarksHtml(await readText(marksRes), courseCreditMap);

        const creditsRes = await vtopPostForm(
            "/vtop/get/dashboard/current/cgpa/credits",
            formParams({
                authorizedID: String(authorizedID),
                _csrf: String(csrf),
                x: Date.now().toString(),
            }),
            { cookies: cookieHeader({ cookies }), timeoutMs: 20_000 }
        );

        const cgpa = parseCgpaHtml(await readText(creditsRes));

        return { courses, cgpa };
    } catch (err: unknown) {
        console.error(err);
        const message = err instanceof Error ? err.message : 'Unknown error';
        throw new Error(`Failed to fetch marks: ${message}`);
    }
}
