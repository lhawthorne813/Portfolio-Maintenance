// db.js — SQLite connection + V2/V3 migrations (idempotent, preserves data)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'opsdeck.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ---------------- V1 base schema (fresh installs) ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  vendor_id INTEGER REFERENCES vendors(id),
  hourly_rate REAL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL, trade TEXT, contact_name TEXT, phone TEXT, email TEXT, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, address TEXT NOT NULL, city TEXT, state TEXT, zip TEXT,
  type TEXT, year_built INTEGER, photo_url TEXT, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  label TEXT NOT NULL, beds INTEGER, baths REAL, sqft INTEGER, occupied INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  unit_id INTEGER REFERENCES units(id),
  category TEXT NOT NULL, name TEXT NOT NULL,
  manufacturer TEXT, model TEXT, serial TEXT,
  install_date TEXT, warranty_expires TEXT, purchase_price REAL,
  useful_life_years INTEGER, replacement_cost REAL, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  unit_id INTEGER REFERENCES units(id),
  category TEXT NOT NULL, description TEXT NOT NULL,
  priority TEXT NOT NULL, reported_by TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  work_order_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  unit_id INTEGER REFERENCES units(id),
  asset_id INTEGER REFERENCES assets(id),
  category TEXT NOT NULL, title TEXT NOT NULL, description TEXT, instructions TEXT,
  priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
  assigned_user_id INTEGER REFERENCES users(id),
  assigned_vendor_id INTEGER REFERENCES vendors(id),
  scheduled_date TEXT, due_date TEXT, estimated_minutes INTEGER,
  completion_notes TEXT, completed_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  pm_schedule_id INTEGER REFERENCES pm_schedules(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wo_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER REFERENCES work_orders(id),
  property_id INTEGER REFERENCES properties(id),
  asset_id INTEGER REFERENCES assets(id),
  kind TEXT NOT NULL DEFAULT 'general', url TEXT NOT NULL, caption TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL, is_voice_note INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  name TEXT NOT NULL, qty REAL NOT NULL DEFAULT 1, unit_cost REAL NOT NULL DEFAULT 0,
  added_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER REFERENCES work_orders(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  user_id INTEGER REFERENCES users(id),
  vendor_id INTEGER REFERENCES vendors(id),
  category TEXT NOT NULL, description TEXT, amount REAL NOT NULL,
  incurred_on TEXT NOT NULL,
  receipt_photo_id INTEGER REFERENCES photos(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS time_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'work', started_at TEXT NOT NULL, ended_at TEXT, minutes INTEGER
);
CREATE TABLE IF NOT EXISTS pm_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  asset_id INTEGER REFERENCES assets(id),
  title TEXT NOT NULL, category TEXT NOT NULL,
  interval_days INTEGER NOT NULL, next_due TEXT NOT NULL,
  estimated_minutes INTEGER, instructions TEXT,
  assigned_user_id INTEGER REFERENCES users(id),
  assigned_vendor_id INTEGER REFERENCES vendors(id),
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  required_role TEXT DEFAULT 'manager',
  decided_by INTEGER REFERENCES users(id), decision_note TEXT, decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  unit_id INTEGER REFERENCES units(id),
  inspected_by INTEGER REFERENCES users(id),
  inspected_on TEXT NOT NULL, summary TEXT, condition TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT, value TEXT);
`);

/* ---------------- V2 migration (idempotent) ---------------- */
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
function hasTable(t) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
}

const MIGRATION_LOG = [];
function migrateV2() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_name TEXT, phone TEXT, email TEXT,
    approx_units INTEGER, primary_market TEXT, logo_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    email TEXT NOT NULL, name TEXT, role TEXT NOT NULL,
    vendor_id INTEGER REFERENCES vendors(id),
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    invited_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS vendor_quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
    vendor_id INTEGER NOT NULL REFERENCES vendors(id),
    status TEXT NOT NULL DEFAULT 'requested',
    price REAL, scope TEXT, est_start TEXT, est_complete TEXT, notes TEXT,
    requested_by INTEGER REFERENCES users(id),
    decided_by INTEGER REFERENCES users(id), decided_at TEXT,
    submitted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS completion_requirements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    category TEXT NOT NULL,
    before_photo INTEGER NOT NULL DEFAULT 0,
    after_photo INTEGER NOT NULL DEFAULT 0,
    completion_notes INTEGER NOT NULL DEFAULT 0,
    materials INTEGER NOT NULL DEFAULT 0,
    receipt INTEGER NOT NULL DEFAULT 0,
    time_recorded INTEGER NOT NULL DEFAULT 0,
    UNIQUE(organization_id, category)
  );
  CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    in_app INTEGER NOT NULL DEFAULT 1,
    email INTEGER NOT NULL DEFAULT 0,
    sms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, kind)
  );
  CREATE TABLE IF NOT EXISTS rvr_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    action TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);

  const orgTables = ['users','vendors','properties','requests','work_orders','assets','expenses',
    'pm_schedules','approvals','notifications','inspections','photos','comments','materials','time_logs','wo_history','units'];
  for (const t of orgTables) {
    if (!hasColumn(t, 'organization_id')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN organization_id INTEGER REFERENCES organizations(id)`);
      MIGRATION_LOG.push(`${t}: added organization_id`);
    }
  }
  if (!hasColumn('settings', 'organization_id')) {
    db.exec(`ALTER TABLE settings ADD COLUMN organization_id INTEGER`);
    MIGRATION_LOG.push('settings: added organization_id');
  }

  const reqCols = {
    reporter_type: `TEXT DEFAULT 'manager'`, reporter_phone: 'TEXT', reporter_email: 'TEXT',
    access_instructions: 'TEXT', permission_to_enter: 'INTEGER DEFAULT 0', pets: 'TEXT',
    preferred_availability: 'TEXT', is_emergency: 'INTEGER DEFAULT 0',
    flag_safety: 'INTEGER DEFAULT 0', flag_water: 'INTEGER DEFAULT 0',
    flag_electrical: 'INTEGER DEFAULT 0', flag_hvac_out: 'INTEGER DEFAULT 0',
    triage_note: 'TEXT'
  };
  for (const [c, t] of Object.entries(reqCols))
    if (!hasColumn('requests', c)) { db.exec(`ALTER TABLE requests ADD COLUMN ${c} ${t}`); MIGRATION_LOG.push(`requests: added ${c}`); }

  const vendCols = { service_area: 'TEXT', insurance_expires: 'TEXT', license_number: 'TEXT',
    hourly_rate: 'REAL', emergency_available: 'INTEGER DEFAULT 0' };
  for (const [c, t] of Object.entries(vendCols))
    if (!hasColumn('vendors', c)) { db.exec(`ALTER TABLE vendors ADD COLUMN ${c} ${t}`); MIGRATION_LOG.push(`vendors: added ${c}`); }

  for (const c of ['old_value', 'new_value'])
    if (!hasColumn('wo_history', c)) { db.exec(`ALTER TABLE wo_history ADD COLUMN ${c} TEXT`); MIGRATION_LOG.push(`wo_history: added ${c}`); }

  for (const [c, t] of Object.entries({ condition: 'TEXT', location: 'TEXT' }))
    if (!hasColumn('assets', c)) { db.exec(`ALTER TABLE assets ADD COLUMN ${c} ${t}`); MIGRATION_LOG.push(`assets: added ${c}`); }

  for (const c of ['assigned_user_id', 'assigned_vendor_id'])
    if (!hasColumn('pm_schedules', c)) { db.exec(`ALTER TABLE pm_schedules ADD COLUMN ${c} INTEGER`); MIGRATION_LOG.push(`pm_schedules: added ${c}`); }

  if (!hasColumn('approvals', 'required_role')) {
    db.exec(`ALTER TABLE approvals ADD COLUMN required_role TEXT DEFAULT 'manager'`);
    MIGRATION_LOG.push('approvals: added required_role (tiered approval routing)');
  }

  // Rebuild users if V1 role CHECK present (blocks the new 'viewer' role). Role validation moves to app layer.
  const uSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='users'`).get() || {}).sql || '';
  if (uSql.includes('CHECK')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`BEGIN;
      CREATE TABLE users_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        vendor_id INTEGER REFERENCES vendors(id),
        hourly_rate REAL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        organization_id INTEGER REFERENCES organizations(id)
      );
      INSERT INTO users_v2 (id,name,email,phone,password_hash,role,vendor_id,hourly_rate,active,created_at,organization_id)
      SELECT id,name,email,phone,password_hash,role,vendor_id,hourly_rate,active,created_at,organization_id FROM users;
      DROP TABLE users;
      ALTER TABLE users_v2 RENAME TO users;
    COMMIT;`);
    db.pragma('foreign_keys = ON');
    MIGRATION_LOG.push("users: rebuilt without role CHECK (enables 'viewer' role)");
  }

  // Rebuild work_orders/requests if V1 CHECK constraints present (blocks waiting_vendor + triage statuses).
  // Documented change: status validation moves to the application layer (src/api.js VALID_STATUSES).
  const woSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='work_orders'`).get() || {}).sql || '';
  if (woSql.includes('CHECK')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`BEGIN;
      CREATE TABLE work_orders_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number TEXT NOT NULL UNIQUE,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        unit_id INTEGER REFERENCES units(id),
        asset_id INTEGER REFERENCES assets(id),
        category TEXT NOT NULL, title TEXT NOT NULL, description TEXT, instructions TEXT,
        priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
        assigned_user_id INTEGER REFERENCES users(id),
        assigned_vendor_id INTEGER REFERENCES vendors(id),
        scheduled_date TEXT, due_date TEXT, estimated_minutes INTEGER,
        completion_notes TEXT, completed_at TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        pm_schedule_id INTEGER REFERENCES pm_schedules(id),
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        organization_id INTEGER REFERENCES organizations(id)
      );
      INSERT INTO work_orders_v2 (id,number,property_id,unit_id,asset_id,category,title,description,instructions,
        priority,status,assigned_user_id,assigned_vendor_id,scheduled_date,due_date,estimated_minutes,
        completion_notes,completed_at,source,pm_schedule_id,created_by,created_at,organization_id)
      SELECT id,number,property_id,unit_id,asset_id,category,title,description,instructions,
        priority,status,assigned_user_id,assigned_vendor_id,scheduled_date,due_date,estimated_minutes,
        completion_notes,completed_at,source,pm_schedule_id,created_by,created_at,organization_id FROM work_orders;
      DROP TABLE work_orders;
      ALTER TABLE work_orders_v2 RENAME TO work_orders;
    COMMIT;`);
    db.pragma('foreign_keys = ON');
    MIGRATION_LOG.push('work_orders: rebuilt without status CHECK (enables waiting_vendor)');
  }
  const reqSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='requests'`).get() || {}).sql || '';
  if (reqSql.includes('CHECK') || !/id INTEGER PRIMARY KEY/.test(reqSql)) {
    db.pragma('foreign_keys = OFF');
    db.exec(`BEGIN;
      CREATE TABLE requests_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        unit_id INTEGER REFERENCES units(id),
        category TEXT NOT NULL, description TEXT NOT NULL,
        priority TEXT NOT NULL, reported_by TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        work_order_id INTEGER,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        organization_id INTEGER REFERENCES organizations(id),
        reporter_type TEXT DEFAULT 'manager', reporter_phone TEXT, reporter_email TEXT,
        access_instructions TEXT, permission_to_enter INTEGER DEFAULT 0, pets TEXT,
        preferred_availability TEXT, is_emergency INTEGER DEFAULT 0,
        flag_safety INTEGER DEFAULT 0, flag_water INTEGER DEFAULT 0,
        flag_electrical INTEGER DEFAULT 0, flag_hvac_out INTEGER DEFAULT 0,
        triage_note TEXT
      );
      INSERT INTO requests_v2 (id,property_id,unit_id,category,description,priority,reported_by,status,work_order_id,
        created_by,created_at,organization_id,reporter_type,reporter_phone,reporter_email,access_instructions,
        permission_to_enter,pets,preferred_availability,is_emergency,flag_safety,flag_water,flag_electrical,flag_hvac_out,triage_note)
      SELECT COALESCE(id,rowid),property_id,unit_id,COALESCE(category,'General'),COALESCE(description,''),COALESCE(priority,'normal'),reported_by,COALESCE(status,'open'),work_order_id,
        created_by,created_at,organization_id,
        COALESCE(reporter_type,'manager'),reporter_phone,reporter_email,access_instructions,
        COALESCE(permission_to_enter,0),pets,preferred_availability,COALESCE(is_emergency,0),
        COALESCE(flag_safety,0),COALESCE(flag_water,0),COALESCE(flag_electrical,0),COALESCE(flag_hvac_out,0),triage_note
      FROM requests;
      DROP TABLE requests;
      ALTER TABLE requests_v2 RENAME TO requests;
    COMMIT;`);
    db.pragma('foreign_keys = ON');
    MIGRATION_LOG.push('requests: rebuilt with proper primary key, no CHECKs (enables triage statuses)');
  }

  // settings must be unique per (organization, key), not globally by key
  const setSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='settings'`).get() || {}).sql || '';
  if (/key TEXT PRIMARY KEY/.test(setSql)) {
    db.exec(`BEGIN;
      CREATE TABLE settings_v2 (organization_id INTEGER, key TEXT NOT NULL, value TEXT, UNIQUE(organization_id, key));
      INSERT INTO settings_v2 (organization_id,key,value) SELECT organization_id,key,value FROM settings;
      DROP TABLE settings;
      ALTER TABLE settings_v2 RENAME TO settings;
    COMMIT;`);
    MIGRATION_LOG.push('settings: uniqueness changed from global key to per-organization');
  }

  // Multi-tenant fix: WO numbers must be unique PER ORGANIZATION, not globally (each org has its own WO-1001).
  const woSql2 = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='work_orders'`).get() || {}).sql || '';
  if (/number TEXT NOT NULL UNIQUE/.test(woSql2)) {
    db.pragma('foreign_keys = OFF');
    db.exec(`BEGIN;
      CREATE TABLE work_orders_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number TEXT NOT NULL,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        unit_id INTEGER REFERENCES units(id),
        asset_id INTEGER REFERENCES assets(id),
        category TEXT NOT NULL, title TEXT NOT NULL, description TEXT, instructions TEXT,
        priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
        assigned_user_id INTEGER REFERENCES users(id),
        assigned_vendor_id INTEGER REFERENCES vendors(id),
        scheduled_date TEXT, due_date TEXT, estimated_minutes INTEGER,
        completion_notes TEXT, completed_at TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        pm_schedule_id INTEGER REFERENCES pm_schedules(id),
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        organization_id INTEGER REFERENCES organizations(id),
        UNIQUE(organization_id, number)
      );
      INSERT INTO work_orders_v3 (id,number,property_id,unit_id,asset_id,category,title,description,instructions,
        priority,status,assigned_user_id,assigned_vendor_id,scheduled_date,due_date,estimated_minutes,
        completion_notes,completed_at,source,pm_schedule_id,created_by,created_at,organization_id)
      SELECT id,number,property_id,unit_id,asset_id,category,title,description,instructions,
        priority,status,assigned_user_id,assigned_vendor_id,scheduled_date,due_date,estimated_minutes,
        completion_notes,completed_at,source,pm_schedule_id,created_by,created_at,organization_id FROM work_orders;
      DROP TABLE work_orders;
      ALTER TABLE work_orders_v3 RENAME TO work_orders;
    COMMIT;`);
    db.pragma('foreign_keys = ON');
    MIGRATION_LOG.push('work_orders: number uniqueness changed from global to per-organization');
  }

  // Offline sync: remembers every mutation a client has already applied, so a replayed
  // request after reconnect returns the original result instead of duplicating work.
  db.exec(`CREATE TABLE IF NOT EXISTS client_ops (
    op_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    method TEXT, path TEXT,
    status INTEGER, response TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_client_ops_created ON client_ops(created_at)`);

  // Phone notifications: web-push device subscriptions, per-kind push pref, optional Pushover key
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    endpoint TEXT NOT NULL UNIQUE,
    sub_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  if (!hasColumn('notification_prefs', 'push')) {
    db.exec(`ALTER TABLE notification_prefs ADD COLUMN push INTEGER DEFAULT 1`);
    MIGRATION_LOG.push('notification_prefs: added push channel (phone notifications)');
  }
  if (!hasColumn('users', 'pushover_key')) {
    db.exec(`ALTER TABLE users ADD COLUMN pushover_key TEXT`);
    MIGRATION_LOG.push('users: added pushover_key (optional Pushover delivery)');
  }

  // Tenant intake: public per-property tokens + photos attachable to requests
  if (!hasColumn('properties', 'intake_token')) {
    db.exec(`ALTER TABLE properties ADD COLUMN intake_token TEXT`);
    MIGRATION_LOG.push('properties: added intake_token (public tenant request links)');
  }
  if (!hasColumn('properties', 'tenant_routing')) {
    db.exec(`ALTER TABLE properties ADD COLUMN tenant_routing TEXT DEFAULT 'maintenance'`);
    MIGRATION_LOG.push("properties: added tenant_routing ('maintenance' or 'owner' — owner reviews tenant requests first)");
  }
  if (!hasColumn('photos', 'request_id')) {
    db.exec(`ALTER TABLE photos ADD COLUMN request_id INTEGER REFERENCES requests(id)`);
    MIGRATION_LOG.push('photos: added request_id (tenant intake photos)');
  }
  {
    const crypto = require('crypto');
    const untokened = db.prepare('SELECT id FROM properties WHERE intake_token IS NULL').all();
    const setTok = db.prepare('UPDATE properties SET intake_token=? WHERE id=?');
    for (const p of untokened) setTok.run(crypto.randomBytes(9).toString('hex'), p.id);
  }

  // Backfill: assign all pre-V2 records to the default demo organization. The helper
  // also repairs numbers created by older fresh-install bootstraps before applying
  // the organization id, avoiding a UNIQUE(organization_id, number) collision.
  if (ensureDefaultOrganization(orgTables))
    MIGRATION_LOG.push('backfill: existing records assigned to Pine Ridge Residential');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_wo_org ON work_orders(organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_prop_org ON properties(organization_id);
    CREATE INDEX IF NOT EXISTS idx_req_org ON requests(organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_exp_org ON expenses(organization_id, incurred_on);
    CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
    CREATE INDEX IF NOT EXISTS idx_quotes_wo ON vendor_quotes(work_order_id);
    CREATE INDEX IF NOT EXISTS idx_wo_property ON work_orders(property_id);
    CREATE INDEX IF NOT EXISTS idx_wo_assigned ON work_orders(assigned_user_id);
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
    CREATE INDEX IF NOT EXISTS idx_hist_wo ON wo_history(work_order_id);
  `);

  if (MIGRATION_LOG.length) console.log('V2 migration:\n  ' + MIGRATION_LOG.join('\n  '));
}

