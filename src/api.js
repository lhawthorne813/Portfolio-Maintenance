// api.js — V2 REST API. Every query is scoped to the authenticated user's organization (server-side).
// Cross-org access returns 404 so record existence is never confirmed to outsiders.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const db = require('./db');
const I = require('./insights');
const { OPEN_STATUSES } = I;

const router = express.Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED_IMG = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif'];
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + (path.extname(file.originalname || '') || '.jpg'))
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_IMG.includes(file.mimetype))
});

/* ---------------- helpers ---------------- */
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const isDate = s => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);
const isMoney = n => Number.isFinite(+n) && +n >= 0 && +n < 10_000_000;

const VALID_STATUSES = ['new', 'assigned', 'scheduled', 'in_progress', 'waiting_parts', 'waiting_approval', 'waiting_vendor', 'completed', 'cancelled'];
const VALID_PRIORITIES = ['emergency', 'high', 'normal', 'low'];
const VALID_ROLES = ['owner', 'manager', 'technician', 'viewer', 'vendor'];

function me(req) { return req.session.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId) : null; }
function requireAuth(req, res, next) {
  const u = me(req);
  if (!u || !u.active) return res.status(401).json({ error: 'Not signed in' });
  req.user = u;
  req.oid = u.organization_id;   // organization scope derives ONLY from the session, never from client input
  next();
}
const isMgmt = u => u.role === 'owner' || u.role === 'manager';
const canRead = u => ['owner', 'manager', 'viewer'].includes(u.role);   // viewer = read-only owner experience
function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not permitted for your role' });
}
const MGMT_READ = requireRole('owner', 'manager', 'viewer');
const MGMT_WRITE = requireRole('owner', 'manager');

function notFound(res) { return res.status(404).json({ error: 'Not found' }); }

function canSeeWO(u, w) {
  if (canRead(u)) return true;
  if (u.role === 'technician') return w.assigned_user_id === u.id;
  if (u.role === 'vendor') return w.assigned_vendor_id === u.vendor_id ||
    !!db.prepare('SELECT 1 FROM vendor_quotes WHERE work_order_id=? AND vendor_id=?').get(w.id, u.vendor_id);
  return false;
}
function getWOOr404(req, res) {
  const w = db.prepare('SELECT * FROM work_orders WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!w) { notFound(res); return null; }
  if (!canSeeWO(req.user, w)) { notFound(res); return null; }
  return w;
}
function hist(orgId, woId, userId, action, detail, oldVal, newVal) {
  db.prepare(`INSERT INTO wo_history (organization_id,work_order_id,user_id,action,detail,old_value,new_value,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(orgId, woId, userId, action, detail || null, oldVal ?? null, newVal ?? null, now());
}
function notify(orgId, userIds, kind, title, body, link) {
  const ins = db.prepare('INSERT INTO notifications (organization_id,user_id,kind,title,body,link,created_at) VALUES (?,?,?,?,?,?,?)');
  const pref = db.prepare('SELECT in_app FROM notification_prefs WHERE user_id=? AND kind=?');
  for (const uid of [].concat(userIds).filter(Boolean)) {
    const p = pref.get(uid, kind);
    if (p && !p.in_app) continue;             // user opted out of this kind
    ins.run(orgId, uid, kind, title, body || null, link || null, now());
    // Email/SMS-ready: delivery adapters would hook here, reading notification_prefs.email / .sms
  }
}
function mgmtIds(orgId) { return db.prepare(`SELECT id FROM users WHERE organization_id=? AND role IN ('owner','manager') AND active=1`).all(orgId).map(r => r.id); }
function ownerIds(orgId) { return db.prepare(`SELECT id FROM users WHERE organization_id=? AND role='owner' AND active=1`).all(orgId).map(r => r.id); }
function setting(orgId, key, def) {
  const r = db.prepare('SELECT value FROM settings WHERE organization_id=? AND key=?').get(orgId, key);
  return r ? r.value : def;
}
function setSetting(orgId, key, value) {
  db.prepare('DELETE FROM settings WHERE organization_id=? AND key=?').run(orgId, key);
  db.prepare('INSERT INTO settings (organization_id,key,value) VALUES (?,?,?)').run(orgId, key, String(value));
}
function nextWONumber(orgId) {
  const r = db.prepare(`SELECT number FROM work_orders WHERE organization_id=? ORDER BY id DESC LIMIT 1`).get(orgId);
  const n = r ? parseInt(r.number.replace('WO-', ''), 10) + 1 : 1001;
  return 'WO-' + n;
}

const WO_SELECT = `
  SELECT w.*, p.name AS property_name, p.address, p.city, u.label AS unit_label,
         tu.name AS tech_name, v.company AS vendor_company,
         (SELECT COALESCE(SUM(amount),0) FROM expenses e WHERE e.work_order_id=w.id) AS total_cost,
         (w.due_date IS NOT NULL AND w.due_date < date('now') AND w.status NOT IN ('completed','cancelled')) AS overdue
  FROM work_orders w
  JOIN properties p ON p.id = w.property_id
  LEFT JOIN units u ON u.id = w.unit_id
  LEFT JOIN users tu ON tu.id = w.assigned_user_id
  LEFT JOIN vendors v ON v.id = w.assigned_vendor_id`;

/* ---------------- Completion requirements ---------------- */
const REQ_KEYS = ['before_photo', 'after_photo', 'completion_notes', 'materials', 'receipt', 'time_recorded'];
function requirementsFor(orgId, category) {
  return db.prepare('SELECT * FROM completion_requirements WHERE organization_id=? AND category=?').get(orgId, category)
    || db.prepare(`SELECT * FROM completion_requirements WHERE organization_id=? AND category='*'`).get(orgId)
    || null;
}
function completionCheck(orgId, wo, pendingNotes) {
  const reqs = requirementsFor(orgId, wo.category);
  const has = {
    before_photo: !!db.prepare(`SELECT 1 FROM photos WHERE work_order_id=? AND kind='before'`).get(wo.id),
    after_photo: !!db.prepare(`SELECT 1 FROM photos WHERE work_order_id=? AND kind='after'`).get(wo.id),
    receipt: !!db.prepare(`SELECT 1 FROM photos WHERE work_order_id=? AND kind='receipt'`).get(wo.id),
    materials: !!db.prepare(`SELECT 1 FROM materials WHERE work_order_id=?`).get(wo.id),
    time_recorded: !!db.prepare(`SELECT 1 FROM time_logs WHERE work_order_id=? AND kind='work'`).get(wo.id),
    completion_notes: !!(pendingNotes && pendingNotes.trim()) || !!wo.completion_notes
  };
  const LABELS = { before_photo: 'Before photo', after_photo: 'After photo', completion_notes: 'Completion notes',
    materials: 'Materials used', receipt: 'Receipt', time_recorded: 'Time recorded' };
  const items = REQ_KEYS.map(k => ({ key: k, label: LABELS[k], required: !!(reqs && reqs[k]), done: has[k] }));
  return { items, missing: items.filter(i => i.required && !i.done) };
}

/* ---------------- Preventive maintenance generation ---------------- */
function generatePMWorkOrders() {
  const due = db.prepare(`SELECT s.*, p.name AS property_name FROM pm_schedules s JOIN properties p ON p.id=s.property_id
    WHERE s.active=1 AND s.next_due <= date('now','+7 days')`).all();
  for (const s of due) {
    const exists = db.prepare(`SELECT id FROM work_orders WHERE pm_schedule_id=? AND status NOT IN ('completed','cancelled')`).get(s.id);
    if (exists) continue;
    const num = nextWONumber(s.organization_id);
    const status = (s.assigned_user_id || s.assigned_vendor_id) ? 'assigned' : 'new';
    const id = db.prepare(`INSERT INTO work_orders (organization_id,number,property_id,asset_id,category,title,description,instructions,
        priority,status,assigned_user_id,assigned_vendor_id,due_date,estimated_minutes,source,pm_schedule_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(s.organization_id, num, s.property_id, s.asset_id, s.category, s.title,
        'Auto-generated from preventive maintenance schedule.', s.instructions, 'normal', status,
        s.assigned_user_id || null, s.assigned_vendor_id || null, s.next_due, s.estimated_minutes || 60, 'preventive', s.id, now()).lastInsertRowid;
    hist(s.organization_id, id, null, 'created', 'Generated from preventive maintenance schedule');
    notify(s.organization_id, mgmtIds(s.organization_id), 'pm_due', 'Preventive maintenance due',
      `${s.title} — ${s.property_name} (due ${s.next_due}). ${num} created.`, '#/work-orders/' + id);
    if (s.assigned_user_id) notify(s.organization_id, s.assigned_user_id, 'assigned', 'PM job assigned', `${s.title} — ${s.property_name}`, '#/work-orders/' + id);
  }
  return due.length;
}

/* =====================================================================
   AUTH: login, signup (creates organization), invite acceptance
===================================================================== */
router.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get((email || '').toLowerCase().trim());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect' });
  req.session.userId = u.id;
  const org = db.prepare('SELECT name FROM organizations WHERE id=?').get(u.organization_id);
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role, vendor_id: u.vendor_id, org_name: org ? org.name : null });
});
router.post('/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
router.get('/auth/me', (req, res) => {
  const u = me(req);
  if (!u || !u.active) return res.status(401).json({ error: 'Not signed in' });
  const org = db.prepare('SELECT name FROM organizations WHERE id=?').get(u.organization_id);
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role, vendor_id: u.vendor_id, org_name: org ? org.name : null });
});

