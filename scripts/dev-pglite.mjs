/**
 * Local in-memory Postgres (PGlite over TCP) for development/testing.
 * Seeds the club_representatives table. NOT for production use.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const PORT = Number(process.env.PGLITE_PORT ?? 55433);
const db = await PGlite.create();

await db.query(`
  CREATE TABLE club_representatives (
    club_id TEXT NOT NULL,
    vtop_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'representative',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (club_id, vtop_id)
  )
`);

await db.query(`
  INSERT INTO club_representatives (club_id, vtop_id, role) VALUES
    ('LINUX CLUB', '25BLC1081', 'representative'),
    ('ROBOTICS CLUB', '25BLC1081', 'super-club-rep'),
    ('LINUX CLUB', '24BCE0001', 'representative')
`);

await db.query(`
  CREATE TABLE club_feed (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    club_id TEXT NOT NULL,
    event_id TEXT,
    content TEXT NOT NULL,
    links JSONB DEFAULT '[]'::jsonb,
    image_urls JSONB DEFAULT '[]'::jsonb,
    posted_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

await db.query(`
  INSERT INTO club_feed (club_id, event_id, content, posted_by) VALUES
    ('LINUX CLUB', NULL, 'Hello from the LINUX CLUB local seed', '25BLC1081')
`);

const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1', maxConnections: 5 });
await server.start();
console.log(`PGlite socket PG listening on 127.0.0.1:${PORT}`);

process.on('SIGINT', async () => { await server.stop(); await db.close(); process.exit(0); });
