/* OpsDeck SPA */
(function () {
'use strict';

// ---------------- state + api ----------------
let ME = null, META = { properties: [], units: [], technicians: [], vendors: [], assets: [], categories: [] };
const $app = document.getElementById('app');

async function api(path, opts = {}) {
  const o = { headers: {}, credentials: 'same-origin', ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
  const r = await fetch('/api' + path, o);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const GET = p => api(p);
const POST = (p, b) => api(p, { method: 'POST', body: b });
const PATCH = (p, b) => api(p, { method: 'PATCH', body: b });

// ---------------- helpers ----------------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + (+n || 0).toLocaleString(undefined, { maximumFractionDigits: (+n % 1 ? 2 : 0) });
const STATUS_LABEL = { new: 'New', assigned: 'Assigned', scheduled: 'Scheduled', in_progress: 'In progress', waiting_parts: 'Waiting for parts', waiting_approval: 'Waiting for approval', completed: 'Completed', cancelled: 'Cancelled' };
const STATUS_COLOR = { new: '#7A5BC7', assigned: '#6B7A82', scheduled: '#3568C9', in_progress: '#0E5A50', waiting_parts: '#F0A400', waiting_approval: '#C98A00', completed: '#2E8B57' };
const chip = s => `<span class="chip ${s}">${STATUS_LABEL[s] || s}</span>`;
const pri = p => `<span class="pri ${p}">${p}</span>`;
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date((d + '').replace(' ', 'T'));
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date((d + '').replace(' ', 'T'));
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function fmtMin(m) { if (m == null) return '—'; const h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m`; }
function propGradient(id) {
  const hues = [[168, 38], [204, 45], [24, 60], [262, 40], [140, 38], [332, 42], [48, 55], [190, 42]];
  const [h, s] = hues[id % hues.length];
  return `background:linear-gradient(135deg,hsl(${h},${s}%,34%),hsl(${(h + 28) % 360},${s}%,48%))`;
}
function healthRing(score) {
  const cls = score >= 80 ? 'h-good' : score >= 60 ? 'h-ok' : 'h-bad';
  return `<span class="health"><span class="ring ${cls}">${score}</span></span>`;
}
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2400);
}
function modal(html) {
  closeModal();
  const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.id = 'modal';
  bg.innerHTML = `<div class="modal"><button class="modal-close" onclick="closeModal()">×</button>${html}</div>`;
  bg.addEventListener('click', e => { if (e.target === bg) closeModal(); });
  document.body.appendChild(bg);
}
window.closeModal = () => { const m = document.getElementById('modal'); if (m) m.remove(); };
function fv(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function selOpts(arr, valKey, labelKey, selected) {
  return arr.map(o => `<option value="${o[valKey]}" ${o[valKey] == selected ? 'selected' : ''}>${esc(o[labelKey])}</option>`).join('');
}
const isMgmt = () => ME && (ME.role === 'owner' || ME.role === 'manager');

// ---------------- shell / nav ----------------
const NAV_MGMT = [
  ['#/dashboard', '⌂', 'Dashboard'], ['#/work-orders', '🗂', 'Work Orders'], ['#/properties', '🏘', 'Properties'],
  ['#/maintenance', '🔧', 'Maintenance'], ['#/calendar', '📅', 'Calendar'], ['#/team', '👷', 'Team'],
  ['#/vendors', '🚚', 'Vendors'], ['#/analytics', '📊', 'Analytics'], ['#/settings', '⚙', 'Settings'],
];
const NAV_TECH = [['#/today', '☀', 'Today'], ['#/jobs', '🗂', 'Jobs'], ['#/notifications', '🔔', 'Alerts'], ['#/profile', '👤', 'Profile']];
const TABS_MGMT = [['#/dashboard', '⌂', 'Home'], ['#/work-orders', '🗂', 'Work'], ['#/properties', '🏘', 'Props'], ['#/maintenance', '🔧', 'Maint.'], ['#/analytics', '📊', 'Data']];

let unreadCount = 0;
async function refreshUnread() {
  try { const n = await GET('/notifications'); unreadCount = n.filter(x => !x.read).length; } catch (e) {}
}

function shell(content, route) {
  const nav = isMgmt() ? NAV_MGMT : NAV_TECH;
  const tabs = isMgmt() ? TABS_MGMT : NAV_TECH;
  $app.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">O</span> OpsDeck</div>
      ${nav.map(([h, i, l]) => `<a class="nav-item ${route.startsWith(h) ? 'active' : ''}" href="${h}"><span>${i}</span>${l}</a>`).join('')}
      <div class="nav-spacer"></div>
      <a class="nav-item ${route.startsWith('#/notifications') ? 'active' : ''}" href="#/notifications"><span>🔔</span>Notifications ${unreadCount ? `<span style="background:var(--amber);color:#17242D;border-radius:99px;padding:1px 8px;font-size:11px;margin-left:auto">${unreadCount}</span>` : ''}</a>
      <div class="nav-user"><div>${esc(ME.name)}</div><div class="role">${ME.role}</div><button id="btn-logout">Sign out</button></div>
    </aside>
    <div class="main">
      <div class="topbar">
        <div class="brand" style="display:${window.innerWidth >= 900 ? 'none' : 'flex'}"><span class="brand-mark">O</span> OpsDeck</div>
        <div class="grow"></div>
        ${isMgmt() ? `<button class="icon-btn" id="btn-search" aria-label="Search">🔍</button>` : ''}
        <a class="icon-btn" href="#/notifications" aria-label="Notifications">🔔${unreadCount ? '<span class="badge-dot"></span>' : ''}</a>
      </div>
      <div class="page">${content}</div>
    </div>
  </div>
  <nav class="tabbar">${tabs.map(([h, i, l]) => `<a class="tab ${route.startsWith(h) ? 'active' : ''}" href="${h}"><span class="ti">${i}</span>${l}</a>`).join('')}</nav>`;
  const lo = document.getElementById('btn-logout');
  if (lo) lo.onclick = async () => { await POST('/auth/logout', {}); ME = null; location.hash = '#/login'; };
  const sb = document.getElementById('btn-search');
  if (sb) sb.onclick = openSearch;
}

// ---------------- login ----------------
function renderLogin(msg) {
  $app.innerHTML = `
  <div class="login-wrap"><div class="login-card">
    <div class="brand"><span class="brand-mark">O</span> OpsDeck</div>
    <div class="login-sub">Maintenance operations for your rental portfolio</div>
    ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
    <div class="field"><label>Email</label><input id="li-email" type="email" autocomplete="username" placeholder="owner@demo.com"></div>
    <div class="field"><label>Password</label><input id="li-pass" type="password" autocomplete="current-password" placeholder="demo123"></div>
    <button class="btn pri full" id="li-go">Sign in</button>
    <div style="font-size:12px;color:var(--muted);margin-top:16px;font-weight:600">Try a demo role (password: demo123)</div>
    <div class="demo-roles">
      <button data-e="owner@demo.com">Owner</button>
      <button data-e="manager@demo.com">Manager</button>
      <button data-e="tech@demo.com">Technician</button>
      <button data-e="vendor@demo.com">Vendor</button>
    </div>
  </div></div>`;
  const go = async (email, pass) => {
    try { ME = await POST('/auth/login', { email, password: pass }); await bootMeta(); location.hash = isMgmt() ? '#/dashboard' : '#/today'; render(); }
    catch (e) { renderLogin(e.message); }
  };
  document.getElementById('li-go').onclick = () => go(fv('li-email'), document.getElementById('li-pass').value);
  document.getElementById('li-pass').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('li-go').click(); });
  document.querySelectorAll('.demo-roles button').forEach(b => b.onclick = () => go(b.dataset.e, 'demo123'));
}

async function bootMeta() { try { META = await GET('/meta'); } catch (e) {} await refreshUnread(); }

// ---------------- dashboard ----------------
async function renderDashboard() {
  const d = await GET('/dashboard');
  const s = d.stats;
  const attnIco = { emergency: '🚨', approval: '💵', overdue: '⏰', parts: '📦', repeat: '↻' };
  const totalWOs = Object.entries(d.status_counts).filter(([k]) => k !== 'completed').reduce((a, [, v]) => a + v, 0) || 1;
  const barOrder = ['new', 'assigned', 'scheduled', 'in_progress', 'waiting_parts', 'waiting_approval'];
  const spendDelta = s.spend_prev_month ? Math.round(((s.spend_month - s.spend_prev_month) / s.spend_prev_month) * 100) : null;

  shell(`
    <div class="stat-row">
      <div class="stat"><div class="v">${s.open}</div><div class="l">Open work orders</div></div>
      <div class="stat ${s.urgent ? 'warn' : ''}"><div class="v">${s.urgent}</div><div class="l">Urgent issues</div></div>
      <div class="stat ${s.overdue ? 'bad' : ''}"><div class="v">${s.overdue}</div><div class="l">Overdue</div></div>
      <div class="stat"><div class="v">${s.completed_month}</div><div class="l">Completed this month</div></div>
      <div class="stat"><div class="v">${money(s.spend_month)}</div><div class="l">Spend this month${spendDelta != null ? ` (${spendDelta > 0 ? '+' : ''}${spendDelta}%)` : ''}</div></div>
      <div class="stat"><div class="v">${s.avg_completion_days ?? '—'}<span style="font-size:14px">d</span></div><div class="l">Avg completion time</div></div>
    </div>

    <div class="section-title">Needs attention</div>
    ${d.needs_attention.length ? d.needs_attention.map(a => `
      <a class="attn ${a.type === 'emergency' ? 'emergency' : ''}" href="${a.link}">
        <span class="ico">${attnIco[a.type] || '⚠'}</span>
        <div><div class="t">${esc(a.title)}</div><div class="s">${esc(a.sub)}</div></div>
        <span class="go">›</span>
      </a>`).join('') : `<div class="card empty">Nothing needs your attention right now.</div>`}

    <div class="section-title">Work order status</div>
    <div class="card">
      <div class="status-bars">${barOrder.filter(k => d.status_counts[k]).map(k =>
        `<div style="width:${(d.status_counts[k] / totalWOs) * 100}%;background:${STATUS_COLOR[k]}" title="${STATUS_LABEL[k]}"></div>`).join('')}</div>
      <div class="legend">${barOrder.map(k => `<span><span class="sw" style="background:${STATUS_COLOR[k]}"></span>${STATUS_LABEL[k]} · <b>${d.status_counts[k] || 0}</b></span>`).join('')}
        <span><span class="sw" style="background:${STATUS_COLOR.completed}"></span>Completed · <b>${d.status_counts.completed || 0}</b></span></div>
    </div>

    <div class="section-title">Maintenance spending <a class="more" href="#/analytics">Details ›</a></div>
    <div class="card">
      <div class="kv" style="grid-template-columns:1fr 1fr 1fr">
        <div><div class="k">This month</div><div class="v money">${money(s.spend_month)}</div></div>
        <div><div class="k">Last month</div><div class="v money">${money(s.spend_prev_month)}</div></div>
        <div><div class="k">Year to date</div><div class="v money">${money(s.spend_ytd)}</div></div>
      </div>
      <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:6px">
        ${d.spend_by_property.slice(0, 6).map(p => `
          <a class="list-item" href="#/properties/${p.id}">
            <div class="body"><div class="t">${esc(p.name)}</div><div class="s">${p.unit_count} unit${p.unit_count > 1 ? 's' : ''} · ${money(p.per_unit)}/unit YTD</div></div>
            <div class="end money">${money(p.total)}</div>
          </a>`).join('')}
      </div>
    </div>

    ${d.problem_properties.length ? `
    <div class="section-title">Problem properties</div>
    <div class="card">${d.problem_properties.map(p => `
      <a class="list-item" href="#/properties/${p.id}">
        <div class="body"><div class="t">${esc(p.name)}</div>
        <div class="s">${p.wo_90} work orders / 90d · ${money(p.spend_90)} spent${p.repeats ? ` · <span style="color:var(--amber);font-weight:700">${p.repeats} repeat pattern${p.repeats > 1 ? 's' : ''}</span>` : ''}</div></div>
        <span class="go">›</span>
      </a>`).join('')}</div>` : ''}
  `, '#/dashboard');
}

// ---------------- work orders (management list) ----------------
async function renderWorkOrders(qs) {
  const params = new URLSearchParams(qs || '');
  const status = params.get('status') || '';
  const wos = await GET('/work-orders' + (status ? `?status=${status}` : ''));
  const filters = ['', 'new', 'assigned', 'scheduled', 'in_progress', 'waiting_parts', 'waiting_approval', 'completed'];
  shell(`
    <div class="section-title">Work orders ${isMgmt() ? `<button class="btn pri" style="padding:8px 14px" id="wo-new">+ New</button>` : ''}</div>
    <div class="tabs">${filters.map(f => `<button class="${f === status ? 'active' : ''}" data-f="${f}">${f ? STATUS_LABEL[f] : 'All'}</button>`).join('')}</div>
    <div class="card">
      ${wos.length ? wos.map(w => `
        <a class="list-item" href="#/work-orders/${w.id}">
          <div class="body">
            <div class="s"><span class="wo-num">${w.number}</span> · ${pri(w.priority)} ${w.overdue ? '<b style="color:var(--red)">· OVERDUE</b>' : ''}</div>
            <div class="t">${esc(w.title)}</div>
            <div class="s">${esc(w.property_name)}${w.unit_label ? ' · Unit ' + esc(w.unit_label) : ''} · ${esc(w.tech_name || w.vendor_company || 'Unassigned')}</div>
          </div>
          <div class="end">${chip(w.status)}<div class="s" style="margin-top:3px">${w.total_cost ? money(w.total_cost) : ''}</div></div>
        </a>`).join('') : '<div class="empty">No work orders match this filter.</div>'}
    </div>`, '#/work-orders');
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { location.hash = '#/work-orders' + (b.dataset.f ? '?status=' + b.dataset.f : ''); });
  const nb = document.getElementById('wo-new'); if (nb) nb.onclick = () => openWOForm();
}

function openWOForm(preset = {}) {
  modal(`<h3>New work order</h3>
    <div class="field"><label>Property</label><select id="f-prop">${selOpts(META.properties, 'id', 'name', preset.property_id)}</select></div>
    <div class="row2">
      <div class="field"><label>Unit (optional)</label><select id="f-unit"></select></div>
      <div class="field"><label>Category</label><select id="f-cat">${META.categories.map(c => `<option>${c}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Title</label><input id="f-title" placeholder="AC not cooling — Unit A"></div>
    <div class="field"><label>Description</label><textarea id="f-desc"></textarea></div>
    <div class="field"><label>Instructions for technician</label><textarea id="f-instr" placeholder="Lockbox code, parking, parts to bring…"></textarea></div>
    <div class="row2">
      <div class="field"><label>Priority</label><select id="f-pri"><option>normal</option><option>emergency</option><option>high</option><option>low</option></select></div>
      <div class="field"><label>Est. minutes</label><input id="f-est" type="number" value="60"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Assign technician</label><select id="f-tech"><option value="">—</option>${selOpts(META.technicians, 'id', 'name')}</select></div>
      <div class="field"><label>Or vendor</label><select id="f-vend"><option value="">—</option>${selOpts(META.vendors, 'id', 'company')}</select></div>
    </div>
    <div class="row2">
      <div class="field"><label>Scheduled date</label><input id="f-sched" type="date"></div>
      <div class="field"><label>Due date</label><input id="f-due" type="date"></div>
    </div>
    <button class="btn pri full" id="f-save">Create work order</button>`);
  const unitSel = document.getElementById('f-unit');
  const fillUnits = () => {
    const pid = +fv('f-prop');
    unitSel.innerHTML = '<option value="">—</option>' + selOpts(META.units.filter(u => u.property_id === pid), 'id', 'label');
  };
  document.getElementById('f-prop').onchange = fillUnits; fillUnits();
  document.getElementById('f-save').onclick = async () => {
    try {
      const r = await POST('/work-orders', {
        property_id: +fv('f-prop'), unit_id: +fv('f-unit') || null, category: fv('f-cat'), title: fv('f-title'),
        description: fv('f-desc'), instructions: fv('f-instr'), priority: fv('f-pri'), estimated_minutes: +fv('f-est') || 60,
        assigned_user_id: +fv('f-tech') || null, assigned_vendor_id: +fv('f-vend') || null,
        scheduled_date: fv('f-sched') || null, due_date: fv('f-due') || null
      });
      closeModal(); toast(r.number + ' created'); location.hash = '#/work-orders/' + r.id;
    } catch (e) { toast(e.message); }
  };
}

// ---------------- work order detail ----------------
let timerInterval = null;
async function renderWODetail(id) {
  clearInterval(timerInterval);
  const d = await GET('/work-orders/' + id);
  const w = d.wo;
  const tech = !isMgmt();
  const before = d.photos.filter(p => p.kind === 'before');
  const after = d.photos.filter(p => p.kind === 'after');
  const receipts = d.photos.filter(p => p.kind === 'receipt');
  const totalMin = d.time.reduce((s, t) => s + (t.minutes || 0), 0);
  const matTotal = d.materials.reduce((s, m) => s + m.qty * m.unit_cost, 0);
  const done = w.status === 'completed' || w.status === 'cancelled';
  const pendingApproval = d.approvals.find(a => a.status === 'pending');

  const photoBlock = (title, arr, kind) => `
    <div style="margin-bottom:14px">
      <div class="photo-tag" style="margin-bottom:6px">${title}</div>
      ${arr.length ? `<div class="photo-grid">${arr.map(p => `<a href="${p.url}" target="_blank"><img src="${p.url}" alt="${title}"></a>`).join('')}</div>` : `<div class="s" style="color:var(--muted);font-size:13px">None yet</div>`}
      ${!done ? `<button class="btn sec" style="margin-top:8px;padding:8px 13px;font-size:13px" onclick="uploadPhoto(${w.id},'${kind}')">📷 Add ${kind} photo</button>` : ''}
    </div>`;

  // Technician action grid
  const timerRunning = !!d.active_timer;
  let actions = '';
  if (!done && (tech || isMgmt())) {
    actions = `<div class="action-grid">`;
    if (!timerRunning && ['new', 'assigned', 'scheduled'].includes(w.status))
      actions += `<button class="act primary" onclick="woStart(${w.id})"><span class="ai">▶</span>START JOB</button>`;
    if (timerRunning)
      actions += `<button class="act done" onclick="woComplete(${w.id})"><span class="ai">✓</span>COMPLETE JOB · <span class="timer-live" id="live-timer">0:00</span></button>`;
    if (!timerRunning && ['in_progress', 'waiting_parts', 'waiting_approval'].includes(w.status))
      actions += `<button class="act done" onclick="woComplete(${w.id})"><span class="ai">✓</span>COMPLETE JOB</button>`;
    actions += `
      <a class="act" href="https://maps.google.com/?q=${encodeURIComponent(w.address + ', ' + (w.city || ''))}" target="_blank"><span class="ai">🧭</span>Navigate</a>
      <button class="act" onclick="addNote(${w.id},0)"><span class="ai">✎</span>Add note</button>
      <button class="act" onclick="addNote(${w.id},1)"><span class="ai">🎙</span>Voice note</button>
      <button class="act" onclick="addMaterial(${w.id})"><span class="ai">🧰</span>Materials</button>
      <button class="act" onclick="uploadPhoto(${w.id},'receipt')"><span class="ai">🧾</span>Receipt</button>
      <button class="act warn" onclick="requestApproval(${w.id},${d.threshold})"><span class="ai">💵</span>Request approval</button>
      <button class="act warn" onclick="woStatus(${w.id},'waiting_parts')"><span class="ai">📦</span>Waiting for parts</button>
    </div>`;
  }

  shell(`
    <div class="detail-head">
      <div class="s"><span class="wo-num">${w.number}</span> · ${pri(w.priority)} · ${chip(w.status)} ${w.overdue ? '<b style="color:var(--red)">OVERDUE</b>' : ''}</div>
      <h1>${esc(w.title)}</h1>
      <div style="color:var(--muted);font-size:14px;margin-top:3px">${esc(w.property_name)}${w.unit_label ? ' · Unit ' + esc(w.unit_label) : ''} · ${esc(w.address)}</div>
    </div>

    ${pendingApproval && isMgmt() ? `
      <div class="attn"><span class="ico">💵</span>
        <div><div class="t">Approval requested: ${money(pendingApproval.amount)}</div>
        <div class="s">${esc(pendingApproval.requested_by_name)} — ${esc(pendingApproval.reason || '')}</div>
        <div style="display:flex;gap:8px;margin-top:9px">
          <button class="btn pri" style="padding:8px 14px" onclick="decide(${pendingApproval.id},'approved',${w.id})">Approve</button>
          <button class="btn danger" style="padding:8px 14px" onclick="decide(${pendingApproval.id},'declined',${w.id})">Decline</button>
          <button class="btn sec" style="padding:8px 14px" onclick="decide(${pendingApproval.id},'info_requested',${w.id})">Ask more</button>
        </div></div></div>` : ''}
    ${pendingApproval && tech ? `<div class="attn"><span class="ico">⏳</span><div><div class="t">Approval pending: ${money(pendingApproval.amount)}</div><div class="s">You'll be notified as soon as a decision is made.</div></div></div>` : ''}

    ${actions}

    ${w.instructions ? `<div class="card" style="margin-top:14px;border-left:4px solid var(--pine)"><div class="photo-tag">Instructions</div><div style="margin-top:4px">${esc(w.instructions)}</div></div>` : ''}
    ${w.description ? `<div class="card" style="margin-top:12px"><div class="photo-tag">Problem</div><div style="margin-top:4px">${esc(w.description)}</div></div>` : ''}

    <div class="section-title">Details ${isMgmt() && !done ? `<button class="more" onclick="editWO(${w.id})">Edit / assign ›</button>` : ''}</div>
    <div class="card"><div class="kv">
      <div><div class="k">Assigned to</div><div class="v">${esc(w.tech_name || w.vendor_company || 'Unassigned')}</div></div>
      <div><div class="k">Category</div><div class="v">${esc(w.category)}</div></div>
      <div><div class="k">Scheduled</div><div class="v">${fmtDate(w.scheduled_date)}</div></div>
      <div><div class="k">Due</div><div class="v">${fmtDate(w.due_date)}</div></div>
      <div><div class="k">Estimated</div><div class="v">${fmtMin(w.estimated_minutes)}</div></div>
      <div><div class="k">Time logged</div><div class="v">${fmtMin(totalMin)}${timerRunning ? ' <b style="color:var(--pine)">· running</b>' : ''}</div></div>
      <div><div class="k">Total cost</div><div class="v money">${money(w.total_cost)}</div></div>
      <div><div class="k">Created</div><div class="v">${fmtDate(w.created_at)}</div></div>
    </div></div>

    <div class="section-title">Photos</div>
    <div class="card">
      ${photoBlock('Before', before, 'before')}
      ${photoBlock('After', after, 'after')}
      ${receipts.length || !done ? photoBlock('Receipts', receipts, 'receipt') : ''}
    </div>

    <div class="section-title">Materials & expenses</div>
    <div class="card">
      ${d.materials.length ? d.materials.map(m => `<div class="list-item"><div class="body"><div class="t">${esc(m.name)}</div><div class="s">Qty ${m.qty} × ${money(m.unit_cost)}</div></div><div class="end money">${money(m.qty * m.unit_cost)}</div></div>`).join('') : '<div class="s" style="color:var(--muted)">No materials recorded</div>'}
      ${d.expenses.filter(e => e.category !== 'materials').map(e => `<div class="list-item"><div class="body"><div class="t">${esc(e.description || e.category)}</div><div class="s">${e.category.replace('_', ' ')} · ${fmtDate(e.incurred_on)}</div></div><div class="end money">${money(e.amount)}</div></div>`).join('')}
      <div class="list-item" style="border-top:1.5px solid var(--line)"><div class="body"><div class="t">Total</div></div><div class="end money" style="font-size:16px">${money(w.total_cost)}</div></div>
    </div>

    <div class="section-title">Notes & comments</div>
    <div class="card">
      ${d.comments.length ? d.comments.map(c => `<div class="list-item"><div class="body"><div class="s">${c.is_voice_note ? '🎙 ' : ''}<b>${esc(c.user_name)}</b> · ${fmtDateTime(c.created_at)}</div><div style="margin-top:2px">${esc(c.body)}</div></div></div>`).join('') : '<div class="s" style="color:var(--muted)">No notes yet</div>'}
      ${w.completion_notes ? `<div class="list-item"><div class="body"><div class="photo-tag">Completion notes</div><div style="margin-top:3px">${esc(w.completion_notes)}</div></div></div>` : ''}
    </div>

    <div class="section-title">Activity</div>
    <div class="card"><div class="timeline">
      ${d.history.slice().reverse().map(h => `<div class="tl-item"><div class="d">${fmtDateTime(h.created_at)}${h.user_name ? ' · ' + esc(h.user_name) : ''}</div><div class="t">${esc(h.detail || h.action)}</div></div>`).join('')}
    </div></div>

    ${isMgmt() && !done ? `<button class="btn danger full" style="margin-top:16px" onclick="woStatus(${w.id},'cancelled')">Cancel work order</button>` : ''}
  `, tech ? '#/jobs' : '#/work-orders');

  if (timerRunning) {
    const start = new Date(d.active_timer.started_at.replace(' ', 'T')).getTime();
    const el = () => {
      const t = document.getElementById('live-timer'); if (!t) return clearInterval(timerInterval);
      const s = Math.floor((Date.now() - start) / 1000);
      t.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };
    el(); timerInterval = setInterval(el, 1000);
  }
}

// WO detail actions (global)
window.woStart = async id => { try { await POST(`/work-orders/${id}/time/start`, {}); toast('Timer started'); render(); } catch (e) { toast(e.message); } };
window.woStatus = async (id, status) => { try { await PATCH(`/work-orders/${id}`, { status }); toast(STATUS_LABEL[status]); render(); } catch (e) { toast(e.message); } };
window.woComplete = id => {
  modal(`<h3>Complete job</h3>
    <div class="field"><label>Completion notes</label><textarea id="cn" placeholder="What was done, parts used, anything to watch…"></textarea></div>
    <div class="s" style="color:var(--muted);margin-bottom:12px">Tip: add an after photo before completing so the record is complete.</div>
    <button class="btn pri full" id="cgo">✓ Mark completed</button>`);
  document.getElementById('cgo').onclick = async () => {
    try { await PATCH(`/work-orders/${id}`, { status: 'completed', completion_notes: fv('cn') }); closeModal(); toast('Job completed'); render(); }
    catch (e) { toast(e.message); }
  };
};
window.addNote = (id, voice) => {
  modal(`<h3>${voice ? 'Voice note (transcribed)' : 'Add note'}</h3>
    <div class="field"><textarea id="nb" placeholder="${voice ? 'Dictate with your keyboard mic, then save…' : 'Type a quick note…'}"></textarea></div>
    <button class="btn pri full" id="ngo">Save note</button>`);
  document.getElementById('ngo').onclick = async () => {
    try { await POST(`/work-orders/${id}/comments`, { body: fv('nb'), is_voice_note: voice }); closeModal(); toast('Note saved'); render(); }
    catch (e) { toast(e.message); }
  };
};
window.addMaterial = id => {
  modal(`<h3>Record material</h3>
    <div class="field"><label>Item</label><input id="mn" placeholder="PVC fitting"></div>
    <div class="row2">
      <div class="field"><label>Qty</label><input id="mq" type="number" value="1" inputmode="decimal"></div>
      <div class="field"><label>Unit cost ($)</label><input id="mc" type="number" step="0.01" inputmode="decimal" placeholder="8.42"></div>
    </div>
    <button class="btn pri full" id="mgo">Add material</button>`);
  document.getElementById('mgo').onclick = async () => {
    try { await POST(`/work-orders/${id}/materials`, { name: fv('mn'), qty: fv('mq'), unit_cost: fv('mc') }); closeModal(); toast('Material added'); render(); }
    catch (e) { toast(e.message); }
  };
};
window.uploadPhoto = (id, kind) => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
  inp.onchange = async () => {
    if (!inp.files[0]) return;
    const fd = new FormData(); fd.append('photo', inp.files[0]); fd.append('kind', kind);
    try { await api(`/work-orders/${id}/photos`, { method: 'POST', body: fd }); toast('Photo added'); render(); }
    catch (e) { toast(e.message); }
  };
  inp.click();
};
window.requestApproval = (id, threshold) => {
  modal(`<h3>Request approval</h3>
    <div class="s" style="color:var(--muted);margin-bottom:12px">Anything over ${money(threshold)} needs sign-off before you spend.</div>
    <div class="field"><label>Estimated amount ($)</label><input id="aa" type="number" step="0.01" inputmode="decimal"></div>
    <div class="field"><label>What for</label><textarea id="ar" placeholder="50-gal water heater + expansion tank"></textarea></div>
    <button class="btn pri full" id="ago">Send request</button>`);
  document.getElementById('ago').onclick = async () => {
    try { await POST(`/work-orders/${id}/approvals`, { amount: fv('aa'), reason: fv('ar') }); closeModal(); toast('Approval requested'); render(); }
    catch (e) { toast(e.message); }
  };
};
window.decide = (aid, decision, woId) => {
  modal(`<h3>${{ approved: 'Approve', declined: 'Decline', info_requested: 'Request more information' }[decision]}</h3>
    <div class="field"><label>Note to technician (optional)</label><textarea id="dn"></textarea></div>
    <button class="btn pri full" id="dgo">Confirm</button>`);
  document.getElementById('dgo').onclick = async () => {
    try { await PATCH(`/approvals/${aid}`, { decision, note: fv('dn') }); closeModal(); toast('Decision sent'); render(); }
    catch (e) { toast(e.message); }
  };
};
window.editWO = async id => {
  const d = await GET('/work-orders/' + id); const w = d.wo;
  modal(`<h3>Edit ${w.number}</h3>
    <div class="row2">
      <div class="field"><label>Technician</label><select id="e-tech"><option value="">—</option>${selOpts(META.technicians, 'id', 'name', w.assigned_user_id)}</select></div>
      <div class="field"><label>Vendor</label><select id="e-vend"><option value="">—</option>${selOpts(META.vendors, 'id', 'company', w.assigned_vendor_id)}</select></div>
    </div>
    <div class="row2">
      <div class="field"><label>Scheduled</label><input id="e-sched" type="date" value="${w.scheduled_date || ''}"></div>
      <div class="field"><label>Due</label><input id="e-due" type="date" value="${w.due_date || ''}"></div>
    </div>
    <div class="field"><label>Priority</label><select id="e-pri">${['emergency', 'high', 'normal', 'low'].map(p => `<option ${p === w.priority ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
    <div class="field"><label>Instructions</label><textarea id="e-instr">${esc(w.instructions || '')}</textarea></div>
    <div class="field"><label>Status</label><select id="e-status">${Object.keys(STATUS_LABEL).map(s => `<option value="${s}" ${s === w.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></div>
    <button class="btn pri full" id="ego">Save changes</button>`);
  document.getElementById('ego').onclick = async () => {
    try {
      await PATCH(`/work-orders/${id}`, {
        assigned_user_id: +fv('e-tech') || null, assigned_vendor_id: +fv('e-vend') || null,
        scheduled_date: fv('e-sched') || null, due_date: fv('e-due') || null,
        priority: fv('e-pri'), instructions: fv('e-instr'), status: fv('e-status')
      });
      closeModal(); toast('Saved'); render();
    } catch (e) { toast(e.message); }
  };
};

// ---------------- technician: Today & Jobs ----------------
async function renderToday() {
  const wos = await GET('/work-orders?today=1');
  const open = wos.filter(w => !['completed', 'cancelled'].includes(w.status));
  const doneToday = wos.filter(w => w.status === 'completed');
  const dt = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  shell(`
    <div class="today-head">
      <h1>Today's work</h1>
      <div class="sub">${dt} · ${open.length} job${open.length !== 1 ? 's' : ''} on your board</div>
    </div>
    ${open.length ? open.map(jobCard).join('') : `<div class="card empty">No jobs assigned for today. Check <a href="#/jobs" style="color:var(--pine);font-weight:700">all jobs</a>.</div>`}
    ${doneToday.length ? `<div class="section-title">Completed today</div>${doneToday.map(jobCard).join('')}` : ''}
  `, '#/today');
}
function jobCard(w) {
  return `<a class="job-card" href="#/work-orders/${w.id}">
    <div class="job-rail ${w.priority}"></div>
    <div class="job-inner">
      <div class="job-top"><span class="wo-num">${w.number}</span>${chip(w.status)}</div>
      <div class="job-title">${esc(w.title)}</div>
      <div class="job-addr">📍 ${esc(w.address)}${w.unit_label ? ' · Unit ' + esc(w.unit_label) : ''}</div>
      <div class="job-tags">${pri(w.priority)}<span class="job-est">· est ${fmtMin(w.estimated_minutes)}</span>
        ${w.overdue ? '<b style="color:var(--red);font-size:12px">OVERDUE</b>' : ''}
        ${w.scheduled_date ? `<span class="job-est">· ${fmtDate(w.scheduled_date)}</span>` : ''}</div>
    </div></a>`;
}
async function renderJobs() {
  const wos = await GET('/work-orders');
  const open = wos.filter(w => !['completed', 'cancelled'].includes(w.status));
  const closed = wos.filter(w => w.status === 'completed').slice(0, 20);
  shell(`
    <div class="section-title">My open jobs</div>
    ${open.length ? open.map(jobCard).join('') : '<div class="card empty">No open jobs.</div>'}
    <div class="section-title">Recently completed</div>
    ${closed.map(jobCard).join('') || '<div class="card empty">Nothing completed yet.</div>'}
  `, '#/jobs');
}
async function renderProfile() {
  shell(`
    <div class="section-title">Profile</div>
    <div class="card">
      <div class="kv">
        <div><div class="k">Name</div><div class="v">${esc(ME.name)}</div></div>
        <div><div class="k">Role</div><div class="v" style="text-transform:capitalize">${ME.role}</div></div>
        <div><div class="k">Email</div><div class="v">${esc(ME.email)}</div></div>
      </div>
      <button class="btn sec full" style="margin-top:16px" onclick="(async()=>{await fetch('/api/auth/logout',{method:'POST'});location.hash='#/login';location.reload()})()">Sign out</button>
    </div>`, '#/profile');
}

// ---------------- properties ----------------
async function renderProperties() {
  const props = await GET('/properties');
  shell(`
    <div class="section-title">Properties <button class="btn pri" style="padding:8px 14px" id="p-new">+ Add</button></div>
    <div class="search-bar"><input id="p-filter" placeholder="Filter by name or address…"></div>
    <div class="prop-grid" id="p-grid">${props.map(propCard).join('')}</div>`, '#/properties');
  document.getElementById('p-filter').oninput = e => {
    const q = e.target.value.toLowerCase();
    document.getElementById('p-grid').innerHTML = props.filter(p => (p.name + p.address).toLowerCase().includes(q)).map(propCard).join('');
  };
  document.getElementById('p-new').onclick = () => {
    modal(`<h3>Add property</h3>
      <div class="field"><label>Name</label><input id="np-name" placeholder="Oak Haven Duplex"></div>
      <div class="field"><label>Address</label><input id="np-addr"></div>
      <div class="row2">
        <div class="field"><label>City</label><input id="np-city" value="Jacksonville"></div>
        <div class="field"><label>State</label><input id="np-state" value="FL"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Type</label><select id="np-type"><option>duplex</option><option>quadplex</option><option>single-family</option><option>small multifamily</option></select></div>
        <div class="field"><label>Year built</label><input id="np-year" type="number"></div>
      </div>
      <button class="btn pri full" id="np-go">Add property</button>`);
    document.getElementById('np-go').onclick = async () => {
      try {
        const r = await POST('/properties', { name: fv('np-name'), address: fv('np-addr'), city: fv('np-city'), state: fv('np-state'), type: fv('np-type'), year_built: +fv('np-year') || null });
        await bootMeta(); closeModal(); location.hash = '#/properties/' + r.id;
      } catch (e) { toast(e.message); }
    };
  };
}
function propCard(p) {
  return `<a class="prop-card" href="#/properties/${p.id}">
    <div class="prop-photo" style="${propGradient(p.id)}">${esc(p.name)}</div>
    <div class="prop-body">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:13px;color:var(--muted)">${esc(p.address)}</div>${healthRing(p.health)}
      </div>
      <div class="prop-meta">
        <span>${p.unit_count} unit${p.unit_count !== 1 ? 's' : ''}</span>
        <span>${p.open_wos} open WO${p.open_wos !== 1 ? 's' : ''}</span>
        <span class="money">${money(p.ytd_cost)} YTD</span>
      </div>
    </div></a>`;
}

async function renderPropertyDetail(id, qs) {
  const d = await GET('/properties/' + id);
  const p = d.property;
  const tab = new URLSearchParams(qs || '').get('tab') || 'overview';
  const tabs = ['overview', 'work', 'history', 'assets', 'pm', 'expenses', 'photos', 'inspections'];
  const tabLabel = { overview: 'Overview', work: `Open (${d.open_wos.length})`, history: 'History', assets: 'Assets', pm: 'Preventive', expenses: 'Expenses', photos: 'Photos', inspections: 'Inspections' };

  let body = '';
  if (tab === 'overview') {
    body = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div class="kv" style="flex:1">
            <div><div class="k">Type</div><div class="v" style="text-transform:capitalize">${esc(p.type || '—')}</div></div>
            <div><div class="k">Year built</div><div class="v">${p.year_built || '—'}</div></div>
            <div><div class="k">Units</div><div class="v">${d.units.length}</div></div>
            <div><div class="k">YTD maintenance</div><div class="v money">${money(d.ytd_cost)}</div></div>
          </div>
        </div>
        ${p.notes ? `<div style="margin-top:12px;font-size:13.5px;color:var(--ink-2)">📝 ${esc(p.notes)}</div>` : ''}
      </div>
      <div class="section-title">Property health</div>
      <div class="card">
        <div style="display:flex;align-items:center;gap:14px">
          ${healthRing(d.health.score)}
          <div><div style="font-family:var(--font-d);font-weight:800;font-size:22px">${d.health.score} / 100</div>
          <div class="s" style="color:var(--muted);font-size:13px">${d.health.reasons.length ? 'Why this score:' : 'No deductions — everything is in good shape.'}</div></div>
        </div>
        ${d.health.reasons.length ? `<div style="margin-top:10px">${d.health.reasons.map(r => `<div class="reason"><span>${esc(r.reason)}</span><span class="pts">${r.points}</span></div>`).join('')}</div>` : ''}
      </div>
      <div class="section-title">Units</div>
      <div class="card">${d.units.map(u => `<div class="list-item"><div class="body"><div class="t">Unit ${esc(u.label)}</div><div class="s">${u.beds || '—'} bd · ${u.baths || '—'} ba · ${u.sqft || '—'} sqft</div></div><div class="end s">${u.occupied ? 'Occupied' : '<b style="color:var(--amber)">Vacant</b>'}</div></div>`).join('')}
        <button class="btn sec" style="margin-top:10px;padding:8px 13px;font-size:13px" onclick="addUnit(${p.id})">+ Add unit</button></div>
      <div class="section-title">Recent maintenance timeline</div>
      <div class="card"><div class="timeline">
        ${d.history.slice(0, 8).map(w => `<div class="tl-item"><div class="d">${fmtDate(w.completed_at)}</div><div class="t"><a href="#/work-orders/${w.id}">${esc(w.title)}</a></div><div class="s">${esc(w.category)} · ${money(w.total_cost)}</div></div>`).join('') || '<div class="empty">No completed work yet.</div>'}
      </div></div>`;
  }
  if (tab === 'work') body = `<div class="card">${d.open_wos.map(w => `
      <a class="list-item" href="#/work-orders/${w.id}"><div class="body"><div class="s"><span class="wo-num">${w.number}</span> · ${pri(w.priority)}</div><div class="t">${esc(w.title)}</div><div class="s">${esc(w.tech_name || w.vendor_company || 'Unassigned')}</div></div><div class="end">${chip(w.status)}</div></a>`).join('') || '<div class="empty">No open work orders.</div>'}</div>`;
  if (tab === 'history') body = `<div class="card"><div class="timeline">${d.history.map(w => `<div class="tl-item"><div class="d">${fmtDate(w.completed_at)}</div><div class="t"><a href="#/work-orders/${w.id}">${esc(w.title)}</a></div><div class="s">${esc(w.category)} · ${esc(w.tech_name || w.vendor_company || '')} · ${money(w.total_cost)}</div></div>`).join('') || '<div class="empty">No history yet.</div>'}</div></div>`;
  if (tab === 'assets') body = `
      <div class="card">${d.assets.map(a => {
        const age = a.install_date ? ((Date.now() - new Date(a.install_date)) / 3.156e10).toFixed(1) : null;
        const pct = age && a.useful_life_years ? age / a.useful_life_years : null;
        return `<div class="list-item"><div class="body">
          <div class="t">${esc(a.name)}</div>
          <div class="s">${esc([a.manufacturer, a.model].filter(Boolean).join(' ') || a.category)}${a.serial ? ' · SN ' + esc(a.serial) : ''}</div>
          <div class="s">Installed ${a.install_date || '?'} ${age ? `· ${age} yrs old / ${a.useful_life_years || '?'} yr life` : ''}
          ${pct >= 1 ? '<b style="color:var(--red)"> · past useful life</b>' : pct >= .85 ? '<b style="color:var(--amber)"> · nearing replacement</b>' : ''}</div>
          ${a.notes ? `<div class="s">📝 ${esc(a.notes)}</div>` : ''}
        </div><div class="end s">${a.replacement_cost ? '<div class="money">' + money(a.replacement_cost) + '</div><div style="font-size:11px">replace est.</div>' : ''}</div></div>`;
      }).join('') || '<div class="empty">No assets recorded.</div>'}
      <button class="btn sec" style="margin-top:10px;padding:8px 13px;font-size:13px" onclick="addAsset(${p.id})">+ Add asset</button></div>`;
  if (tab === 'pm') body = `<div class="card">${d.pm.map(s => `
      <div class="list-item"><div class="body"><div class="t">${esc(s.title)}</div><div class="s">Every ${s.interval_days} days · ${esc(s.category)}</div></div>
      <div class="end"><div class="${s.next_due < new Date().toISOString().slice(0, 10) ? 'pri emergency' : 's'}">${s.next_due < new Date().toISOString().slice(0, 10) ? 'Overdue' : 'Due'} ${fmtDate(s.next_due)}</div></div></div>`).join('') || '<div class="empty">No preventive schedules.</div>'}
      <button class="btn sec" style="margin-top:10px;padding:8px 13px;font-size:13px" onclick="addPM(${p.id})">+ Add schedule</button></div>`;
  if (tab === 'expenses') body = `<div class="card table-wrap"><table class="data"><tr><th>Date</th><th>Description</th><th>Category</th><th style="text-align:right">Amount</th></tr>
      ${d.expenses.map(e => `<tr class="tr-click" onclick="${e.work_order_id ? `location.hash='#/work-orders/${e.work_order_id}'` : ''}"><td class="mono" style="font-size:12px">${fmtDate(e.incurred_on)}</td><td>${esc(e.description || e.wo_title || '—')}</td><td>${e.category.replace('_', ' ')}</td><td class="money" style="text-align:right">${money(e.amount)}</td></tr>`).join('')}
      </table>${!d.expenses.length ? '<div class="empty">No expenses.</div>' : ''}</div>`;
  if (tab === 'photos') body = d.photos.length ? `<div class="card"><div class="photo-grid" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))">${d.photos.map(ph => `<a href="${ph.url}" target="_blank"><img src="${ph.url}" alt="${ph.kind}"></a>`).join('')}</div></div>` : '<div class="card empty">Photos from work orders will collect here automatically.</div>';
  if (tab === 'inspections') body = `<div class="card">${d.inspections.map(i => `<div class="list-item"><div class="body"><div class="t">${fmtDate(i.inspected_on)} — <span style="text-transform:capitalize">${esc(i.condition || '')}</span></div><div class="s">${esc(i.summary || '')} · ${esc(i.inspector || '')}</div></div></div>`).join('') || '<div class="empty">No inspections recorded.</div>'}</div>`;

  shell(`
    <div class="prop-photo" style="${propGradient(p.id)};border-radius:16px;height:110px;margin-bottom:14px">${esc(p.name)}</div>
    <div class="detail-head" style="padding-top:0">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="color:var(--muted);font-size:14px">${esc(p.address)}, ${esc(p.city || '')} ${esc(p.state || '')}</div>
        <button class="btn pri" style="padding:8px 14px" onclick="openWOFromProp(${p.id})">+ Work order</button>
      </div>
    </div>
    <div class="tabs">${tabs.map(t => `<button class="${t === tab ? 'active' : ''}" onclick="location.hash='#/properties/${p.id}?tab=${t}'">${tabLabel[t]}</button>`).join('')}</div>
    ${body}`, '#/properties');
}
window.openWOFromProp = pid => openWOForm({ property_id: pid });
window.addUnit = pid => {
  modal(`<h3>Add unit</h3>
    <div class="field"><label>Label</label><input id="u-label" placeholder="A"></div>
    <div class="row2"><div class="field"><label>Beds</label><input id="u-beds" type="number"></div><div class="field"><label>Baths</label><input id="u-baths" type="number" step="0.5"></div></div>
    <button class="btn pri full" id="u-go">Add unit</button>`);
  document.getElementById('u-go').onclick = async () => {
    try { await POST(`/properties/${pid}/units`, { label: fv('u-label'), beds: +fv('u-beds') || null, baths: +fv('u-baths') || null }); await bootMeta(); closeModal(); render(); } catch (e) { toast(e.message); }
  };
};
window.addAsset = pid => {
  modal(`<h3>Add asset</h3>
    <div class="row2">
      <div class="field"><label>Category</label><select id="a-cat"><option>HVAC</option><option>Water Heater</option><option>Roof</option><option>Appliance</option><option>Electrical Panel</option><option>Plumbing</option><option>Other</option></select></div>
      <div class="field"><label>Name</label><input id="a-name" placeholder="HVAC — Unit A"></div>
    </div>
    <div class="row2"><div class="field"><label>Manufacturer</label><input id="a-mfr"></div><div class="field"><label>Model</label><input id="a-model"></div></div>
    <div class="row2"><div class="field"><label>Serial</label><input id="a-ser"></div><div class="field"><label>Install date</label><input id="a-inst" type="date"></div></div>
    <div class="row2"><div class="field"><label>Useful life (yrs)</label><input id="a-life" type="number"></div><div class="field"><label>Replacement cost ($)</label><input id="a-repl" type="number"></div></div>
    <div class="row2"><div class="field"><label>Warranty expires</label><input id="a-warr" type="date"></div><div class="field"><label>Purchase price ($)</label><input id="a-price" type="number"></div></div>
    <button class="btn pri full" id="a-go">Add asset</button>`);
  document.getElementById('a-go').onclick = async () => {
    try {
      await POST(`/properties/${pid}/assets`, { category: fv('a-cat'), name: fv('a-name'), manufacturer: fv('a-mfr'), model: fv('a-model'), serial: fv('a-ser'), install_date: fv('a-inst') || null, useful_life_years: +fv('a-life') || null, replacement_cost: +fv('a-repl') || null, warranty_expires: fv('a-warr') || null, purchase_price: +fv('a-price') || null });
      closeModal(); render();
    } catch (e) { toast(e.message); }
  };
};
window.addPM = pid => {
  modal(`<h3>Preventive maintenance schedule</h3>
    <div class="field"><label>Title</label><input id="pm-title" placeholder="HVAC filter change"></div>
    <div class="row2">
      <div class="field"><label>Category</label><select id="pm-cat">${(META.categories.length ? META.categories : ['General']).map(c => `<option>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Every (days)</label><input id="pm-int" type="number" value="90"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Next due</label><input id="pm-due" type="date" value="${new Date(Date.now() + 6048e5).toISOString().slice(0, 10)}"></div>
      <div class="field"><label>Est. minutes</label><input id="pm-est" type="number" value="60"></div>
    </div>
    <div class="field"><label>Instructions</label><textarea id="pm-instr"></textarea></div>
    <div class="s" style="color:var(--muted);margin-bottom:12px">A work order is generated automatically as each due date approaches.</div>
    <button class="btn pri full" id="pm-go">Create schedule</button>`);
  document.getElementById('pm-go').onclick = async () => {
    try { await POST('/pm', { property_id: pid, title: fv('pm-title'), category: fv('pm-cat'), interval_days: +fv('pm-int'), next_due: fv('pm-due'), estimated_minutes: +fv('pm-est'), instructions: fv('pm-instr') }); closeModal(); toast('Schedule created'); render(); }
    catch (e) { toast(e.message); }
  };
};

// ---------------- maintenance (requests + PM) ----------------
async function renderMaintenance() {
  const [reqs, pm] = await Promise.all([GET('/requests'), GET('/pm')]);
  const open = reqs.filter(r => r.status === 'open');
  const today = new Date().toISOString().slice(0, 10);
  shell(`
    <div class="section-title">Maintenance requests <button class="btn pri" style="padding:8px 14px" id="r-new">+ Request</button></div>
    <div class="card">
      ${open.length ? open.map(r => `
        <div class="list-item"><div class="body">
          <div class="s">${pri(r.priority)} · ${esc(r.category)} · ${fmtDate(r.created_at)}</div>
          <div class="t">${esc(r.property_name)}${r.unit_label ? ' · Unit ' + esc(r.unit_label) : ''}</div>
          <div class="s">${esc(r.description)}</div>
          <div class="s">Reported by ${esc(r.reported_by || '—')}</div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn pri" style="padding:7px 13px;font-size:13px" onclick="convertReq(${r.id})">→ Create work order</button>
            <button class="btn sec" style="padding:7px 13px;font-size:13px" onclick="dismissReq(${r.id})">Dismiss</button>
          </div></div></div>`).join('') : '<div class="empty">No open requests.</div>'}
      ${reqs.filter(r => r.status !== 'open').slice(0, 8).map(r => `
        <div class="list-item"><div class="body"><div class="t" style="color:var(--muted)">${esc(r.description.slice(0, 70))}</div><div class="s">${esc(r.property_name)}</div></div><div class="end">${chip(r.status)}</div></div>`).join('')}
    </div>
    <div class="section-title">Preventive maintenance <button class="more" onclick="generatePM()">Generate due WOs ›</button></div>
    <div class="card">${pm.map(s => `
      <div class="list-item"><div class="body"><div class="t">${esc(s.title)}</div><div class="s">${esc(s.property_name)} · every ${s.interval_days} days</div></div>
      <div class="end ${s.next_due < today ? 'pri emergency' : 's'}" style="font-size:12.5px">${s.next_due < today ? 'Overdue ' : ''}${fmtDate(s.next_due)}</div></div>`).join('') || '<div class="empty">No schedules yet — add one from a property page.</div>'}
    </div>`, '#/maintenance');
  document.getElementById('r-new').onclick = () => {
    modal(`<h3>New maintenance request</h3>
      <div class="field"><label>Property</label><select id="r-prop">${selOpts(META.properties, 'id', 'name')}</select></div>
      <div class="row2">
        <div class="field"><label>Unit</label><select id="r-unit"></select></div>
        <div class="field"><label>Category</label><select id="r-cat">${META.categories.map(c => `<option>${c}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Description</label><textarea id="r-desc"></textarea></div>
      <div class="row2">
        <div class="field"><label>Priority</label><select id="r-pri"><option>normal</option><option>emergency</option><option>high</option><option>low</option></select></div>
        <div class="field"><label>Reported by</label><input id="r-rep" placeholder="Tenant — Unit A"></div>
      </div>
      <button class="btn pri full" id="r-go">Submit request</button>`);
    const fill = () => { document.getElementById('r-unit').innerHTML = '<option value="">—</option>' + selOpts(META.units.filter(u => u.property_id === +fv('r-prop')), 'id', 'label'); };
    document.getElementById('r-prop').onchange = fill; fill();
    document.getElementById('r-go').onclick = async () => {
      try { await POST('/requests', { property_id: +fv('r-prop'), unit_id: +fv('r-unit') || null, category: fv('r-cat'), description: fv('r-desc'), priority: fv('r-pri'), reported_by: fv('r-rep') }); closeModal(); toast('Request submitted'); render(); }
      catch (e) { toast(e.message); }
    };
  };
}
window.convertReq = async id => { try { const r = await POST(`/requests/${id}/convert`, {}); toast(r.number + ' created'); location.hash = '#/work-orders/' + r.id; } catch (e) { toast(e.message); } };
window.dismissReq = async id => { try { await POST(`/requests/${id}/dismiss`, {}); render(); } catch (e) { toast(e.message); } };
window.generatePM = async () => { try { const r = await POST('/pm/generate', {}); toast(`Checked schedules — work orders are up to date`); render(); } catch (e) { toast(e.message); } };

// ---------------- calendar ----------------
let calOffset = 0;
async function renderCalendar() {
  const d = await GET('/calendar');
  const base = new Date(); base.setDate(1); base.setMonth(base.getMonth() + calOffset);
  const y = base.getFullYear(), m = base.getMonth();
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);
  const evByDay = {};
  d.work_orders.forEach(w => { if (w.scheduled_date) (evByDay[w.scheduled_date] = evByDay[w.scheduled_date] || []).push({ t: w.title, l: '#/work-orders/' + w.id, pm: false }); });
  d.pm.forEach(s => { (evByDay[s.next_due] = evByDay[s.next_due] || []).push({ t: '🔁 ' + s.title, l: '#/maintenance', pm: true }); });
  let cells = '';
  for (let i = 0; i < first; i++) cells += '<div class="cal-cell dim"></div>';
  for (let day = 1; day <= days; day++) {
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const evs = evByDay[ds] || [];
    cells += `<div class="cal-cell ${ds === todayStr ? 'today' : ''}"><div class="cal-day">${day}</div>
      ${evs.slice(0, 3).map(e => `<a class="cal-ev ${e.pm ? 'pm' : ''}" href="${e.l}" title="${esc(e.t)}">${esc(e.t)}</a>`).join('')}
      ${evs.length > 3 ? `<div style="font-size:9.5px;color:var(--muted)">+${evs.length - 3} more</div>` : ''}</div>`;
  }
  shell(`
    <div class="section-title">
      <span>${base.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
      <span><button class="btn sec" style="padding:6px 12px" id="cal-prev">‹</button>
      <button class="btn sec" style="padding:6px 12px" id="cal-next">›</button></span>
    </div>
    <div class="cal-head">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(x => `<div>${x}</div>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <div class="legend" style="margin-top:12px"><span><span class="sw" style="background:var(--pine)"></span>Scheduled work</span><span><span class="sw" style="background:var(--violet)"></span>Preventive maintenance</span></div>
  `, '#/calendar');
  document.getElementById('cal-prev').onclick = () => { calOffset--; render(); };
  document.getElementById('cal-next').onclick = () => { calOffset++; render(); };
}

// ---------------- team / vendors ----------------
async function renderTeam() {
  const team = await GET('/team');
  shell(`
    <div class="section-title">Technician scorecards</div>
    <div class="s" style="color:var(--muted);font-size:13px;margin-bottom:12px">Raw metrics rather than a single score — interpret alongside job mix and difficulty.</div>
    ${team.map(t => `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-family:var(--font-d);font-weight:700;font-size:16px">${esc(t.name)}</div>
          <span class="chip in_progress">${t.currently_assigned} active</span>
        </div>
        <div class="kv" style="grid-template-columns:repeat(3,1fr)">
          <div><div class="k">Completed</div><div class="v">${t.jobs_completed}</div></div>
          <div><div class="k">Avg job time</div><div class="v">${fmtMin(t.avg_completion_minutes)}</div></div>
          <div><div class="k">First-time fix</div><div class="v">${t.first_time_fix_rate != null ? t.first_time_fix_rate + '%' : '—'}</div></div>
          <div><div class="k">Repeat rate</div><div class="v">${t.repeat_repair_rate != null ? t.repeat_repair_rate + '%' : '—'}</div></div>
          <div><div class="k">Avg cost / WO</div><div class="v money">${t.avg_cost_per_wo != null ? money(t.avg_cost_per_wo) : '—'}</div></div>
          <div><div class="k">On-time</div><div class="v">${t.on_time_pct != null ? t.on_time_pct + '%' : '—'}</div></div>
        </div>
      </div>`).join('')}`, '#/team');
}
async function renderVendors() {
  const vendors = await GET('/vendors');
  shell(`
    <div class="section-title">Vendors <button class="btn pri" style="padding:8px 14px" id="v-new">+ Add</button></div>
    ${vendors.map(v => `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div><div style="font-family:var(--font-d);font-weight:700;font-size:16px">${esc(v.company)}</div>
          <div class="s" style="color:var(--muted)">${esc(v.trade || '')} · ${esc(v.contact_name || '')} · ${esc(v.phone || '')}</div></div>
          <div class="end" style="text-align:right"><div class="money">${money(v.ytd_spend)}</div><div class="s" style="font-size:11px;color:var(--muted)">YTD spend</div></div>
        </div>
        <div class="prop-meta" style="margin-top:8px"><span>${v.open_wos} open</span><span>${v.completed_wos} completed</span></div>
      </div>`).join('')}`, '#/vendors');
  document.getElementById('v-new').onclick = () => {
    modal(`<h3>Add vendor</h3>
      <div class="field"><label>Company</label><input id="v-co"></div>
      <div class="row2"><div class="field"><label>Trade</label><input id="v-tr" placeholder="HVAC"></div><div class="field"><label>Contact</label><input id="v-cn"></div></div>
      <div class="row2"><div class="field"><label>Phone</label><input id="v-ph"></div><div class="field"><label>Email</label><input id="v-em"></div></div>
      <button class="btn pri full" id="v-go">Add vendor</button>`);
    document.getElementById('v-go').onclick = async () => {
      try { await POST('/vendors', { company: fv('v-co'), trade: fv('v-tr'), contact_name: fv('v-cn'), phone: fv('v-ph'), email: fv('v-em') }); await bootMeta(); closeModal(); render(); } catch (e) { toast(e.message); }
    };
  };
}

// ---------------- analytics ----------------
async function renderAnalytics() {
  const a = await GET('/analytics');
  const maxSpend = Math.max(...a.monthly_spend.map(r => r.total), 1);
  shell(`
    <div class="section-title">Monthly maintenance spend</div>
    <div class="card"><div class="bars">
      ${a.monthly_spend.map(r => `<div class="bar-col"><div class="bv">${money(Math.round(r.total))}</div><div class="bar" style="height:${(r.total / maxSpend) * 100}%"></div><div class="bl">${r.m.slice(5)}</div></div>`).join('')}
    </div></div>

    <div class="section-title">Spend by category (180 days)</div>
    <div class="card table-wrap"><table class="data"><tr><th>Category</th><th>Work orders</th><th style="text-align:right">Total</th></tr>
      ${a.by_category.map(c => `<tr><td>${esc(c.category)}</td><td>${c.wos}</td><td class="money" style="text-align:right">${money(c.total)}</td></tr>`).join('')}
    </table></div>

    ${a.repeat_repairs.length ? `
    <div class="section-title">⚠ Repeat repairs detected</div>
    ${a.repeat_repairs.map(r => `
      <div class="attn"><span class="ico">↻</span><div>
        <div class="t">${esc(r.property)} — ${esc(r.category)}</div>
        <div class="s">${esc(r.message)} Total spent: <b>${money(r.total_spent)}</b></div>
        <div class="s" style="color:var(--pine);font-weight:600;margin-top:2px">${esc(r.action)}</div>
      </div><a class="go" href="#/properties/${r.property_id}">›</a></div>`).join('')}` : ''}

    <div class="section-title">CapEx forecast — next ${a.capex.window_months} months</div>
    <div class="card">
      <div style="font-family:var(--font-d);font-weight:800;font-size:24px">${money(a.capex.estimated_total)}</div>
      <div class="s" style="color:var(--muted);font-size:12.5px;margin-bottom:12px">Estimated capital requirement · ${Object.entries(a.capex.by_category).map(([k, v]) => `${v} ${k}`).join(' · ')}</div>
      ${a.capex.items.map(i => `
        <div class="list-item"><div class="body">
          <div class="t">${esc(i.name)} — ${esc(i.property)}</div>
          <div class="s">${i.age_years} yrs old / ${i.useful_life_years} yr life · ${i.overdue ? '<b style="color:var(--red)">past due for replacement</b>' : `~${i.months_remaining} months remaining`}</div>
        </div><div class="end money">${i.est_replacement_cost ? money(i.est_replacement_cost) : '—'}</div></div>`).join('')}
      <div class="s" style="color:var(--muted);font-size:12px;margin-top:10px">⚠ ${esc(a.capex.disclaimer)}</div>
    </div>`, '#/analytics');
}

// ---------------- notifications / settings / search ----------------
const NOTIF_ICO = { emergency: '🚨', approval: '💵', approval_decision: '💵', repeat: '↻', pm_due: '🔁', assigned: '🗂', completed: '✅', request: '📥', high_cost: '💸', overdue: '⏰' };
async function renderNotifications() {
  const items = await GET('/notifications');
  shell(`
    <div class="section-title">Notifications ${items.some(i => !i.read) ? `<button class="more" id="n-all">Mark all read</button>` : ''}</div>
    <div class="card">
      ${items.length ? items.map(n => `
        <a class="notif-item ${n.read ? '' : 'unread'}" href="${n.link || '#'}" onclick="markRead(${n.id})">
          <span class="ico">${NOTIF_ICO[n.kind] || '🔔'}</span>
          <div><div class="t" style="font-weight:600;font-size:14px">${esc(n.title)}</div>
          <div class="s" style="font-size:13px;color:var(--muted)">${esc(n.body || '')}</div>
          <div class="s" style="font-size:11.5px;color:var(--muted)">${fmtDateTime(n.created_at)}</div></div>
        </a>`).join('') : '<div class="empty">No notifications.</div>'}
    </div>`, '#/notifications');
  const b = document.getElementById('n-all');
  if (b) b.onclick = async () => { await POST('/notifications/read', {}); await refreshUnread(); render(); };
}
window.markRead = async id => { try { await POST('/notifications/read', { id }); await refreshUnread(); } catch (e) {} };

async function renderSettings() {
  const meta = await GET('/meta');
  shell(`
    <div class="section-title">Settings</div>
    <div class="card">
      <div class="field"><label>Approval threshold — technicians can spend up to this without sign-off</label>
        <input id="s-thr" type="number" value="${meta.threshold}"></div>
      <button class="btn pri" id="s-go">Save</button>
    </div>
    <div class="section-title">Account</div>
    <div class="card"><div class="kv">
      <div><div class="k">Signed in as</div><div class="v">${esc(ME.name)}</div></div>
      <div><div class="k">Role</div><div class="v" style="text-transform:capitalize">${ME.role}</div></div>
    </div></div>`, '#/settings');
  document.getElementById('s-go').onclick = async () => {
    try { await PATCH('/settings', { approval_threshold: +fv('s-thr') }); toast('Saved'); } catch (e) { toast(e.message); }
  };
}

function openSearch() {
  modal(`<h3>Search</h3>
    <div class="search-bar"><input id="gs" placeholder="123 Oak · HVAC · Mike · water heater…" autofocus></div>
    <div id="gs-results"></div>`);
  const inp = document.getElementById('gs');
  let t;
  inp.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = inp.value.trim();
      const out = document.getElementById('gs-results');
      if (!q) { out.innerHTML = ''; return; }
      const r = await GET('/search?q=' + encodeURIComponent(q));
      out.innerHTML = `
        ${r.properties.length ? `<div class="photo-tag" style="margin:10px 0 4px">Properties</div>` + r.properties.map(p => `<a class="list-item" href="#/properties/${p.id}" onclick="closeModal()"><div class="body"><div class="t">${esc(p.name)}</div><div class="s">${esc(p.address)}</div></div></a>`).join('') : ''}
        ${r.work_orders.length ? `<div class="photo-tag" style="margin:10px 0 4px">Work orders</div>` + r.work_orders.map(w => `<a class="list-item" href="#/work-orders/${w.id}" onclick="closeModal()"><div class="body"><div class="s wo-num">${w.number}</div><div class="t">${esc(w.title)}</div><div class="s">${esc(w.property_name)}</div></div><div class="end">${chip(w.status)}</div></a>`).join('') : ''}
        ${r.assets.length ? `<div class="photo-tag" style="margin:10px 0 4px">Assets</div>` + r.assets.map(x => `<a class="list-item" href="#/properties/${x.property_id}?tab=assets" onclick="closeModal()"><div class="body"><div class="t">${esc(x.name)}</div><div class="s">${esc(x.category)} · ${esc(x.property_name)}</div></div></a>`).join('') : ''}
        ${r.people.length ? `<div class="photo-tag" style="margin:10px 0 4px">People</div>` + r.people.map(u => `<div class="list-item"><div class="body"><div class="t">${esc(u.name)}</div><div class="s" style="text-transform:capitalize">${u.role}</div></div></div>`).join('') : ''}
        ${!r.properties.length && !r.work_orders.length && !r.assets.length && !r.people.length ? '<div class="empty">No matches — try a shorter search.</div>' : ''}`;
    }, 250);
  };
}

// ---------------- router ----------------
async function render() {
  const hash = location.hash || '#/';
  if (!ME) {
    try { ME = await GET('/auth/me'); await bootMeta(); } catch (e) { return renderLogin(); }
  }
  await refreshUnread();
  const [route, qs] = hash.split('?');
  try {
    if (route === '#/' || route === '#/login' || route === '') {
      location.hash = isMgmt() ? '#/dashboard' : '#/today'; return;
    }
    const woMatch = route.match(/^#\/work-orders\/(\d+)$/);
    const propMatch = route.match(/^#\/properties\/(\d+)$/);
    if (woMatch) return await renderWODetail(+woMatch[1]);
    if (propMatch && isMgmt()) return await renderPropertyDetail(+propMatch[1], qs);
    if (isMgmt()) {
      if (route === '#/dashboard') return await renderDashboard();
      if (route === '#/work-orders') return await renderWorkOrders(qs);
      if (route === '#/properties') return await renderProperties();
      if (route === '#/maintenance') return await renderMaintenance();
      if (route === '#/calendar') return await renderCalendar();
      if (route === '#/team') return await renderTeam();
      if (route === '#/vendors') return await renderVendors();
      if (route === '#/analytics') return await renderAnalytics();
      if (route === '#/settings') return await renderSettings();
    } else {
      if (route === '#/today') return await renderToday();
      if (route === '#/jobs') return await renderJobs();
      if (route === '#/profile') return await renderProfile();
    }
    if (route === '#/notifications') return await renderNotifications();
    location.hash = isMgmt() ? '#/dashboard' : '#/today';
  } catch (e) {
    if (e.message === 'Not signed in') { ME = null; return renderLogin(); }
    $app.querySelector('.page') ? ($app.querySelector('.page').innerHTML = `<div class="card empty">${esc(e.message)}</div>`) : renderLogin(e.message);
  }
}
window.addEventListener('hashchange', render);
render();
})();
