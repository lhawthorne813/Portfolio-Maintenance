# OpsDeck — Property Maintenance Operations Platform

A mobile-first maintenance operations app for rental-property investors (20–200 units) and their maintenance teams. Not property management software — no rent, leasing, or accounting. It answers two questions: **"What should I do next?"** (technician) and **"What needs my attention?"** (owner).

## Demo logins (password for all: `demo123`)

| Role | Email | Sees |
|---|---|---|
| Owner | owner@demo.com | Full portfolio, analytics, approvals |
| Manager | manager@demo.com | Same operational views as owner |
| Technician | tech@demo.com | Only their assigned jobs (Mike Torres) |
| Vendor | vendor@demo.com | Only Coastal HVAC Pros jobs |

Demo data seeds automatically on first boot: 15 Jacksonville properties, ~40 units, 4 technicians, 3 vendors, 40+ work orders, assets, PM schedules, expenses, and two live repeat-repair patterns (Oak Haven HVAC, Avondale cast-iron plumbing).

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm run seed       # optional: wipe and re-seed demo data
```

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo. It auto-detects Node and runs `npm start`.
3. Set environment variables:
   - `SESSION_SECRET` — any long random string
4. **Persistence (recommended):** attach a Railway Volume mounted at `/data`, then set:
   - `DATA_DIR=/data`
   - `UPLOAD_DIR=/data/uploads`

   Without a volume, the SQLite database and uploaded photos reset on each redeploy (fine for a demo).

## Architecture

- **Backend:** Express + better-sqlite3 (WAL mode), session auth (bcrypt), multer photo uploads
- **Frontend:** zero-build vanilla JS SPA (`public/`), hash routing, mobile-first
- `src/db.js` — schema (19 tables) · `src/seed.js` — demo data · `src/api.js` — REST API + role guards · `src/insights.js` — health score, repeat-repair detection, tech scorecards, CapEx forecast

## What's implemented

**Phase 1 (complete):** auth + 4 roles with enforced permissions, properties/units, maintenance requests → work-order conversion, assignment (tech or vendor), 8-status workflow with full audit trail, technician mobile "Today" view with one-tap Start/Complete + live timer, before/after/receipt photos (camera capture on mobile), notes + voice-note entry, materials (auto-create expense lines), expenses, approval threshold workflow with instant round-trip notifications, in-app notifications, owner dashboard (stats, Needs Attention, status breakdown, spend, problem properties), global search.

**Phase 2 (complete):** explainable 0–100 Property Health Score with itemized deductions, technician scorecards (jobs, avg time, first-time fix, repeat rate, avg cost, on-time %), repeat-repair detection (3+ same property+category in 180 days), preventive-maintenance schedules that auto-generate work orders as due dates approach (checked at boot and every 6 hours), asset tracking with age/useful-life status, monthly + category cost analytics, maintenance calendar.

**Phase 3 (started):** CapEx forecast (24-month window from asset age/useful life/replacement cost, clearly labeled as estimates). AI diagnosis, route optimization, and trend detection are intentionally left for later so they can't compromise the core workflow.

## Notes

- Approval threshold is configurable in Settings (default $150).
- Sessions use the in-memory store — fine for a small team on one instance; swap in `connect-sqlite3` if you need sessions to survive restarts.
- "Voice notes" are typed/dictated via the phone keyboard mic; true audio recording is a natural next step.
