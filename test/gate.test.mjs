const B = 'http://localhost:3000/api'; const j = {};
async function c(u, m, p, b) {
  const h = { 'Content-Type': 'application/json' }; if (j[u]) h.Cookie = j[u];
  const r = await fetch(B + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const s = r.headers.get('set-cookie'); if (s) j[u] = s.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const li = (u, e) => c(u, 'POST', '/auth/login', { email: e, password: 'demo123' });

(async () => {
  await li('mgr', 'manager@demo.com'); await li('tech', 'tech@demo.com');
  const w = (await c('mgr', 'POST', '/work-orders', { property_id: 1, category: 'HVAC', title: 'AUTOTEST gate check', assigned_user_id: 3 })).data;
  const blocked = await c('tech', 'POST', `/work-orders/${w.id}/time/start`);
  console.log('tech start w/o before photo →', blocked.status, blocked.data.needs || blocked.data.error);
  console.log('manager override →', (await c('mgr', 'POST', `/work-orders/${w.id}/time/start`, { override: true, override_note: 'test' })).status);
  const w2 = (await c('mgr', 'POST', '/work-orders', { property_id: 1, category: 'Pest', title: 'AUTOTEST gate pest', assigned_user_id: 3 })).data;
  console.log('Pest job (no photo required) starts →', (await c('tech', 'POST', `/work-orders/${w2.id}/time/start`)).status);
  const u = (await c('mgr', 'POST', '/properties/1/units', { label: 'AUTOTESTZ' })).data;
  const before = (await c('mgr', 'GET', '/properties/1')).data.units.find(x => x.id === u.id);
  console.log('new unit defaults vacant →', before.occupied === 0);
  await c('mgr', 'PATCH', '/units/' + u.id, { occupied: 1 });
  const after = (await c('mgr', 'GET', '/properties/1')).data.units.find(x => x.id === u.id);
  console.log('toggled to occupied →', after.occupied === 1);
})();
