import { requireAdminAuth } from '../../lib/auth';
import { getDbPool } from '../../lib/db';

export async function GET(req: Request) {
    const authResult = await requireAdminAuth(req);
    if (authResult instanceof Response) {
        return authResult; // Unauthorized
    }

    try {
        const pool = getDbPool();
        const result = await pool.query('SELECT * FROM club_details ORDER BY club_name ASC');
        return Response.json({ success: true, clubs: result.rows }, { status: 200 });
    } catch (error: unknown) {
        console.error('Error fetching club details in admin GET:', error);
        return Response.json({ success: false, error: 'Failed to fetch club details' }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const authResult = await requireAdminAuth(req);
    if (authResult instanceof Response) {
        return authResult; // Unauthorized
    }

    try {
        const body = await (req.json() as any);
        const { club_id, club_name, mission, description, hiring_process, website, recruitment_link, instagram, whatsapp, poc, logo_url } = body;

        if (!club_id || !club_name) {
            return Response.json({ success: false, error: 'club_id and club_name are required' }, { status: 400 });
        }

        const pool = getDbPool();
        
        // Upsert
        const query = `
            INSERT INTO club_details (
                club_id, club_name, mission, description, hiring_process, website, recruitment_link, instagram, whatsapp, poc, logo_url
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
            )
            ON CONFLICT (club_id) DO UPDATE SET
                club_name = EXCLUDED.club_name,
                mission = EXCLUDED.mission,
                description = EXCLUDED.description,
                hiring_process = EXCLUDED.hiring_process,
                website = EXCLUDED.website,
                recruitment_link = EXCLUDED.recruitment_link,
                instagram = EXCLUDED.instagram,
                whatsapp = EXCLUDED.whatsapp,
                poc = EXCLUDED.poc,
                logo_url = EXCLUDED.logo_url,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *;
        `;
        
        const values = [club_id, club_name, mission, description, hiring_process, website, recruitment_link, instagram, whatsapp, poc, logo_url];
        
        const result = await pool.query(query, values);

        return Response.json({ success: true, club: result.rows[0] }, { status: 200 });
    } catch (error: unknown) {
        console.error('Error updating club details in admin POST:', error);
        return Response.json({ success: false, error: 'Failed to update club details' }, { status: 500 });
    }
}