// New organization signup — first user becomes Organization Owner
router.post('/auth/signup', (req, res) => {
  const b = req.body || {};
  if (!b.org_name || !b.name || !b.email || !b.password) return res.status(400).json({ error: 'Organization name, your name, email, and password are required' });
  if (b.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const email = b.email.toLowerCase().trim();
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(400).json({ error: 'That email already has an account' });
  const orgId = db.prepare(`INSERT INTO organizations (name,owner_name,email,phone,approx_units,primary_market)
    VALUES (?,?,?,?,?,?)`).run(b.org_name, b.name, email, b.phone || null, +b.approx_units || null, b.primary_market || null).lastInsertRowid;
  const uid = db.prepare(`INSERT INTO users (organization_id,name,email,phone,password_hash,role,created_at)
    VALUES (?,?,?,?,?,'owner',?)`).run(orgId, b.name, email, b.phone || null, bcrypt.hashSync(b.password, 10), now()).lastInsertRowid;
  // sensible default completion requirements for a new org
  db.prepare(`INSERT INTO completion_requirements (organization_id,category,before_photo,after_photo,completion_notes,materials,receipt,time_recorded)
    VALUES (?,'*',0,1,1,0,0,1)`).run(orgId);
  setSetting(orgId, 'approval_t1', 150);
  setSetting(orgId, 'approval_t2', 500);
  req.session.userId = uid;
  res.json({ id: uid, name: b.name, email, role: 'owner', org_name: b.org_name, onboarding: true });
});

// Invite acceptance (token shared by the inviting manager)
router.get('/auth/invite/:token', (req, res) => {
  const inv = db.prepare(`SELECT i.*, o.name AS org_name FROM invites i JOIN organizations o ON o.id=i.organization_id
    WHERE token=? AND i.status='pending'`).get(req.params.token);
  if (!inv) return notFound(res);
  res.json({ email: inv.email, name: inv.name, role: inv.role, org_name: inv.org_name });
});
router.post('/auth/accept-invite', (req, res) => {
  const { token, name, password } = req.body || {};
  const inv = db.prepare(`SELECT * FROM invites WHERE token=? AND status='pending'`).get(token);
  if (!inv) return notFound(res);
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(inv.email)) return res.status(400).json({ error: 'That email already has an account' });
  const uid = db.prepare(`INSERT INTO users (organization_id,name,email,password_hash,role,vendor_id,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(inv.organization_id, name || inv.name || inv.email, inv.email, bcrypt.hashSync(password, 10), inv.role, inv.vendor_id, now()).lastInsertRowid;
  db.prepare(`UPDATE invites SET status='accepted' WHERE id=?`).run(inv.id);
  req.session.userId = uid;
  res.json({ ok: true, role: inv.role });
});

/* =====================================================================
   PUBLIC TENANT INTAKE — no login. Reached via unguessable per-property
   tokens (shared as links or printed QR codes). Lightly rate-limited.
===================================================================== */
const intakeHits = new Map();   // ip -> [timestamps]
function intakeRateLimit(req, res, next) {
  const ip = req.ip || 'x';
  const nowMs = Date.now();
  const hits = (intakeHits.get(ip) || []).filter(t => nowMs - t < 3600_000);
  if (hits.length >= 12) return res.status(429).json({ error: 'Too many requests — please wait a bit and try again, or call your property manager directly.' });
  hits.push(nowMs); intakeHits.set(ip, hits);
  next();
}
function intakeProp(token) {
  if (!token || token.length < 8) return null;
  return db.prepare(`SELECT p.*, o.name AS org_name FROM properties p JOIN organizations o ON o.id=p.organization_id
    WHERE p.intake_token=? AND p.active=1`).get(token);
}
// Minimal public info: enough to render the form, nothing about the portfolio
router.get('/intake/:token', (req, res) => {
  const p = intakeProp(req.params.token);
  if (!p) return notFound(res);
  res.json({
    property: p.name, org: p.org_name,
    units: db.prepare('SELECT id,label FROM units WHERE property_id=? ORDER BY label').all(p.id),
    categories: ['Plumbing', 'HVAC', 'Electrical', 'Appliance', 'Roofing', 'Pest', 'Safety', 'General']
  });
});
router.post('/intake/:token', intakeRateLimit, upload.array('photos', 3), (req, res) => {
  const p = intakeProp(req.params.token);
  if (!p) return notFound(res);
  const b = req.body || {};
  const desc = (b.description || '').trim().slice(0, 2000);
  if (!b.category || !desc) return res.status(400).json({ error: 'Please choose a category and describe the issue' });
  if (!b.reported_by || !b.reporter_phone) return res.status(400).json({ error: 'Please include your name and phone number so we can reach you' });
  if (b.unit_id && !db.prepare('SELECT 1 FROM units WHERE id=? AND property_id=?').get(b.unit_id, p.id)) return res.status(400).json({ error: 'Invalid unit' });
  const emergency = b.is_emergency === '1' || b.is_emergency === 'true' || b.is_emergency === true;
  // Owner-review routing: non-emergency tenant requests can be held for the owner before maintenance sees them.
  const ownerFirst = p.tenant_routing === 'owner' && !emergency;
  const id = db.prepare(`INSERT INTO requests (organization_id,property_id,unit_id,category,description,priority,
      reported_by,reporter_type,reporter_phone,reporter_email,access_instructions,permission_to_enter,pets,
      preferred_availability,is_emergency,flag_safety,flag_water,flag_electrical,flag_hvac_out,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.organization_id, p.id, +b.unit_id || null, b.category, desc, emergency ? 'emergency' : 'normal',
      String(b.reported_by).slice(0, 120), 'tenant', String(b.reporter_phone).slice(0, 40), (b.reporter_email || '').slice(0, 120) || null,
      (b.access_instructions || '').slice(0, 300) || null, (b.permission_to_enter === '1' || b.permission_to_enter === 'true') ? 1 : 0,
      (b.pets || '').slice(0, 120) || null, (b.preferred_availability || '').slice(0, 200) || null,
      emergency ? 1 : 0, b.flag_safety === '1' ? 1 : 0, b.flag_water === '1' ? 1 : 0,
      b.flag_electrical === '1' ? 1 : 0, b.flag_hvac_out === '1' ? 1 : 0,
      ownerFirst ? 'owner_review' : 'open', now()).lastInsertRowid;
  for (const f of (req.files || []))
    db.prepare(`INSERT INTO photos (organization_id,request_id,property_id,kind,url,caption,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(p.organization_id, id, p.id, 'general', '/uploads/' + f.filename, 'Tenant intake photo', now());
  // Notify the right audience: owner-review requests alert owners only; everything else alerts management.
  const photoNote = req.files && req.files.length ? ` · ${req.files.length} photo${req.files.length > 1 ? 's' : ''}` : '';
  if (ownerFirst) {
    notify(p.organization_id, ownerIds(p.organization_id), 'request',
      `Tenant request awaiting your review: ${b.category}`,
      `${p.name} — ${desc.slice(0, 120)}${photoNote} · Held until you send it to maintenance.`, '#/maintenance');
  } else {
    notify(p.organization_id, mgmtIds(p.organization_id), 'request',
      emergency ? `🚨 EMERGENCY tenant request: ${b.category}` : `New tenant request: ${b.category}`,
      `${p.name} — ${desc.slice(0, 120)}${photoNote}`, '#/maintenance');
  }
  res.json({ ok: true, reference: 'REQ-' + id, emergency });
});

router.use(requireAuth);

/* =====================================================================
   TEAM MANAGEMENT (Settings → Team)
===================================================================== */
router.get('/team/users', MGMT_READ, (req, res) => {
  const users = db.prepare(`SELECT id,name,email,phone,role,vendor_id,active,created_at FROM users WHERE organization_id=? ORDER BY active DESC, role, name`).all(req.oid);
  const invites = db.prepare(`SELECT id,email,name,role,token,status,created_at FROM invites WHERE organization_id=? AND status='pending' ORDER BY created_at DESC`).all(req.oid);
  res.json({ users, invites });
});
router.post('/team/invites', MGMT_WRITE, (req, res) => {
  const { email, name, role, vendor_id } = req.body || {};
  if (!email || !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Email and a valid role are required' });
  if (role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only an owner can invite another owner' });
  if (role === 'vendor' && vendor_id && !db.prepare('SELECT 1 FROM vendors WHERE id=? AND organization_id=?').get(vendor_id, req.oid)) return notFound(res);
  const token = crypto.randomBytes(18).toString('hex');
  const id = db.prepare(`INSERT INTO invites (organization_id,email,name,role,vendor_id,token,invited_by,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(req.oid, email.toLowerCase().trim(), name || null, role, vendor_id || null, token, req.user.id, now()).lastInsertRowid;
  res.json({ id, token, link: '/#/join?token=' + token });
});
router.post('/team/invites/:id/revoke', MGMT_WRITE, (req, res) => {
  const r = db.prepare(`UPDATE invites SET status='revoked' WHERE id=? AND organization_id=? AND status='pending'`).run(req.params.id, req.oid);
  r.changes ? res.json({ ok: true }) : notFound(res);
});
router.patch('/team/users/:id', MGMT_WRITE, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!target) return notFound(res);
  const b = req.body || {};
  // Owners are protected: only an owner can change an owner, and the last active owner can't be deactivated/demoted
  if (target.role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only an owner can modify another owner' });
  const activeOwners = db.prepare(`SELECT COUNT(*) c FROM users WHERE organization_id=? AND role='owner' AND active=1`).get(req.oid).c;
  const demoting = ('role' in b && b.role !== 'owner') || ('active' in b && !b.active);
  if (target.role === 'owner' && activeOwners <= 1 && demoting) return res.status(400).json({ error: 'The organization must keep at least one active owner' });
  if ('role' in b) {
    if (!VALID_ROLES.includes(b.role)) return res.status(400).json({ error: 'Invalid role' });
    if (b.role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only an owner can promote to owner' });
    db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, target.id);
    hist(req.oid, null, req.user.id, 'user_role_changed', `${target.name}: role changed`, target.role, b.role);
  }
  if ('active' in b) {
    db.prepare('UPDATE users SET active=? WHERE id=?').run(b.active ? 1 : 0, target.id);
    // Historical records stay intact — deactivation never deletes maintenance history.
    hist(req.oid, null, req.user.id, 'user_status_changed', `${target.name}: ${b.active ? 'reactivated' : 'deactivated'}`);
  }
  res.json({ ok: true });
});

/* =====================================================================
   ORGANIZATION / SETTINGS
===================================================================== */
router.get('/org', MGMT_READ, (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(req.oid);
  res.json({
    ...org,
    approval_t1: +setting(req.oid, 'approval_t1', 150),
    approval_t2: +setting(req.oid, 'approval_t2', 500)
  });
});
router.patch('/org', requireRole('owner'), (req, res) => {
  const b = req.body || {};
  const fields = ['name', 'owner_name', 'phone', 'email', 'approx_units', 'primary_market'];
  const sets = [], vals = [];
  for (const f of fields) if (f in b) { sets.push(`${f}=?`); vals.push(b[f]); }
  if (sets.length) { vals.push(req.oid); db.prepare(`UPDATE organizations SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  if ('approval_t1' in b && isMoney(b.approval_t1)) setSetting(req.oid, 'approval_t1', +b.approval_t1);
  if ('approval_t2' in b && isMoney(b.approval_t2)) setSetting(req.oid, 'approval_t2', +b.approval_t2);
  res.json({ ok: true });
});

router.get('/completion-requirements', MGMT_READ, (req, res) => {
  res.json(db.prepare('SELECT * FROM completion_requirements WHERE organization_id=? ORDER BY category').all(req.oid));
});
router.put('/completion-requirements', MGMT_WRITE, (req, res) => {
  const { category } = req.body || {};
  if (!category) return res.status(400).json({ error: 'Category is required' });
  db.prepare('DELETE FROM completion_requirements WHERE organization_id=? AND category=?').run(req.oid, category);
  db.prepare(`INSERT INTO completion_requirements (organization_id,category,before_photo,after_photo,completion_notes,materials,receipt,time_recorded)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(req.oid, category, ...REQ_KEYS.map(k => req.body[k] ? 1 : 0));
  res.json({ ok: true });
});

router.get('/notification-prefs', (req, res) => {
  const kinds = ['emergency', 'assigned', 'approval', 'approval_decision', 'overdue', 'completed', 'quote', 'pm_due', 'repeat', 'asset_warning', 'request', 'high_cost'];
  const prefs = {};
  kinds.forEach(k => prefs[k] = { in_app: 1, email: 0, sms: 0 });
  db.prepare('SELECT * FROM notification_prefs WHERE user_id=?').all(req.user.id)
    .forEach(p => prefs[p.kind] = { in_app: p.in_app, email: p.email, sms: p.sms });
  res.json(prefs);
});
router.put('/notification-prefs', (req, res) => {
  for (const [kind, p] of Object.entries(req.body || {})) {
    db.prepare('DELETE FROM notification_prefs WHERE user_id=? AND kind=?').run(req.user.id, kind);
    db.prepare('INSERT INTO notification_prefs (user_id,kind,in_app,email,sms) VALUES (?,?,?,?,?)')
      .run(req.user.id, kind, p.in_app ? 1 : 0, p.email ? 1 : 0, p.sms ? 1 : 0);
  }
  res.json({ ok: true });
});

/* =====================================================================
   DASHBOARD — Attention Center first
===================================================================== */
router.get('/dashboard', MGMT_READ, (req, res) => {
  const O = req.oid;
  const open = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND status IN ${OPEN_STATUSES}`).get(O).c;
  const urgent = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND status IN ${OPEN_STATUSES} AND priority IN ('emergency','high')`).get(O).c;
  const overdue = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND status IN ${OPEN_STATUSES} AND due_date < date('now')`).get(O).c;
  const completedMonth = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND status='completed' AND completed_at >= date('now','start of month')`).get(O).c;
  const spendMonth = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE organization_id=? AND incurred_on >= date('now','start of month')`).get(O).s;
  const spendPrev = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE organization_id=? AND incurred_on >= date('now','start of month','-1 month') AND incurred_on < date('now','start of month')`).get(O).s;
  const spendYTD = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE organization_id=? AND incurred_on >= date('now','start of year')`).get(O).s;
  const avgDays = db.prepare(`SELECT AVG(julianday(completed_at)-julianday(created_at)) d FROM work_orders WHERE organization_id=? AND status='completed' AND completed_at >= datetime('now','-90 days')`).get(O).d;

  const statusCounts = {};
  db.prepare(`SELECT status, COUNT(*) c FROM work_orders WHERE organization_id=? AND status != 'cancelled' GROUP BY status`).all(O)
    .forEach(r => statusCounts[r.status] = r.c);

  // ----- Attention Center: grouped, actionable, each card links to the underlying problem -----
  const attention = [];
  const emerg = db.prepare(`${WO_SELECT} WHERE w.organization_id=? AND w.priority='emergency' AND w.status IN ${OPEN_STATUSES}`).all(O);
  if (emerg.length) attention.push({ type: 'emergency', count: emerg.length, title: `${emerg.length} emergency repair${emerg.length > 1 ? 's' : ''}`,
    items: emerg.map(w => ({ t: w.title, s: w.property_name + (w.unit_label ? ' · Unit ' + w.unit_label : ''), link: '#/work-orders/' + w.id })) });
  const approvals = db.prepare(`SELECT a.*, w.title, w.id AS wo_id, u.name AS req_name FROM approvals a
    JOIN work_orders w ON w.id=a.work_order_id JOIN users u ON u.id=a.requested_by
    WHERE a.organization_id=? AND a.status='pending'`).all(O)
    .filter(a => a.required_role !== 'owner' || req.user.role === 'owner' || req.user.role === 'viewer');
  if (approvals.length) attention.push({ type: 'approval', count: approvals.length, title: `${approvals.length} approval request${approvals.length > 1 ? 's' : ''}`,
    items: approvals.map(a => ({ t: `$${(+a.amount).toLocaleString()} — ${a.title}`, s: a.req_name + (a.required_role === 'owner' ? ' · needs owner' : ''), link: '#/work-orders/' + a.wo_id })) });
  const late = db.prepare(`${WO_SELECT} WHERE w.organization_id=? AND w.status IN ${OPEN_STATUSES} AND w.due_date < date('now') ORDER BY w.due_date LIMIT 10`).all(O);
  if (late.length) attention.push({ type: 'overdue', count: overdue, title: `${overdue} overdue job${overdue > 1 ? 's' : ''}`,
    items: late.map(w => ({ t: w.title, s: `${w.property_name} · due ${w.due_date}`, link: '#/work-orders/' + w.id })) });
  const triage = db.prepare(`SELECT COUNT(*) c FROM requests WHERE organization_id=? AND status='open'`).get(O).c;
  if (triage) attention.push({ type: 'triage', count: triage, title: `${triage} request${triage > 1 ? 's' : ''} need triage`, items: [], link: '#/maintenance' });
  const ownerRev = db.prepare(`SELECT COUNT(*) c FROM requests WHERE organization_id=? AND status='owner_review'`).get(O).c;
  if (ownerRev && req.user.role !== 'manager') attention.push({ type: 'owner_review', count: ownerRev,
    title: `${ownerRev} tenant request${ownerRev > 1 ? 's' : ''} awaiting owner review`, items: [], link: '#/maintenance' });
  const repeats = I.repeatRepairs(O);
  if (repeats.length) attention.push({ type: 'repeat', count: repeats.length, title: `${repeats.length} repeat-repair warning${repeats.length > 1 ? 's' : ''}`,
    items: repeats.map(r => ({ t: `${r.category} at ${r.property}`, s: `${r.count} calls / ${r.window} · $${r.total_spent.toLocaleString()}`, link: '#/properties/' + r.property_id })) });
  const pmOver = db.prepare(`SELECT s.*, p.name pn FROM pm_schedules s JOIN properties p ON p.id=s.property_id WHERE s.organization_id=? AND s.active=1 AND s.next_due < date('now')`).all(O);
  if (pmOver.length) attention.push({ type: 'pm', count: pmOver.length, title: `${pmOver.length} preventive item${pmOver.length > 1 ? 's' : ''} overdue`,
    items: pmOver.slice(0, 6).map(s => ({ t: s.title, s: s.pn, link: '#/maintenance' })) });
  const anomalies = I.costAnomalies(O);
  if (anomalies.length) attention.push({ type: 'anomaly', count: anomalies.length, title: `${anomalies.length} unusually expensive propert${anomalies.length > 1 ? 'ies' : 'y'}`,
    items: anomalies.map(a => ({ t: a.property, s: `${a.multiple}× portfolio per-unit average`, link: '#/properties/' + a.property_id })) });
  const rvr = I.repairVsReplace(O);
  if (rvr.length) attention.push({ type: 'rvr', count: rvr.length, title: `${rvr.length} asset${rvr.length > 1 ? 's' : ''} to review for replacement`,
    items: rvr.map(r => ({ t: `${r.name} — ${r.property}`, s: `${r.repairs_12mo} repairs / 12 mo · $${r.spend_12mo.toLocaleString()}`, link: '#/analytics' })) });
  const quotes = db.prepare(`SELECT q.*, w.title, v.company FROM vendor_quotes q JOIN work_orders w ON w.id=q.work_order_id JOIN vendors v ON v.id=q.vendor_id
    WHERE q.organization_id=? AND q.status='submitted'`).all(O);
  if (quotes.length) attention.push({ type: 'quote', count: quotes.length, title: `${quotes.length} vendor quote${quotes.length > 1 ? 's' : ''} to review`,
    items: quotes.map(q => ({ t: `$${(+q.price).toLocaleString()} — ${q.title}`, s: q.company, link: '#/work-orders/' + q.work_order_id })) });

  const spendByProperty = db.prepare(`SELECT p.id, p.name, COALESCE(SUM(e.amount),0) total,
      (SELECT COUNT(*) FROM units un WHERE un.property_id=p.id) unit_count
    FROM properties p LEFT JOIN expenses e ON e.property_id=p.id AND e.incurred_on >= date('now','start of year')
    WHERE p.organization_id=? AND p.active=1 GROUP BY p.id ORDER BY total DESC`).all(O)
    .map(r => ({ ...r, total: +r.total.toFixed(2), per_unit: r.unit_count ? +(r.total / r.unit_count).toFixed(2) : 0 }));

  res.json({
    stats: { open, urgent, overdue, completed_month: completedMonth,
      spend_month: +spendMonth.toFixed(2), spend_prev_month: +spendPrev.toFixed(2), spend_ytd: +spendYTD.toFixed(2),
      avg_completion_days: avgDays ? +avgDays.toFixed(1) : null },
    status_counts: statusCounts,
    attention,
    spend_by_property: spendByProperty
  });
});

/* =====================================================================
   PROPERTIES / UNITS / ASSETS
===================================================================== */
router.get('/properties', MGMT_READ, (req, res) => {
  const rows = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM units u WHERE u.property_id=p.id) unit_count,
      (SELECT COUNT(*) FROM work_orders w WHERE w.property_id=p.id AND w.status IN ${OPEN_STATUSES}) open_wos,
      (SELECT COALESCE(SUM(amount),0) FROM expenses e WHERE e.property_id=p.id AND e.incurred_on >= date('now','start of year')) ytd_cost
    FROM properties p WHERE p.organization_id=? AND p.active=1 ORDER BY p.name`).all(req.oid);
  res.json(rows.map(p => ({ ...p, ytd_cost: +p.ytd_cost.toFixed(2), health: I.propertyHealth(req.oid, p.id).score })));
});

