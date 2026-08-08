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
  console.log('Steadhold V2 test suite\n');

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
  const tStart = await call('tech', 'POST', `/work-orders/${conv.id}/time/start`);
  ok(tStart.status === 400 && tStart.data.needs === 'before_photo', 'Plumbing job blocks work start until a before photo exists');
  ok((await call('manager', 'POST', `/work-orders/${conv.id}/time/start`, { override: true })).status === 200, 'work timer starts after manager override');
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

  console.log('\nPUBLIC TENANT INTAKE');
  const tokRow = await call('owner', 'GET', '/properties/1');
  const tok = tokRow.data.property.intake_token;
  ok(!!tok && tok.length >= 12, 'property has an intake token');
  const pubGet = await fetch(BASE + '/intake/' + tok);
  ok(pubGet.status === 200, 'public intake form loads with no auth');
  const pubInfo = await pubGet.json();
  ok(pubInfo.units.length >= 1 && !pubInfo.hasOwnProperty('id'), 'public payload exposes only name/units/categories');
  ok((await fetch(BASE + '/intake/0000000000000000')).status === 404, 'bad token returns 404');
  const fd = new FormData();
  fd.append('category', 'Plumbing'); fd.append('description', 'AUTOTEST public tenant submission padding');
  fd.append('reported_by', 'Test Tenant'); fd.append('reporter_phone', '904-555-0000');
  fd.append('flag_water', '1'); fd.append('pets', 'Cat'); fd.append('access_instructions', 'Code 1234');
  fd.append('photos', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 't.png');
  const pubPost = await fetch(BASE + '/intake/' + tok, { method: 'POST', body: fd });
  const pubData = await pubPost.json();
  ok(pubPost.status === 200 && /^REQ-\d+$/.test(pubData.reference), 'tenant submits with photo, gets a reference number');
  const reqRow = (await call('manager', 'GET', '/requests')).data.filter(r => r.description.includes('AUTOTEST public tenant')).sort((a, b) => b.id - a.id)[0];
  ok(reqRow && reqRow.reporter_type === 'tenant' && reqRow.flag_water === 1, 'submission lands in triage with tenant fields');
  ok(reqRow.photos.length === 1, 'intake photo visible in triage queue');
  const pconv = (await call('manager', 'POST', `/requests/${reqRow.id}/triage`, { action: 'convert', title: 'AUTOTEST tenant WO', assigned_user_id: 3 })).data;
  const pwo = (await call('owner', 'GET', '/work-orders/' + pconv.id)).data;
  ok(pwo.photos.length === 1, 'intake photo carries onto the converted work order');
  ok((pwo.wo.instructions || '').includes('Code 1234') && (pwo.wo.instructions || '').includes('Cat'), 'access + pets carry onto the WO');
  const badPost = await fetch(BASE + '/intake/' + tok, { method: 'POST', body: (() => { const f = new FormData(); f.append('category', 'HVAC'); f.append('description', 'no contact info'); return f; })() });
  ok(badPost.status === 400, 'submission without contact info rejected');
  console.log('\nOWNER-REVIEW ROUTING & OWNER SUBMISSIONS');
  ok((await call('manager', 'PATCH', '/properties/1', { tenant_routing: 'owner' })).status === 403, 'only an owner can enable owner routing');
  ok((await call('owner', 'PATCH', '/properties/1', { tenant_routing: 'owner' })).status === 200, 'owner enables owner-review routing');
  const rfd = new FormData();
  rfd.append('category', 'Appliance'); rfd.append('description', 'AUTOTEST routed dishwasher issue padding');
  rfd.append('reported_by', 'T'); rfd.append('reporter_phone', '904');
  await fetch(BASE + '/intake/' + tok, { method: 'POST', body: rfd });
  let heldReq = (await call('owner', 'GET', '/requests')).data.filter(r => r.description.includes('AUTOTEST routed dishwasher')).sort((a, b) => b.id - a.id)[0];
  ok(heldReq && heldReq.status === 'owner_review', 'non-emergency tenant request held for owner review');
  ok((await call('manager', 'POST', `/requests/${heldReq.id}/triage`, { action: 'convert', title: 'x' })).status === 403, 'manager cannot triage a held request');
  ok((await call('manager', 'POST', `/requests/${heldReq.id}/review`, { action: 'release' })).status === 403, 'manager cannot release a held request');
  ok((await call('owner', 'POST', `/requests/${heldReq.id}/review`, { action: 'release' })).status === 200, 'owner releases to maintenance');
  heldReq = (await call('manager', 'GET', '/requests')).data.find(r => r.id === heldReq.id);
  ok(heldReq.status === 'open', 'released request enters the normal triage queue');
  const efd = new FormData();
  efd.append('category', 'Plumbing'); efd.append('description', 'AUTOTEST routed emergency burst padding');
  efd.append('reported_by', 'T'); efd.append('reporter_phone', '904'); efd.append('is_emergency', '1');
  await fetch(BASE + '/intake/' + tok, { method: 'POST', body: efd });
  const emReq = (await call('owner', 'GET', '/requests')).data.filter(r => r.description.includes('AUTOTEST routed emergency')).sort((a, b) => b.id - a.id)[0];
  ok(emReq && emReq.status === 'open' && emReq.priority === 'emergency', 'emergencies bypass owner review');
  ok((await call('owner', 'PATCH', '/properties/1', { tenant_routing: 'maintenance' })).status === 200, 'routing restored to direct');
  ok((await call('viewer', 'POST', '/requests', { property_id: 2, category: 'Roofing', description: 'AUTOTEST viewer request padding' })).status === 200, 'viewer (owner persona) can submit a request');
  const vReq = (await call('owner', 'GET', '/requests')).data.filter(r => r.description.includes('AUTOTEST viewer request')).sort((a, b) => b.id - a.id)[0];
  ok(vReq && vReq.reporter_type === 'owner', 'viewer submission recorded as owner-reported');

  const rot = await call('manager', 'POST', '/properties/1/intake-token/rotate');
  ok(rot.status === 200 && rot.data.intake_token !== tok, 'token rotation issues a new link');
  ok((await fetch(BASE + '/intake/' + tok)).status === 404, 'old link dead after rotation');

  console.log('\nBEFORE-PHOTO GATE & UNIT OCCUPANCY');
  const gw = (await call('manager', 'POST', '/work-orders', { property_id: 1, category: 'HVAC', title: 'AUTOTEST gate', assigned_user_id: 3 })).data;
  const gStart = await call('tech', 'POST', `/work-orders/${gw.id}/time/start`);
  ok(gStart.status === 400 && gStart.data.needs === 'before_photo', 'work cannot start until the before photo is taken');
  ok((await call('manager', 'POST', `/work-orders/${gw.id}/time/start`, { override: true, override_note: 't' })).status === 200, 'manager can override the before-photo gate');
  const gHist = (await call('owner', 'GET', '/work-orders/' + gw.id)).data.history;
  ok(gHist.some(h => h.action === 'before_photo_override'), 'before-photo override is audit-logged');
  const gp = (await call('manager', 'POST', '/work-orders', { property_id: 1, category: 'Pest', title: 'AUTOTEST gate pest', assigned_user_id: 3 })).data;
  ok((await call('tech', 'POST', `/work-orders/${gp.id}/time/start`)).status === 200, 'categories without a before-photo requirement start freely');
  const nu = (await call('manager', 'POST', '/properties/1/units', { label: 'AUTOTESTU' })).data;
  const nuRow = (await call('manager', 'GET', '/properties/1')).data.units.find(x => x.id === nu.id);
  ok(nuRow && nuRow.occupied === 0, 'newly added units default to vacant, not occupied');
  ok((await call('manager', 'PATCH', '/units/' + nu.id, { occupied: 1 })).status === 200, 'unit occupancy can be toggled');
  ok((await call('viewer', 'PATCH', '/units/' + nu.id, { occupied: 0 })).status === 403, 'viewers cannot change occupancy');

  console.log('\nOWNER-RUN TEAM (no manager)');
  const soloMeta = (await call('org2', 'GET', '/meta')).data;
  ok(soloMeta.has_managers === false, 'org with no manager reports a flat team');
  ok(soloMeta.supervisor && soloMeta.supervisor.role === 'owner', 'the owner is the contact when there is no manager');
  const pineMeta = (await call('owner', 'GET', '/meta')).data;
  ok(pineMeta.has_managers === true, 'org with a manager still reports the manager layer');
  const soloProp = (await call('org2', 'GET', '/properties')).data[0];
  const soloWo = (await call('org2', 'POST', '/work-orders', { property_id: soloProp.id, category: 'Plumbing', title: 'AUTOTEST solo job' })).data;
  const soloDet = (await call('org2', 'GET', '/work-orders/' + soloWo.id)).data;
  ok(soloDet.has_managers === false && soloDet.supervisor.role === 'owner', 'job detail carries the owner as the contact');
  const soloAp = (await call('org2', 'POST', `/work-orders/${soloWo.id}/approvals`, { amount: 200, reason: 'parts' })).data;
  ok(soloAp.required_role === 'owner' && soloAp.single_tier === true, 'mid-range approval routes to the owner when no manager exists');
  ok((await call('org2', 'PATCH', '/approvals/' + soloAp.id, { decision: 'approved' })).status === 200, 'owner approves it directly');
  const tieredAp = (await call('tech', 'POST', `/work-orders/${cw.id}/approvals`, { amount: 200, reason: 'parts' })).data;
  ok(tieredAp.required_role === 'manager', 'the manager tier still applies in orgs that have managers');

  console.log('\nOFFLINE SYNC IDEMPOTENCY');
  const idWo = (await call('manager', 'POST', '/work-orders', { property_id: 1, category: 'General', title: 'AUTOTEST idem' })).data;
  async function opCall(op, body) {
    const r = await fetch(BASE + `/work-orders/${idWo.id}/comments`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: jars.manager, 'X-Client-Op-Id': op }, body: JSON.stringify(body) });
    return { status: r.status, replayed: r.headers.get('x-replayed'), data: await r.json().catch(() => ({})) };
  }
  const o1 = await opCall('AUTOTEST-op-1', { body: 'AUTOTEST idempotent note' });
  const o2 = await opCall('AUTOTEST-op-1', { body: 'AUTOTEST idempotent note' });
  ok(o1.status === 200 && o2.status === 200, 'replayed op returns success, not an error');
  ok(o2.replayed === '1', 'server flags the second attempt as a replay');
  ok(o1.data.id === o2.data.id, 'replay returns the original result rather than creating a second record');
  const cmts = (await call('manager', 'GET', '/work-orders/' + idWo.id)).data.comments.filter(c => c.body.includes('AUTOTEST idempotent'));
  ok(cmts.length === 1, 'a replayed mutation creates exactly one record');
  const o3 = await opCall('AUTOTEST-op-2', { body: 'AUTOTEST second distinct note' });
  ok(o3.replayed !== '1' && o3.data.id !== o1.data.id, 'a different op id still applies normally');
  const dupWo = await fetch(BASE + '/work-orders', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: jars.manager, 'X-Client-Op-Id': 'AUTOTEST-wo-op' },
    body: JSON.stringify({ property_id: 1, category: 'General', title: 'AUTOTEST queued wo' }) });
  const dupWo2 = await fetch(BASE + '/work-orders', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: jars.manager, 'X-Client-Op-Id': 'AUTOTEST-wo-op' },
    body: JSON.stringify({ property_id: 1, category: 'General', title: 'AUTOTEST queued wo' }) });
  const w1 = await dupWo.json(), w2 = await dupWo2.json();
  ok(w1.id === w2.id, 'a replayed work-order creation does not duplicate the job');

  console.log('\nPHONE PUSH');
  const vk = await call('owner', 'GET', '/push/vapid-public-key');
  ok(vk.status === 200 && vk.data.key && vk.data.key.length > 40, 'VAPID public key served');
  ok((await call('anon2', 'GET', '/push/vapid-public-key')).status === 401, 'push endpoints require sign-in');
  const subR = await call('owner', 'POST', '/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/AUTOTEST-dev', keys: { p256dh: 'x', auth: 'y' } } });
  ok(subR.status === 200 && subR.data.devices >= 1, 'device subscription stored');
  ok((await call('owner', 'POST', '/push/subscribe', { subscription: {} })).status === 400, 'invalid subscription rejected');
  ok((await call('owner', 'PATCH', '/push/pushover-key', { key: 'AUTOTESTKEY123' })).status === 200, 'pushover key saved');
  ok((await call('owner', 'GET', '/push/status')).data.pushover_configured === true, 'pushover status reflects saved key');
  const unsub = await call('owner', 'POST', '/push/unsubscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/AUTOTEST-dev' } });
  ok(unsub.status === 200 && unsub.data.devices === 0, 'device unsubscribed');
  await call('owner', 'PATCH', '/push/pushover-key', { key: '' });
  const pp = await call('owner', 'PUT', '/notification-prefs', { emergency: { in_app: 1, push: 0 } });
  ok(pp.status === 200 && (await call('owner', 'GET', '/notification-prefs')).data.emergency.push === 0, 'per-kind push preference persists');
  await call('owner', 'PUT', '/notification-prefs', { emergency: { in_app: 1, push: 1 } });

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
