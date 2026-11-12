import { Hono } from "hono";
export const calendarRoute = new Hono();
import { vtopPostForm, readText, cookieHeader, formParams } from "../../lib/vtop";
import * as cheerio from "cheerio";

import {
    CalendarDay,
    CalendarEvent,
    CalendarRequestBody
} from "../../types/data/semTT";






calendarRoute.post("/calendar", async (c) => {
    try {
        const body: CalendarRequestBody = (await c.req.json().catch(() => ({}))) as CalendarRequestBody;
        const { cookies, authorizedID, csrf, semesterId } = body;
        let { type } = body;

        if (semesterId?.toString().endsWith("05")) {
            if (type !== "ALL" && type !== "ALL02" && type !== "ALL05") {
                type = "ALL";
            }
        } else if(semesterId?.toString().endsWith("07")) type = "ALL";

        const cookieValue = cookieHeader({ cookies: cookies as string | string[] | undefined });
        
        if (!csrf || !authorizedID)
            return c.json({ success: false, error: "Cannot find _csrf or authorizedID" }, { status: 400 });

        let months: string[] = [];

        const semCode = semesterId?.slice(-2);
        const startYear = parseInt(semesterId?.slice(2, 6) || "2024");
        const nextYear = startYear + 1;

        if (semCode === "01") {
            months = [
                `01-JUL-${startYear}`,
                `01-AUG-${startYear}`,
                `01-SEP-${startYear}`,
                `01-OCT-${startYear}`,
                `01-NOV-${startYear}`,
            ];
        } else if (semCode === "05") {
            months = [
                `01-DEC-${startYear}`,
                `01-JAN-${nextYear}`,
                `01-FEB-${nextYear}`,
                `01-MAR-${nextYear}`,
                `01-APR-${nextYear}`,
            ];
        } else {
            months = [
                `01-MAY-${nextYear}`,
                `01-JUN-${nextYear}`,
                `01-JUL-${nextYear}`,
            ];
        }

        const allCalendars: unknown[] = [];
        

        // Fetch for each month
        for (const calDate of months) {
            const ttRes = await vtopPostForm(
                "/vtop/processViewCalendar",
                formParams({
                    authorizedID: String(authorizedID),
                    semSubId: String(semesterId ?? ""),
                    calDate,
                    classGroupId: String(type ?? ""),
                    _csrf: String(csrf),
                    x: Date.now().toString(),
                }),
                { cookies: cookieValue, timeoutMs: 20_000 }
            );

            const parsed = await parseCalendar(await readText(ttRes));
            allCalendars.push(parsed);
        }

        // Add your custom event (Nov 8)
        // const addCustomEvent = {
        //     text: "Crystal GuruVITa",
        //     type: "Holiday",
        //     color: "#B22222",
        //     category: "Crystal GuruVITa",
        // };

        // allCalendars.forEach((cal, idx) => {
        //     const calDate = months[idx] || "";
        //     if (
        //         typeof calDate === "string" &&
        //         calDate.toUpperCase().includes("-NOV-")
        //     ) {
        //         addHolidayToCalendar(cal, 8, addCustomEvent);
        //     }
        // });

        return c.json({
            semesterId,
            calendars: allCalendars,
        }, { status: 200 });

    } catch (err: unknown) {
        console.error(err);
        return c.json({ error: "Internal server error" }, { status: 500 });
    }
});



async function parseCalendar(html: string) {
    const $ = cheerio.load(html);
    const month = $("h4").first().text().trim();
    const data: CalendarDay[] = [];

    $("table.calendar-table tbody tr td").each((_, td) => {
        const cell = $(td);
        const dateText = cell.find("span").first().text().trim();
        if (!dateText) return;

        const date = parseInt(dateText, 10);
        const events: CalendarEvent[] = [];

        cell.find("span").slice(1).each((__, span) => {
            const text = $(span).text().trim();
            if (!text) return;

            const style = $(span).attr("style") || "";
            const colorMatch = style.match(/color:\s*([^;]+)/);
            const color = colorMatch ? (colorMatch[1] || " ").trim() : "";

            const isInstructional = text.toLowerCase().includes("instructional");
            const isHoliday = text.toLowerCase().includes("holiday");

            events.push({
                text,
                type: isInstructional
                    ? "Instructional Day"
                    : isHoliday
                        ? "Holiday"
                        : "Other",
                color,
                category: "",
            });
        });

        const structured = events.map((e) => {
            const match = e.text.match(/\(([^)]+)\)/);
            return {
                ...e,
                category: match ? (match[1] || " ").trim() : "General",
            };
        });

        if (events.length !== 0) {
            data.push({ date, events: structured });
        }
    });

    return { month, days: data };
}


