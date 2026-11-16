# Runtime Postgres to D1 cutover

## Scope and status

- The current task moves Hono request handlers to D1. Historical application
  records are not being copied from Postgres.
- `APP_DB` is the dedicated `amazecc-api` D1 database. `AUTH_DB` remains the
  separate shared `amazecc-auth` database for Amaze ID sessions; its schema is
  not part of this change.
- Runtime handlers use `APP_DB` or `AUTH_DB`; there are no runtime PostgreSQL
  client or Hyperdrive bindings. D1 schemas are managed by `migrations/`.
- Runtime paths do not require a data-backfill marker. They read and write the
  rows currently present in D1, so records left in Postgres are not visible
  through these handlers.
- The worktree has removed Hyperdrive from `wrangler.jsonc`, but it has not
  been deployed. Production remains on its previously deployed Worker until a
  separate deployment.
- The old backfill utility and its `pg` development dependency remain for
  reference, but no data transfer is in scope. Do not run it with `--apply`.

## Runtime database ownership

- Service configuration, profiles, enrollments, social/FFCS, marks statistics,
  QBank, CabShare, transport, clubs, faculty directories, fresher resources,
  and admin audit/settings data use `APP_DB`.
- Amaze ID user/session and admin identity lookups use `AUTH_DB` only.
- Tables excluded from historical transfer remain in D1 schema where routes
  need them, but their Postgres rows are not copied. This includes bus
  students, GoRobo, push subscriptions, files, and visitor logs.
- Marks and cohort statistics are built from new attendance observations.

## Local verification

```powershell
pnpm typecheck
pnpm exec wrangler d1 migrations apply amazecc-api --local
pnpm exec wrangler d1 execute amazecc-api --local --json --command "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"
pnpm exec wrangler deploy --dry-run
```

The local faculty directory smoke request returned `200` with an empty D1
result. The deploy dry-run showed only `APP_DB` and `AUTH_DB` bindings. Neither
check deploys the worktree or copies historical records.
