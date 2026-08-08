// Steadhold V3 — Maintenance Autopilot (multi-tenant)
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./src/db');               // runs idempotent migrations
const seed = require('./src/seed');
const seedV2 = require('./src/seed2');
const { router: api } = require('./src/api');
const automation = require('./src/automation');
const createSessionStore = require('./src/session-store');

// Bootstrap in a deliberate order. V1 demo rows predate organization scoping,
// so they must be attached before the V2 supplement creates a second tenant.
seed(false);
db.ensureDefaultOrganization();
seedV2();
for (const org of db.prepare('SELECT id FROM organizations').all()) automation.ensureOrgDefaults(org.id);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
// Session secret: prefer the SESSION_SECRET env var; otherwise generate one and persist it
// alongside the database so sessions survive restarts and redeploys (when /data is a volume).
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const f = path.join(dir, '.session-secret');
  try {
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
    const s = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  } catch (e) { return crypto.randomBytes(48).toString('hex'); }
}

app.use(session({
  name: 'steadhold.sid',
  store: createSessionStore(session, db),
  secret: sessionSecret(),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 24 * 14 }
}));

app.use('/api', api);
app.use('/uploads', express.static(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong on the server' }); });

// A short in-process poll only claims due records from the durable SQLite queue.
// Timers, retries, and recurring schedules survive restarts in durable_jobs.
automation.startWorker();

// Startup configuration report — makes missing Railway setup obvious in deploy logs
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Steadhold V3 Autopilot running on port ${PORT}`);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  console.log(`  Data directory:   ${dataDir}${process.env.DATA_DIR ? '' : '  (set DATA_DIR=/data with a mounted volume so the database survives redeploys)'}`);
  console.log(`  Upload directory: ${process.env.UPLOAD_DIR || path.join(__dirname, 'uploads')}${process.env.UPLOAD_DIR ? '' : '  (set UPLOAD_DIR=/data/uploads so photos survive redeploys)'}`);
  console.log(`  Session secret:   ${process.env.SESSION_SECRET ? 'from SESSION_SECRET env var' : 'auto-generated and stored in the data directory'}`);
});
