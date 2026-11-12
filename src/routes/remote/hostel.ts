import { Hono } from "hono";
export const hostelRoute = new Hono();
import { vtopPostForm, readText, cookieHeader, formParams } from "../../lib/vtop";
import { hostel, leaveItem } from "../../types/data/hostel";
import * as cheerio from "cheerio";







hostelRoute.post("/hostel", async (c) => {
    try {
        const { cookies, authorizedID, csrf } = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

        const cookieValue = cookieHeader({ cookies: cookies as string | string[] | undefined });
        if (!csrf || !authorizedID) {
            return c.json({ success: false, error: "Cannot find _csrf or authorizedID" }, { status: 400 });
        }

        const menuParams = (extra: Record<string, string> = {}) =>
            formParams({
                verifyMenu: "true",
                authorizedID: String(authorizedID),
                _csrf: String(csrf),
                nocache: Date.now().toString(),
                ...extra,
            });

        const hostelRes = await vtopPostForm(
            "/vtop/studentsRecord/StudentProfileAllView",
            menuParams(),
            { cookies: cookieValue, timeoutMs: 20_000 }
        );
        const hostelHtml = await readText(hostelRes);

        // Fire and forget: prime the leave subsystem before the history calls.
        await vtopPostForm("/vtop/hostels/student/leave/1", menuParams(), {
            cookies: cookieValue,
            timeoutMs: 20_000,
        }).then((r) => r.text());

        const leaveRes = await vtopPostForm(
            "/vtop/hostels/student/leave/6",
            formParams({
                history: "",
                authorizedID: String(authorizedID),
                _csrf: String(csrf),
                form: "undefined",
                control: "history",
                x: Date.now().toString(),
            }),
            {
                cookies: cookieValue,
                timeoutMs: 20_000,
                headers: { Referer: "https://vtopcc.vit.ac.in/vtop/hostels/student/leave/1" },
            }
        );
        const leaveHtml = await readText(leaveRes);

        const activeLeaveRes = await vtopPostForm(
            "/vtop/hostels/student/leave/4",
            formParams({
                status: "",
                authorizedID: String(authorizedID),
                _csrf: String(csrf),
                form: "undefined",
                control: "status",
                x: Date.now().toString(),
            }),
            {
                cookies: cookieValue,
                timeoutMs: 20_000,
                headers: { Referer: "https://vtopcc.vit.ac.in/vtop/hostels/student/leave/1" },
            }
        );
        const activeLeaveHtml = await readText(activeLeaveRes);

        const $$ = cheerio.load(hostelHtml);
        const $$$ = cheerio.load(leaveHtml);
        const $$$_ = cheerio.load(activeLeaveHtml);
        const leaveRows = $$$("#LeaveHistoryTable tbody tr");
        const appliedLeaveRows = $$$_("#LeaveAppliedTable tbody tr");

        const hostelInfo: hostel = {};

        $$("table tr").each((_, row) => {
            const cols = $$(row).find("td");
            if (cols.length < 2) return;

            const label = cols.eq(0).text().trim();
            const value = cols.eq(1).text().trim();

            if (label.includes("GENDER")) {
                hostelInfo.gender = value;
            } else if (label.includes("HOSTELLER")) {
                hostelInfo.isHosteller = value === "HOSTELLER";
            }

            if (label.includes("Block Name")) {
                hostelInfo.blockName = value.split(" ")[0] || "NOT ALLOTED";
            } else if (label.includes("Room No")) {
                hostelInfo.roomNo = value;
            } else if (label.includes("Mess Information")) {
                hostelInfo.messInfo = value.split(" ")[0] || "NOT ALLOTED";
                if (hostelInfo.messInfo.length > 7) {
                    if (hostelInfo.messInfo === "NON") hostelInfo.messInfo = "NON VEG";
                    else if (hostelInfo.messInfo === "FOOD") hostelInfo.messInfo = "FOOD PARK";
                    else hostelInfo.messInfo = "NOT ALLOTED";
                }
            }
        });

        const leaveMap = new Map<string, leaveItem>();
        leaveRows.each((_, row) => {
            const cells = $$$(row).find("td");

            if (cells.length >= 8) {
                const leave: leaveItem = {
                    leaveId: $$$(cells[1]).text().trim(),
                    visitPlace: $$$(cells[2]).text().trim(),
                    reason: $$$(cells[3]).text().trim(),
                    leaveType: $$$(cells[4]).text().trim(),
                    from: $$$(cells[5]).text().trim(),
                    to: $$$(cells[6]).text().trim(),
                    status: $$$(cells[7]).text().trim(),
                    remarks: $$$(cells[8]).text().trim(),
                };

                leaveMap.set(leave.leaveId, leave);
            }
        });
        appliedLeaveRows.each((_, row) => {
            const cells = $$$_(row).find("td");

            if (cells.length >= 9) {
                const leave: leaveItem = {
                    leaveId: $$$_(cells[2]).text().trim(),
                    visitPlace: $$$_(cells[3]).text().trim(),
                    reason: $$$_(cells[4]).text().trim(),
                    leaveType: $$$_(cells[5]).text().trim(),
                    from: $$$_(cells[6]).text().trim(),
                    to: $$$_(cells[7]).text().trim(),
                    status: $$$_(cells[8]).text().trim(),
                    remarks: $$$_(cells[9]).text().trim(),
                };

                leaveMap.set(leave.leaveId, leave);
            }
        });
        const leaveHistory = Array.from(leaveMap.values());

        return c.json({ hostelInfo, leaveHistory }, { status: 200 });
    } catch (err: unknown) {
        console.error(err);
        return c.json({ error: "Internal server error" }, { status: 500 });
    }
});