function ensureDefaultOrganization(orgTables) {
  const tables = orgTables || ['users','vendors','properties','requests','work_orders','assets','expenses',
    'pm_schedules','approvals','notifications','inspections','photos','comments','materials','time_logs','wo_history','units'];
  const anyUser = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (!anyUser) return null;
  const ensurePublicTokens = () => {
    const crypto = require('crypto');
    if (hasColumn('properties', 'intake_token')) {
      const set = db.prepare('UPDATE properties SET intake_token=? WHERE id=?');
      db.prepare(`SELECT id FROM properties WHERE intake_token IS NULL OR intake_token=''`).all()
        .forEach(r => set.run(crypto.randomBytes(12).toString('hex'), r.id));
    }
    if (hasColumn('requests', 'tracking_token')) {
      const set = db.prepare('UPDATE requests SET tracking_token=? WHERE id=?');
      db.prepare(`SELECT id FROM requests WHERE tracking_token IS NULL OR tracking_token=''`).all()
        .forEach(r => set.run(crypto.randomBytes(24).toString('base64url'), r.id));
    }
  };
  const needsScope = tables.some(t => hasTable(t) && hasColumn(t, 'organization_id') &&
    db.prepare(`SELECT 1 FROM ${t} WHERE organization_id IS NULL LIMIT 1`).get());
  if (!needsScope && !db.prepare('SELECT 1 FROM settings WHERE organization_id IS NULL LIMIT 1').get()) {
    ensurePublicTokens();
    return null;
  }
  const existing = db.prepare(`SELECT id FROM organizations WHERE name='Pine Ridge Residential'`).get();
  const orgId = existing ? existing.id : db.prepare(`INSERT INTO organizations (name,owner_name,email,approx_units,primary_market)
    VALUES ('Pine Ridge Residential','Dan Whitfield','owner@demo.com',40,'Jacksonville, FL')`).run().lastInsertRowid;

  db.transaction(() => {
    // NULL values are exempt from SQLite composite uniqueness, so old bootstraps
    // could create several WO-1001 rows. Give every unscoped row a stable unique
    // number before assigning the shared organization id.
    const unscopedWos = db.prepare('SELECT id FROM work_orders WHERE organization_id IS NULL ORDER BY id').all();
    if (unscopedWos.length) {
      const max = db.prepare(`SELECT MAX(CAST(substr(number,4) AS INTEGER)) n FROM work_orders
        WHERE organization_id=? AND number GLOB 'WO-[0-9]*'`).get(orgId).n || 1000;
      const temp = db.prepare('UPDATE work_orders SET number=? WHERE id=?');
      unscopedWos.forEach(w => temp.run(`BOOT-${w.id}-${Date.now()}`, w.id));
      unscopedWos.forEach((w, i) => temp.run(`WO-${max + i + 1}`, w.id));
    }
    for (const t of tables) {
      if (hasTable(t) && hasColumn(t, 'organization_id'))
        db.prepare(`UPDATE ${t} SET organization_id=? WHERE organization_id IS NULL`).run(orgId);
    }
    db.prepare(`UPDATE settings SET organization_id=? WHERE organization_id IS NULL`).run(orgId);
  })();
  ensurePublicTokens();
  return orgId;
}

