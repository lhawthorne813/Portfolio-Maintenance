// db.js — SQLite connection + schema
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'opsdeck.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','technician','vendor')),
  vendor_id INTEGER REFERENCES vendors(id),
  hourly_rate REAL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  trade TEXT,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT, state TEXT, zip TEXT,
  type TEXT,                       -- duplex, quadplex, single-family, small multifamily
  year_built INTEGER,
  photo_url TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  label TEXT NOT NULL,             -- "Unit A", "1", "Main"
  beds INTEGER, baths REAL, sqft INTEGER,
  occupied INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  unit_id INTEGER REFERENCES units(id),
  category TEXT NOT NULL,          -- HVAC, Water Heater, Roof, Appliance, Electrical Panel, Plumbing, Other
  name TEXT NOT NULL,
  manufacturer TEXT, model TEXT, serial TEXT,
  install_date TEXT,
  warranty_expires TEXT,
  purchase_price REAL,
  useful_life_years INTEGER,
  replacement_cost REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  unit_id INTEGER REFERENCES units(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('emergency','high','normal','low')),
  reported_by TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','dismissed')),
  work_order_id INTEGER REFERENCES work_orders(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,     -- WO-1001
  property_id INTEGER NOT NULL REFERENCES properties(id),
  unit_id INTEGER REFERENCES units(id),
  asset_id INTEGER REFERENCES assets(id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  instructions TEXT,
  priority TEXT NOT NULL CHECK (priority IN ('emergency','high','normal','low')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN
    ('new','assigned','scheduled','in_progress','waiting_parts','waiting_approval','completed','cancelled')),
  assigned_user_id INTEGER REFERENCES users(id),
  assigned_vendor_id INTEGER REFERENCES vendors(id),
  scheduled_date TEXT,
  due_date TEXT,
  estimated_minutes INTEGER,
  completion_notes TEXT,
  completed_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual',   -- manual | request | preventive
  pm_schedule_id INTEGER REFERENCES pm_schedules(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wo_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,            -- created, status_changed, assigned, scheduled, edited...
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER REFERENCES work_orders(id),
  property_id INTEGER REFERENCES properties(id),
  asset_id INTEGER REFERENCES assets(id),
  kind TEXT NOT NULL DEFAULT 'general',  -- before | after | receipt | general
  url TEXT NOT NULL,
  caption TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  is_voice_note INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  name TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit_cost REAL NOT NULL DEFAULT 0,
  added_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER REFERENCES work_orders(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  user_id INTEGER REFERENCES users(id),
  vendor_id INTEGER REFERENCES vendors(id),
  category TEXT NOT NULL,          -- materials, labor, vendor_invoice, other
  description TEXT,
  amount REAL NOT NULL,
  incurred_on TEXT NOT NULL,
  receipt_photo_id INTEGER REFERENCES photos(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'work',     -- work | travel
  started_at TEXT NOT NULL,
  ended_at TEXT,
  minutes INTEGER
);

CREATE TABLE IF NOT EXISTS pm_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  asset_id INTEGER REFERENCES assets(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  interval_days INTEGER NOT NULL,
  next_due TEXT NOT NULL,
  estimated_minutes INTEGER,
  instructions TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','info_requested')),
  decided_by INTEGER REFERENCES users(id),
  decision_note TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  unit_id INTEGER REFERENCES units(id),
  inspected_by INTEGER REFERENCES users(id),
  inspected_on TEXT NOT NULL,
  summary TEXT,
  condition TEXT,                  -- good | fair | poor
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_wo_property ON work_orders(property_id);
CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_wo_assigned ON work_orders(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_exp_property ON expenses(property_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
`);

module.exports = db;
