-- LOCAL-ONLY SEED — DO NOT APPLY TO PRODUCTION.
-- Production schema migration: ../amazecc-auth/migrations/0002_rbac.sql
UPDATE "user" SET role='superadmin' WHERE email='hono-admin@amaze.local';

INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role, vtopRegNo, permissions)
VALUES ('local-qbank-admin-1', 'Qbank Admin', 'qbank-admin@amaze.local', 0, '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z', 'admin', '24BCE0001', 'qbank');

INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role, vtopRegNo, permissions)
VALUES ('local-users-admin-1', 'Users Admin', 'users-admin@amaze.local', 0, '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z', 'admin', '24BCE0002', 'users,dashboard');

INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId)
VALUES ('sess-local-qbank-1', '2030-01-01T00:00:00.000Z', 'local-qbank-token-1', '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z', 'local-qbank-admin-1');

INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId)
VALUES ('sess-local-users-1', '2030-01-01T00:00:00.000Z', 'local-users-token-1', '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z', 'local-users-admin-1');

INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId)
VALUES ('sess-hono-admin-2', '2030-01-01T00:00:00.000Z', 'local-super-token-1', '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z', 'VNPVcwNKFEVHuBGahVn7ow');
