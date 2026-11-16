import { requireSection } from'../../lib/auth';
import type { BusStudentInput } from '../../types/transport';
import { ensureTransportInD1 } from '../../lib/transportD1';


export async function POST(req: Request) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const db = await ensureTransportInD1();
    const body = await (req.json() as any);
    const students: BusStudentInput[] = body.students || body;

    if (!Array.isArray(students) || students.length === 0) {
      return Response.json({ success: false, error: 'Expected a non-empty array of students' }, { status: 400 });
    }

    const routeNumber = students[0].routeNumber;
    if (!routeNumber) {
      return Response.json({ success: false, error: 'routeNumber is required for each student' }, { status: 400 });
    }

    const route = await db.prepare('SELECT id FROM buses_v2 WHERE route_number = ?')
      .bind(routeNumber).first<{ id: number }>();
    if (!route) {
      return Response.json({ success: false, error: 'Route not found' }, { status: 404 });
    }
    const routeId = route.id;

    await db.prepare('DELETE FROM bus_students WHERE route_id = ?').bind(routeId).run();
    const statements = students.map((student) => db.prepare(`INSERT INTO bus_students
      (route_id, registration_number, application_number, destination) VALUES (?, ?, ?, ?)`)
      .bind(routeId, student.registrationNumber, student.applicationNumber || '', student.destination || ''));
    for (let index = 0; index < statements.length; index += 80) await db.batch(statements.slice(index, index + 80));

    return Response.json({ success: true, message: `Inserted ${students.length} students for route ${routeNumber}` });
  } catch (error: unknown) {
    console.error('Failed to update students:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const auth = await requireSection('transport')(req);
  if (auth instanceof Response) return auth;
  if (!auth.permissions.includes('transport') && !auth.permissions.includes('buses')) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const db = await ensureTransportInD1();
    const url = new URL(req.url);
    const routeId = parseInt(url.searchParams.get('routeId') || '', 10);

    if (isNaN(routeId)) {
      return Response.json({ success: false, error: 'routeId query parameter is required' }, { status: 400 });
    }

    const rowCount = (await db.prepare('DELETE FROM bus_students WHERE route_id = ?').bind(routeId).run()).meta.changes ?? 0;
    return Response.json({ success: true, message: `Deleted ${rowCount} students for route ${routeId}` });
  } catch (error: unknown) {
    console.error('Failed to delete students:', error);
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
