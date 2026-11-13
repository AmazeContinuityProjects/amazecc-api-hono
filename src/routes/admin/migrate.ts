import { getWorkerEnv } from "../../env";
import { getDbPool } from '../../lib/db';
import { requireSuperadmin } from'../../lib/auth';
import { checkRateLimit, rateLimitResponse, getClientIp } from '../../lib/rateLimit';



/**
 * @openapi
 * /api/admin/migrate:
 *   get:
 *     tags:
 *       - Admin
 *     summary: GET endpoint for /api/admin/migrate
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Bad Request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal Server Error
 *   post:
 *     tags:
 *       - Admin
 *     summary: POST endpoint for /api/admin/migrate
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Bad Request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal Server Error
 */


// POST — run all migrations (buses + Q-Bank tables)
/**
 * @swagger
 * /api/admin/migrate:
 *   post:
 *     summary: Run database migrations
 *     description: Creates necessary tables for buses, papers archive, Q-Bank, push subscriptions, files, logs, etc.
 *     tags:
 *       - Admin
 *     responses:
 *       200:
 *         description: Tables created successfully
 *       500:
 *         description: Migration failed or DATABASE_URL not set
 */
export async function POST(req: Request) {
  const authResult = await requireSuperadmin(req);
  if (authResult instanceof Response) return authResult;

  const ip = getClientIp(req);
  const rl = checkRateLimit(`migrate:${ip}`, 3, 300000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const pool = getDbPool();

    if (!getWorkerEnv().DATABASE_URL && !getWorkerEnv().HYPERDRIVE) {
      return Response.json({ error: 'DATABASE_URL not set' }, { status: 500 });
    }

    const sql = `
      -- Buses table
      
      -- Push subscriptions (if not exists)
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        endpoint TEXT UNIQUE NOT NULL,
        p256dh TEXT,
        auth TEXT,
        vitol_enabled BOOLEAN DEFAULT FALSE,
        vitol_reminder_day INT DEFAULT 1,
        vitol_reminder_time TEXT DEFAULT '10:00',
        created_at TIMESTAMPTZ DEFAULT now()
      );

      -- Files table
      CREATE TABLE IF NOT EXISTS class_data (
        class_id TEXT PRIMARY KEY,
        includes_users JSONB DEFAULT '[]',
        count INT DEFAULT 0,
        mean FLOAT DEFAULT 0,
        m2 FLOAT DEFAULT 0
      );
      
      CREATE TABLE IF NOT EXISTS files (
        file_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        extension TEXT,
        name TEXT,
        size INT,
        expires_at TIMESTAMPTZ
      );

      -- API Route Logs
      CREATE TABLE IF NOT EXISTS api_route_logs (
        id SERIAL PRIMARY KEY,
        method TEXT,
        route TEXT,
        source TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      -- Visitor Logs
      CREATE TABLE IF NOT EXISTS visitor_logs (
        id SERIAL PRIMARY KEY,
        source TEXT,
        hashed_ip TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS buses (
        id SERIAL PRIMARY KEY,
        type TEXT,
        route TEXT,
        boarding_points JSONB,
        driver_phone TEXT,
        driver_name TEXT,
        whatsapp_group TEXT,
        bus_location TEXT
      );

      -- Papers archive
      CREATE TABLE IF NOT EXISTS papers_archive (
        source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        course_code TEXT,
        title TEXT,
        source_type TEXT,
        exam_year INT,
        file_url TEXT,
        uploader_reg_no TEXT,
        approval_status TEXT DEFAULT 'PENDING',
        created_at TIMESTAMPTZ DEFAULT now()
      );

      -- Extracted questions
      CREATE TABLE IF NOT EXISTS qbank_questions (
        question_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id UUID REFERENCES papers_archive(source_id) ON DELETE CASCADE,
        question_number TEXT,
        question_text TEXT,
        image_url TEXT,
        question_type TEXT,
        options JSONB,
        correct_answer TEXT,
        marks INT
      );

      -- Topics / course objectives
      CREATE TABLE IF NOT EXISTS qbank_topics (
        topic_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        course_code TEXT,
        topic_name TEXT
      );

      -- Junction table
      CREATE TABLE IF NOT EXISTS qbank_question_topics (
        question_id UUID REFERENCES qbank_questions(question_id) ON DELETE CASCADE,
        topic_id UUID REFERENCES qbank_topics(topic_id) ON DELETE CASCADE,
        PRIMARY KEY(question_id, topic_id)
      );

      -- Consolidated buses table (replaces bus_routes, bus_stops, bus_placements, old buses)
      CREATE TABLE IF NOT EXISTS buses_v2 (
        id SERIAL PRIMARY KEY,
        route_number VARCHAR(10) NOT NULL UNIQUE,
        route_name VARCHAR(255) NOT NULL,
        type VARCHAR(10) NOT NULL CHECK (type IN ('AC', 'Non-AC')),
        driver_name VARCHAR(100) DEFAULT '',
        driver_phone VARCHAR(50) DEFAULT '',
        whatsapp_group TEXT DEFAULT '',
        bus_location TEXT DEFAULT '',
        supervisor_name VARCHAR(100) DEFAULT '',
        supervisor_phone VARCHAR(50) DEFAULT '',
        driver_incharge_name VARCHAR(100) DEFAULT '',
        driver_incharge_phone VARCHAR(50) DEFAULT '',
        stops JSONB DEFAULT '[]'::jsonb,
        placements JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      -- Transport rules (separate — not bus-specific)
      CREATE TABLE IF NOT EXISTS transport_rules (
        id SERIAL PRIMARY KEY,
        rule_number INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      -- Admin users table
      CREATE TABLE IF NOT EXISTS admin_users (
        username TEXT PRIMARY KEY,
        role TEXT DEFAULT 'admin' CHECK (role IN ('superadmin', 'admin')),
        permissions JSONB DEFAULT '["dashboard","qbank","buses","push","fresher-resources","faculty-directories","faculty-directory"]',
        added_by TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      -- Admin activity audit logs table
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id SERIAL PRIMARY KEY,
        admin_user TEXT NOT NULL,
        action TEXT NOT NULL,
        target_resource TEXT DEFAULT '',
        details JSONB DEFAULT '{}'::jsonb,
        ip_address TEXT DEFAULT '',
        user_agent TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_admin_user ON admin_audit_logs (admin_user);

      -- Fresher resources table
      CREATE TABLE IF NOT EXISTS fresher_resources (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        url TEXT,
        icon TEXT DEFAULT 'ExternalLink',
        sort_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        type TEXT DEFAULT 'link' CHECK (type IN ('link', 'text', 'md')),
        content TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      -- Add driver_incharge columns to buses_v2 if they don't exist
      DO $$ BEGIN
        ALTER TABLE buses_v2 ADD COLUMN IF NOT EXISTS driver_incharge_name VARCHAR(100) DEFAULT '';
      EXCEPTION WHEN duplicate_column THEN null; END $$;

      DO $$ BEGIN
        ALTER TABLE buses_v2 ADD COLUMN IF NOT EXISTS driver_incharge_phone VARCHAR(50) DEFAULT '';
      EXCEPTION WHEN duplicate_column THEN null; END $$;

      -- Add new columns to existing table if they don't exist
      DO $$ BEGIN
        ALTER TABLE fresher_resources ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'link';
      EXCEPTION WHEN duplicate_column THEN null; END $$;

      DO $$ BEGIN
        ALTER TABLE fresher_resources ADD COLUMN IF NOT EXISTS content TEXT DEFAULT '';
      EXCEPTION WHEN duplicate_column THEN null; END $$;

      DO $$ BEGIN
        ALTER TABLE fresher_resources ALTER COLUMN url DROP NOT NULL;
      EXCEPTION WHEN others THEN null; END $$;

      DO $$ BEGIN
        ALTER TABLE fresher_resources DROP CONSTRAINT IF EXISTS fresher_resources_type_check;
        ALTER TABLE fresher_resources ADD CONSTRAINT fresher_resources_type_check CHECK (type IN ('link', 'text', 'md'));
      EXCEPTION WHEN others THEN null; END $$;
    `;

    await pool.query(sql);

    return Response.json({ success: true, message: 'All tables created: buses, papers_archive, qbank_questions, qbank_topics, qbank_question_topics, fresher_resources, bus_routes, bus_stops, bus_placements, bus_students, transport_rules' });
  } catch (error: unknown) {
    console.error('Migration failed:', error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET — health check: DB connectivity + list tables
/**
 * @swagger
 * /api/admin/migrate:
 *   get:
 *     summary: Check database connectivity and list tables
 *     description: Returns the database connectivity status, server time, and a list of tables.
 *     tags:
 *       - Admin
 *     responses:
 *       200:
 *         description: Database health and table list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 connected:
 *                   type: boolean
 *                 db:
 *                   type: string
 *                 serverTime:
 *                   type: string
 *                 tables:
 *                   type: array
 *                   items:
 *                     type: string
 *                 error:
 *                   type: string
 */
export async function GET(req: Request) {
  const authResult = await requireSuperadmin(req);
  if (authResult instanceof Response) return authResult;

  try {
    const pool = getDbPool();

    if (!getWorkerEnv().DATABASE_URL && !getWorkerEnv().HYPERDRIVE) {
      return Response.json({ connected: false, error: 'DATABASE_URL not set' });
    }

    const { rows } = await pool.query("SELECT NOW() as time, current_database() as db");

    const { rows: tables } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    return Response.json({
      connected: true,
      db: rows[0].db,
      serverTime: rows[0].time,
      tables: tables.map(t => t.table_name),
    });
  } catch (error: unknown) {
    console.error('DB check failed:', error);
    return Response.json({ connected: false, error: "Internal server error" });
  }
}