// Property comparison table (sortable client-side)
router.get('/comparison', MGMT_READ, (req, res) => {
  const O = req.oid;
  const repeats = I.repeatRepairs(O);
  const capex = I.capexForecast(O, 24);
  const rows = db.prepare(`SELECT p.id, p.name, p.address,
      (SELECT COUNT(*) FROM units u WHERE u.property_id=p.id) unit_count,
      (SELECT COALESCE(SUM(amount),0) FROM expenses e WHERE e.property_id=p.id AND e.incurred_on >= date('now','-365 days')) spend12,
      (SELECT COUNT(*) FROM work_orders w WHERE w.property_id=p.id AND w.status IN ${OPEN_STATUSES}) open_wos,
      (SELECT COUNT(*) FROM work_orders w WHERE w.property_id=p.id AND w.status IN ${OPEN_STATUSES} AND w.due_date < date('now')) overdue_wos
    FROM properties p WHERE p.organization_id=? AND p.active=1`).all(O)
    .map(p => ({
      ...p, spend12: +p.spend12.toFixed(2),
      per_unit: p.unit_count ? +(p.spend12 / p.unit_count).toFixed(2) : 0,
      repeat_warnings: repeats.filter(r => r.property_id === p.id).length,
      pm_compliance: I.pmCompliance(O, p.id),
      upcoming_capex: +capex.items.filter(i => i.property_id === p.id).reduce((s, i) => s + (i.est_replacement_cost || 0), 0).toFixed(2)
    }));
  res.json(rows);
});

