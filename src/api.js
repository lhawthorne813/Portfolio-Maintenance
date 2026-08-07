// api.js — REST API with role-based access control.
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { repeatRepairs, propertyHealth, techScorecards, capexForecast, OPEN_STATUSES } = require('./insights');

const router = express.Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(file.originalname || '.jpg'))
  }),
  limits: { fileSize: 12 * 1024 * 1024 }
});

// ---------- helpers ----------
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function me(req) { return req.session.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId) : null; }
function requireAuth(req, res, next) {
  const u = me(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  req.user = u; next();
}
function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not permitted for your role' });
}
const isMgmt = u => u.role === 'owner' || u.role === 'manager';

function canSeeWO(u, w) {
  if (isMgmt(u)) return true;
  if (u.role === 'technician') return w.assigned_user_id === u.id;
  if (u.role === 'vendor') return w.assigned_vendor_id === u.vendor_id;
  return false;
}
function getWOOr404(req, res) {
  const w = db.prepare('SELECT * FROM work_orders WHERE id=?').get(req.params.id);
  if (!w) { res.status(404).json({ error: 'Work order not found' }); return null; }
  if (!canSeeWO(req.user, w)) { res.status(403).json({ error: 'Not permitted' }); return null; }
  return w;
}
function hist(woId, userId, action, detail) {
  db.prepare('INSERT INTO wo_history (work_order_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?)')
    .run(woId, userId, action, detail || null, now());
}
function notify(userIds, kind, title, body, link) {
  const ins = db.prepare('INSERT INTO notifications (user_id,kind,title,body,link,created_at) VALUES (?,?,?,?,?,?)');
  for (const uid of [].concat(userIds).filter(Boolean)) ins.run(uid, kind, title, body || null, link || null, now());
}
function mgmtIds() { return db.prepare(`SELECT id FROM users WHERE role IN ('owner','manager') AND active=1`).all().map(r => r.id); }
function setting(key, def) { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return r ? r.value : def; }
function nextWONumber() {
  const r = db.prepare(`SELECT number FROM work_orders ORDER BY id DESC LIMIT 1`).get();
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

// ---------- Preventive maintenance generation ----------
function generatePMWorkOrders() {
  const due = db.prepare(`SELECT s.*, p.name AS property_name FROM pm_schedules s JOIN properties p ON p.id=s.property_id
    WHERE s.active=1 AND s.next_due <= date('now','+7 days')`).all();
  const mgrs = mgmtIds();
  for (const s of due) {
    const exists = db.prepare(`SELECT id FROM work_orders WHERE pm_schedule_id=? AND status NOT IN ('completed','cancelled')`).get(s.id);
    if (exists) continue;
    const num = nextWONumber();
    const id = db.prepare(`INSERT INTO work_orders (number,property_id,asset_id,category,title,description,instructions,priority,status,due_date,estimated_minutes,source,pm_schedule_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(num, s.property_id, s.asset_id, s.category, s.title, 'Auto-generated from preventive maintenance schedule.',
        s.instructions, 'normal', 'new', s.next_due, s.estimated_minutes || 60, 'preventive', s.id, now()).lastInsertRowid;
    hist(id, null, 'created', 'Generated from preventive maintenance schedule');
    notify(mgrs, 'pm_due', 'Preventive maintenance due', `${s.title} — ${s.property_name} (due ${s.next_due}). ${num} created.`, '#/work-orders/' + id);
  }
  return due.length;
}

// =====================================================================
// AUTH
// =====================================================================
router.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get((email || '').toLowerCase().trim());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect' });
  req.session.userId = u.id;
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role, vendor_id: u.vendor_id });
});
router.post('/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
router.get('/auth/me', (req, res) => {
  const u = me(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role, vendor_id: u.vendor_id });
});

router.use(requireAuth);

// =====================================================================
// DASHBOARD (owner / manager)
// =====================================================================
router.get('/dashboard', requireRole('owner', 'manager'), (req, res) => {
  const open = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE status IN ${OPEN_STATUSES}`).get().c;
  const urgent = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE status IN ${OPEN_STATUSES} AND priority IN ('emergency','high')`).get().c;
  const overdue = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE status IN ${OPEN_STATUSES} AND due_date < date('now')`).get().c;
  const completedMonth = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE status='completed' AND completed_at >= date('now','start of month')`).get().c;
  const spendMonth = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE incurred_on >= date('now','start of month')`).get().s;
  const spendPrev = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE incurred_on >= date('now','start of month','-1 month') AND incurred_on < date('now','start of month')`).get().s;
  const spendYTD = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE incurred_on >= date('now','start of year')`).get().s;
  const avgDays = db.prepare(`SELECT AVG(julianday(completed_at)-julianday(created_at)) d FROM work_orders WHERE status='completed' AND completed_at >= datetime('now','-90 days')`).get().d;

  const statusCounts = {};
  db.prepare(`SELECT status, COUNT(*) c FROM work_orders WHERE status NOT IN ('cancelled') GROUP BY status`).all()
    .forEach(r => statusCounts[r.status] = r.c);

  const needsAttention = [];
  db.prepare(`${WO_SELECT} WHERE w.priority='emergency' AND w.status IN ${OPEN_STATUSES}`).all()
    .forEach(w => needsAttention.push({ type: 'emergency', title: `Emergency: ${w.title}`, sub: `${w.property_name}${w.unit_label ? ' · Unit ' + w.unit_label : ''}`, link: '#/work-orders/' + w.id }));
  db.prepare(`SELECT a.*, w.title, w.id AS wo_id, u.name AS req_name FROM approvals a JOIN work_orders w ON w.id=a.work_order_id JOIN users u ON u.id=a.requested_by WHERE a.status='pending'`).all()
    .forEach(a => needsAttention.push({ type: 'approval', title: `Approval requested: $${a.amount.toLocaleString()}`, sub: `${a.req_name} — ${a.title}`, link: '#/work-orders/' + a.wo_id, approval_id: a.id }));
  db.prepare(`${WO_SELECT} WHERE w.status IN ${OPEN_STATUSES} AND w.due_date < date('now') ORDER BY w.due_date LIMIT 6`).all()
    .forEach(w => needsAttention.push({ type: 'overdue', title: `Overdue: ${w.title}`, sub: `${w.property_name} · due ${w.due_date}`, link: '#/work-orders/' + w.id }));
  db.prepare(`${WO_SELECT} WHERE w.status='waiting_parts'`).all()
    .forEach(w => needsAttention.push({ type: 'parts', title: `Waiting for parts: ${w.title}`, sub: w.property_name, link: '#/work-orders/' + w.id }));
  repeatRepairs().forEach(r => needsAttention.push({ type: 'repeat', title: `Repeat repair: ${r.category} at ${r.property}`, sub: `${r.count} calls / 6 mo · $${r.total_spent.toLocaleString()} spent`, link: '#/properties/' + r.property_id }));

  // spending by property (YTD)
  const spendByProperty = db.prepare(`SELECT p.id, p.name, COALESCE(SUM(e.amount),0) total,
      (SELECT COUNT(*) FROM units un WHERE un.property_id=p.id) unit_count
    FROM properties p LEFT JOIN expenses e ON e.property_id=p.id AND e.incurred_on >= date('now','start of year')
    WHERE p.active=1 GROUP BY p.id ORDER BY total DESC`).all()
    .map(r => ({ ...r, total: +r.total.toFixed(2), per_unit: r.unit_count ? +(r.total / r.unit_count).toFixed(2) : 0 }));

  // problem properties: score by 90-day WO count + spend + repeats
  const repeats = repeatRepairs();
  const problems = db.prepare(`SELECT p.id, p.name, p.address,
      (SELECT COUNT(*) FROM work_orders w WHERE w.property_id=p.id AND w.created_at >= datetime('now','-90 days') AND w.source!='preventive') wo_90,
      (SELECT COALESCE(SUM(amount),0) FROM expenses e WHERE e.property_id=p.id AND e.incurred_on >= date('now','-90 days')) spend_90
    FROM properties p WHERE p.active=1`).all()
    .map(p => ({ ...p, repeats: repeats.filter(r => r.property_id === p.id).length,
      spend_90: +p.spend_90.toFixed(2) }))
    .filter(p => p.wo_90 >= 3 || p.spend_90 > 800 || p.repeats > 0)
    .sort((a, b) => (b.wo_90 + b.repeats * 3) - (a.wo_90 + a.repeats * 3))
    .slice(0, 5);

  res.json({
    stats: {
      open, urgent, overdue, completed_month: completedMonth,
      spend_month: +spendMonth.toFixed(2), spend_prev_month: +spendPrev.toFixed(2), spend_ytd: +spendYTD.toFixed(2),
      avg_completion_days: avgDays ? +avgDays.toFixed(1) : null
    },
    status_counts: statusCounts,
    needs_attention: needsAttention,
    spend_by_property: spendByProperty,
    problem_properties: problems
  });
});