/* ---------------- V3 automation migration ----------------
   Deterministic rules authorize work. Optional AI only extracts or interprets
   evidence; every automated change is recorded and reversible where practical. */
function migrateV3() {
  const logStart = MIGRATION_LOG.length;
  const add = (table, columns) => {
    for (const [name, type] of Object.entries(columns)) {
      if (!hasColumn(table, name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        MIGRATION_LOG.push(`${table}: added ${name}`);
      }
    }
  };

  add('requests', {
    tracking_token: 'TEXT', playbook: 'TEXT', triage_confidence: 'REAL',
    automation_state: 'TEXT', resident_status: `TEXT DEFAULT 'received'`,
    last_resident_message_at: 'TEXT', resident_confirmed_at: 'TEXT',
    satisfaction_score: 'INTEGER', reopened_at: 'TEXT', sla_due_at: 'TEXT'
  });
  add('work_orders', {
    accepted_at: 'TEXT', auto_assigned: 'INTEGER NOT NULL DEFAULT 0',
    sla_due_at: 'TEXT', resident_confirmed_at: 'TEXT', callback_of_id: 'INTEGER',
    last_resident_update_at: 'TEXT', management_touches: 'INTEGER NOT NULL DEFAULT 1'
  });
  add('photos', { ai_analysis: 'TEXT', ocr_status: `TEXT DEFAULT 'not_requested'` });
  add('expenses', { source: `TEXT DEFAULT 'manual'`, external_id: 'TEXT' });

  db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS durable_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER REFERENCES organizations(id),
    kind TEXT NOT NULL, payload TEXT, run_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
    dedupe_key TEXT UNIQUE, locked_at TEXT, completed_at TEXT, last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER REFERENCES organizations(id),
    channel TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT, body TEXT,
    link TEXT, payload TEXT, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, run_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS automation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    event_type TEXT NOT NULL, source_type TEXT, source_id INTEGER,
    action TEXT NOT NULL, reason TEXT, confidence REAL, undo_payload TEXT,
    status TEXT NOT NULL DEFAULT 'applied', actor_user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), undone_at TEXT
  );
  CREATE TABLE IF NOT EXISTS exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    kind TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'action',
    title TEXT NOT NULL, detail TEXT, source_type TEXT, source_id INTEGER,
    owner_user_id INTEGER REFERENCES users(id), due_at TEXT,
    status TEXT NOT NULL DEFAULT 'open', snoozed_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS resident_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    request_id INTEGER NOT NULL REFERENCES requests(id),
    work_order_id INTEGER REFERENCES work_orders(id),
    direction TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'portal',
    body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS technician_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    skills TEXT NOT NULL DEFAULT '[]', service_area TEXT,
    work_days TEXT NOT NULL DEFAULT '1,2,3,4,5', shift_start TEXT DEFAULT '08:00',
    shift_end TEXT DEFAULT '17:00', max_daily_minutes INTEGER DEFAULT 480,
    auto_assign INTEGER NOT NULL DEFAULT 1, emergency_on_call INTEGER NOT NULL DEFAULT 0,
    latitude REAL, longitude REAL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS automation_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    policy_key TEXT NOT NULL, name TEXT NOT NULL, trigger_json TEXT,
    actions_json TEXT, risk_level TEXT NOT NULL DEFAULT 'low',
    enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(organization_id, policy_key)
  );
  CREATE TABLE IF NOT EXISTS sla_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    priority TEXT NOT NULL, acknowledge_minutes INTEGER NOT NULL,
    start_minutes INTEGER NOT NULL, resolve_hours INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(organization_id, priority)
  );
  CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'outbound',
    url TEXT, secret TEXT, event_types TEXT NOT NULL DEFAULT '*',
    inbound_token TEXT UNIQUE, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS integration_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    provider TEXT NOT NULL, direction TEXT NOT NULL, entity TEXT NOT NULL,
    records INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS owner_digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    period_start TEXT NOT NULL, period_end TEXT NOT NULL, summary_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
  CREATE INDEX IF NOT EXISTS idx_jobs_due ON durable_jobs(status, run_at);
  CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, run_at);
  CREATE INDEX IF NOT EXISTS idx_auto_org ON automation_events(organization_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_exceptions_org ON exceptions(organization_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_resident_request ON resident_messages(request_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_tracking ON requests(tracking_token) WHERE tracking_token IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_wo_callback ON work_orders(callback_of_id);
  `);

  // Added after the table declaration so this also upgrades early V3 databases
  // created before resident follow-up evidence was introduced.
  add('resident_messages', { attachment_url: 'TEXT' });

  const crypto = require('crypto');
  const missingTokens = db.prepare('SELECT id FROM requests WHERE tracking_token IS NULL').all();
  const tokenStmt = db.prepare('UPDATE requests SET tracking_token=? WHERE id=?');
  missingTokens.forEach(r => tokenStmt.run(crypto.randomBytes(24).toString('base64url'), r.id));
  const changes = MIGRATION_LOG.slice(logStart);
  if (changes.length) console.log('V3 migration:\n  ' + changes.join('\n  '));
}
migrateV2();
migrateV3();

db.ensureDefaultOrganization = ensureDefaultOrganization;
db.hasColumn = hasColumn;
module.exports = db;
