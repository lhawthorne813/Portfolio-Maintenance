const B = 'http://localhost:3000/api';
const jars = {};
async function call(u, m, p, b) {
  const h = { 'Content-Type': 'application/json' };
  if (jars[u]) h.Cookie = jars[u];
  const r = await fetch(B + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const c = r.headers.get('set-cookie'); if (c) jars[u] = c.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const login = (u, e) => call(u, 'POST', '/auth/login', { email: e, password: 'demo123' });

(async () => {
  await login('owner', 'owner@demo.com'); await login('manager', 'manager@demo.com'); await login('viewer', 'viewer@demo.com');

  console.log('mgr sets owner routing:', (await call('manager', 'PATCH', '/properties/1', { tenant_routing: 'owner' })).status);
  console.log('owner sets owner routing:', (await call('owner', 'PATCH', '/properties/1', { tenant_routing: 'owner' })).status);
  const tok = (await call('owner', 'GET', '/properties/1')).data.property.intake_token;

  const fd = new FormData();
  fd.append('category', 'Appliance'); fd.append('description', 'AUTOTEST-ROUTE dishwasher not draining properly');
  fd.append('reported_by', 'Tenant B'); fd.append('reporter_phone', '904-555-9999');
  let r = await fetch(B + '/intake/' + tok, { method: 'POST', body: fd });
  console.log('tenant submit under owner routing:', r.status);
  let held = (await call('owner', 'GET', '/requests')).data.find(x => x.description.includes('AUTOTEST-ROUTE dishwasher'));
  console.log('status after submit:', held.status);

  console.log('mgr triage attempt:', (await call('manager', 'POST', `/requests/${held.id}/triage`, { action: 'convert', title: 'x' })).status);
  console.log('mgr release attempt:', (await call('manager', 'POST', `/requests/${held.id}/review`, { action: 'release' })).status);

  console.log('owner release:', (await call('owner', 'POST', `/requests/${held.id}/review`, { action: 'release', note: 'ok' })).status);
  held = (await call('manager', 'GET', '/requests')).data.find(x => x.id === held.id);
  console.log('status after release:', held.status);
  console.log('mgr converts now:', (await call('manager', 'POST', `/requests/${held.id}/triage`, { action: 'convert', title: 'AUTOTEST-ROUTE dishwasher' })).status);

  const fe = new FormData();
  fe.append('category', 'Plumbing'); fe.append('description', 'AUTOTEST-ROUTE-EMERG main line burst water everywhere');
  fe.append('reported_by', 'Tenant B'); fe.append('reporter_phone', '904-555-9999'); fe.append('is_emergency', '1');
  await fetch(B + '/intake/' + tok, { method: 'POST', body: fe });
  const em = (await call('owner', 'GET', '/requests')).data.find(x => x.description.includes('AUTOTEST-ROUTE-EMERG'));
  console.log('emergency bypasses review — status:', em.status, '| priority:', em.priority);

  console.log('viewer creates request:', (await call('viewer', 'POST', '/requests', { property_id: 2, category: 'Roofing', description: 'AUTOTEST-ROUTE viewer spotted loose shingles' })).status);
  const vr = (await call('owner', 'GET', '/requests')).data.find(x => x.description.includes('viewer spotted'));
  console.log('viewer request type/status:', vr.reporter_type, vr.status);
  console.log('viewer still blocked from WOs:', (await call('viewer', 'POST', '/work-orders', { property_id: 1, category: 'HVAC', title: 'nope' })).status);

  await call('owner', 'PATCH', '/properties/1', { tenant_routing: 'maintenance' });
  console.log('routing reset');
})();