// =====================================================================
// PROPERTIES / UNITS / ASSETS
// =====================================================================
router.get('/properties', requireRole('owner', 'manager'), (req, res) => {
  const rows = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM units u WHERE u.property_id=p.id) unit_count,
      (SELECT COUNT(*) FROM work_orders w WHERE w.property_id=p.id AND w.status IN ${OPEN_STATUSES}) open_wos,
      (SELECT COALESCE(SUM(amount),0) FROM expenses e WHERE e.property_id=p.id AND e.incurred_on >= date('now','start of year')) ytd_cost
    FROM properties p WHERE p.active=1 ORDER BY p.name`).all();
  res.json(rows.map(p => ({ ...p, ytd_cost: +p.ytd_cost.toFixed(2), health: propertyHealth(p.id).score })));
});

router.post('/properties', requireRole('owner', 'manager'), (req, res) => {
  const { name, address, city, state, zip, type, year_built, notes } = req.body;
  if (!name || !address) return res.status(400).json({ error: 'Name and address are required' });
  const id = db.prepare(`INSERT INTO properties (name,address,city,state,zip,type,year_built,notes) VALUES (?,?,?,?,?,?,?,?)`)
    .run(name, address, city || null, state || null, zip || null, type || null, year_built || null, notes || null).lastInsertRowid;
  res.json({ id });
});

router.get('/properties/:id', requireRole('owner', 'manager'), (req, res) => {
  const p = db.prepare('SELECT * FROM properties WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Property not found' });
  const units = db.prepare('SELECT * FROM units WHERE property_id=? ORDER BY label').all(p.id);
  const openWos = db.prepare(`${WO_SELECT} WHERE w.property_id=? AND w.status IN ${OPEN_STATUSES} ORDER BY w.priority='emergency' DESC, w.due_date`).all(p.id);
  const history = db.prepare(`${WO_SELECT} WHERE w.property_id=? AND w.status IN ('completed','cancelled') ORDER BY w.completed_at DESC LIMIT 100`).all(p.id);
  const assets = db.prepare('SELECT * FROM assets WHERE property_id=?').all(p.id);
  const pm = db.prepare('SELECT * FROM pm_schedules WHERE property_id=? AND active=1 ORDER BY next_due').all(p.id);
  const expenses = db.prepare(`SELECT e.*, w.number AS wo_number, w.title AS wo_title FROM expenses e LEFT JOIN work_orders w ON w.id=e.work_order_id WHERE e.property_id=? ORDER BY e.incurred_on DESC LIMIT 100`).all(p.id);
  const photos = db.prepare(`SELECT * FROM photos WHERE property_id=? ORDER BY created_at DESC LIMIT 60`).all(p.id);
  const inspections = db.prepare(`SELECT i.*, u.name AS inspector FROM inspections i LEFT JOIN users u ON u.id=i.inspected_by WHERE i.property_id=? ORDER BY inspected_on DESC`).all(p.id);
  const health = propertyHealth(p.id);
  const spendYTD = expenses.filter(e => e.incurred_on >= new Date().getFullYear() + '-01-01').reduce((s, e) => s + e.amount, 0);
  res.json({ property: p, units, open_wos: openWos, history, assets, pm, expenses, photos, inspections, health,
    ytd_cost: +spendYTD.toFixed(2) });
});

router.patch('/properties/:id', requireRole('owner', 'manager'), (req, res) => {
  const fields = ['name', 'address', 'city', 'state', 'zip', 'type', 'year_built', 'notes', 'active'];
  const sets = [], vals = [];
  for (const f of fields) if (f in req.body) { sets.push(`${f}=?`); vals.push(req.body[f]); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE properties SET ${sets.join(',')} WHERE id=?`).run(...vals);
  res.json({ ok: true });
});

