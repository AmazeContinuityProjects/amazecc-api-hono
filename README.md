# amazecc-api-hono

The optimized rewrite of the AmazeCC API for **Cloudflare Workers + Queues**.
No Next.js, no axios, no `node-canvas`, no Node TLS hacks — Hono on raw Web
APIs with a small, deliberate dependency set, targeting a **10 ms CPU budget
per request** (Cloudflare's free-tier limit).

Lineage: ported from [`../amazecc-api`](../amazecc-api). The **VTOP scrapers →
`/api/remote/*`**, **services built atop them → `/api/services/*`**, and the
**admin surface → `/api/admin/*`**.

---

## Access control (RBAC)

Identity is **Amaze ID** (`auth.amazecc.com`); this worker shares its D1 database (`AUTH_DB`), so authorization is one indexed query per admin request — no token signing round-trip, instant revocation.

| Role | Access |
|---|---|
| `superadmin` | Every section; manages admins at `/api/admin/users*` |
| `admin` | Only the sections in the user's `permissions` field (comma-separated, stored in D1) |
| `user` | No admin surface |

Section keys (`src/lib/permissions.ts`): `dashboard`, `qbank`, `buses`, `transport`, `gorobo`, `clubs`, `cabshare`, `fresher-resources`, `faculty-directories`, `push`, `settings`, `storage`, `users`, `ocr`, `migrate`, `audit-logs`.

`/api/admin/users*` and `/api/admin/migrate` are superadmin-only. Every other `/api/admin/*` and `/api/qbank/admin/*` route is section-gated. `/api/club-admin/*` stays on the VTOP-linked club token until the club flow migrates.

To create/promote an admin: they sign up at `auth.amazecc.com/sign-up`, then a superadmin:

```sh
curl -X POST https://hono.amazecc.com/api/admin/users \
  -H "Authorization: Bearer <your Amaze ID session token>" \
  -H "content-type: application/json" \
  -d '{"email":"them@vit.ac.in","role":"admin","permissions":["qbank"]}'
```

## QBank storage

`/api/qbank/import-to-storage` and `/api/qbank/papers/download/*` use a **native R2 binding** (`PAPERS_BUCKET`, preferred) or S3-compatible `B2_*` credentials as fallback. Until one is configured they answer `503 storage not configured` (by design — the failure is explicit, not silent). To enable R2:

1. Cloudflare Dashboard → R2 → Enable, create bucket (e.g. `amazecc-qbank`)
2. `wrangler.jsonc`: add `"r2_buckets": [{ "binding": "PAPERS_BUCKET", "bucket_name": "amazecc-qbank" }]`
3. `wrangler deploy`

No keys are needed for the native binding.

## Environment

See `.env.example` — account/zone, bindings (D1, Hyperdrive, queue), and the secrets you must track. `.env` (gitignored) holds local dev values; production bindings live in `wrangler.jsonc` + `wrangler secret put`.

---

## Layout

```
src/
  index.ts            worker entry (fetch + queue consumer)
  app.ts              Hono app composition, /api/health, /api/status
  env.ts              per-request bindings stashed for shared libs
  routes/
    remote/*.ts       VTOP (and LMS/Vitol/directory) scrapers
    services/*.ts     features atop remote + the database (marks, enroll, faculty)
    admin/*.ts        admin CRUD (auth, gorobo, transport, users, push, …)
  lib/
    vtop.ts           fetch-based VTOP client (no axios, no TLS pinning)
    vtopLogin.ts      shared pre-login → captcha → dashboard attempt
    captcha/          pure-JS MLP solver (jpeg-js + pngjs, no canvas/WASM)
    crypto.ts         WebCrypto HMAC/base64url (timing-safe)
    auth.ts           admin + service HMAC tokens (legacy-compatible format)
    clubAuth.ts       club-rep tokens (typ "club")
    db.ts             Hyperdrive → pg (local fallback: DATABASE_URL)
    marksStats.ts     Welford cohort stats (class_user_marks, no values stored)
    services.ts       service registry + unified enrollment (service_enrollments)
    syncClubs.ts      daily VTOP club sync — run via the SYNC_QUEUE consumer
    webpush.ts        RFC 8291/8292 Web Push on WebCrypto
    parsers/*         cheerio + htmlparser2 parsers (ported 1:1)
```

**Dependencies (runtime, complete):** `hono` · `pg` (Hyperdrive) ·
`cheerio` · `htmlparser2`/`css-select`/`domhandler`/`domutils` ·
`jpeg-js` · `pngjs` · `aws4fetch` (reserved for qbank pass).
Bundle ≈ **2.3 MB raw / 462 KB gzip**.

## What's where (full route map)

### `/api/remote/*` — VTOP (and LMS/Vitol/directory) scrapers

| Route | Port of | Notes |
|---|---|---|
| `POST /api/remote/login` | `/api/login` | captcha solved in-worker; enqueues daily club sync to `SYNC_QUEUE` |
| `POST /api/remote/whoami` | `/api/whoami` | 10 sequential page scrapes, identity merged |
| `POST /api/remote/attendance` | `/api/attendance` | cheerio variant |
| `POST /api/remote/attendance/htmlparser2` | `/api/attendance/htmlparser2` | lower-CPU variant (recommended); records class enrollment |
| `POST /api/remote/grades` | `/api/grades` | overall + semester history |
| `POST /api/remote/ffcs` | `/api/ffcs` | registration/feedback/wishlist/schedule/qcm |
| `POST /api/remote/finance` | `/api/finance` | dues/receipts/wallet/bank/library |
| `POST /api/remote/hostel` | `/api/hostel` | profile + leave history |
| `POST /api/remote/od` | `/api/od` | |
| `POST /api/remote/curriculum` | `/api/curriculum` | parsers: curriculum + categoryView |
| `POST /api/remote/curriculum/syllabus` | `/api/curriculum/syllabus` | streams PDF/ZIP |
| `POST /api/remote/curriculum/download` | `/api/curriculum/download` | streams PDF/ZIP |
| `POST /api/remote/course-page` | `/api/course-page` | cascading AJAX (course→slot→faculty→details) |
| `POST /api/remote/lms-data` | `/api/lms-data` | Moodle lms.vit.ac.in |
| `POST /api/remote/vitol-data` | `/api/vitol-data` | `vitolSite` selects vitolcc / vitolcc1 |
| `POST /api/remote/transport` | `/api/transport` | registration + live bus link |
| `POST /api/remote/circulars` | `/api/circulars` | |
| `POST /api/remote/circulars/download` | `/api/circulars/download` | streams PDF |
| `POST /api/remote/calendar` | `/api/calendar` | semester timetable calendar |
| `POST /api/remote/bulk` | `/api/bulk` | whitelisted proxies: `hostel-counselling`, `registration-schedule`, `exc-registration`, `course-completion` |

### `/api/services/*` — services atop remote

| Route | Port of | Notes |
|---|---|---|
| `POST /api/services/marks/sync` | `/api/marks/sync` | identity resolved from VTOP; HMAC tokens; Welford stats |
| `POST /api/services/marks/stats` | `/api/marks/stats` | enrollment-gated class cohort stats (POST only) |
| `POST /api/services/marks/tokens` | `/api/marks/tokens` | HMAC tokens + legacy associations |
| `POST /api/services/enroll` | **new** | unified enrollment (see below) |
| `GET /api/services/enroll` | **new** | enrollment state (Bearer or `?cookies=&authorizedID=&csrf=`) |
| `DELETE /api/services/enroll` | **new** | un-enroll |
| `POST /api/services/faculty/scrape` | `/api/faculty/scrape` | VIT directory scraper; SSRF allow-list re-checked per redirect |
| `GET /api/services/faculty/schools` | `/api/faculty/schools` | public school list (DB) |

### `/api/admin/*` — admin surface (HMAC bearer, re-checked against env+DB per request)

| Route | Port of |
|---|---|
| `POST /api/admin/auth` | `/api/admin/auth` (now calls shared VTOP login, no HTTP self-call) |
| `POST /api/admin/buses` | `/api/admin/buses` |
| `POST/DELETE /api/admin/cabshare/hubs` | `/api/admin/cabshare/hubs` |
| `GET/DELETE /api/admin/cabshare/trips` | `/api/admin/cabshare/trips` |
| `GET/POST /api/admin/clubs` | `/api/admin/clubs` |
| `GET/POST/DELETE /api/admin/clubs/representatives` | `/api/admin/clubs/representatives` |
| `GET/POST/PUT/DELETE /api/admin/faculty-directories` | `/api/admin/faculty-directories` |
| `GET/POST /api/admin/fresher-resources` · `PATCH/DELETE /api/admin/fresher-resources/:id` | `/api/admin/fresher-resources*` |
| `GET /api/admin/gorobo/analytics` | `/api/admin/gorobo/analytics` |
| `GET/POST /api/admin/gorobo/bundles` · `PUT/DELETE /api/admin/gorobo/bundles/:id` | `/api/admin/gorobo/bundles*` |
| `GET/POST /api/admin/gorobo/items` · `PUT/DELETE /api/admin/gorobo/items/:id` · `PATCH /api/admin/gorobo/items/stock` | `/api/admin/gorobo/items*` |
| `GET/POST /api/admin/gorobo/orders` · `GET/PUT/PATCH /api/admin/gorobo/orders/:id` | `/api/admin/gorobo/orders*` |
| `POST /api/admin/gorobo/orders/:id/{archive,complete,confirm,unarchive}` | `/api/admin/gorobo/orders/[id]/*` |
| `GET /api/admin/gorobo/wallet` · `POST /api/admin/gorobo/wallet/orders/:id/settle` | `/api/admin/gorobo/wallet*` |
| `GET/POST /api/admin/migrate` | `/api/admin/migrate` |
| `POST /api/admin/ocr` · `POST /api/admin/ocr/reset` | `/api/admin/ocr*` |
| `POST /api/admin/push` | `/api/admin/push` (Web Push via WebCrypto) |
| `PUT /api/admin/settings/global` | `/api/admin/settings/global` |
| `GET /api/admin/stats` | `/api/admin/stats` |
| `GET/POST /api/admin/storage` | `/api/admin/storage` |
| `GET/POST /api/admin/transport/placements` | `/api/admin/transport/placements` |
| `GET/POST /api/admin/transport/routes` · `GET/PUT/DELETE /api/admin/transport/routes/:id` · `POST …/:id/stops` | `/api/admin/transport/routes*` |
| `GET/POST /api/admin/transport/rules` · `DELETE /api/admin/transport/rules/:id` | `/api/admin/transport/rules*` |
| `POST /api/admin/transport/seed` · `POST /api/admin/transport/students` · `DELETE /api/admin/transport/students` | `/api/admin/transport/*` |
| `GET/POST /api/admin/users` · `PATCH/DELETE /api/admin/users/:username` | `/api/admin/users*` |

### Unified enrollment API

One call opts a student into **all current and future** `/api/services/*`.

- `POST /api/services/enroll` — `{ services?: string[] }` + credentials
  (Bearer `serviceToken`, **or** `{ cookies, authorizedID, csrf }`).
  Enrolls in the requested services (default: **all** in the registry).
  VTOP-authenticated callers also receive a 24 h `serviceToken` to use
  afterwards (`Authorization: Bearer …`).
- `GET /api/services/enroll` — enrollment state per service
  (Bearer, or `?cookies=&authorizedID=&csrf=`).
- `DELETE /api/services/enroll` — `{ services?: string[] }` revokes
  (default: all).

Identity is **always** resolved server-side (VTOP profile response, or the
`sub` claim of a service token minted by this route) — the client can never
name another student's enrollment. Rows live in `service_enrollments`
(`owner_key` = HMAC(REGISTER NO, ID_SALT) — values are never stored).

Current registry (`src/lib/services.ts`): `marks-stats`.

---

## Hyperdrive + Supabase (learned the hard way)

For Supabase, create the Hyperdrive against the **direct** connection host
(`db.<project-ref>.supabase.co:5432`, user `postgres`), **not** the
transaction pooler (`aws-N-<region>.pooler.supabase.com:6543`). Queries routed
through the pooler via Hyperdrive **never return and never error** — the
connection handshakes fine (~20 ms) and the query bytes are never relayed back
(observed as requests that time out at 25–125 s with zero worker logs). The
`postgres.<ref>` pooler user format is additionally pooler-only and is not
valid on the direct host.

## Production state (deployed)

- **Worker**: `https://amazecc-api-hono.sugeethjayaraj2007.workers.dev` — all routes live
- **Hyperdrive** `amazecc-db-direct` → `db.<project-ref>.supabase.co:5432` — serving real queries
  (e.g. `faculty/schools` ~600 ms)
- **Queues**: `amazecc-sync` + consumer + `amazecc-sync-dlq`
- **Secrets**: ADMIN_SECRET · ID_SALT · ADMIN_VTOP_IDS · VAPID keys (all pushed)
- **Verified end-to-end**: VTOP login/captcha from the edge ✓, admin auth + real DB counts ✓,
  enroll + remote routes ✓, 401 sweeps ✓

```bash
pnpm install
wrangler queues create amazecc-sync
wrangler queues create amazecc-sync-dlq
wrangler hyperdrive create amazecc-db-direct --connection-string="postgresql://postgres:…@db.<project-ref>.supabase.co:5432/postgres"
#   → paste the id into wrangler.jsonc "hyperdrive"
wrangler secret put ADMIN_SECRET          # required (≠ ID_SALT)
wrangler secret put ID_SALT               # required
wrangler secret put ADMIN_VTOP_IDS        # optional superadmin list
wrangler secret put NEXT_PUBLIC_VAPID_PUBLIC_KEY   # admin push
wrangler secret put VAPID_PRIVATE_KEY              # admin push
wrangler deploy
```

Local dev (port 3100) needs **no** Hyperdrive/queues:

```bash
DATABASE_URL=postgresql://… pnpm dev
# or: cp .env.example .dev.vars   (ADMIN_SECRET / ID_SALT / ADMIN_VTOP_IDS, no HF binding)
```

`npx wrangler deploy --dry-run` passes. Verified matrix: VTOP TLS + captcha
login, 12 remote routes 400/200 correctly, admin 401-gating everywhere,
authenticated admin 200.

## Design decisions (the 10 ms budget)

- **VTOP TLS**: the old code pinned the Sectigo intermediate (VIT's servers
  omit it). Probed `fetch` from a real Worker → **HTTP 200, set-cookie
  present**. Cloudflare's egress verifies VTOP fine, so **no cert pinning, no
  relay**. Deno/Node paths need no such relay either, but on Workers the
  custom-CA problem simply doesn't exist.
- **Scraping stays inline** (the client needs the answer ASAP). Network wait
  doesn't count against the 10 ms CPU; parsing does — the hot scrapers use
  the htmlparser2 path where available (`attendance/htmlparser2`), and cheerio
  elsewhere (same parsers as before, O(small doc)).
- **Background work goes to the queue**: the daily club sync (enqueued by
  login) runs in the `SYNC_QUEUE` consumer. Cron-style jobs can use the same
  queue when `/api/cron/*` is ported.
- **`waiver`**: routes that scrape 10+ pages (`whoami`, `grades`, `ffcs
  all`) are I/O-bound but CPU-heavy; if your plan has a strict 10 ms CPU
  ceiling they may exceed it — htmlparser2-fy their parsers first, or raise
  the CPU limit (paid plans allow 30 s).
- **Rate limiting** is per-isolate (same semantics as the original). For
  strict global limits back it with KV.
- **TLS escape hatch**: `VIT_TLS_INSECURE` was *deleted* — Workers never had
  it, and Node's custom agent is gone.
- **Tokens are legacy-byte-compatible**: `base64(payload).hex(HMAC-SHA256)`
  with per-typ derived keys — existing admin sessions keep working after the
  migration.
- **`NODE_TLS_REJECT_UNAUTHORIZED=0` calls are deleted** — the Workers egress
  handles VIT's chain; leaking/bypassing cert verification is not an option.

## Client migration (path map)

| Old | New |
|---|---|
| `/api/login` | `/api/remote/login` |
| `/api/whoami` | `/api/remote/whoami` |
| `/api/attendance` | `/api/remote/attendance` |
| `/api/attendance/htmlparser2` | `/api/remote/attendance/htmlparser2` |
| `/api/grades` | `/api/remote/grades` |
| `/api/ffcs` | `/api/remote/ffcs` |
| `/api/finance` | `/api/remote/finance` |
| `/api/hostel` · `/api/od` · `/api/curriculum*` · `/api/course-page` | `/api/remote/…` |
| `/api/lms-data` · `/api/vitol-data` | `/api/remote/lms-data` · `/api/remote/vitol-data` |
| `/api/transport` · `/api/circulars*` · `/api/calendar` · `/api/bulk` | `/api/remote/…` |
| `/api/marks/sync` · `/api/marks/stats` · `/api/marks/tokens` | `/api/services/marks/*` |
| `/api/faculty/scrape` · `/api/faculty/schools` | `/api/services/faculty/*` |
| `/api/admin/*` | unchanged shape |
| `/api/docs` · `/api/status` · `/api/health` | docs dropped in this port; status/health kept at root |

## Deliberately NOT ported yet (next passes)

Public/DB surfaces that don't scrape VTOP or gate admins:
`GET /api/docs` (swagger UI), `tests` (vitest configs),
`/api/social/*` (all), `/api/cabshare/*` (all),
`/api/qbank/*` (all), `/api/gorobo/*` (public items/orders/seed/version),
`/api/events/*` (all), `/api/club-admin/*` (all), `/api/clubs/details`,
`/api/koha/*`, `/api/notifications/*`, `/api/cron/reminders`,
`/api/fresher-resources` (public list), `/api/settings/global` (public read),
`/api/buses`, `/api/transport` (already covered under remote),
`/api/circulars*` (done), `/api/whoami` (done).

Port order suggestion: `notifications` (small) → `gorobo` public (medium) →
`events` (+ eventhub proxy) → `social` (Supabase) → `qbank` → `cron`.
