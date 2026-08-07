// test/api.test.js — OpsDeck V2 automated tests.
// Run with the server up:  node test/api.test.js  (exits 1 on any failure)
const BASE = process.env.BASE_URL || 'http://localhost:3000/api';

const jars = {};
async function call(user, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (jars[user]) headers.Cookie = jars[user];
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setC = r.headers.get('set-cookie');
  if (setC) jars[user] = setC.split(';')[0];
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}
const login = (user, email) => call(user, 'POST', '/auth/login', { email, password: 'demo123' });

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra).slice(0, 160) : '')); }
}

(async () => {
  console.log('OpsDeck V2 test suite\n');

  console.log('AUTH & ROLES');
  ok((await call('anon', 'GET', '/dashboard')).status === 401, 'unauthenticated requests are rejected');
  ok((await login('owner', 'owner@demo.com')).status === 200, 'owner login');
  ok((await login('manager', 'manager@demo.com')).status === 200, 'manager login');
  ok((await login('tech', 'tech@demo.com')).status === 200, 'technician login');
  ok((await login('vendor', 'vendor@demo.com')).status === 200, 'vendor login');
  ok((await login('viewer', 'viewer@demo.com')).status === 200, 'viewer login');
  ok((await login('org2', 'owner@bayview.demo')).status === 200, 'second-org owner login');
  ok((await call('anon', 'POST', '/auth/login', { email: 'owner@demo.com', password: 'wrong' })).status === 401, 'wrong password rejected');

  console.log('\nORGANIZATION ISOLATION');
  const pr = await call('owner', 'GET', '/dashboard');
  const bv = await call('org2', 'GET', '/dashboard');
  ok(pr.data.spend_by_property.length >= 10, 'Pine Ridge sees its full portfolio');
  ok(bv.data.spend_by_property.length === 1, 'Bayview sees only its own property');
  const prWO = (await call('owner', 'GET', '/work-orders?open=1')).data[0];
  ok((await call('org2', 'GET', '/work-orders/' + prWO.id)).status === 404, 'cross-org work order fetch returns 404');
  ok((await call('org2', 'GET', '/properties/1')).status === 404, 'cross-org property fetch returns 404');
  ok((await call('org2', 'PATCH', '/work-orders/' + prWO.id, { priority: 'low' })).status === 404, 'cross-org write returns 404');
  const srch = (await call('org2', 'GET', '/search?q=Oak')).data;
  ok(Object.values(srch).every(a => a.length === 0), 'cross-org search returns nothing');

  console.log('\nVIEWER (READ-ONLY)');
  ok((await call('viewer', 'GET', '/dashboard')).status === 200, 'viewer can read dashboard');
  ok((await call('viewer', 'GET', '/analytics')).status === 200, 'viewer can read analytics');
  ok((await call('viewer', 'POST', '/work-orders', { property_id: 1, category: 'HVAC', title: 'x' })).status === 403, 'viewer cannot create work orders');
  ok((await call('viewer', 'PATCH', '/work-orders/' + prWO.id, { priority: 'low' })).status === 403, 'viewer cannot edit work orders');
  ok((await call('viewer', 'POST', '/team/invites', { email: 'x@x.com', role: 'manager' })).status === 403, 'viewer cannot invite');
  ok((await call('viewer', 'PATCH', '/org', { name: 'Hacked' })).status === 403, 'viewer cannot edit organization');

  console.log('\nTECHNICIAN SCOPE');
  const techWOs = (await call('tech', 'GET', '/work-orders')).data;
  ok(techWOs.every(w => w.assigned_user_id === 3), 'technician sees only assigned jobs');
  ok((await call('tech', 'GET', '/dashboard')).status === 403, 'technician blocked from dashboard');

  console.log('\nINTAKE → TRIAGE → WORK ORDER');
  const req = (await call('manager', 'POST', '/requests', {
    property_id: 1, unit_id: 1, category: 'Plumbing', description: 'AUTOTEST leak under sink',
    is_emergency: true, flag_water: true, reporter_type: 'tenant', access_instructions: 'Gate 4411',
    permission_to_enter: true, pets: 'Dog' })).data;
  ok(!!req.id, 'emergency request created');
  const conv = (await call('manager', 'POST', `/requests/${req.id}/triage`, { action: 'convert', title: 'AUTOTEST leak', assigned_user_id: 3 })).data;
  ok(!!conv.id && /^WO-\d+$/.test(conv.number), 'triage convert creates numbered WO');
  const woD = (await call('owner', 'GET', '/work-orders/' + conv.id)).data;
  ok(woD.wo.priority === 'emergency', 'emergency priority carries through');
  ok((woD.wo.instructions || '').includes('Gate 4411') && (woD.wo.instructions || '').includes('Dog'), 'access info + pets carry onto the WO');
  ok((await call('manager', 'POST', `/requests/${req.id}/triage`, { action: 'reject' })).status === 400, 'converted request cannot be re-triaged');
  ok((await call('owner', 'GET', '/requests')).data.find(r => r.id === req.id).status === 'converted', 'request marked converted');

  console.log('\nTECH WORKFLOW + COMPLETION REQUIREMENTS');
  ok((await call('tech', 'POST', `/work-orders/${conv.id}/travel/start`)).status === 200, 'travel start');
  ok((await call('tech', 'POST', `/work-orders/${conv.id}/arrived`)).status === 200, 'arrived');
  ok((await call('tech', 'POST', `/work-orders/${conv.id}/time/start`)).status === 200, 'work timer start');
  const blocked = await call('tech', 'PATCH', `/work-orders/${conv.id}`, { status: 'completed', completion_notes: 'done' });
  ok(blocked.status === 400 && blocked.data.missing && blocked.data.missing.length >= 2, 'completion blocked; missing items listed (Plumbing needs photos)');
  const ovr = await call('manager', 'PATCH', `/work-orders/${conv.id}`, { status: 'completed', completion_notes: 'done', override: true, override_note: 'test' });
  ok(ovr.status === 200, 'manager override completes the job');
  const hist = (await call('owner', 'GET', '/work-orders/' + conv.id)).data.history;
  ok(hist.some(h => h.action === 'completion_override'), 'override is audit-logged');
  ok(hist.some(h => h.action === 'travel_started') && hist.some(h => h.action === 'arrived'), 'travel + arrival in timeline');
  ok(hist.some(h => h.old_value && h.new_value), 'audit log records old and new values');

  console.log('\nTIERED APPROVALS');
  const cw = (await call('manager', 'POST', '/work-orders', { property_id: 2, category: 'HVAC', title: 'AUTOTEST approval flow', assigned_user_id: 3 })).data;
  const a1 = (await call('tech', 'POST', `/work-orders/${cw.id}/approvals`, { amount: 300, reason: 'parts' })).data;
  ok(a1.required_role === 'manager', '$300 routes to manager tier');
  const a2 = (await call('tech', 'POST', `/work-orders/${cw.id}/approvals`, { amount: 650, reason: 'compressor' })).data;
  ok(a2.required_role === 'owner', '$650 routes to owner tier');
  ok((await call('manager', 'PATCH', '/approvals/' + a2.id, { decision: 'approved' })).status === 403, 'manager blocked from owner-tier approval');
  ok((await call('owner', 'PATCH', '/approvals/' + a2.id, { decision: 'approved' })).status === 200, 'owner approves owner-tier request');
  ok((await call('manager', 'PATCH', '/approvals/' + a1.id, { decision: 'approved' })).status === 200, 'manager approves manager-tier request');

  console.log('\nVENDOR QUOTES');
  const qw = (await call('manager', 'POST', '/work-orders', { property_id: 3, category: 'Roofing', title: 'AUTOTEST quote flow' })).data;
  const qr = (await call('manager', 'POST', `/work-orders/${qw.id}/quotes/request`, { vendor_ids: [1, 3] })).data;
  ok(qr.created.length === 2, 'quotes requested from two vendors');
  ok((await call('owner', 'GET', '/work-orders/' + qw.id)).data.wo.status === 'waiting_vendor', 'WO moves to waiting_vendor');
  const vq = (await call('vendor', 'GET', '/work-orders/' + qw.id)).data.quotes;
  ok(vq.length === 1, 'vendor sees only their own quote');
  ok((await call('vendor', 'POST', `/quotes/${vq[0].id}/submit`, { price: 1800, scope: 'AUTOTEST scope' })).status === 200, 'vendor submits quote');
  ok((await call('manager', 'PATCH', '/quotes/' + vq[0].id, { decision: 'approved' })).status === 200, 'manager approves quote');
  const qFinal = (await call('owner', 'GET', '/work-orders/' + qw.id)).data;
  ok(qFinal.wo.assigned_vendor_id === 1 && qFinal.wo.status === 'assigned', 'approved quote assigns the vendor');

  console.log('\nVALIDATION');
  ok((await call('manager', 'POST', '/work-orders', { property_id: 1, category: 'HVAC', title: 'x', due_date: 'not-a-date' })).status === 400, 'invalid date rejected');
  ok((await call('tech', 'POST', `/work-orders/${cw.id}/expenses`, { amount: -50 })).status === 400, 'negative expense rejected');
  ok((await call('tech', 'POST', `/work-orders/${cw.id}/expenses`, { amount: 'abc' })).status === 400, 'non-numeric expense rejected');
  ok((await call('manager', 'POST', '/requests', { property_id: 1, category: 'HVAC', description: 'x', priority: 'bogus' })).status === 400, 'invalid priority rejected');

  console.log('\nTEAM PROTECTIONS');
  const team = (await call('owner', 'GET', '/team/users')).data;
  const soleOwner = team.users.find(u => u.role === 'owner');
  ok((await call('owner', 'PATCH', '/team/users/' + soleOwner.id, { role: 'manager' })).status === 400, 'cannot demote the last active owner');
  ok((await call('manager', 'POST', '/team/invites', { email: 'x@y.com', role: 'owner' })).status === 403, 'manager cannot invite an owner');

  console.log('\nINSIGHTS & QR');
  const an = (await call('owner', 'GET', '/analytics?capex_months=60')).data;
  ok(an.capex.window_months === 60, 'CapEx horizon switches to 60 months');
  ok(an.repair_vs_replace.length >= 1 && an.repair_vs_replace[0].reasons.length >= 2, 'repair-vs-replace produces reasoned recommendations');
  ok(Array.isArray(an.anomalies), 'cost anomaly detection runs');
  const qrRes = await fetch(BASE + '/qr/asset/1', { headers: { Cookie: jars.owner } });
  ok(qrRes.status === 200 && (qrRes.headers.get('content-type') || '').includes('svg'), 'asset QR code renders as SVG');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Test run crashed:', e.message); process.exit(1); });
