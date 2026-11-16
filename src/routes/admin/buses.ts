/**
 * @openapi
 * /api/admin/buses:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Auto-generated POST endpoint for /api/admin/buses
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               cookies:
 *                 type: string
 *               authorizedID:
 *                 type: string
 *               csrf:
 *                 type: string
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               example:
 *                 success: true
 *                 message: "sample_value"
 *       400:
 *         description: Bad Request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal Server Error
 */

import { requireSection } from'../../lib/auth';
import { ensureTransportInD1 } from '../../lib/transportD1';

/**
 * @swagger
 * /api/admin/buses:
 *   post:
 *     summary: Update the list of buses
 *     description: Replaces the current buses list in the database with the provided array of buses. Requires admin authentication via Bearer token.
 *     tags:
 *       - Admin
 *       - Buses
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 type:
 *                   type: string
 *                 route:
 *                   type: string
 *                 boardingPoints:
 *                   type: array
 *                   items:
 *                     type: string
 *                 driverPhone:
 *                   type: string
 *                 driverName:
 *                   type: string
 *                 whatsappGroup:
 *                   type: string
 *                 busLocation:
 *                   type: string
 *     responses:
 *       200:
 *         description: Buses updated successfully
 *       400:
 *         description: Expected an array of buses
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error or APP_DB not configured
 */

export async function POST(req: Request) {
  const authResult = await requireSection('buses')(req);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const buses = await (req.json() as any);

    if (!Array.isArray(buses)) {
      return Response.json({ success: false, message: 'Expected an array of buses.' }, { status: 400 });
    }
    if (buses.length > 999) {
      return Response.json({ success: false, message: 'Too many buses in one update.' }, { status: 400 });
    }

    const db = await ensureTransportInD1();
    const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM buses')];
    for (const bus of buses) {
      statements.push(db.prepare(`INSERT INTO buses
        (id, type, route, boarding_points, driver_phone, driver_name, whatsapp_group, bus_location)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(String(bus.id), bus.type ?? null, bus.route ?? null, JSON.stringify(bus.boardingPoints || []),
          bus.driverPhone ?? null, bus.driverName ?? null, bus.whatsappGroup ?? null, bus.busLocation ?? null));
    }
    await db.batch(statements);

    return Response.json({ success: true, message: 'Buses updated successfully in the database.' });
  } catch (error: unknown) {
    console.error('Failed to update buses:', error);
    return Response.json({ success: false, message: "Internal server error" }, { status: 500 });
  }
}
