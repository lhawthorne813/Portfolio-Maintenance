const B = 'http://localhost:3000/api'; const j = {};
async function c(u, m, p, b) {
  const h = { 'Content-Type': 'application/json' }; if (j[u]) h.Cookie = j[u];
  const r = await fetch(B + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const s = r.headers.get('set-cookie'); if (s) j[u] = s.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

(async () => {
  // Bayview Holdings has an owner and no manager — exactly the case in question.
  await c('bay', 'POST', '/auth/login', { email: 'owner@bayview.demo', password: 'demo123' });
  const meta = (await c('bay', 'GET', '/meta')).data;
  console.log('owner-only org: has_managers =', meta.has_managers, '| supervisor =', meta.supervisor && meta.supervisor.name, meta.supervisor && meta.supervisor.role);

  // Owner invites a tech directly and works with them
  const inv = (await c('bay', 'POST', '/team/invites', { email: 'solotech@bayview.demo', role: 'technician', name: 'Solo Tech' })).data;
  const acc = await fetch(B + '/auth/accept-invite', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inv.token, name: 'Solo Tech', password: 'password123' }) });
  const cookie = acc.headers.get('set-cookie'); j.solo = cookie ? cookie.split(';')[0] : null;
  console.log('tech joined owner-run org:', acc.status === 200);

  const prop = (await c('bay', 'GET', '/properties')).data[0];
  const wo = (await c('bay', 'POST', '/work-orders', { property_id: prop.id, category: 'Plumbing', title: 'SOLOTEST drain line' })).data;
  const techId = (await c('bay', 'GET', '/team/users')).data.users.find(u => u.email === 'solotech@bayview.demo').id;
  await c('bay', 'PATCH', '/work-orders/' + wo.id, { assigned_user_id: techId });

  // Tech sees who to call — the owner, since there's no manager
  const det = (await c('solo', 'GET', '/work-orders/' + wo.id)).data;
  console.log('tech contact card shows:', det.supervisor && det.supervisor.name, '(' + (det.supervisor && det.supervisor.role) + ')');
  console.log('single-tier approvals:', det.has_managers === false);

  // A small amount that would be "manager tier" in a two-tier org routes to the owner instead
  const ap = (await c('solo', 'POST', `/work-orders/${wo.id}/approvals`, { amount: 200, reason: 'parts' })).data;
  console.log('$200 approval required_role =', ap.required_role, '| single_tier =', ap.single_tier);
  console.log('owner can approve it:', (await c('bay', 'PATCH', '/approvals/' + ap.id, { decision: 'approved' })).status === 200);

  // Owner gets the notification (nobody else exists to catch it)
  const notifs = (await c('bay', 'GET', '/notifications')).data.filter(n => n.kind === 'approval');
  console.log('owner received the approval alert:', notifs.length > 0);
})();
