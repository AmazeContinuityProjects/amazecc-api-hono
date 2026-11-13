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

import { getWorkerEnv } from '../../env';
import { getDbPool } from '../../lib/db';
import { requireSection } from'../../lib/auth';

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
 *         description: Internal server error or DATABASE_URL not configured
 */

export async function POST(req: Request) {
  const authResult = await requireSection('buses')(req);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    if (!getWorkerEnv().DATABASE_URL && !getWorkerEnv().HYPERDRIVE) {
      return Response.json({ success: false, message: 'DATABASE_URL is not configured.' }, { status: 500 });
    }

    const buses = await (req.json() as any);

    if (!Array.isArray(buses)) {
      return Response.json({ success: false, message: 'Expected an array of buses.' }, { status: 400 });
    }

    const pool = getDbPool();

    // Create table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS buses (
        id VARCHAR(255) PRIMARY KEY,
        type VARCHAR(50),
        route VARCHAR(255),
        boarding_points JSONB,
        driver_phone VARCHAR(50),
        driver_name VARCHAR(100),
        whatsapp_group TEXT,
        bus_location TEXT
      );
    `);

    // We'll use a transaction to replace the buses
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('TRUNCATE TABLE buses');

      for (const bus of buses) {
        await client.query(
          `INSERT INTO buses (id, type, route, boarding_points, driver_phone, driver_name, whatsapp_group, bus_location)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            bus.id,
            bus.type,
            bus.route,
            JSON.stringify(bus.boardingPoints || []),
            bus.driverPhone,
            bus.driverName,
            bus.whatsappGroup,
            bus.busLocation
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return Response.json({ success: true, message: 'Buses updated successfully in the database.' });
  } catch (error: unknown) {
    console.error('Failed to update buses:', error);
    return Response.json({ success: false, message: "Internal server error" }, { status: 500 });
  }
}
