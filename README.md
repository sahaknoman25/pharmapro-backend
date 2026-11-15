# PharmaPro Backend API

Real, production-shaped backend for the PharmaPro mobile app (Expo / React
Native), owned by **SWM — Sahak Web & Media**. It implements the full API
contract in `../pharmapro-mobile-app/docs/API_CONTRACT.md`: 44 actions under
`POST /api/v1/actions/<actionName>` plus the backend-only `restore` endpoint
and the documented gaps (`closecash`, `voidsale` `reason`, `getreports`
`branchId`).

- **Stack:** Node.js 20 + TypeScript + Express, PostgreSQL 15+ (`pg`),
  bcryptjs password hashing, crypto-random session tokens stored hashed
  (sha256) with 30-day expiry.
- **Multi-tenant:** every business row carries `workspace_id`, resolved from
  the session token. No workspace can read or change another workspace's data.
- **Business rules enforced server-side:** FEFO allocation (earliest-expiry
  first, spill-over), expired batches never sellable, batches never merged,
  void/return restores quantities to the exact original batches and reverses
  qarz, profit from actual batch purchase costs, role checks, audit logging,
  rate limiting on login.

## Run locally

Requirements: Node.js 20+, PostgreSQL 15+.

```bash
npm install
cp .env.example .env        # set DATABASE_URL (and a real SESSION_SECRET)
npm run migrate             # applies migrations/*.sql in order
npm run build && npm start  # or: npm run dev (watch mode)
```

Server listens on `PORT` (default 3000). Health check: `GET /health`.

## Tests

```bash
npm test
```

`npm test` recreates the `pharmapro_test` database on the local PostgreSQL
server, applies the migrations, starts the real server, and runs
`tests/api.test.mjs` (node:test) against it. It covers: workspace setup,
login/logout, a purchase creating 3 batches (incl. one expired), a FEFO sale
of 7 allocating exactly 3 from B-101 + 4 from B-102 with correct change,
oversell rejection, a Qarz sale + void restoring stock and balance, tenant
isolation, export/restore round-trip, cash closing and branch reports.

## Deploy (Render free tier)

1. Push this folder to a GitHub repo.
2. In Render: **New → Blueprint**, select the repo. `render.yaml` creates the
   web service + Postgres and wires `DATABASE_URL` and `SESSION_SECRET`.
3. Migrations run automatically on server start.
4. Note the public URL, e.g. `https://pharmapro-backend.onrender.com`.

**Free-tier warning:** Render's free Postgres expires after 90 days. For a
real business, upgrade to a paid database (or move to a VPS) before then,
and keep regular `pg_dump` backups regardless of tier.

## Point the mobile app at it

In the mobile app project (`pharmapro-mobile-app`):

- Set `EXPO_PUBLIC_API_URL` to the backend URL (e.g.
  `https://pharmapro-backend.onrender.com`) before building, **or**
- Open the app → Settings → server address, and enter the same URL.

The app warns while the address is still the placeholder
`https://api.pharmapro.example`.

## API shape

```
POST {API_BASE_URL}/api/v1/actions/<actionName>
Content-Type: application/json
Authorization: Bearer <token>   (optional; token is also in the body)
Body: JSON object with the action fields, including "token"
Response: { "ok": true, "data": ... }  or  { "ok": false, "error": "..." }
```

All 44 actions from the contract, plus:

| Action | Notes |
|---|---|
| `closecash` | New. Body `{ date, openingCash, countedCash, branchId? }`. Cash sales/expenses for the day are computed server-side; returns the closing record with expected vs counted and the difference. |
| `listclosings` | New. Closing history. |
| `voidsale` | Now accepts optional `reason`, stored in the server audit log. Void always restores stock to the original batches and reverses qarz. Admin only. |
| `getreports` | Now accepts optional `branchId` for per-branch reports. |
| `restore` | Backend-only. See below. |
| `registerpushtoken` | New. Stores an Expo push token for future remote push. |

## Data safety — restore

**Never delete, overwrite, modify or damage existing business data.**

`restore` never restores over live data. It restores the backup into a **new,
separate workspace** (a verified copy), checks that the record counts match
the backup, and returns the new workspace id. The original workspace is left
untouched. The user switches over by logging into the restored workspace with
the same credentials as the backup; the old workspace can then be suspended
by the SWM admin (`swmsetworkspacestatus`). The mobile app additionally only
offers restore after a fresh backup exists in the session and after explicit
confirmation.

## Seeds

Migrations seed the 4 plans (**Free Trial / Basic / Professional /
Enterprise**) and the 5 default payment methods (**Cash, Qarz, HesabPay
manual, M-Paisa manual, Card**).

- **Plan prices are 0 (not set) on purpose** — SWM sets real subscription
  prices in the `plans` table before selling. Do not treat 0 as a real price.
- Billing is manual records in v1 (see `changeplan`); there is no payment
  gateway yet.

## Roles

`Admin`, `Pharmacist`, `Cashier`, `Inventory Manager`. Enforced server-side:

- Void / return a sale: **Admin only** (with a written reason).
- Create employees, branches, change plan, workspace settings: **Admin only**.
- Adjust stock / batch status / transfers: **Admin or Inventory Manager**.
- Purchases: **Admin, Pharmacist or Inventory Manager**.
- POS sales, customers, supplier/customer payments: any active role.
- SWM platform admin (`swmoverview`, `swmsetworkspacestatus`): only users
  with `is_swm_admin = true`. Grant it with SQL, e.g.:
  `UPDATE users SET is_swm_admin = TRUE WHERE username = '...';`

## Known limitations (honest, not faked)

- **Login by username only.** The contract's `login` takes `username` +
  `password` with no workspace identifier, so if two workspaces both have a
  user called `admin`, login returns the earliest-created one. Pharmacies
  should use distinctive usernames (e.g. include the pharmacy name).
- **Remote push is implemented but not triggered.** `push_tokens` and
  `registerpushtoken` exist and `src/lib/push.ts` can send via Expo's push
  service, but nothing sends alerts yet and the mobile app does not register
  its token yet. Local on-device alerts are the working notification path.
- **No payment gateway.** Subscription billing is manual records.
- **Forgot password is admin-reset only** (an Admin changes the password with
  `saveuser`); there is no self-service reset email/SMS.
- **`slowMovers` in reports is workspace-wide** (not branch-filtered).
- **Medicine images:** `savemedicine` accepts an optional `imageUrl` and
  `listmedicines` returns it, but the mobile app does not send images yet.
- **AI assistant is analytics, not a language model:** it computes real
  summaries, best/slow movers and a 90-day stock forecast server-side and
  answers simple keyword questions from that data. It never gives medical
  advice.

## Project layout

```
src/
  index.ts            Express server, rate limits, error handler
  db.ts               pg pool, transactions, migration runner
  auth.ts             bcrypt, session tokens, role checks
  util.ts / errors.ts validation + serialisation helpers
  lib/common.ts       audit log + row mappers (snake_case -> camelCase)
  lib/fefo.ts         FEFO allocation + restore-to-batch
  lib/push.ts         Expo push sender
  actions/            one module per area (auth, pos, inventory,
                      purchases, customers, finance, reports, admin)
  actions/index.ts    action registry + dispatcher
migrations/           001_init.sql (schema), 002_seed.sql (plans, methods)
src/migrate.ts        `npm run migrate`
tests/                api.test.mjs + setup-test-db.mjs (`npm test`)
Dockerfile  render.yaml  .env.example
```