router.post('/properties', MGMT_WRITE, (req, res) => {
  const { name, address, city, state, zip, type, year_built, notes } = req.body || {};
  if (!name || !address) return res.status(400).json({ error: 'Name and address are required' });
  const id = db.prepare(`INSERT INTO properties (organization_id,name,address,city,state,zip,type,year_built,notes)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(req.oid, name, address, city || null, state || null, zip || null, type || null, +year_built || null, notes || null).lastInsertRowid;
  res.json({ id });
});

router.get('/properties/:id', MGMT_READ, (req, res) => {
  const p = db.prepare('SELECT * FROM properties WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!p) return notFound(res);
  const O = req.oid;
  const units = db.prepare('SELECT * FROM units WHERE property_id=? ORDER BY label').all(p.id);
  const openWos = db.prepare(`${WO_SELECT} WHERE w.property_id=? AND w.status IN ${OPEN_STATUSES} ORDER BY w.priority='emergency' DESC, w.due_date`).all(p.id);
  const history = db.prepare(`${WO_SELECT} WHERE w.property_id=? AND w.status IN ('completed','cancelled') ORDER BY w.completed_at DESC LIMIT 150`).all(p.id);
  const assets = db.prepare('SELECT * FROM assets WHERE property_id=?').all(p.id);
  const pm = db.prepare('SELECT * FROM pm_schedules WHERE property_id=? AND active=1 ORDER BY next_due').all(p.id);
  const expenses = db.prepare(`SELECT e.*, w.number AS wo_number, w.title AS wo_title FROM expenses e LEFT JOIN work_orders w ON w.id=e.work_order_id WHERE e.property_id=? ORDER BY e.incurred_on DESC LIMIT 150`).all(p.id);
  const photos = db.prepare(`SELECT * FROM photos WHERE property_id=? ORDER BY created_at DESC LIMIT 60`).all(p.id);
  const inspections = db.prepare(`SELECT i.*, u.name AS inspector FROM inspections i LEFT JOIN users u ON u.id=i.inspected_by WHERE i.property_id=? ORDER BY inspected_on DESC`).all(p.id);
  const requests = db.prepare(`SELECT * FROM requests WHERE property_id=? ORDER BY created_at DESC LIMIT 50`).all(p.id);
  const spend12 = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE property_id=? AND incurred_on >= date('now','-365 days')`).get(p.id).s;
  const spendYTD = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE property_id=? AND incurred_on >= date('now','start of year')`).get(p.id).s;

  // Unified maintenance timeline: repairs, requests, inspections, asset installs, PM
  const timeline = [];
  history.filter(w => w.status === 'completed').forEach(w => timeline.push({
    date: (w.completed_at || w.created_at).slice(0, 10), kind: w.source === 'preventive' ? 'preventive' : 'repair',
    title: w.title, category: w.category, cost: +(+w.total_cost).toFixed(2),
    who: w.tech_name || w.vendor_company || null, who_type: w.tech_name ? 'technician' : (w.vendor_company ? 'vendor' : null),
    unit_id: w.unit_id, unit: w.unit_label, asset_id: w.asset_id,
    note: w.completion_notes, link: '#/work-orders/' + w.id,
    has_photos: !!db.prepare('SELECT 1 FROM photos WHERE work_order_id=?').get(w.id)
  }));
  inspections.forEach(i => timeline.push({ date: i.inspected_on, kind: 'inspection', title: 'Inspection — ' + (i.condition || ''), note: i.summary, who: i.inspector, unit_id: i.unit_id }));
  assets.filter(a => a.install_date).forEach(a => timeline.push({ date: a.install_date, kind: 'asset', title: a.name + ' installed', category: a.category, cost: a.purchase_price, asset_id: a.id, unit_id: a.unit_id }));
  timeline.sort((a, b) => b.date.localeCompare(a.date));

  res.json({ property: p, units, open_wos: openWos, history, assets, pm, expenses, photos, inspections, requests,
    timeline, health: I.propertyHealth(O, p.id),
    snapshot: {
      unit_count: units.length, open_wos: openWos.length,
      spend_ytd: +spendYTD.toFixed(2), spend_12mo: +spend12.toFixed(2),
      pm_upcoming: pm.filter(s => s.next_due >= new Date().toISOString().slice(0, 10)).length,
      pm_overdue: pm.filter(s => s.next_due < new Date().toISOString().slice(0, 10)).length,
      assets_near_replacement: assets.filter(a => { const st = I.assetAgeStatus(a); return st && st.pct >= 0.85; }).length,
      repeat_warnings: I.repeatRepairs(O).filter(r => r.property_id === p.id).length
    } });
});

router.patch('/properties/:id', MGMT_WRITE, (req, res) => {
  const p = db.prepare('SELECT id FROM properties WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!p) return notFound(res);
  const fields = ['name', 'address', 'city', 'state', 'zip', 'type', 'year_built', 'notes', 'active'];
  const sets = [], vals = [];
  for (const f of fields) if (f in req.body) { sets.push(`${f}=?`); vals.push(req.body[f]); }
  if ('tenant_routing' in req.body) {
    if (!['maintenance', 'owner'].includes(req.body.tenant_routing)) return res.status(400).json({ error: 'Invalid routing option' });
    if (req.body.tenant_routing === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only an owner can route tenant requests to owner review' });
    sets.push('tenant_routing=?'); vals.push(req.body.tenant_routing);
  }
  if (sets.length) { vals.push(p.id); db.prepare(`UPDATE properties SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  res.json({ ok: true });
});

