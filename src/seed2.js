// seed2.js — V2 supplemental demo data. Idempotent. Runs after the V1 seed + migration backfill.
const bcrypt = require('bcryptjs');
const db = require('./db');
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const dateAhead = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function seedV2() {
  const org1 = db.prepare(`SELECT id FROM organizations WHERE name='Pine Ridge Residential'`).get();
  if (!org1) return; // fresh DB not seeded yet
  const O = org1.id;
  const hash = bcrypt.hashSync('demo123', 10);

  // Backfill safety: any seed rows missing org id
  for (const t of ['users','vendors','properties','units','requests','work_orders','assets','expenses','pm_schedules',
    'approvals','notifications','inspections','photos','comments','materials','time_logs','wo_history'])
    db.prepare(`UPDATE ${t} SET organization_id=? WHERE organization_id IS NULL`).run(O);
  db.prepare(`UPDATE settings SET organization_id=? WHERE organization_id IS NULL`).run(O);

  // Approval tiers + migrate old single threshold
  const has = k => db.prepare('SELECT 1 FROM settings WHERE organization_id=? AND key=?').get(O, k);
  if (!has('approval_t1')) db.prepare('INSERT INTO settings (organization_id,key,value) VALUES (?,?,?)').run(O, 'approval_t1', '150');
  if (!has('approval_t2')) db.prepare('INSERT INTO settings (organization_id,key,value) VALUES (?,?,?)').run(O, 'approval_t2', '500');

  // Viewer user
  if (!db.prepare(`SELECT 1 FROM users WHERE email='viewer@demo.com'`).get())
    db.prepare(`INSERT INTO users (organization_id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,'viewer',?)`)
      .run(O, 'Pat Ellison (Investor)', 'viewer@demo.com', hash, now());

  // Default completion requirements: sensible per-category story
  const cr = (cat, b, a, n, m, r, t) => {
    if (!db.prepare('SELECT 1 FROM completion_requirements WHERE organization_id=? AND category=?').get(O, cat))
      db.prepare(`INSERT INTO completion_requirements (organization_id,category,before_photo,after_photo,completion_notes,materials,receipt,time_recorded)
        VALUES (?,?,?,?,?,?,?,?)`).run(O, cat, b, a, n, m, r, t);
  };
  cr('*', 0, 1, 1, 0, 0, 1);
  cr('Plumbing', 1, 1, 1, 0, 0, 1);
  cr('HVAC', 1, 1, 1, 0, 0, 1);
  cr('Pest', 0, 0, 1, 0, 0, 0);

  // Vendor quotes on the HVAC replacement decision WO
  const rvWO = db.prepare(`SELECT id FROM work_orders WHERE organization_id=? AND title LIKE 'HVAC replacement decision%'`).get(O);
  if (rvWO && !db.prepare('SELECT 1 FROM vendor_quotes WHERE work_order_id=?').get(rvWO.id)) {
    const vHVAC = db.prepare(`SELECT id FROM vendors WHERE organization_id=? AND company='Coastal HVAC Pros'`).get(O);
    const vRoof = db.prepare(`SELECT id FROM vendors WHERE organization_id=? AND company LIKE 'Duval%'`).get(O);
    const mgr = db.prepare(`SELECT id FROM users WHERE email='manager@demo.com'`).get(O ? {} : {}) || db.prepare(`SELECT id FROM users WHERE email='manager@demo.com'`).get();
    if (vHVAC) db.prepare(`INSERT INTO vendor_quotes (organization_id,work_order_id,vendor_id,status,price,scope,est_start,est_complete,notes,requested_by,submitted_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(O, rvWO.id, vHVAC.id, 'submitted', 6200, '2.5-ton 14.3 SEER2 Goodman split system, new pad, line set flush, permit included',
        dateAhead(5), dateAhead(6), 'Can expedite if unit fails completely', mgr ? mgr.id : null, now(), now());
    if (vRoof) db.prepare(`INSERT INTO vendor_quotes (organization_id,work_order_id,vendor_id,status,requested_by,created_at)
      VALUES (?,?,?,?,?,?)`).run(O, rvWO.id, vRoof.id, 'requested', mgr ? mgr.id : null, now());
  }

  // Enrich one open request with V2 intake fields (tenant-reported, with access details)
  const req1 = db.prepare(`SELECT id FROM requests WHERE organization_id=? AND status='open' AND description LIKE '%Toilet rocks%'`).get(O);
  if (req1) db.prepare(`UPDATE requests SET reporter_type='tenant', reporter_phone='(904) 555-0188',
    access_instructions='Lockbox 2214 on porch rail', permission_to_enter=1, pets='Small dog (friendly)',
    preferred_availability='Weekdays after 3pm', flag_water=1 WHERE id=?`).run(req1.id);

  // Second organization — proves multi-tenant isolation. Completely separate data.
  if (!db.prepare(`SELECT 1 FROM organizations WHERE name='Bayview Holdings'`).get()) {
    const O2 = db.prepare(`INSERT INTO organizations (name,owner_name,email,approx_units,primary_market)
      VALUES ('Bayview Holdings','Grace Kim','owner@bayview.demo',12,'Tampa, FL')`).run().lastInsertRowid;
    const gk = db.prepare(`INSERT INTO users (organization_id,name,email,password_hash,role,created_at)
      VALUES (?,?,?,?,'owner',?)`).run(O2, 'Grace Kim', 'owner@bayview.demo', hash, now()).lastInsertRowid;
    const p2 = db.prepare(`INSERT INTO properties (organization_id,name,address,city,state,zip,type,year_built)
      VALUES (?,?,?,?,?,?,?,?)`).run(O2, 'Bayshore Duplex', '412 W Bay Vista Ave', 'Tampa', 'FL', '33611', 'duplex', 1972).lastInsertRowid;
    db.prepare(`INSERT INTO units (organization_id,property_id,label,beds,baths) VALUES (?,?,?,?,?)`).run(O2, p2, 'A', 2, 1);
    db.prepare(`INSERT INTO units (organization_id,property_id,label,beds,baths) VALUES (?,?,?,?,?)`).run(O2, p2, 'B', 2, 1);
    db.prepare(`INSERT INTO work_orders (organization_id,number,property_id,category,title,priority,status,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(O2, 'WO-1001', p2, 'Plumbing', 'Slow bathroom drain — Unit A', 'normal', 'new', gk, now());
    db.prepare('INSERT INTO settings (organization_id,key,value) VALUES (?,?,?)').run(O2, 'approval_t1', '100');
    db.prepare('INSERT INTO settings (organization_id,key,value) VALUES (?,?,?)').run(O2, 'approval_t2', '500');
    db.prepare(`INSERT INTO completion_requirements (organization_id,category,before_photo,after_photo,completion_notes,materials,receipt,time_recorded)
      VALUES (?,'*',0,1,1,0,0,1)`).run(O2);
  }
  console.log('V2 seed supplement applied.');
}

if (require.main === module) seedV2();
module.exports = seedV2;
