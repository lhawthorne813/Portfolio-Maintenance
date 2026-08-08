// seed.js — realistic demo data. Dates are generated relative to "now" so the demo always looks live.
const bcrypt = require('bcryptjs');
const db = require('./db');

function daysAgo(n, hour = 9) {
  const d = new Date(Date.now() - n * 86400000);
  d.setHours(hour, Math.floor(Math.random() * 50), 0, 0);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
function daysAhead(n) { return daysAgo(-n); }
function dateOnly(n) { return daysAgo(n).slice(0, 10); }

function seed(force = false) {
  const has = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (has && !force) return false;
  if (force) {
    const tables = ['owner_digests','integration_runs','webhook_endpoints','sla_policies','automation_policies',
      'technician_profiles','resident_messages','exceptions','automation_events','outbox','durable_jobs','sessions',
      'inspections','notifications','approvals','pm_schedules','time_logs','expenses','materials',
      'comments','photos','wo_history','work_orders','requests','assets','units','properties','users','vendors','settings','vendor_quotes','completion_requirements','invites','notification_prefs','rvr_actions','organizations'];
    db.pragma('foreign_keys = OFF');
    for (const t of tables) db.exec(`DELETE FROM ${t}; DELETE FROM sqlite_sequence WHERE name='${t}';`);
    db.pragma('foreign_keys = ON');
  }

  const hash = bcrypt.hashSync('demo123', 10);

  // ---------- Vendors ----------
  const insVendor = db.prepare(`INSERT INTO vendors (company,trade,contact_name,phone,email) VALUES (?,?,?,?,?)`);
  const vHVAC = insVendor.run('Coastal HVAC Pros', 'HVAC', 'Dana Kelley', '(904) 555-0142', 'dispatch@coastalhvacpros.com').lastInsertRowid;
  const vPlumb = insVendor.run('First Coast Plumbing', 'Plumbing', 'Rob Chastain', '(904) 555-0177', 'service@firstcoastplumbing.com').lastInsertRowid;
  const vRoof = insVendor.run('Duval Roofing & Exteriors', 'Roofing', 'Tina Marsh', '(904) 555-0129', 'office@duvalroofing.com').lastInsertRowid;

  // ---------- Users ----------
  const insUser = db.prepare(`INSERT INTO users (name,email,phone,password_hash,role,vendor_id,hourly_rate) VALUES (?,?,?,?,?,?,?)`);
  const uOwner = insUser.run('Dan Whitfield', 'owner@demo.com', '(904) 555-0101', hash, 'owner', null, 0).lastInsertRowid;
  const uMgr = insUser.run('Maria Santos', 'manager@demo.com', '(904) 555-0102', hash, 'manager', null, 0).lastInsertRowid;
  const uMike = insUser.run('Mike Torres', 'tech@demo.com', '(904) 555-0111', hash, 'technician', null, 32).lastInsertRowid;
  const uJames = insUser.run('James Carter', 'james@demo.com', '(904) 555-0112', hash, 'technician', null, 30).lastInsertRowid;
  const uAlex = insUser.run('Alex Nguyen', 'alex@demo.com', '(904) 555-0113', hash, 'technician', null, 28).lastInsertRowid;
  const uSam = insUser.run('Sam Rivera', 'sam@demo.com', '(904) 555-0114', hash, 'technician', null, 26).lastInsertRowid;
  const uVend = insUser.run('Dana Kelley (Coastal HVAC)', 'vendor@demo.com', '(904) 555-0142', hash, 'vendor', vHVAC, 0).lastInsertRowid;

  db.prepare(`INSERT INTO settings (key,value) VALUES ('approval_threshold','150')`).run();

  // ---------- Properties + Units ----------
  const insProp = db.prepare(`INSERT INTO properties (name,address,city,state,zip,type,year_built,notes) VALUES (?,?,?,?,?,?,?,?)`);
  const insUnit = db.prepare(`INSERT INTO units (property_id,label,beds,baths,sqft,occupied) VALUES (?,?,?,?,?,?)`);

  const props = [
    ['Oak Haven Duplex', '1847 Oak Haven Dr', 'Jacksonville', 'FL', '32210', 'duplex', 1988, 'Aging HVAC on both sides'],
    ['Riverside Quad', '2215 Post St', 'Jacksonville', 'FL', '32204', 'quadplex', 1962, 'Historic district — check permits'],
    ['Murray Hill Duplex', '4519 Kingsbury St', 'Jacksonville', 'FL', '32205', 'duplex', 1954, null],
    ['Springfield Fourplex', '1330 N Pearl St', 'Jacksonville', 'FL', '32206', 'quadplex', 1948, 'Renovated 2019'],
    ['Lakeshore Duplex', '2734 Lakeshore Blvd', 'Jacksonville', 'FL', '32210', 'duplex', 1975, null],
    ['Arlington Triplex', '6822 Merrill Rd', 'Jacksonville', 'FL', '32277', 'small multifamily', 1981, null],
    ['San Marco Duplex', '1912 Naldo Ave', 'Jacksonville', 'FL', '32207', 'duplex', 1957, 'Premium units'],
    ['Westside SFR', '7245 Hyde Grove Ave', 'Jacksonville', 'FL', '32210', 'single-family', 1992, null],
    ['Normandy Fourplex', '8120 Herlong Rd', 'Jacksonville', 'FL', '32210', 'quadplex', 1979, null],
    ['Avondale Duplex', '3627 Valencia Rd', 'Jacksonville', 'FL', '32205', 'duplex', 1941, 'Older plumbing — cast iron'],
    ['Mandarin SFR', '11540 Scott Mill Rd', 'Jacksonville', 'FL', '32223', 'single-family', 2001, null],
    ['Brentwood Triplex', '2109 W 20th St', 'Jacksonville', 'FL', '32209', 'small multifamily', 1968, null],
    ['Beach Blvd Fourplex', '9842 Beach Blvd', 'Jacksonville', 'FL', '32246', 'quadplex', 1985, null],
    ['Ortega Duplex', '4415 Longfellow St', 'Jacksonville', 'FL', '32210', 'duplex', 1963, null],
    ['Northside SFR', '10318 Sibbald Rd', 'Jacksonville', 'FL', '32208', 'single-family', 1996, null],
  ];
  const P = {};
  props.forEach((p, i) => { P[i + 1] = insProp.run(...p).lastInsertRowid; });

  const unitPlans = {
    1: ['A', 'B'], 2: ['1', '2', '3', '4'], 3: ['A', 'B'], 4: ['1', '2', '3', '4'], 5: ['A', 'B'],
    6: ['1', '2', '3'], 7: ['A', 'B'], 8: ['Main'], 9: ['1', '2', '3', '4'], 10: ['A', 'B'],
    11: ['Main'], 12: ['1', '2', '3'], 13: ['1', '2', '3', '4'], 14: ['A', 'B'], 15: ['Main'],
  };
  const U = {}; // U[propIdx] = [unitIds]
  for (const [pi, labels] of Object.entries(unitPlans)) {
    U[pi] = labels.map((l, j) =>
      insUnit.run(P[pi], l, 2 + (j % 2), j % 2 ? 1 : 1.5, 850 + j * 60, j === 2 && pi == 9 ? 0 : 1).lastInsertRowid);
  }

  // ---------- Assets ----------
  const insAsset = db.prepare(`INSERT INTO assets
    (property_id,unit_id,category,name,manufacturer,model,serial,install_date,warranty_expires,purchase_price,useful_life_years,replacement_cost,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const A = {};
  A.oakHvacA = insAsset.run(P[1], U[1][0], 'HVAC', 'HVAC — Unit A', 'Goodman', 'GSX140301', 'GM-88213A', '2012-06-15', '2017-06-15', 3400, 14, 6200, '2.5-ton split system; repeated compressor issues').lastInsertRowid;
  A.oakHvacB = insAsset.run(P[1], U[1][1], 'HVAC', 'HVAC — Unit B', 'Goodman', 'GSX140301', 'GM-88214B', '2013-03-02', '2018-03-02', 3400, 14, 6200, null).lastInsertRowid;
  A.oakWH = insAsset.run(P[1], U[1][0], 'Water Heater', 'Water Heater — Unit A', 'Rheem', 'XE40M06ST45U1', 'RH-40221', '2015-09-10', '2021-09-10', 620, 11, 1400, null).lastInsertRowid;
  A.rivRoof = insAsset.run(P[2], null, 'Roof', 'Shingle Roof', 'GAF', 'Timberline HDZ', null, '2008-04-01', null, 14500, 20, 21000, 'Approaching end of useful life').lastInsertRowid;
  A.rivWH2 = insAsset.run(P[2], U[2][1], 'Water Heater', 'Water Heater — Unit 2', 'A.O. Smith', 'GCR-40', 'AS-77320', '2016-02-14', '2022-02-14', 680, 11, 1450, null).lastInsertRowid;
  A.sprHvac = insAsset.run(P[4], null, 'HVAC', 'HVAC — shared system', 'Trane', 'XR14', 'TR-51102', '2019-05-20', '2029-05-20', 5200, 15, 7800, 'Installed during renovation').lastInsertRowid;
  A.avoPlumb = insAsset.run(P[10], null, 'Plumbing', 'Cast iron main drain', null, null, null, '1941-01-01', null, null, 80, 9500, 'Original stack — recurring backups').lastInsertRowid;
  A.manWH = insAsset.run(P[11], U[11][0], 'Water Heater', 'Water Heater', 'Rheem', 'XE50M06ST45U1', 'RH-50993', '2014-07-22', '2020-07-22', 740, 11, 1500, null).lastInsertRowid;
  A.beaHvac3 = insAsset.run(P[13], U[13][2], 'HVAC', 'HVAC — Unit 3', 'Carrier', '24ACC636', 'CA-30871', '2010-08-11', '2015-08-11', 3900, 15, 6500, null).lastInsertRowid;
  A.norRoof = insAsset.run(P[9], null, 'Roof', 'Shingle Roof', 'Owens Corning', 'Duration', null, '2007-10-01', null, 16800, 20, 24000, null).lastInsertRowid;
  A.wesAppl = insAsset.run(P[8], U[8][0], 'Appliance', 'Dishwasher', 'Whirlpool', 'WDF520PADM', 'WP-11204', '2021-03-18', '2022-03-18', 480, 10, 550, null).lastInsertRowid;
  A.ortPanel = insAsset.run(P[14], null, 'Electrical Panel', 'Main panel — 100A', 'Square D', 'QO', null, '1994-06-01', null, null, 40, 2800, 'Consider 200A upgrade at turnover').lastInsertRowid;

  // ---------- Work orders ----------
  const insWO = db.prepare(`INSERT INTO work_orders
    (number,property_id,unit_id,asset_id,category,title,description,instructions,priority,status,
     assigned_user_id,assigned_vendor_id,scheduled_date,due_date,estimated_minutes,completion_notes,completed_at,source,pm_schedule_id,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insHist = db.prepare(`INSERT INTO wo_history (work_order_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?)`);
  const insMat = db.prepare(`INSERT INTO materials (work_order_id,name,qty,unit_cost,added_by,created_at) VALUES (?,?,?,?,?,?)`);
  const insExp = db.prepare(`INSERT INTO expenses (work_order_id,property_id,user_id,vendor_id,category,description,amount,incurred_on,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const insTime = db.prepare(`INSERT INTO time_logs (work_order_id,user_id,kind,started_at,ended_at,minutes) VALUES (?,?,?,?,?,?)`);
  const insCom = db.prepare(`INSERT INTO comments (work_order_id,user_id,body,is_voice_note,created_at) VALUES (?,?,?,?,?)`);

  let woNum = 1000;
  function wo(o) {
    woNum++;
    const id = insWO.run(
      'WO-' + woNum, o.p, o.u || null, o.asset || null, o.cat, o.title, o.desc || null, o.instr || null,
      o.pri || 'normal', o.status, o.tech || null, o.vendor || null,
      o.sched || null, o.due || null, o.est || 60,
      o.notes || null, o.done || null, o.source || 'manual', null, o.by || uMgr, o.created
    ).lastInsertRowid;
    insHist.run(id, o.by || uMgr, 'created', 'Work order created', o.created);
    if (o.tech || o.vendor) insHist.run(id, uMgr, 'assigned', 'Assigned', o.created);
    if (o.done) insHist.run(id, o.tech || uMgr, 'status_changed', 'Status → completed', o.done);
    return id;
  }
  function completeJob(id, propId, tech, days, workMin, mats, laborRate, extraExp) {
    const start = daysAgo(days, 8);
    const end = new Date(new Date(start.replace(' ', 'T')).getTime() + workMin * 60000)
      .toISOString().replace('T', ' ').slice(0, 19);
    insTime.run(id, tech, 'work', start, end, workMin);
    let matTotal = 0;
    (mats || []).forEach(m => { insMat.run(id, m[0], m[1], m[2], tech, start); matTotal += m[1] * m[2]; });
    if (matTotal > 0) insExp.run(id, propId, tech, null, 'materials', 'Job materials', +matTotal.toFixed(2), start.slice(0, 10), start);
    if (laborRate) insExp.run(id, propId, tech, null, 'labor', 'Technician labor', +((workMin / 60) * laborRate).toFixed(2), start.slice(0, 10), start);
    if (extraExp) insExp.run(id, propId, null, extraExp.vendor || null, extraExp.cat, extraExp.desc, extraExp.amt, start.slice(0, 10), start);
  }

  // --- Repeat-repair pattern: Oak Haven HVAC, 4 calls in ~6 months ---
  const rr = [
    { d: 168, t: 'AC not cooling — Unit A', min: 110, notes: 'Recharged refrigerant, found slow leak at service valve. Tightened and monitored.', mats: [['R-410A refrigerant (lb)', 3, 38]] },
    { d: 121, t: 'AC blowing warm again — Unit A', min: 95, notes: 'Replaced capacitor. Compressor hard-starting.', mats: [['Dual run capacitor 45/5', 1, 24.5], ['Contactor', 1, 19]] },
    { d: 63, t: 'HVAC tripping breaker — Unit A', min: 140, notes: 'Compressor drawing high amps. Cleaned coil, installed hard-start kit. Recommend replacement quote.', mats: [['Hard start kit', 1, 42]] },
    { d: 18, t: 'AC down again — Unit A', min: 75, notes: 'Vendor service call. Compressor near end of life; replacement quoted at $6,200.', vendorCall: 385 },
  ];
  rr.forEach(r => {
    const id = wo({ p: P[1], u: U[1][0], asset: A.oakHvacA, cat: 'HVAC', title: r.t, pri: 'high', status: 'completed',
      tech: r.vendorCall ? null : uMike, vendor: r.vendorCall ? vHVAC : null,
      created: daysAgo(r.d + 1), done: daysAgo(r.d), notes: r.notes, est: 120 });
    if (r.vendorCall) {
      insExp.run(id, P[1], null, vHVAC, 'vendor_invoice', 'HVAC service call — Coastal HVAC Pros', r.vendorCall, dateOnly(r.d), daysAgo(r.d));
    } else {
      completeJob(id, P[1], uMike, r.d, r.min, r.mats, 32);
    }
  });

  // --- Second repeat pattern: Avondale cast-iron drain backups ---
  [150, 88, 34].forEach((d, i) => {
    const id = wo({ p: P[10], u: U[10][i % 2], asset: A.avoPlumb, cat: 'Plumbing',
      title: 'Main drain backup — snaked line', pri: 'high', status: 'completed',
      vendor: vPlumb, created: daysAgo(d + 1), done: daysAgo(d),
      notes: 'Cleared blockage. Camera shows scaling in cast iron main. Long-term: repipe.' });
    insExp.run(id, P[10], null, vPlumb, 'vendor_invoice', 'Drain cleaning — First Coast Plumbing', 265 + i * 20, dateOnly(d), daysAgo(d));
  });

  // --- General completed history across the portfolio ---
  const hist = [
    { p: 2, u: 0, cat: 'Plumbing', t: 'Kitchen faucet leaking', tech: uJames, d: 140, min: 65, mats: [['Kitchen faucet', 1, 47], ['Supply line', 2, 11.5]], notes: 'Replaced faucet and both supply lines.' },
    { p: 3, u: 1, cat: 'Electrical', t: 'GFCI outlet dead in bathroom', tech: uAlex, d: 132, min: 40, mats: [['GFCI outlet', 1, 18.75]], notes: 'Replaced GFCI, tested.' },
    { p: 4, u: 2, cat: 'Appliance', t: 'Dishwasher not draining', tech: uMike, d: 125, min: 55, mats: [['Drain hose', 1, 16.4]], notes: 'Cleared clog, replaced kinked hose.' },
    { p: 5, u: 0, cat: 'General', t: 'Rotted fascia board — front eave', tech: uSam, d: 118, min: 150, mats: [['1x6 fascia board 12ft', 2, 21], ['Exterior paint (qt)', 1, 19]], notes: 'Replaced fascia, primed and painted.' },
    { p: 6, u: 1, cat: 'Plumbing', t: 'Running toilet', tech: uJames, d: 110, min: 30, mats: [['Fill valve + flapper kit', 1, 14.2]], notes: 'Rebuilt tank internals.' },
    { p: 7, u: 0, cat: 'HVAC', t: 'AC service — weak airflow', tech: uMike, d: 104, min: 70, mats: [['Filter 16x25x1', 2, 7.5]], notes: 'Cleaned blower, replaced filters.' },
    { p: 8, u: 0, cat: 'Appliance', t: 'Dishwasher replacement', tech: uMike, d: 96, min: 120, mats: [['Whirlpool dishwasher', 1, 480], ['Install kit', 1, 22]], notes: 'Removed old unit, installed new Whirlpool.' },
    { p: 9, u: 3, cat: 'General', t: 'Turnover — patch and paint Unit 4', tech: uSam, d: 90, min: 420, mats: [['Interior paint (gal)', 4, 34], ['Patch compound', 2, 9.5]], notes: 'Full turn: patched walls, two coats.' },
    { p: 12, u: 0, cat: 'Electrical', t: 'Ceiling fan wobble/noise', tech: uAlex, d: 84, min: 45, mats: [['Fan balance kit', 1, 6.8]], notes: 'Balanced and tightened mount.' },
    { p: 13, u: 2, cat: 'HVAC', t: 'AC freeze-up — Unit 3', tech: uMike, d: 77, min: 90, mats: [['Filter 20x20x1', 1, 8.2]], notes: 'Severely clogged filter caused freeze. Thawed, replaced filter.' },
    { p: 14, u: 1, cat: 'Plumbing', t: 'Water heater pilot won\'t stay lit', tech: uJames, d: 70, min: 80, mats: [['Thermocouple', 1, 12.9]], notes: 'Replaced thermocouple.' },
    { p: 15, u: 0, cat: 'General', t: 'Fence gate repair', tech: uSam, d: 66, min: 60, mats: [['Gate hinge set', 1, 17.3], ['Latch', 1, 9.4]], notes: 'Re-hung gate, new hardware.' },
    { p: 2, u: 3, cat: 'Pest', t: 'Roach treatment — Unit 4', tech: null, vendor: vPlumb, d: 60, inv: 145, notes: 'Vendor treatment completed.' },
    { p: 11, u: 0, cat: 'Plumbing', t: 'Garbage disposal jammed', tech: uJames, d: 55, min: 35, mats: [], notes: 'Cleared jam, reset. No parts needed.' },
    { p: 3, u: 0, cat: 'General', t: 'Screen door replacement', tech: uSam, d: 48, min: 50, mats: [['Screen door 36in', 1, 64]], notes: 'Installed new screen door.' },
    { p: 6, u: 2, cat: 'Appliance', t: 'Range burner not igniting', tech: uAlex, d: 44, min: 55, mats: [['Igniter', 1, 21.6]], notes: 'Replaced igniter.' },
    { p: 4, u: 0, cat: 'Plumbing', t: 'Bathtub drain slow', tech: uJames, d: 40, min: 35, mats: [['Drain cleaner', 1, 11]], notes: 'Snaked drain, cleared hair clog.' },
    { p: 9, u: 0, cat: 'HVAC', t: 'Thermostat replacement', tech: uMike, d: 36, min: 40, mats: [['Honeywell T4 thermostat', 1, 62]], notes: 'Swapped failed thermostat.' },
    { p: 7, u: 1, cat: 'General', t: 'Regrout shower — Unit B', tech: uSam, d: 30, min: 180, mats: [['Grout', 2, 14], ['Caulk', 2, 7.2]], notes: 'Regrouted and recaulked full surround.' },
    { p: 13, u: 0, cat: 'Electrical', t: 'Exterior light fixture replacement', tech: uAlex, d: 26, min: 45, mats: [['LED exterior fixture', 2, 32]], notes: 'Both entry fixtures replaced.' },
    { p: 5, u: 1, cat: 'Plumbing', t: 'Washing machine valve leak', tech: uJames, d: 22, min: 50, mats: [['Washer valve set', 1, 28.5]], notes: 'Replaced both valves.' },
    { p: 15, u: 0, cat: 'HVAC', t: 'Seasonal AC service', tech: uMike, d: 15, min: 60, mats: [['Filter 16x20x1', 1, 7.5], ['Coil cleaner', 1, 12]], notes: 'Cleaned condenser coil, checked pressures.' },
    { p: 12, u: 2, cat: 'Plumbing', t: 'Kitchen sink drain leak', tech: uJames, d: 12, min: 45, mats: [['P-trap kit', 1, 8.42], ['Plumber\'s putty', 1, 4.3]], notes: 'Rebuilt P-trap assembly.' },
    { p: 8, u: 0, cat: 'General', t: 'Gutter cleaning', tech: uSam, d: 9, min: 90, mats: [], notes: 'Cleared all gutters and downspouts.' },
    { p: 10, u: 0, cat: 'Electrical', t: 'Smoke detectors — replace batteries + 1 unit', tech: uAlex, d: 6, min: 40, mats: [['Smoke detector', 1, 24], ['9V batteries', 4, 3.5]], notes: 'All detectors tested.' },
  ];
  hist.forEach(h => {
    const id = wo({ p: P[h.p], u: U[h.p][h.u], cat: h.cat, title: h.t, pri: h.pri || 'normal', status: 'completed',
      tech: h.tech || null, vendor: h.vendor || null, created: daysAgo(h.d + 2), done: daysAgo(h.d), notes: h.notes, est: h.min || 60 });
    if (h.inv) insExp.run(id, P[h.p], null, h.vendor, 'vendor_invoice', h.t, h.inv, dateOnly(h.d), daysAgo(h.d));
    else if (h.tech) completeJob(id, P[h.p], h.tech, h.d, h.min, h.mats, ({ [uMike]: 32, [uJames]: 30, [uAlex]: 28, [uSam]: 26 })[h.tech]);
  });

  // --- Open work orders (a live board) ---
  const woEmergency = wo({ p: P[2], u: U[2][1], cat: 'Plumbing', title: 'Water heater leaking — active leak', 
    desc: 'Tenant reports water pooling around water heater base in Unit 2 closet.', asset: A.rivWH2,
    pri: 'emergency', status: 'in_progress', tech: uJames, sched: dateOnly(0), due: dateOnly(0), est: 120,
    instr: 'Shut supply valve first. WH is in hall closet. If tank is failed, get replacement approved before purchase.',
    created: daysAgo(0, 7) });
  insTime.run(woEmergency, uJames, 'work', daysAgo(0, 8), null, null);
  insCom.run(woEmergency, uJames, 'On site. Tank seam is leaking — this one needs replacement, not repair.', 0, daysAgo(0, 8));

  const woApproval = wo({ p: P[11], u: U[11][0], cat: 'Plumbing', title: 'Water heater replacement — Mandarin',
    desc: '2014 unit failed inspection; anode gone, rusty water.', asset: A.manWH,
    pri: 'high', status: 'waiting_approval', tech: uJames, sched: dateOnly(1), due: dateOnly(2), est: 180,
    created: daysAgo(2) });
  const apr1 = db.prepare(`INSERT INTO approvals (work_order_id,requested_by,amount,reason,status,created_at)
    VALUES (?,?,?,?,?,?)`).run(woApproval, uJames, 1385, '50-gal Rheem + expansion tank + haul-away', 'pending', daysAgo(0, 10)).lastInsertRowid;

  wo({ p: P[1], u: U[1][0], asset: A.oakHvacA, cat: 'HVAC', title: 'HVAC replacement decision — Unit A',
    desc: 'Compressor at end of life. Vendor quote $6,200. Fourth service call in 6 months.',
    pri: 'high', status: 'waiting_approval', vendor: vHVAC, due: dateOnly(3), est: 480, created: daysAgo(4) });

  wo({ p: P[13], u: U[13][2], asset: A.beaHvac3, cat: 'HVAC', title: 'AC intermittent — Unit 3',
    desc: 'Cools then cuts out. Suspect low charge or board.', pri: 'high', status: 'waiting_parts',
    tech: uMike, sched: dateOnly(2), due: dateOnly(4), est: 120,
    instr: 'Control board on order — arrives Thursday.', created: daysAgo(5) });

  wo({ p: P[6], u: U[6][0], cat: 'Appliance', title: 'Refrigerator not cooling — Unit 1',
    desc: 'Freezer OK, fridge side warm. Likely evaporator fan or damper.', pri: 'high', status: 'scheduled',
    tech: uMike, sched: dateOnly(0), due: dateOnly(1), est: 90,
    instr: 'Tenant home after 9am. Parking behind building.', created: daysAgo(1) });

  wo({ p: P[4], u: U[4][3], cat: 'Plumbing', title: 'Shower diverter stuck — Unit 4',
    pri: 'normal', status: 'scheduled', tech: uMike, sched: dateOnly(0), due: dateOnly(2), est: 60,
    instr: 'Lockbox code 4417. Diverter parts in van stock.', created: daysAgo(2) });

  wo({ p: P[9], u: U[9][1], cat: 'Electrical', title: 'Bedroom outlets dead — Unit 2',
    desc: 'Half the bedroom on one circuit dead. Check tripped GFCI / backstab failure.',
    pri: 'normal', status: 'scheduled', tech: uAlex, sched: dateOnly(0), due: dateOnly(2), est: 75, created: daysAgo(1) });

  wo({ p: P[3], u: U[3][0], cat: 'General', title: 'Front step trip hazard — concrete crack',
    pri: 'normal', status: 'assigned', tech: uSam, due: dateOnly(5), est: 120, created: daysAgo(3) });

  // Overdue
  wo({ p: P[14], u: U[14][0], cat: 'General', title: 'Window won\'t lock — Unit A',
    pri: 'normal', status: 'assigned', tech: uSam, sched: dateOnly(4), due: dateOnly(3), est: 45, created: daysAgo(8) });
  wo({ p: P[12], u: U[12][1], cat: 'Appliance', title: 'Range hood fan dead — Unit 2',
    pri: 'low', status: 'assigned', tech: uAlex, sched: dateOnly(6), due: dateOnly(5), est: 60, created: daysAgo(10) });

  // Vendor-assigned open job (visible to vendor login)
  wo({ p: P[1], u: U[1][1], asset: A.oakHvacB, cat: 'HVAC', title: 'Annual service — Unit B system',
    pri: 'normal', status: 'scheduled', vendor: vHVAC, sched: dateOnly(-2), due: dateOnly(-2), est: 90,
    instr: 'Standard tune-up. Unit B tenant works nights — arrive after 1pm.', created: daysAgo(3) });

  // Unassigned new
  wo({ p: P[7], u: U[7][1], cat: 'Plumbing', title: 'Low water pressure — Unit B bath',
    pri: 'low', status: 'new', due: dateOnly(10), est: 60, created: daysAgo(1) });

  // ---------- Open maintenance requests ----------
  const insReq = db.prepare(`INSERT INTO requests (property_id,unit_id,category,description,priority,reported_by,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  insReq.run(P[5], U[5][0], 'Appliance', 'Dryer takes 3 cycles to dry clothes. Vent may be clogged.', 'normal', 'Tenant — Unit A', 'open', uMgr, daysAgo(1));
  insReq.run(P[2], U[2][0], 'General', 'Front porch light out and porch board feels soft near the door.', 'normal', 'Tenant — Unit 1', 'open', uMgr, daysAgo(0, 8));
  insReq.run(P[13], U[13][3], 'Plumbing', 'Toilet rocks slightly and floor feels damp at base.', 'high', 'Tenant — Unit 4', 'open', uMgr, daysAgo(0, 11));

  // ---------- Preventive maintenance ----------
  const insPM = db.prepare(`INSERT INTO pm_schedules (property_id,asset_id,title,category,interval_days,next_due,estimated_minutes,instructions) VALUES (?,?,?,?,?,?,?,?)`);
  insPM.run(P[1], A.oakHvacA, 'HVAC filter change — both units', 'HVAC', 90, dateOnly(-12), 30, '16x25x1 filters, 2 per side');
  insPM.run(P[2], null, 'Gutter cleaning', 'General', 182, dateOnly(-25), 120, null);
  insPM.run(P[4], A.sprHvac, 'HVAC service — semi-annual', 'HVAC', 182, dateOnly(-40), 90, null);
  insPM.run(P[9], null, 'Smoke detector inspection — all units', 'Safety', 365, dateOnly(-60), 90, 'Test + battery every unit');
  insPM.run(P[10], null, 'Pest treatment — quarterly', 'Pest', 91, dateOnly(-8), 45, null);
  insPM.run(P[13], null, 'HVAC filter change — all units', 'HVAC', 90, dateOnly(5), 45, 'OVERDUE — was due last week'); // due (overdue)
  insPM.run(P[13], null, 'Pressure wash walkways', 'General', 365, dateOnly(2), 120, null); // overdue
  insPM.run(P[7], null, 'Gutter cleaning', 'General', 182, dateOnly(-70), 90, null);

  // ---------- Inspections ----------
  const insInsp = db.prepare(`INSERT INTO inspections (property_id,unit_id,inspected_by,inspected_on,summary,condition) VALUES (?,?,?,?,?,?)`);
  insInsp.run(P[2], U[2][0], uMgr, dateOnly(45), 'Annual walk-through. Porch boards soft near door; roof at end of life.', 'fair');
  insInsp.run(P[4], null, uMgr, dateOnly(30), 'Post-renovation check. Excellent condition.', 'good');
  insInsp.run(P[10], null, uMgr, dateOnly(60), 'Cast iron plumbing continues to scale. Budget repipe.', 'fair');

  // ---------- Notifications ----------
  const insNotif = db.prepare(`INSERT INTO notifications (user_id,kind,title,body,link,read,created_at) VALUES (?,?,?,?,?,?,?)`);
  for (const uid of [uOwner, uMgr]) {
    insNotif.run(uid, 'emergency', 'Emergency: water heater leaking', 'Riverside Quad Unit 2 — James is on site.', '#/work-orders/' + woEmergency, 0, daysAgo(0, 8));
    insNotif.run(uid, 'approval', 'Approval requested: $1,385', 'James Carter — water heater replacement at Mandarin SFR.', '#/work-orders/' + woApproval, 0, daysAgo(0, 10));
    insNotif.run(uid, 'repeat', 'Repeat repair detected', 'Oak Haven Duplex — HVAC Unit A: 4 service calls in 6 months ($1,420 spent). Evaluate replacement.', '#/properties/' + P[1], 0, daysAgo(1));
    insNotif.run(uid, 'pm_due', 'Preventive maintenance overdue', '2 PM items overdue at Beach Blvd Fourplex.', '#/maintenance', 0, daysAgo(2));
  }
  insNotif.run(uMike, 'assigned', 'New job assigned', 'Refrigerator not cooling — Arlington Triplex Unit 1, today.', '#/today', 0, daysAgo(1));
  insNotif.run(uJames, 'emergency', 'Emergency dispatch', 'Water heater leaking — Riverside Quad Unit 2. Go now.', '#/today', 1, daysAgo(0, 7));

  console.log('Seed complete.');
  return true;
}

if (require.main === module) seed(process.argv.includes('--force'));
module.exports = seed;
