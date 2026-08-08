# Steadhold — Property Maintenance Operations Platform

Multi-tenant maintenance operations for small rental portfolios: intake → triage → work orders → completion enforcement → analytics, with roles for owners, managers, technicians, vendors, and read-only viewers.

## Quick start (local)
```bash
npm install
node server.js          # http://localhost:3000
node test/api.test.js   # run the 57-check test suite (server must be running)
```

## Demo logins (password: `demo123`)
| Role | Email | Sees |
|---|---|---|
| Owner | owner@demo.com | Everything, incl. owner-tier approvals & org settings |
| Manager | manager@demo.com | Day-to-day ops, triage, quotes, manager-tier approvals |
| Technician | tech@demo.com | Only assigned jobs (Today / Jobs views) |
| Vendor | vendor@demo.com | Only Coastal HVAC's jobs + quote requests |
| Viewer | viewer@demo.com | Read-only owner view (investors/accountants) |
| 2nd org owner | owner@bayview.demo | A separate organization (proves isolation) |

## What's new in V2
- **Multi-tenant organizations** — self-serve signup creates an org; every query is scoped server-side to the session's organization; cross-org access always returns 404. Work-order numbers and settings are unique per organization.
- **Team management** — invite links (owner/manager/technician/viewer/vendor), role changes, deactivation (history preserved), last-owner protection.
- **Richer intake + triage queue** — tenant-context fields (access, permission to enter, pets, availability), emergency + safety/water/electrical/HVAC flags, and triage actions: convert (carries access info to the WO), re-prioritize, need-info, duplicate, reject. Converted/closed requests can't be re-triaged.
- **Configurable completion requirements** — per-category checklists (before/after photo, notes, materials, receipt, time). Enforced server-side; managers can override with a logged reason.
- **Technician flow** — Start Travel → Arrived → Start Work (travel and work time tracked separately), big-button UI, completion checklist modal. Where a category requires a *before* photo, work cannot start until it is taken (enforced server-side; managers can override with a logged reason) — a before photo taken after the repair is worthless.
- **Tiered approvals** — under T1: none; T1–T2: manager; over T2: owner only (managers get 403). Tiers editable in Settings.
- **Vendor quotes** — request from multiple vendors, vendors see and submit only their own, approving one assigns the job and declines the rest.
- **Attention Center dashboard** — grouped actionable cards: emergencies, approvals, overdue, triage, repeat repairs, PM overdue, cost anomalies, repair-vs-replace, quotes to review.
- **Property snapshot + unified timeline** — operating stats up top; filterable history across repairs, preventive work, inspections, and asset installs; explainable health score secondary.
- **Repair vs. replace engine** — transparent scoring (age, repair frequency, 12-mo spend vs. replacement cost, warranty) with owner actions: get quotes / mark replacement / keep repairing / dismiss 90 days.
- **QR labels** — printable SVG codes per asset/property/unit; scanning opens the equipment page with full service history.
- **CapEx forecast horizons** — 12 / 24 / 60 months with confidence levels; property comparison table (sortable); spend by vendor and technician; reactive-vs-preventive split.
- **Phone notifications** — real push notifications to phones via Web Push: each user taps "Enable on this device" in notification preferences (Settings → Notifications, or Profile for techs). Works in the browser on Android; on iPhone the app must first be added to the Home Screen (the app walks users through it). Emergencies are marked urgent and stay on screen. Optional Pushover delivery per user: set the PUSHOVER_TOKEN env var on the server, then each user pastes their own Pushover key. Per-kind In-app and Phone toggles control both channels. VAPID keys are auto-generated and persisted alongside the database.
- **Audit trail** — old → new values on status/priority/assignment changes; overrides logged.
- **Public tenant intake** — every property has a shareable link and printable QR poster (Property page → "Tenant request link"). Tenants report issues with photos, access notes, pets, and availability — no account, no app. Submissions land in the triage queue, notify management instantly, and photos + access details carry onto the converted work order. Rate-limited; links are unguessable and can be reset per property at any time.
- **Owner-review routing (per property)** — owners choose whether tenant requests go straight to maintenance triage or are held for the owner to review and release first (emergencies always go straight through). Viewers — the read-only owner/investor role — can also submit maintenance requests themselves, recorded as owner-reported.

## Architecture
- **Backend:** Node + Express + better-sqlite3 (`src/db.js` schema+migration, `src/api.js` REST, `src/insights.js` analytics, `src/seed.js` + `src/seed2.js` demo data)
- **Frontend:** dependency-free vanilla SPA (`public/js/app.js`), hash routing, role-aware
- **Migration:** `migrateV2()` runs automatically and is idempotent. It adds V2 tables/columns and rebuilds tables where SQLite CHECK constraints or key shapes had to change (`users` role check → app-layer; `work_orders` per-org numbering; `requests` proper PK + intake fields; `settings` per-org keys). Existing data is preserved and backfilled to the first organization.

## Deploying to Railway
1. Push this folder to GitHub; Railway auto-deploys on push.
2. Set env vars: `SESSION_SECRET` (any long random string). Optional: `DATA_DIR=/data`, `UPLOAD_DIR=/data/uploads` with a mounted volume at `/data` so the database and photos survive redeploys.
3. `PORT` is provided by Railway automatically.

## Tests
`node test/api.test.js` — 57 assertions covering auth, org isolation, viewer/tech/vendor scoping, intake→triage→completion, tiered approvals, quotes, validation, team protections, insights, and QR generation.