router.post('/properties/:id/units', requireRole('owner', 'manager'), (req, res) => {
  const { label, beds, baths, sqft } = req.body;
  if (!label) return res.status(400).json({ error: 'Unit label is required' });
  const id = db.prepare(`INSERT INTO units (property_id,label,beds,baths,sqft) VALUES (?,?,?,?,?)`)
    .run(req.params.id, label, beds || null, baths || null, sqft || null).lastInsertRowid;
  res.json({ id });
});

router.post('/properties/:id/assets', requireRole('owner', 'manager'), (req, res) => {
  const b = req.body;
  if (!b.category || !b.name) return res.status(400).json({ error: 'Category and name are required' });
  const id = db.prepare(`INSERT INTO assets (property_id,unit_id,category,name,manufacturer,model,serial,install_date,warranty_expires,purchase_price,useful_life_years,replacement_cost,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.params.id, b.unit_id || null, b.category, b.name, b.manufacturer || null, b.model || null, b.serial || null,
      b.install_date || null, b.warranty_expires || null, b.purchase_price || null, b.useful_life_years || null,
      b.replacement_cost || null, b.notes || null).lastInsertRowid;
  res.json({ id });
});

// =====================================================================
// MAINTENANCE REQUESTS
// =====================================================================
router.get('/requests', requireRole('owner', 'manager'), (req, res) => {
  const rows = db.prepare(`SELECT r.*, p.name AS property_name, u.label AS unit_label
    FROM requests r JOIN properties p ON p.id=r.property_id LEFT JOIN units u ON u.id=r.unit_id
    ORDER BY r.status='open' DESC, r.created_at DESC`).all();
  res.json(rows);
});
router.post('/requests', (req, res) => {
  const b = req.body;
  if (!b.property_id || !b.category || !b.description) return res.status(400).json({ error: 'Property, category, and description are required' });
  const id = db.prepare(`INSERT INTO requests (property_id,unit_id,category,description,priority,reported_by,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(b.property_id, b.unit_id || null, b.category, b.description, b.priority || 'normal', b.reported_by || req.user.name, req.user.id, now()).lastInsertRowid;
  if (b.priority === 'emergency' || b.priority === 'high') {
    const p = db.prepare('SELECT name FROM properties WHERE id=?').get(b.property_id);
    notify(mgmtIds(), 'request', `${b.priority === 'emergency' ? 'Emergency' : 'Urgent'} request: ${b.category}`, `${p.name} — ${b.description.slice(0, 120)}`, '#/maintenance');
  }
  res.json({ id });
});
router.post('/requests/:id/convert', requireRole('owner', 'manager'), (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  const num = nextWONumber();
  const woId = db.prepare(`INSERT INTO work_orders (number,property_id,unit_id,category,title,description,priority,status,source,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(num, r.property_id, r.unit_id, r.category, req.body.title || r.description.slice(0, 80), r.description, r.priority, 'new', 'request', req.user.id, now()).lastInsertRowid;
  db.prepare(`UPDATE requests SET status='converted', work_order_id=? WHERE id=?`).run(woId, r.id);
  hist(woId, req.user.id, 'created', `Converted from request #${r.id}`);
  res.json({ id: woId, number: num });
});
router.post('/requests/:id/dismiss', requireRole('owner', 'manager'), (req, res) => {
  db.prepare(`UPDATE requests SET status='dismissed' WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// =====================================================================
// WORK ORDERS
// =====================================================================
router.get('/work-orders', (req, res) => {
  let where = [], vals = [];
  const u = req.user;
  if (u.role === 'technician') { where.push('w.assigned_user_id=?'); vals.push(u.id); }
  if (u.role === 'vendor') { where.push('w.assigned_vendor_id=?'); vals.push(u.vendor_id); }
  if (req.query.status) { where.push('w.status=?'); vals.push(req.query.status); }
  if (req.query.property_id) { where.push('w.property_id=?'); vals.push(req.query.property_id); }
  if (req.query.open === '1') where.push(`w.status IN ${OPEN_STATUSES}`);
  if (req.query.today === '1') where.push(`(w.scheduled_date = date('now') OR (w.status IN ${OPEN_STATUSES} AND (w.scheduled_date < date('now') OR w.priority='emergency')))`);
  const sql = `${WO_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE w.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             w.due_date IS NULL, w.due_date, w.created_at DESC LIMIT 300`;
  res.json(db.prepare(sql).all(...vals));
});

router.post('/work-orders', requireRole('owner', 'manager'), (req, res) => {
  const b = req.body;
  if (!b.property_id || !b.title || !b.category) return res.status(400).json({ error: 'Property, title, and category are required' });
  const num = nextWONumber();
  const status = (b.assigned_user_id || b.assigned_vendor_id) ? (b.scheduled_date ? 'scheduled' : 'assigned') : 'new';
  const id = db.prepare(`INSERT INTO work_orders (number,property_id,unit_id,asset_id,category,title,description,instructions,priority,status,assigned_user_id,assigned_vendor_id,scheduled_date,due_date,estimated_minutes,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(num, b.property_id, b.unit_id || null, b.asset_id || null, b.category, b.title, b.description || null, b.instructions || null,
      b.priority || 'normal', status, b.assigned_user_id || null, b.assigned_vendor_id || null,
      b.scheduled_date || null, b.due_date || null, b.estimated_minutes || 60, req.user.id, now()).lastInsertRowid;
  hist(id, req.user.id, 'created', 'Work order created');
  if (b.assigned_user_id) {
    hist(id, req.user.id, 'assigned', 'Assigned to technician');
    const p = db.prepare('SELECT name FROM properties WHERE id=?').get(b.property_id);
    notify(b.assigned_user_id, 'assigned', 'New job assigned', `${b.title} — ${p.name}`, '#/work-orders/' + id);
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
  const activeTimer = time.find(t => !t.ended_at && t.user_id === req.user.id) || null;
  res.json({ wo: full, photos, comments, materials, expenses, time, history, approvals, active_timer: activeTimer,
    threshold: +setting('approval_threshold', 150) });
});

router.patch('/work-orders/:id', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const u = req.user;
  const b = req.body;

  // Status changes — technicians/vendors limited to workflow statuses on their own jobs
  if (b.status && b.status !== w.status) {
    const techAllowed = ['in_progress', 'waiting_parts', 'waiting_approval', 'completed', 'scheduled'];
    if (!isMgmt(u) && !techAllowed.includes(b.status)) return res.status(403).json({ error: 'Not permitted for your role' });
    const sets = { status: b.status };
    if (b.status === 'completed') {
      sets.completed_at = now();
      if (b.completion_notes) sets.completion_notes = b.completion_notes;
      // close any running timer
      const open = db.prepare('SELECT * FROM time_logs WHERE work_order_id=? AND ended_at IS NULL').all(w.id);
      for (const t of open) {
        const mins = Math.max(1, Math.round((Date.now() - new Date(t.started_at.replace(' ', 'T')).getTime()) / 60000));
        db.prepare('UPDATE time_logs SET ended_at=?, minutes=? WHERE id=?').run(now(), mins, t.id);
      }
      // advance PM schedule
      if (w.pm_schedule_id) {
        const s = db.prepare('SELECT * FROM pm_schedules WHERE id=?').get(w.pm_schedule_id);
        if (s) db.prepare('UPDATE pm_schedules SET next_due=date(?, ?) WHERE id=?')
          .run(now().slice(0, 10), `+${s.interval_days} days`, s.id);
      }
      notify(mgmtIds(), 'completed', `Job completed: ${w.title}`, `${w.number} completed by ${u.name}.`, '#/work-orders/' + w.id);
    }
    if (b.status === 'in_progress' && !db.prepare('SELECT id FROM time_logs WHERE work_order_id=? AND user_id=? AND ended_at IS NULL').get(w.id, u.id)) {
      db.prepare('INSERT INTO time_logs (work_order_id,user_id,kind,started_at) VALUES (?,?,?,?)').run(w.id, u.id, 'work', now());
    }
    const keys = Object.keys(sets);
    db.prepare(`UPDATE work_orders SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => sets[k]), w.id);
    hist(w.id, u.id, 'status_changed', `Status → ${b.status.replace('_', ' ')}`);
  }

  // Management-only edits
  if (isMgmt(u)) {
    const fields = ['title', 'description', 'instructions', 'priority', 'category', 'scheduled_date', 'due_date', 'estimated_minutes', 'unit_id', 'asset_id'];
    const sets = [], vals = [];
    for (const f of fields) if (f in b) { sets.push(`${f}=?`); vals.push(b[f]); }
    if ('assigned_user_id' in b || 'assigned_vendor_id' in b) {
      sets.push('assigned_user_id=?', 'assigned_vendor_id=?');
      vals.push(b.assigned_user_id || null, b.assigned_vendor_id || null);
      if (w.status === 'new') { sets.push(`status='assigned'`); }
      hist(w.id, u.id, 'assigned', 'Assignment updated');
      if (b.assigned_user_id) notify(b.assigned_user_id, 'assigned', 'Job assigned to you', `${w.number} — ${w.title}`, '#/work-orders/' + w.id);
    }
    if (sets.length) {
      vals.push(w.id);
      db.prepare(`UPDATE work_orders SET ${sets.join(',')} WHERE id=?`).run(...vals);
      if (!('assigned_user_id' in b)) hist(w.id, u.id, 'edited', 'Details updated');
    }
  }
  res.json({ ok: true });
});

// --- workflow sub-resources ---
router.post('/work-orders/:id/photos', upload.single('photo'), (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  if (!req.file) return res.status(400).json({ error: 'No photo received' });
  const kind = ['before', 'after', 'receipt', 'general'].includes(req.body.kind) ? req.body.kind : 'general';
  const id = db.prepare(`INSERT INTO photos (work_order_id,property_id,kind,url,caption,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(w.id, w.property_id, kind, '/uploads/' + req.file.filename, req.body.caption || null, req.user.id, now()).lastInsertRowid;
  hist(w.id, req.user.id, 'photo', `${kind} photo added`);
  res.json({ id, url: '/uploads/' + req.file.filename, kind });
});

router.post('/work-orders/:id/comments', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  if (!req.body.body) return res.status(400).json({ error: 'Comment text is required' });
  const id = db.prepare('INSERT INTO comments (work_order_id,user_id,body,is_voice_note,created_at) VALUES (?,?,?,?,?)')
    .run(w.id, req.user.id, req.body.body, req.body.is_voice_note ? 1 : 0, now()).lastInsertRowid;
  res.json({ id });
});

router.post('/work-orders/:id/materials', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const { name, qty, unit_cost } = req.body;
  if (!name) return res.status(400).json({ error: 'Material name is required' });
  const id = db.prepare('INSERT INTO materials (work_order_id,name,qty,unit_cost,added_by,created_at) VALUES (?,?,?,?,?,?)')
    .run(w.id, name, +qty || 1, +unit_cost || 0, req.user.id, now()).lastInsertRowid;
  // materials automatically create an expense line
  const amount = +((+qty || 1) * (+unit_cost || 0)).toFixed(2);
  if (amount > 0) db.prepare(`INSERT INTO expenses (work_order_id,property_id,user_id,category,description,amount,incurred_on,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(w.id, w.property_id, req.user.id, 'materials', name, amount, now().slice(0, 10), now());
  hist(w.id, req.user.id, 'material', `${name} — $${amount.toFixed(2)}`);
  res.json({ id });
});

router.post('/work-orders/:id/expenses', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const { category, description, amount } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount is required' });
  const id = db.prepare(`INSERT INTO expenses (work_order_id,property_id,user_id,vendor_id,category,description,amount,incurred_on,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(w.id, w.property_id, req.user.id, req.user.vendor_id || null, category || 'other', description || null, +amount, now().slice(0, 10), now()).lastInsertRowid;
  const threshold = +setting('approval_threshold', 150);
  const total = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE work_order_id=?').get(w.id).s;
  if (+amount > threshold * 2) notify(mgmtIds(), 'high_cost', 'Unusually high expense recorded', `$${(+amount).toLocaleString()} on ${w.number} — ${w.title}`, '#/work-orders/' + w.id);
  res.json({ id, wo_total: +total.toFixed(2) });
});

router.post('/work-orders/:id/time/start', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const kind = req.body.kind === 'travel' ? 'travel' : 'work';
  const running = db.prepare('SELECT id FROM time_logs WHERE work_order_id=? AND user_id=? AND ended_at IS NULL').get(w.id, req.user.id);
  if (running) return res.status(400).json({ error: 'A timer is already running on this job' });
  const id = db.prepare('INSERT INTO time_logs (work_order_id,user_id,kind,started_at) VALUES (?,?,?,?)').run(w.id, req.user.id, kind, now()).lastInsertRowid;
  if (w.status === 'assigned' || w.status === 'scheduled' || w.status === 'new') {
    db.prepare(`UPDATE work_orders SET status='in_progress' WHERE id=?`).run(w.id);
    hist(w.id, req.user.id, 'status_changed', 'Status → in progress');
  }
  res.json({ id, started_at: now() });
});
router.post('/work-orders/:id/time/stop', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const t = db.prepare('SELECT * FROM time_logs WHERE work_order_id=? AND user_id=? AND ended_at IS NULL').get(w.id, req.user.id);
  if (!t) return res.status(400).json({ error: 'No timer is running' });
  const mins = Math.max(1, Math.round((Date.now() - new Date(t.started_at.replace(' ', 'T')).getTime()) / 60000));
  db.prepare('UPDATE time_logs SET ended_at=?, minutes=? WHERE id=?').run(now(), mins, t.id);
  res.json({ minutes: mins });
});

// --- approvals ---
router.post('/work-orders/:id/approvals', (req, res) => {
  const w = getWOOr404(req, res); if (!w) return;
  const { amount, reason } = req.body;
  if (!amount) return res.status(400).json({ error: 'Estimated amount is required' });
  const id = db.prepare('INSERT INTO approvals (work_order_id,requested_by,amount,reason,created_at) VALUES (?,?,?,?,?)')
    .run(w.id, req.user.id, +amount, reason || null, now()).lastInsertRowid;
  db.prepare(`UPDATE work_orders SET status='waiting_approval' WHERE id=?`).run(w.id);
  hist(w.id, req.user.id, 'approval_requested', `$${(+amount).toLocaleString()} — ${reason || ''}`);
  notify(mgmtIds(), 'approval', `Approval requested: $${(+amount).toLocaleString()}`, `${req.user.name} — ${w.title} (${w.number})`, '#/work-orders/' + w.id);
  res.json({ id });
});
router.patch('/approvals/:id', requireRole('owner', 'manager'), (req, res) => {
  const a = db.prepare('SELECT * FROM approvals WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Approval not found' });
  const decision = req.body.decision; // approved | declined | info_requested
  if (!['approved', 'declined', 'info_requested'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
  db.prepare('UPDATE approvals SET status=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?')
    .run(decision, req.user.id, req.body.note || null, now(), a.id);
  const w = db.prepare('SELECT * FROM work_orders WHERE id=?').get(a.work_order_id);
  if (decision === 'approved') {
    db.prepare(`UPDATE work_orders SET status=CASE WHEN status='waiting_approval' THEN 'in_progress' ELSE status END WHERE id=?`).run(w.id);
  }
  hist(w.id, req.user.id, 'approval_' + decision, req.body.note || null);
  const label = { approved: 'Approved', declined: 'Declined', info_requested: 'More information requested' }[decision];
  notify(a.requested_by, 'approval_decision', `${label}: $${a.amount.toLocaleString()}`, `${w.number} — ${w.title}${req.body.note ? ' · ' + req.body.note : ''}`, '#/work-orders/' + w.id);
  res.json({ ok: true });
});

// =====================================================================
// PREVENTIVE MAINTENANCE
// =====================================================================
router.get('/pm', requireRole('owner', 'manager'), (req, res) => {
  const rows = db.prepare(`SELECT s.*, p.name AS property_name FROM pm_schedules s JOIN properties p ON p.id=s.property_id WHERE s.active=1 ORDER BY s.next_due`).all();
  res.json(rows);
});
router.post('/pm', requireRole('owner', 'manager'), (req, res) => {
  const b = req.body;
  if (!b.property_id || !b.title || !b.interval_days || !b.next_due) return res.status(400).json({ error: 'Property, title, interval, and next due date are required' });
  const id = db.prepare(`INSERT INTO pm_schedules (property_id,asset_id,title,category,interval_days,next_due,estimated_minutes,instructions)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(b.property_id, b.asset_id || null, b.title, b.category || 'General', +b.interval_days, b.next_due, b.estimated_minutes || 60, b.instructions || null).lastInsertRowid;
  res.json({ id });
});
router.post('/pm/generate', requireRole('owner', 'manager'), (req, res) => {
  res.json({ generated: generatePMWorkOrders() });
});

// =====================================================================
// CALENDAR
// =====================================================================
router.get('/calendar', requireRole('owner', 'manager'), (req, res) => {
  const wos = db.prepare(`${WO_SELECT} WHERE w.scheduled_date IS NOT NULL AND w.status NOT IN ('completed','cancelled')`).all();
  const pm = db.prepare(`SELECT s.*, p.name AS property_name FROM pm_schedules s JOIN properties p ON p.id=s.property_id WHERE s.active=1 AND s.next_due <= date('now','+90 days')`).all();
  res.json({ work_orders: wos, pm });
});

// =====================================================================
// TEAM / VENDORS / ANALYTICS
// =====================================================================
router.get('/team', requireRole('owner', 'manager'), (req, res) => res.json(techScorecards()));
router.get('/vendors', requireRole('owner', 'manager'), (req, res) => {
  const rows = db.prepare(`SELECT v.*,
    (SELECT COUNT(*) FROM work_orders w WHERE w.assigned_vendor_id=v.id AND w.status IN ${OPEN_STATUSES}) open_wos,
    (SELECT COUNT(*) FROM work_orders w WHERE w.assigned_vendor_id=v.id AND w.status='completed') completed_wos,
    (SELECT COALESCE(SUM(amount),0) FROM expenses e WHERE e.vendor_id=v.id AND e.incurred_on >= date('now','start of year')) ytd_spend
    FROM vendors v WHERE v.active=1`).all();
  res.json(rows.map(v => ({ ...v, ytd_spend: +v.ytd_spend.toFixed(2) })));
});
router.post('/vendors', requireRole('owner', 'manager'), (req, res) => {
  const b = req.body;
  if (!b.company) return res.status(400).json({ error: 'Company name is required' });
  const id = db.prepare('INSERT INTO vendors (company,trade,contact_name,phone,email,notes) VALUES (?,?,?,?,?,?)')
    .run(b.company, b.trade || null, b.contact_name || null, b.phone || null, b.email || null, b.notes || null).lastInsertRowid;
  res.json({ id });
});

router.get('/analytics', requireRole('owner', 'manager'), (req, res) => {
  const monthly = db.prepare(`SELECT strftime('%Y-%m', incurred_on) m, SUM(amount) total FROM expenses
    WHERE incurred_on >= date('now','-6 months','start of month') GROUP BY m ORDER BY m`).all();
  const byCategory = db.prepare(`SELECT w.category, COUNT(DISTINCT w.id) wos, COALESCE(SUM(e.amount),0) total
    FROM work_orders w LEFT JOIN expenses e ON e.work_order_id=w.id
    WHERE w.created_at >= datetime('now','-180 days') GROUP BY w.category ORDER BY total DESC`).all();
  res.json({
    monthly_spend: monthly.map(r => ({ ...r, total: +r.total.toFixed(2) })),
    by_category: byCategory.map(r => ({ ...r, total: +r.total.toFixed(2) })),
    repeat_repairs: repeatRepairs(),
    capex: capexForecast(24),
    team: techScorecards()
  });
});

// =====================================================================
// NOTIFICATIONS / SEARCH / SETTINGS / META
// =====================================================================
router.get('/notifications', (req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 60').all(req.user.id));
});
router.post('/notifications/read', (req, res) => {
  if (req.body.id) db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(req.body.id, req.user.id);
  else db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

router.get('/search', requireRole('owner', 'manager'), (req, res) => {
  const q = '%' + (req.query.q || '').trim() + '%';
  if (q === '%%') return res.json({ properties: [], work_orders: [], assets: [], people: [] });
  res.json({
    properties: db.prepare(`SELECT id,name,address FROM properties WHERE (name LIKE ? OR address LIKE ?) AND active=1 LIMIT 6`).all(q, q),
    work_orders: db.prepare(`SELECT w.id,w.number,w.title,w.status,p.name property_name FROM work_orders w JOIN properties p ON p.id=w.property_id
      WHERE w.title LIKE ? OR w.number LIKE ? OR w.category LIKE ? OR w.description LIKE ? ORDER BY w.created_at DESC LIMIT 8`).all(q, q, q, q),
    assets: db.prepare(`SELECT a.id,a.name,a.category,a.property_id,p.name property_name FROM assets a JOIN properties p ON p.id=a.property_id
      WHERE a.name LIKE ? OR a.category LIKE ? OR a.manufacturer LIKE ? OR a.model LIKE ? LIMIT 6`).all(q, q, q, q),
    people: db.prepare(`SELECT id,name,role FROM users WHERE name LIKE ? AND active=1 LIMIT 5`).all(q)
  });
});

router.get('/meta', (req, res) => {
  const out = { threshold: +setting('approval_threshold', 150) };
  if (isMgmt(req.user)) {
    out.properties = db.prepare(`SELECT id,name FROM properties WHERE active=1 ORDER BY name`).all();
    out.units = db.prepare(`SELECT id,property_id,label FROM units ORDER BY label`).all();
    out.technicians = db.prepare(`SELECT id,name FROM users WHERE role='technician' AND active=1`).all();
    out.vendors = db.prepare(`SELECT id,company FROM vendors WHERE active=1`).all();
    out.assets = db.prepare(`SELECT id,property_id,name FROM assets`).all();
    out.categories = ['HVAC', 'Plumbing', 'Electrical', 'Appliance', 'Roofing', 'Pest', 'Safety', 'General'];
  }
  res.json(out);
});

router.patch('/settings', requireRole('owner', 'manager'), (req, res) => {
  if (req.body.approval_threshold != null)
    db.prepare(`INSERT INTO settings (key,value) VALUES ('approval_threshold',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(String(+req.body.approval_threshold));
  res.json({ ok: true });
});

module.exports = { router, generatePMWorkOrders };