router.post('/properties/:id/units', MGMT_WRITE, (req, res) => {
  const p = db.prepare('SELECT id FROM properties WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!p) return notFound(res);
  const { label, beds, baths, sqft } = req.body || {};
  if (!label) return res.status(400).json({ error: 'Unit label is required' });
  const id = db.prepare(`INSERT INTO units (organization_id,property_id,label,beds,baths,sqft) VALUES (?,?,?,?,?,?)`)
    .run(req.oid, p.id, label, +beds || null, +baths || null, +sqft || null).lastInsertRowid;
  res.json({ id });
});

router.post('/properties/:id/assets', MGMT_WRITE, (req, res) => {
  const p = db.prepare('SELECT id FROM properties WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!p) return notFound(res);
  const b = req.body || {};
  if (!b.category || !b.name) return res.status(400).json({ error: 'Category and name are required' });
  if (!isDate(b.install_date) || !isDate(b.warranty_expires)) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
  if (b.purchase_price != null && b.purchase_price !== '' && !isMoney(b.purchase_price)) return res.status(400).json({ error: 'Invalid purchase price' });
  const id = db.prepare(`INSERT INTO assets (organization_id,property_id,unit_id,category,name,location,manufacturer,model,serial,install_date,warranty_expires,purchase_price,useful_life_years,replacement_cost,condition,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.oid, p.id, b.unit_id || null, b.category, b.name, b.location || null, b.manufacturer || null, b.model || null, b.serial || null,
      b.install_date || null, b.warranty_expires || null, +b.purchase_price || null, +b.useful_life_years || null,
      +b.replacement_cost || null, b.condition || null, b.notes || null).lastInsertRowid;
  res.json({ id });
});
router.patch('/assets/:id', MGMT_WRITE, (req, res) => {
  const a = db.prepare('SELECT * FROM assets WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!a) return notFound(res);
  const fields = ['name', 'location', 'manufacturer', 'model', 'serial', 'install_date', 'warranty_expires', 'purchase_price', 'useful_life_years', 'replacement_cost', 'condition', 'notes', 'unit_id'];
  const sets = [], vals = [];
  for (const f of fields) if (f in req.body) { sets.push(`${f}=?`); vals.push(req.body[f]); }
  if (sets.length) { vals.push(a.id); db.prepare(`UPDATE assets SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  res.json({ ok: true });
});

// Asset detail — also the QR-scan landing target (techs allowed)
router.get('/assets/:id', (req, res) => {
  const a = db.prepare(`SELECT a.*, p.name AS property, p.address, u.label AS unit_label FROM assets a
    JOIN properties p ON p.id=a.property_id LEFT JOIN units u ON u.id=a.unit_id
    WHERE a.id=? AND a.organization_id=?`).get(req.params.id, req.oid);
  if (!a) return notFound(res);
  if (req.user.role === 'vendor') return notFound(res);
  const repairs = db.prepare(`${WO_SELECT} WHERE w.asset_id=? ORDER BY w.created_at DESC LIMIT 30`).all(a.id);
  const openWos = repairs.filter(w => !['completed', 'cancelled'].includes(w.status));
  const st = I.assetAgeStatus(a);
  res.json({ asset: a, age: st, repairs, open_wos: openWos,
    repair_count: repairs.filter(r => r.status === 'completed').length,
    last_service: (repairs.find(r => r.status === 'completed') || {}).completed_at || null,
    warranty_status: a.warranty_expires ? (a.warranty_expires < new Date().toISOString().slice(0, 10) ? 'Expired' : 'Active until ' + a.warranty_expires) : 'Unknown' });
});

/* ---------------- QR codes (SVG, printable labels) ---------------- */
async function sendQR(res, url, label) {
  const svg = await QRCode.toString(url, { type: 'svg', width: 240, margin: 1 });
  res.type('image/svg+xml').send(svg.replace('</svg>', `<text x="50%" y="98%" text-anchor="middle" font-size="3" font-family="monospace">${label}</text></svg>`));
}
router.get('/qr/property/:id', MGMT_READ, async (req, res) => {
  const p = db.prepare('SELECT id,name FROM properties WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!p) return notFound(res);
  await sendQR(res, `${req.protocol}://${req.get('host')}/#/properties/${p.id}`, 'PROP-' + p.id);
});
router.get('/qr/asset/:id', (req, res, next) => req.user.role === 'vendor' ? notFound(res) : next(), async (req, res) => {
  const a = db.prepare('SELECT id FROM assets WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!a) return notFound(res);
  await sendQR(res, `${req.protocol}://${req.get('host')}/#/scan/asset/${a.id}`, 'ASSET-' + a.id);
});
router.get('/qr/intake/:id', MGMT_READ, async (req, res) => {
  const p = db.prepare('SELECT id,intake_token FROM properties WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!p) return notFound(res);
  await sendQR(res, `${req.protocol}://${req.get('host')}/#/report/${p.intake_token}`, 'REPORT-ISSUE');
});
router.post('/properties/:id/intake-token/rotate', MGMT_WRITE, (req, res) => {
  const p = db.prepare('SELECT id FROM properties WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!p) return notFound(res);
  const tok = crypto.randomBytes(9).toString('hex');
  db.prepare('UPDATE properties SET intake_token=? WHERE id=?').run(tok, p.id);
  res.json({ intake_token: tok });
});
router.get('/qr/unit/:id', MGMT_READ, async (req, res) => {
  const u = db.prepare('SELECT id,property_id FROM units WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!u) return notFound(res);
  await sendQR(res, `${req.protocol}://${req.get('host')}/#/properties/${u.property_id}`, 'UNIT-' + u.id);
});

/* =====================================================================
   MAINTENANCE REQUESTS + TRIAGE
===================================================================== */
router.get('/requests', MGMT_READ, (req, res) => {
  const rows = db.prepare(`SELECT r.*, p.name AS property_name, u.label AS unit_label
    FROM requests r JOIN properties p ON p.id=r.property_id LEFT JOIN units u ON u.id=r.unit_id
    WHERE r.organization_id=?
    ORDER BY r.status='open' DESC, r.is_emergency DESC,
      CASE r.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, r.created_at DESC`).all(req.oid);
  const ph = db.prepare('SELECT id,url FROM photos WHERE request_id=?');
  res.json(rows.map(r => ({ ...r, photos: ph.all(r.id) })));
});
router.post('/requests', (req, res) => {
  // Vendors can't file requests. Viewers (owner/investor read-only role) CAN — it's their single write permission.
  if (req.user.role === 'vendor') return res.status(403).json({ error: 'Not permitted for your role' });
  const b = req.body || {};
  const prop = db.prepare('SELECT id,name FROM properties WHERE id=? AND organization_id=?').get(b.property_id, req.oid);
  if (!prop) return notFound(res);
  if (!b.category || !b.description) return res.status(400).json({ error: 'Category and description are required' });
  if (b.priority && !VALID_PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'Invalid priority' });
  const pri = b.is_emergency ? 'emergency' : (b.priority || 'normal');
  const id = db.prepare(`INSERT INTO requests (organization_id,property_id,unit_id,category,description,priority,
      reported_by,reporter_type,reporter_phone,reporter_email,access_instructions,permission_to_enter,pets,
      preferred_availability,is_emergency,flag_safety,flag_water,flag_electrical,flag_hvac_out,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.oid, prop.id, b.unit_id || null, b.category, b.description, pri,
      b.reported_by || req.user.name, b.reporter_type || (req.user.role === 'viewer' ? 'owner' : 'manager'), b.reporter_phone || null, b.reporter_email || null,
      b.access_instructions || null, b.permission_to_enter ? 1 : 0, b.pets || null,
      b.preferred_availability || null, b.is_emergency ? 1 : 0,
      b.flag_safety ? 1 : 0, b.flag_water ? 1 : 0, b.flag_electrical ? 1 : 0, b.flag_hvac_out ? 1 : 0,
      req.user.id, now()).lastInsertRowid;
  if (pri === 'emergency' || pri === 'high')
    notify(req.oid, mgmtIds(req.oid), 'request', `${pri === 'emergency' ? 'Emergency' : 'Urgent'} request: ${b.category}`,
      `${prop.name} — ${b.description.slice(0, 120)}`, '#/maintenance');
  res.json({ id });
});

function getReqOr404(req, res) {
  const r = db.prepare('SELECT * FROM requests WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!r) { notFound(res); return null; }
  return r;
}
// Triage actions in one endpoint: convert | reject | duplicate | info | priority
// Owner review gate: only an owner can release a held request to maintenance (or reject it)
router.post('/requests/:id/review', requireRole('owner'), (req, res) => {
  const r = getReqOr404(req, res); if (!r) return;
  if (r.status !== 'owner_review') return res.status(400).json({ error: 'This request is not waiting for owner review' });
  const { action } = req.body || {};
  if (action === 'release') {
    db.prepare(`UPDATE requests SET status='open', triage_note=? WHERE id=?`).run(req.body.note || null, r.id);
    const prop = db.prepare('SELECT name FROM properties WHERE id=?').get(r.property_id);
    notify(req.oid, mgmtIds(req.oid).filter(id => id !== req.user.id), 'request',
      `Owner-approved request: ${r.category}`, `${prop.name} — ${r.description.slice(0, 120)}`, '#/maintenance');
    return res.json({ ok: true });
  }
  if (action === 'reject') {
    db.prepare(`UPDATE requests SET status='rejected', triage_note=? WHERE id=?`).run(req.body.note || null, r.id);
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'Unknown review action' });
});

router.post('/requests/:id/triage', MGMT_WRITE, (req, res) => {
  const r = getReqOr404(req, res); if (!r) return;
  if (r.status === 'owner_review')
    return res.status(403).json({ error: 'This request is waiting for the owner to review it first' });
  if (!['open', 'info_needed'].includes(r.status))
    return res.status(400).json({ error: `This request has already been ${r.status === 'converted' ? 'converted to a work order' : 'closed'}` });
  const { action } = req.body || {};
  if (action === 'priority') {
    if (!VALID_PRIORITIES.includes(req.body.priority)) return res.status(400).json({ error: 'Invalid priority' });
    db.prepare('UPDATE requests SET priority=? WHERE id=?').run(req.body.priority, r.id);
    return res.json({ ok: true });
  }
  if (action === 'reject') { db.prepare(`UPDATE requests SET status='rejected', triage_note=? WHERE id=?`).run(req.body.note || null, r.id); return res.json({ ok: true }); }
  if (action === 'duplicate') { db.prepare(`UPDATE requests SET status='duplicate', triage_note=? WHERE id=?`).run(req.body.note || null, r.id); return res.json({ ok: true }); }
  if (action === 'info') { db.prepare(`UPDATE requests SET status='info_needed', triage_note=? WHERE id=?`).run(req.body.note || null, r.id); return res.json({ ok: true }); }
  if (action === 'convert') {
    const b = req.body;
    const num = nextWONumber(req.oid);
    const status = (b.assigned_user_id || b.assigned_vendor_id) ? (b.scheduled_date ? 'scheduled' : 'assigned') : 'new';
    let instructions = r.access_instructions ? 'Access: ' + r.access_instructions : '';
    if (r.permission_to_enter) instructions += (instructions ? ' · ' : '') + 'Permission to enter granted';
    if (r.pets) instructions += (instructions ? ' · ' : '') + 'Pets: ' + r.pets;
    if (r.preferred_availability) instructions += (instructions ? ' · ' : '') + 'Availability: ' + r.preferred_availability;
    const woId = db.prepare(`INSERT INTO work_orders (organization_id,number,property_id,unit_id,category,title,description,instructions,
        priority,status,assigned_user_id,assigned_vendor_id,scheduled_date,due_date,estimated_minutes,source,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req.oid, num, r.property_id, r.unit_id, r.category, b.title || r.description.slice(0, 80), r.description,
        instructions || null, r.priority, status, b.assigned_user_id || null, b.assigned_vendor_id || null,
        b.scheduled_date || null, b.due_date || null, +b.estimated_minutes || 60, 'request', req.user.id, now()).lastInsertRowid;
    db.prepare(`UPDATE requests SET status='converted', work_order_id=? WHERE id=?`).run(woId, r.id);
    const carried = db.prepare('UPDATE photos SET work_order_id=? WHERE request_id=?').run(woId, r.id).changes;
    hist(req.oid, woId, req.user.id, 'created', `Converted from request #${r.id}` + (carried ? ` (${carried} tenant photo${carried > 1 ? 's' : ''} attached)` : ''));
    if (b.assigned_user_id) {
      hist(req.oid, woId, req.user.id, 'assigned', 'Assigned during triage');
      notify(req.oid, b.assigned_user_id, 'assigned', 'New job assigned', `${num} — ${b.title || r.description.slice(0, 60)}`, '#/work-orders/' + woId);
    }
    return res.json({ id: woId, number: num });
  }
  res.status(400).json({ error: 'Unknown triage action' });
});

/* =====================================================================
   WORK ORDERS
===================================================================== */
router.get('/work-orders', (req, res) => {
  const u = req.user;
  let where = ['w.organization_id=?'], vals = [req.oid];
  if (u.role === 'technician') { where.push('w.assigned_user_id=?'); vals.push(u.id); }
  if (u.role === 'vendor') { where.push('(w.assigned_vendor_id=? OR w.id IN (SELECT work_order_id FROM vendor_quotes WHERE vendor_id=?))'); vals.push(u.vendor_id, u.vendor_id); }
  if (req.query.status && VALID_STATUSES.includes(req.query.status)) { where.push('w.status=?'); vals.push(req.query.status); }
  if (req.query.property_id) { where.push('w.property_id=?'); vals.push(+req.query.property_id); }
  if (req.query.open === '1') where.push(`w.status IN ${OPEN_STATUSES}`);
  if (req.query.today === '1') where.push(`(w.scheduled_date = date('now') OR (w.status IN ${OPEN_STATUSES} AND (w.scheduled_date < date('now') OR w.priority='emergency')))`);
  const sql = `${WO_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY CASE w.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             w.due_date IS NULL, w.due_date, w.created_at DESC LIMIT 300`;
  res.json(db.prepare(sql).all(...vals));
});

router.post('/work-orders', MGMT_WRITE, (req, res) => {
  const b = req.body || {};
  const prop = db.prepare('SELECT id,name FROM properties WHERE id=? AND organization_id=?').get(b.property_id, req.oid);
  if (!prop) return notFound(res);
  if (!b.title || !b.category) return res.status(400).json({ error: 'Title and category are required' });
  if (b.priority && !VALID_PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'Invalid priority' });
  if (!isDate(b.scheduled_date) || !isDate(b.due_date)) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
  const num = nextWONumber(req.oid);
  const status = (b.assigned_user_id || b.assigned_vendor_id) ? (b.scheduled_date ? 'scheduled' : 'assigned') : 'new';
  const id = db.prepare(`INSERT INTO work_orders (organization_id,number,property_id,unit_id,asset_id,category,title,description,instructions,
      priority,status,assigned_user_id,assigned_vendor_id,scheduled_date,due_date,estimated_minutes,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.oid, num, prop.id, b.unit_id || null, b.asset_id || null, b.category, b.title, b.description || null, b.instructions || null,
      b.priority || 'normal', status, b.assigned_user_id || null, b.assigned_vendor_id || null,
      b.scheduled_date || null, b.due_date || null, +b.estimated_minutes || 60, req.user.id, now()).lastInsertRowid;
  hist(req.oid, id, req.user.id, 'created', 'Work order created');
  if (b.assigned_user_id) {
    hist(req.oid, id, req.user.id, 'assigned', 'Assigned to technician', null, String(b.assigned_user_id));
    notify(req.oid, b.assigned_user_id, 'assigned', 'New job assigned', `${b.title} — ${prop.name}`, '#/work-orders/' + id);
  }
  res.json({ id, number: num });
});

router.get('/work-orders/:id', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const full = db.prepare(`${WO_SELECT} WHERE w.id=?`).get(w.id);
  const photos = db.prepare('SELECT * FROM photos WHERE work_order_id=? ORDER BY created_at').all(w.id);
  const comments = db.prepare('SELECT c.*, u.name AS user_name FROM comments c JOIN users u ON u.id=c.user_id WHERE work_order_id=? ORDER BY c.created_at').all(w.id);
  const materials = db.prepare('SELECT * FROM materials WHERE work_order_id=? ORDER BY created_at').all(w.id);
  const expenses = db.prepare('SELECT * FROM expenses WHERE work_order_id=? ORDER BY created_at').all(w.id);
  const time = db.prepare('SELECT t.*, u.name AS user_name FROM time_logs t JOIN users u ON u.id=t.user_id WHERE work_order_id=? ORDER BY started_at').all(w.id);
  const history = db.prepare('SELECT h.*, u.name AS user_name FROM wo_history h LEFT JOIN users u ON u.id=h.user_id WHERE work_order_id=? ORDER BY h.created_at').all(w.id);
  const approvals = db.prepare('SELECT a.*, u.name AS requested_by_name, du.name AS decided_by_name FROM approvals a JOIN users u ON u.id=a.requested_by LEFT JOIN users du ON du.id=a.decided_by WHERE work_order_id=? ORDER BY a.created_at DESC').all(w.id);
  const quotes = db.prepare(`SELECT q.*, v.company AS vendor_company FROM vendor_quotes q JOIN vendors v ON v.id=q.vendor_id WHERE q.work_order_id=? ORDER BY q.created_at`).all(w.id);
  const activeTimer = time.find(t => !t.ended_at && t.user_id === req.user.id) || null;
  res.json({ wo: full, photos, comments, materials, expenses, time, history, approvals,
    quotes: req.user.role === 'vendor' ? quotes.filter(q => q.vendor_id === req.user.vendor_id) : quotes,
    active_timer: activeTimer,
    completion: completionCheck(req.oid, w),
    approval_t1: +setting(req.oid, 'approval_t1', 150),
    approval_t2: +setting(req.oid, 'approval_t2', 500) });
});

router.patch('/work-orders/:id', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const u = req.user;
  if (u.role === 'viewer') return res.status(403).json({ error: 'Viewers have read-only access' });
  const b = req.body || {};

  if (b.status && b.status !== w.status) {
    if (!VALID_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
    const techAllowed = ['in_progress', 'waiting_parts', 'waiting_approval', 'completed', 'scheduled'];
    if (!isMgmt(u) && !techAllowed.includes(b.status)) return res.status(403).json({ error: 'Not permitted for your role' });

    if (b.status === 'completed') {
      // ---- configurable completion requirements enforced server-side ----
      const check = completionCheck(req.oid, w, b.completion_notes);
      const override = isMgmt(u) && b.override === true;
      if (check.missing.length && !override) {
        return res.status(400).json({ error: 'Cannot complete job. Still required: ' + check.missing.map(m => m.label).join(', '),
          missing: check.missing });
      }
      if (check.missing.length && override) {
        hist(req.oid, w.id, u.id, 'completion_override',
          `Manager override — completed with missing requirements: ${check.missing.map(m => m.label).join(', ')}${b.override_note ? ' · ' + b.override_note : ''}`);
      }
      const open = db.prepare('SELECT * FROM time_logs WHERE work_order_id=? AND ended_at IS NULL').all(w.id);
      for (const t of open) {
        const mins = Math.max(1, Math.round((Date.now() - new Date(t.started_at.replace(' ', 'T')).getTime()) / 60000));
        db.prepare('UPDATE time_logs SET ended_at=?, minutes=? WHERE id=?').run(now(), mins, t.id);
      }
      db.prepare(`UPDATE work_orders SET status='completed', completed_at=?, completion_notes=COALESCE(?,completion_notes) WHERE id=?`)
        .run(now(), b.completion_notes || null, w.id);
      if (w.pm_schedule_id) {
        const s = db.prepare('SELECT * FROM pm_schedules WHERE id=?').get(w.pm_schedule_id);
        if (s) db.prepare('UPDATE pm_schedules SET next_due=date(?, ?) WHERE id=?').run(now().slice(0, 10), `+${s.interval_days} days`, s.id);
      }
      if (w.asset_id) hist(req.oid, w.id, u.id, 'asset_history', 'Repair recorded to asset history');
      hist(req.oid, w.id, u.id, 'status_changed', 'Status changed', w.status, 'completed');
      notify(req.oid, mgmtIds(req.oid), 'completed', `Job completed: ${w.title}`, `${w.number} completed by ${u.name}.`, '#/work-orders/' + w.id);
      return res.json({ ok: true });
    }

    if (b.status === 'in_progress' && !db.prepare('SELECT id FROM time_logs WHERE work_order_id=? AND user_id=? AND ended_at IS NULL').get(w.id, u.id)) {
      db.prepare('INSERT INTO time_logs (organization_id,work_order_id,user_id,kind,started_at) VALUES (?,?,?,?,?)').run(req.oid, w.id, u.id, 'work', now());
    }
    db.prepare('UPDATE work_orders SET status=? WHERE id=?').run(b.status, w.id);
    hist(req.oid, w.id, u.id, 'status_changed', 'Status changed', w.status, b.status);
  }

  if (isMgmt(u)) {
    const fields = ['title', 'description', 'instructions', 'category', 'scheduled_date', 'due_date', 'estimated_minutes', 'unit_id', 'asset_id'];
    const sets = [], vals = [];
    for (const f of fields) if (f in b) { sets.push(`${f}=?`); vals.push(b[f]); }
    if ('priority' in b && b.priority !== w.priority) {
      if (!VALID_PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'Invalid priority' });
      sets.push('priority=?'); vals.push(b.priority);
      hist(req.oid, w.id, u.id, 'priority_changed', 'Priority changed', w.priority, b.priority);
    }
    if ('assigned_user_id' in b || 'assigned_vendor_id' in b) {
      if (b.assigned_user_id && !db.prepare('SELECT 1 FROM users WHERE id=? AND organization_id=?').get(b.assigned_user_id, req.oid)) return notFound(res);
      if (b.assigned_vendor_id && !db.prepare('SELECT 1 FROM vendors WHERE id=? AND organization_id=?').get(b.assigned_vendor_id, req.oid)) return notFound(res);
      sets.push('assigned_user_id=?', 'assigned_vendor_id=?');
      vals.push(b.assigned_user_id || null, b.assigned_vendor_id || null);
      if (w.status === 'new') sets.push(`status='assigned'`);
      hist(req.oid, w.id, u.id, 'assigned', 'Assignment updated',
        String(w.assigned_user_id || w.assigned_vendor_id || ''), String(b.assigned_user_id || b.assigned_vendor_id || ''));
      if (b.assigned_user_id) notify(req.oid, b.assigned_user_id, 'assigned', 'Job assigned to you', `${w.number} — ${w.title}`, '#/work-orders/' + w.id);
    }
    if (sets.length) { vals.push(w.id); db.prepare(`UPDATE work_orders SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  }
  res.json({ ok: true });
});

router.get('/work-orders/:id/completion-check', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  res.json(completionCheck(req.oid, w));
});

/* --- travel / arrival / work time events --- */
router.post('/work-orders/:id/travel/start', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  if (db.prepare(`SELECT 1 FROM time_logs WHERE work_order_id=? AND user_id=? AND ended_at IS NULL`).get(w.id, req.user.id))
    return res.status(400).json({ error: 'A timer is already running on this job' });
  db.prepare('INSERT INTO time_logs (organization_id,work_order_id,user_id,kind,started_at) VALUES (?,?,?,?,?)').run(req.oid, w.id, req.user.id, 'travel', now());
  hist(req.oid, w.id, req.user.id, 'travel_started', `${req.user.name} started travel`);
  res.json({ ok: true });
});
router.post('/work-orders/:id/arrived', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const t = db.prepare(`SELECT * FROM time_logs WHERE work_order_id=? AND user_id=? AND kind='travel' AND ended_at IS NULL`).get(w.id, req.user.id);
  if (t) {
    const mins = Math.max(1, Math.round((Date.now() - new Date(t.started_at.replace(' ', 'T')).getTime()) / 60000));
    db.prepare('UPDATE time_logs SET ended_at=?, minutes=? WHERE id=?').run(now(), mins, t.id);
  }
  hist(req.oid, w.id, req.user.id, 'arrived', `${req.user.name} arrived on site`);
  res.json({ ok: true });
});
router.post('/work-orders/:id/time/start', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  if (db.prepare('SELECT id FROM time_logs WHERE work_order_id=? AND user_id=? AND ended_at IS NULL').get(w.id, req.user.id))
    return res.status(400).json({ error: 'A timer is already running on this job' });
  db.prepare('INSERT INTO time_logs (organization_id,work_order_id,user_id,kind,started_at) VALUES (?,?,?,?,?)').run(req.oid, w.id, req.user.id, 'work', now());
  if (['assigned', 'scheduled', 'new'].includes(w.status)) {
    db.prepare(`UPDATE work_orders SET status='in_progress' WHERE id=?`).run(w.id);
    hist(req.oid, w.id, req.user.id, 'status_changed', 'Job started', w.status, 'in_progress');
  } else hist(req.oid, w.id, req.user.id, 'job_started', 'Job started');
  res.json({ started_at: now() });
});
router.post('/work-orders/:id/time/stop', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const t = db.prepare('SELECT * FROM time_logs WHERE work_order_id=? AND user_id=? AND ended_at IS NULL').get(w.id, req.user.id);
  if (!t) return res.status(400).json({ error: 'No timer is running' });
  const mins = Math.max(1, Math.round((Date.now() - new Date(t.started_at.replace(' ', 'T')).getTime()) / 60000));
  db.prepare('UPDATE time_logs SET ended_at=?, minutes=? WHERE id=?').run(now(), mins, t.id);
  res.json({ minutes: mins });
});

/* --- photos / comments / materials / expenses --- */
router.post('/work-orders/:id/photos', upload.single('photo'), (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  if (!req.file) return res.status(400).json({ error: 'No photo received (JPEG, PNG, WebP, or HEIC only)' });
  const kind = ['before', 'after', 'receipt', 'general'].includes(req.body.kind) ? req.body.kind : 'general';
  const id = db.prepare(`INSERT INTO photos (organization_id,work_order_id,property_id,asset_id,kind,url,caption,uploaded_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(req.oid, w.id, w.property_id, w.asset_id || null, kind, '/uploads/' + req.file.filename, req.body.caption || null, req.user.id, now()).lastInsertRowid;
  hist(req.oid, w.id, req.user.id, 'photo', `${kind[0].toUpperCase() + kind.slice(1)} photo uploaded`);
  res.json({ id, url: '/uploads/' + req.file.filename, kind });
});
router.post('/work-orders/:id/comments', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  if (!req.body.body || !req.body.body.trim()) return res.status(400).json({ error: 'Comment text is required' });
  const id = db.prepare('INSERT INTO comments (organization_id,work_order_id,user_id,body,is_voice_note,created_at) VALUES (?,?,?,?,?,?)')
    .run(req.oid, w.id, req.user.id, req.body.body.trim(), req.body.is_voice_note ? 1 : 0, now()).lastInsertRowid;
  res.json({ id });
});
router.post('/work-orders/:id/materials', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const { name, qty, unit_cost } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Material name is required' });
  if (!isMoney(unit_cost || 0) || !Number.isFinite(+(qty || 1))) return res.status(400).json({ error: 'Invalid quantity or cost' });
  const id = db.prepare('INSERT INTO materials (organization_id,work_order_id,name,qty,unit_cost,added_by,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(req.oid, w.id, name, +qty || 1, +unit_cost || 0, req.user.id, now()).lastInsertRowid;
  const amount = +((+qty || 1) * (+unit_cost || 0)).toFixed(2);
  if (amount > 0) db.prepare(`INSERT INTO expenses (organization_id,work_order_id,property_id,user_id,category,description,amount,incurred_on,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(req.oid, w.id, w.property_id, req.user.id, 'materials', name, amount, now().slice(0, 10), now());
  hist(req.oid, w.id, req.user.id, 'material', `Material: ${name} — $${amount.toFixed(2)}`);
  res.json({ id });
});
router.post('/work-orders/:id/expenses', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const { category, description, amount } = req.body || {};
  if (!isMoney(amount) || +amount <= 0) return res.status(400).json({ error: 'A valid amount is required' });
  const id = db.prepare(`INSERT INTO expenses (organization_id,work_order_id,property_id,user_id,vendor_id,category,description,amount,incurred_on,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(req.oid, w.id, w.property_id, req.user.id, req.user.vendor_id || null, category || 'other', description || null, +amount, now().slice(0, 10), now()).lastInsertRowid;
  hist(req.oid, w.id, req.user.id, 'expense', `Expense added: $${(+amount).toFixed(2)}${description ? ' — ' + description : ''}`);
  const t2 = +setting(req.oid, 'approval_t2', 500);
  if (+amount > t2 * 1.5) notify(req.oid, mgmtIds(req.oid), 'high_cost', 'Unusually high expense recorded', `$${(+amount).toLocaleString()} on ${w.number} — ${w.title}`, '#/work-orders/' + w.id);
  res.json({ id });
});

/* --- tiered approvals --- */
router.post('/work-orders/:id/approvals', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const { amount, reason } = req.body || {};
  if (!isMoney(amount) || +amount <= 0) return res.status(400).json({ error: 'A valid estimated amount is required' });
  const t1 = +setting(req.oid, 'approval_t1', 150), t2 = +setting(req.oid, 'approval_t2', 500);
  const requiredRole = +amount > t2 ? 'owner' : 'manager';
  const id = db.prepare('INSERT INTO approvals (organization_id,work_order_id,requested_by,amount,reason,required_role,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(req.oid, w.id, req.user.id, +amount, reason || null, requiredRole, now()).lastInsertRowid;
  db.prepare(`UPDATE work_orders SET status='waiting_approval' WHERE id=?`).run(w.id);
  hist(req.oid, w.id, req.user.id, 'approval_requested', `$${(+amount).toLocaleString()} approval requested${reason ? ' — ' + reason : ''} (${requiredRole} sign-off)`);
  const targets = requiredRole === 'owner' ? ownerIds(req.oid) : mgmtIds(req.oid);
  notify(req.oid, targets, 'approval', `Approval requested: $${(+amount).toLocaleString()}`,
    `${req.user.name} — ${w.title} (${w.number})${requiredRole === 'owner' ? ' · requires owner' : ''}`, '#/work-orders/' + w.id);
  res.json({ id, required_role: requiredRole, no_approval_needed_under: t1 });
});
router.patch('/approvals/:id', MGMT_WRITE, (req, res) => {
  const a = db.prepare('SELECT * FROM approvals WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!a) return notFound(res);
  if (a.required_role === 'owner' && req.user.role !== 'owner')
    return res.status(403).json({ error: `Approvals over $${setting(req.oid, 'approval_t2', 500)} require an owner` });
  const decision = req.body.decision;
  if (!['approved', 'declined', 'info_requested'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
  db.prepare('UPDATE approvals SET status=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?')
    .run(decision, req.user.id, req.body.note || null, now(), a.id);
  const w = db.prepare('SELECT * FROM work_orders WHERE id=?').get(a.work_order_id);
  if (decision === 'approved')
    db.prepare(`UPDATE work_orders SET status=CASE WHEN status='waiting_approval' THEN 'in_progress' ELSE status END WHERE id=?`).run(w.id);
  hist(req.oid, w.id, req.user.id, 'approval_' + decision,
    `$${(+a.amount).toLocaleString()} ${decision.replace('_', ' ')} by ${req.user.name}${req.body.note ? ' — ' + req.body.note : ''}`);
  const label = { approved: 'Approved', declined: 'Declined', info_requested: 'More information requested' }[decision];
  notify(req.oid, a.requested_by, 'approval_decision', `${label}: $${(+a.amount).toLocaleString()}`,
    `${w.number} — ${w.title}${req.body.note ? ' · ' + req.body.note : ''}`, '#/work-orders/' + w.id);
  res.json({ ok: true });
});

/* =====================================================================
   VENDOR QUOTES
===================================================================== */
router.post('/work-orders/:id/quotes/request', MGMT_WRITE, (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const vendorIds = [].concat(req.body.vendor_ids || []).filter(Boolean);
  if (!vendorIds.length) return res.status(400).json({ error: 'Select at least one vendor' });
  const created = [];
  for (const vid of vendorIds) {
    const v = db.prepare('SELECT * FROM vendors WHERE id=? AND organization_id=?').get(vid, req.oid);
    if (!v) continue;
    if (db.prepare(`SELECT 1 FROM vendor_quotes WHERE work_order_id=? AND vendor_id=? AND status IN ('requested','submitted')`).get(w.id, vid)) continue;
    const qid = db.prepare(`INSERT INTO vendor_quotes (organization_id,work_order_id,vendor_id,requested_by,created_at)
      VALUES (?,?,?,?,?)`).run(req.oid, w.id, vid, req.user.id, now()).lastInsertRowid;
    created.push(qid);
    hist(req.oid, w.id, req.user.id, 'quote_requested', `Quote requested from ${v.company}`);
    const vendorUsers = db.prepare(`SELECT id FROM users WHERE organization_id=? AND vendor_id=? AND active=1`).all(req.oid, vid).map(r => r.id);
    notify(req.oid, vendorUsers, 'quote', 'Quote requested', `${w.number} — ${w.title} at ${db.prepare('SELECT name FROM properties WHERE id=?').get(w.property_id).name}`, '#/work-orders/' + w.id);
  }
  if (created.length && w.status === 'new') db.prepare(`UPDATE work_orders SET status='waiting_vendor' WHERE id=?`).run(w.id);
  res.json({ created });
});
router.post('/quotes/:id/submit', requireRole('vendor'), (req, res) => {
  const q = db.prepare('SELECT * FROM vendor_quotes WHERE id=? AND organization_id=? AND vendor_id=?').get(req.params.id, req.oid, req.user.vendor_id);
  if (!q || q.status !== 'requested') return notFound(res);
  const { price, scope, est_start, est_complete, notes } = req.body || {};
  if (!isMoney(price) || +price <= 0) return res.status(400).json({ error: 'A valid price is required' });
  if (!isDate(est_start) || !isDate(est_complete)) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
  db.prepare(`UPDATE vendor_quotes SET status='submitted', price=?, scope=?, est_start=?, est_complete=?, notes=?, submitted_at=? WHERE id=?`)
    .run(+price, scope || null, est_start || null, est_complete || null, notes || null, now(), q.id);
  const w = db.prepare('SELECT * FROM work_orders WHERE id=?').get(q.work_order_id);
  hist(req.oid, w.id, req.user.id, 'quote_submitted', `${db.prepare('SELECT company FROM vendors WHERE id=?').get(q.vendor_id).company} quoted $${(+price).toLocaleString()}`);
  notify(req.oid, mgmtIds(req.oid), 'quote', `Quote received: $${(+price).toLocaleString()}`, `${w.number} — ${w.title}`, '#/work-orders/' + w.id);
  res.json({ ok: true });
});
router.patch('/quotes/:id', MGMT_WRITE, (req, res) => {
  const q = db.prepare('SELECT * FROM vendor_quotes WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!q) return notFound(res);
  const decision = req.body.decision;
  if (!['approved', 'declined'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
  db.prepare(`UPDATE vendor_quotes SET status=?, decided_by=?, decided_at=? WHERE id=?`).run(decision, req.user.id, now(), q.id);
  const w = db.prepare('SELECT * FROM work_orders WHERE id=?').get(q.work_order_id);
  const company = db.prepare('SELECT company FROM vendors WHERE id=?').get(q.vendor_id).company;
  if (decision === 'approved') {
    db.prepare(`UPDATE work_orders SET assigned_vendor_id=?, assigned_user_id=NULL,
      status=CASE WHEN status IN ('new','waiting_vendor') THEN 'assigned' ELSE status END WHERE id=?`).run(q.vendor_id, w.id);
    db.prepare(`UPDATE vendor_quotes SET status='declined', decided_by=?, decided_at=? WHERE work_order_id=? AND id != ? AND status='submitted'`)
      .run(req.user.id, now(), w.id, q.id);
    hist(req.oid, w.id, req.user.id, 'quote_approved', `${company} quote approved at $${(+q.price).toLocaleString()} — job assigned`);
  } else hist(req.oid, w.id, req.user.id, 'quote_declined', `${company} quote declined`);
  const vendorUsers = db.prepare(`SELECT id FROM users WHERE organization_id=? AND vendor_id=? AND active=1`).all(req.oid, q.vendor_id).map(r => r.id);
  notify(req.oid, vendorUsers, 'quote', decision === 'approved' ? 'Quote approved — job is yours' : 'Quote declined', `${w.number} — ${w.title}`, '#/work-orders/' + w.id);
  res.json({ ok: true });
});

/* =====================================================================
   PM / CALENDAR / TEAM / VENDORS / ANALYTICS
===================================================================== */
router.get('/pm', MGMT_READ, (req, res) => {
  res.json(db.prepare(`SELECT s.*, p.name AS property_name, tu.name AS tech_name, v.company AS vendor_company
    FROM pm_schedules s JOIN properties p ON p.id=s.property_id
    LEFT JOIN users tu ON tu.id=s.assigned_user_id LEFT JOIN vendors v ON v.id=s.assigned_vendor_id
    WHERE s.organization_id=? AND s.active=1 ORDER BY s.next_due`).all(req.oid));
});
router.post('/pm', MGMT_WRITE, (req, res) => {
  const b = req.body || {};
  const p = db.prepare('SELECT id FROM properties WHERE id=? AND organization_id=?').get(b.property_id, req.oid);
  if (!p) return notFound(res);
  if (!b.title || !b.interval_days || !b.next_due) return res.status(400).json({ error: 'Title, interval, and next due date are required' });
  if (!isDate(b.next_due)) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
  const id = db.prepare(`INSERT INTO pm_schedules (organization_id,property_id,asset_id,title,category,interval_days,next_due,estimated_minutes,instructions,assigned_user_id,assigned_vendor_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.oid, p.id, b.asset_id || null, b.title, b.category || 'General', +b.interval_days, b.next_due,
      +b.estimated_minutes || 60, b.instructions || null, b.assigned_user_id || null, b.assigned_vendor_id || null).lastInsertRowid;
  res.json({ id });
});
router.post('/pm/generate', MGMT_WRITE, (req, res) => res.json({ generated: generatePMWorkOrders() }));

router.get('/calendar', MGMT_READ, (req, res) => {
  const wos = db.prepare(`${WO_SELECT} WHERE w.organization_id=? AND w.scheduled_date IS NOT NULL AND w.status NOT IN ('completed','cancelled')`).all(req.oid);
  const pm = db.prepare(`SELECT s.*, p.name AS property_name FROM pm_schedules s JOIN properties p ON p.id=s.property_id
    WHERE s.organization_id=? AND s.active=1 AND s.next_due <= date('now','+90 days')`).all(req.oid);
  res.json({ work_orders: wos, pm });
});

router.get('/team', MGMT_READ, (req, res) => res.json(I.techScorecards(req.oid)));

router.get('/vendors', MGMT_READ, (req, res) => {
  const rows = db.prepare(`SELECT * FROM vendors WHERE organization_id=? AND active=1 ORDER BY company`).all(req.oid);
  res.json(rows.map(v => ({ ...v, metrics: I.vendorMetrics(req.oid, v.id) })));
});
router.post('/vendors', MGMT_WRITE, (req, res) => {
  const b = req.body || {};
  if (!b.company) return res.status(400).json({ error: 'Company name is required' });
  if (!isDate(b.insurance_expires)) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
  const id = db.prepare(`INSERT INTO vendors (organization_id,company,trade,contact_name,phone,email,service_area,insurance_expires,license_number,hourly_rate,emergency_available,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.oid, b.company, b.trade || null, b.contact_name || null, b.phone || null, b.email || null,
      b.service_area || null, b.insurance_expires || null, b.license_number || null, +b.hourly_rate || null,
      b.emergency_available ? 1 : 0, b.notes || null).lastInsertRowid;
  res.json({ id });
});
router.patch('/vendors/:id', MGMT_WRITE, (req, res) => {
  const v = db.prepare('SELECT id FROM vendors WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!v) return notFound(res);
  const fields = ['company', 'trade', 'contact_name', 'phone', 'email', 'service_area', 'insurance_expires', 'license_number', 'hourly_rate', 'emergency_available', 'notes', 'active'];
  const sets = [], vals = [];
  for (const f of fields) if (f in req.body) { sets.push(`${f}=?`); vals.push(req.body[f]); }
  if (sets.length) { vals.push(v.id); db.prepare(`UPDATE vendors SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  res.json({ ok: true });
});

router.get('/analytics', MGMT_READ, (req, res) => {
  const O = req.oid;
  const monthly = db.prepare(`SELECT strftime('%Y-%m', incurred_on) m, SUM(amount) total FROM expenses
    WHERE organization_id=? AND incurred_on >= date('now','-6 months','start of month') GROUP BY m ORDER BY m`).all(O);
  const byCategory = db.prepare(`SELECT w.category, COUNT(DISTINCT w.id) wos, COALESCE(SUM(e.amount),0) total
    FROM work_orders w LEFT JOIN expenses e ON e.work_order_id=w.id
    WHERE w.organization_id=? AND w.created_at >= datetime('now','-180 days') GROUP BY w.category ORDER BY total DESC`).all(O);
  const byVendor = db.prepare(`SELECT v.company, COALESCE(SUM(e.amount),0) total FROM expenses e JOIN vendors v ON v.id=e.vendor_id
    WHERE e.organization_id=? AND e.incurred_on >= date('now','-365 days') GROUP BY v.id ORDER BY total DESC`).all(O);
  const byTech = db.prepare(`SELECT u.name, COALESCE(SUM(e.amount),0) total FROM expenses e JOIN users u ON u.id=e.user_id
    WHERE e.organization_id=? AND u.role='technician' AND e.incurred_on >= date('now','-365 days') GROUP BY u.id ORDER BY total DESC`).all(O);
  const preventive = db.prepare(`SELECT COALESCE(SUM(e.amount),0) s FROM expenses e JOIN work_orders w ON w.id=e.work_order_id
    WHERE e.organization_id=? AND w.source='preventive' AND e.incurred_on >= date('now','-365 days')`).get(O).s;
  const repair = db.prepare(`SELECT COALESCE(SUM(e.amount),0) s FROM expenses e LEFT JOIN work_orders w ON w.id=e.work_order_id
    WHERE e.organization_id=? AND (w.id IS NULL OR w.source != 'preventive') AND e.incurred_on >= date('now','-365 days')`).get(O).s;
  const avgWO = db.prepare(`SELECT AVG(tot) a FROM (SELECT w.id, SUM(e.amount) tot FROM work_orders w JOIN expenses e ON e.work_order_id=w.id
    WHERE w.organization_id=? AND w.status='completed' GROUP BY w.id)`).get(O).a;
  const horizon = [12, 24, 60].includes(+req.query.capex_months) ? +req.query.capex_months : 24;
  res.json({
    monthly_spend: monthly.map(r => ({ ...r, total: +r.total.toFixed(2) })),
    by_category: byCategory.map(r => ({ ...r, total: +r.total.toFixed(2) })),
    by_vendor: byVendor.map(r => ({ ...r, total: +r.total.toFixed(2) })),
    by_technician: byTech.map(r => ({ ...r, total: +r.total.toFixed(2) })),
    repair_vs_preventive: { repair: +repair.toFixed(2), preventive: +preventive.toFixed(2) },
    avg_cost_per_wo: avgWO ? +avgWO.toFixed(2) : null,
    repeat_repairs: I.repeatRepairs(O),
    repair_vs_replace: I.repairVsReplace(O),
    anomalies: I.costAnomalies(O),
    capex: I.capexForecast(O, horizon),
    team: I.techScorecards(O)
  });
});

router.post('/assets/:id/rvr', MGMT_WRITE, (req, res) => {
  const a = db.prepare('SELECT id FROM assets WHERE id=? AND organization_id=?').get(req.params.id, req.oid);
  if (!a) return notFound(res);
  const action = req.body.action;
  if (!['dismissed', 'marked_replacement', 'quote_requested', 'continue_repair'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  db.prepare('INSERT INTO rvr_actions (organization_id,asset_id,action,user_id,note,created_at) VALUES (?,?,?,?,?,?)')
    .run(req.oid, a.id, action, req.user.id, req.body.note || null, now());
  res.json({ ok: true });
});

/* =====================================================================
   NOTIFICATIONS / SEARCH / META
===================================================================== */
router.get('/notifications', (req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 60').all(req.user.id));
});
router.post('/notifications/read', (req, res) => {
  if (req.body.id) db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(req.body.id, req.user.id);
  else db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

router.get('/search', MGMT_READ, (req, res) => {
  const O = req.oid;
  const q = '%' + (req.query.q || '').trim() + '%';
  if (q === '%%') return res.json({ properties: [], units: [], work_orders: [], requests: [], assets: [], vendors: [], people: [] });
  res.json({
    properties: db.prepare(`SELECT id,name,address FROM properties WHERE organization_id=? AND (name LIKE ? OR address LIKE ?) AND active=1 LIMIT 6`).all(O, q, q),
    units: db.prepare(`SELECT u.id,u.label,u.property_id,p.name property_name FROM units u JOIN properties p ON p.id=u.property_id
      WHERE u.organization_id=? AND ('Unit ' || u.label LIKE ? OR u.label LIKE ?) LIMIT 5`).all(O, q, q),
    work_orders: db.prepare(`SELECT w.id,w.number,w.title,w.status,p.name property_name FROM work_orders w JOIN properties p ON p.id=w.property_id
      WHERE w.organization_id=? AND (w.title LIKE ? OR w.number LIKE ? OR w.category LIKE ? OR w.description LIKE ?) ORDER BY w.created_at DESC LIMIT 8`).all(O, q, q, q, q),
    requests: db.prepare(`SELECT r.id,r.description,r.status,p.name property_name FROM requests r JOIN properties p ON p.id=r.property_id
      WHERE r.organization_id=? AND r.description LIKE ? ORDER BY r.created_at DESC LIMIT 5`).all(O, q),
    assets: db.prepare(`SELECT a.id,a.name,a.category,a.property_id,p.name property_name FROM assets a JOIN properties p ON p.id=a.property_id
      WHERE a.organization_id=? AND (a.name LIKE ? OR a.category LIKE ? OR a.manufacturer LIKE ? OR a.model LIKE ? OR a.serial LIKE ?) LIMIT 6`).all(O, q, q, q, q, q),
    vendors: db.prepare(`SELECT id,company,trade FROM vendors WHERE organization_id=? AND (company LIKE ? OR trade LIKE ?) AND active=1 LIMIT 5`).all(O, q, q),
    people: db.prepare(`SELECT id,name,role FROM users WHERE organization_id=? AND name LIKE ? AND active=1 LIMIT 5`).all(O, q)
  });
});

router.get('/meta', (req, res) => {
  const O = req.oid;
  const out = {
    approval_t1: +setting(O, 'approval_t1', 150),
    approval_t2: +setting(O, 'approval_t2', 500),
    org_name: (db.prepare('SELECT name FROM organizations WHERE id=?').get(O) || {}).name
  };
  if (canRead(req.user)) {
    out.properties = db.prepare(`SELECT id,name FROM properties WHERE organization_id=? AND active=1 ORDER BY name`).all(O);
    out.units = db.prepare(`SELECT id,property_id,label FROM units WHERE organization_id=? ORDER BY label`).all(O);
    out.technicians = db.prepare(`SELECT id,name FROM users WHERE organization_id=? AND role='technician' AND active=1`).all(O);
    out.vendors = db.prepare(`SELECT id,company FROM vendors WHERE organization_id=? AND active=1`).all(O);
    out.assets = db.prepare(`SELECT id,property_id,name FROM assets WHERE organization_id=?`).all(O);
    out.categories = ['HVAC', 'Plumbing', 'Electrical', 'Appliance', 'Roofing', 'Pest', 'Safety', 'General'];
    out.asset_types = ['HVAC', 'Water Heater', 'Roof', 'Dishwasher', 'Refrigerator', 'Range', 'Washer/Dryer', 'Electrical Panel', 'Plumbing System', 'Garage Door', 'Other'];
  }
  res.json(out);
});

module.exports = { router, generatePMWorkOrders };
