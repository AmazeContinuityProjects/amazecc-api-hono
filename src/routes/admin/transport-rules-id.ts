import { requireSection } from'../../lib/auth';
import { ensureTransportInD1 } from '../../lib/transportD1';


export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const db = await ensureTransportInD1();
    const { id: ruleId } = await params;
    const id = parseInt(ruleId, 10);
    if (isNaN(id)) {
      return Response.json({ success: false, error: 'Invalid rule ID' }, { status: 400 });
    }

    const deleted = (await db.prepare('DELETE FROM transport_rules WHERE id = ?').bind(id).run()).meta.changes ?? 0;
    if (deleted === 0) {
      return Response.json({ success: false, error: 'Rule not found' }, { status: 404 });
    }

    return Response.json({ success: true, message: 'Rule deleted successfully' });
  } catch (error: unknown) {
    console.error('Failed to delete rule:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
