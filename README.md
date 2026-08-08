# Steadhold V3 — Maintenance Autopilot

Steadhold is a maintenance operating system for owner-operated rental portfolios with roughly 20–200 units and 1–10 in-house technicians. It moves a repair from resident request to verified, cost-controlled completion automatically, while managers work from an exception queue instead of a general inbox.

## What makes it different

The core metric is **verified zero-touch resolution rate**: the share of resident-originated repairs that reached evidence-backed completion without management intervention. Every automated decision is explainable, logged, and reversible where the underlying action is safe to undo.

- **Policy engine and Exception Center** — deterministic playbooks authorize routine actions; uncertainty, safety risks, policy breaches, overdue work, stale quotes, unaccepted assignments, parts delays, and resident replies become exceptions.
- **Resident magic-link workflow** — no account required. Residents receive safety guidance, see status, reply, confirm appointments, grant entry permission, rate completion, and reopen failed repairs. Reopening creates a linked priority callback.
- **Smart dispatch** — ranks technicians using trade skills, schedule and daily capacity, property familiarity, similar-job history, availability, emergency duty, and cost. Auto-assignment occurs only above a confidence threshold.
- **Four ready-to-run playbooks** — active water leak, HVAC outage, electrical/safety hazard, and routine repair.
- **SLA escalation** — configurable acknowledge, start, and resolve targets by priority, with durable recurring scans.
- **Closed-loop cost capture** — receipt photos can create coded expenses and material lines; spend policies and low-confidence extraction create review exceptions. Repair-vs-replace guidance and repeat callbacks remain visible to owners.
- **PMS/accounting bridges** — property/unit CSV import, work-order and accounting CSV export, token-scoped inbound maintenance webhooks, and HMAC-signed outbound event webhooks.
- **Owner visibility** — weekly digest of completed/opened work, spend, automated actions, callbacks, exceptions, and zero-touch performance.
- **Offline field operations** — cached app shell and reads, durable ordered write queue, photo support, and idempotent replay for technicians in low-signal locations.

AI is optional and deliberately constrained. When `OPENAI_API_KEY` is configured, image and receipt interpretation uses structured output through the OpenAI Responses API. Deterministic playbooks and spending rules remain authoritative; model output never approves spend, dispatches a safety-sensitive job, or overrides a human.

## Quick start

Requires Node.js 18 or newer. Node.js 22 LTS is recommended.

```bash
npm install
npm start
```

Open `http://localhost:3000`. On an empty database Steadhold adds a demo portfolio automatically.

For local optional adapters on Node.js 22, copy `.env.example` to `.env`, add the values you need, and run `node --env-file=.env server.js`. Hosted environments should set the same variables in their runtime configuration.

| Role | Email | Password |
|---|---|---|
| Owner | `owner@demo.com` | `demo123` |
| Manager | `manager@demo.com` | `demo123` |
| Technician | `tech@demo.com` | `demo123` |
| Vendor | `vendor@demo.com` | `demo123` |
| Viewer | `viewer@demo.com` | `demo123` |
| Separate-org owner | `owner@bayview.demo` | `demo123` |

## Autopilot flow

1. A resident, owner, or PMS creates a request.
2. A durable job classifies it against the enabled playbooks and SLA policy.
3. Steadhold sends safe resident guidance, creates and schedules the work order, and scores dispatch candidates.
4. A high-confidence match is assigned automatically; otherwise one clear dispatch exception is created.
5. Status, appointment, approval, parts, and completion events update the resident thread automatically.
6. Evidence and cost rules gate closeout. The resident verifies the outcome or creates a linked callback.
7. Owners see the result in the zero-touch KPI and weekly digest.

The background worker only claims records from SQLite's `durable_jobs` and `outbox` tables. Jobs, retries, scheduled scans, outbound delivery, and login sessions survive process restarts.

## Configuration

Copy values from [.env.example](.env.example) into your hosting environment. Only `SESSION_SECRET` is strongly recommended for production; all delivery and AI adapters are optional.

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Stable encrypted-cookie signing secret |
| `DATA_DIR` | Persistent directory for SQLite and generated keys |
| `UPLOAD_DIR` | Persistent directory for resident and work-order photos |
| `APP_URL` | Public origin used in email/SMS tracking links |
| `OPENAI_API_KEY` | Optional receipt and maintenance-photo interpretation |
| `OPENAI_VISION_MODEL` | Optional model override; defaults to `gpt-5.4-mini` |
| `RESEND_API_KEY`, `EMAIL_FROM` | Optional email delivery |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Optional SMS delivery |
| `PUSHOVER_TOKEN` | Optional Pushover delivery; Web Push works independently |

Adapter readiness is shown in **Settings → Autopilot** and **Settings → Integrations**. If an adapter is absent, its work is marked skipped/not configured without blocking the maintenance workflow.

### Inbound PMS webhook

Create an inbound endpoint in **Settings → Integrations**, then send JSON to its private URL:

```json
{
  "event": "maintenance_request",
  "property_id": 1,
  "unit_id": 2,
  "category": "HVAC",
  "priority": "high",
  "description": "No heat",
  "reported_by": "PMS sync",
  "reporter_phone": "+19045550199"
}
```

Outbound webhooks include `X-Steadhold-Event` and, when a secret is present, `X-Steadhold-Signature: sha256=<HMAC>`. Private-network webhook destinations are rejected.

## Tests

Start the server against a disposable database, then run both suites:

```bash
npm run test:regression
npm run test:autopilot
```

- `test/api.test.js`: 109 regression assertions covering authentication, tenant isolation, roles, intake, technician flow, completion gates, approvals, vendors, offline replay, push, analytics, and QR.
- `test/v3.test.js`: 50 end-to-end Autopilot assertions covering policy pause/reactivation, two-way resident workflow and evidence, classification, technician/vendor dispatch, callbacks, exceptions, audit/undo, SLA, digests, receipt fallback, CSV, and webhooks.

The test server should use a fresh `DATA_DIR` and `UPLOAD_DIR`; both suites intentionally create records.

## Architecture

- **Backend:** Node.js, Express, SQLite through `better-sqlite3`
- **Automation:** `src/automation.js` policy engine and durable jobs; `src/notifications.js` outbox and delivery adapters
- **Optional AI:** `src/ai.js`, OpenAI Responses API with strict JSON schemas and `store: false`
- **Frontend:** dependency-free hash-routed SPA with role-aware views and a public resident portal
- **Persistence:** idempotent V2/V3 migrations, SQLite sessions, tenant-scoped records, durable jobs/outbox
- **Offline:** service-worker app shell plus IndexedDB reads and idempotent mutation replay

## Deployment

For Railway or another Node host:

1. Run `npm start` and expose the platform-provided `PORT`.
2. Mount a persistent volume and set `DATA_DIR=/data` and `UPLOAD_DIR=/data/uploads`.
3. Set a long random `SESSION_SECRET` and the public `APP_URL`.
4. Add only the optional delivery/AI credentials you intend to use.
5. Back up the SQLite database and uploads together.

Steadhold applies schema migrations automatically and preserves existing V1/V2 data. A fresh-install bootstrap defect in the earlier build has also been corrected, so a clean database and a restart of an existing database follow the same safe initialization path.
