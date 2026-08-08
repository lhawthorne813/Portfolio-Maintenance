/* Steadhold SPA — V2 */
(function () {
'use strict';

let ME = null, META = { properties: [], units: [], technicians: [], vendors: [], assets: [], categories: [], asset_types: [] };
const $app = document.getElementById('app');

async function api(path, opts = {}) {
  return window.Offline.request(path, opts);   // read cache + write queue live here
}
const GET = p => api(p);
const POST = (p, b) => api(p, { method: 'POST', body: b });
const isQueued = r => r && r.__queued;
const PATCH = (p, b) => api(p, { method: 'PATCH', body: b });
const PUT = (p, b) => api(p, { method: 'PUT', body: b });

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + (+n || 0).toLocaleString(undefined, { maximumFractionDigits: (+n % 1 ? 2 : 0) });
const STATUS_LABEL = { new: 'New', assigned: 'Assigned', scheduled: 'Scheduled', in_progress: 'In progress', waiting_parts: 'Waiting for parts', waiting_approval: 'Waiting for approval', waiting_vendor: 'Waiting for vendor', completed: 'Completed', cancelled: 'Cancelled' };
const STATUS_COLOR = { new: '#7A5BC7', assigned: '#6B7A82', scheduled: '#3568C9', in_progress: '#0E5A50', waiting_parts: '#F0A400', waiting_approval: '#C98A00', waiting_vendor: '#8A6FD1', completed: '#2E8B57' };
const chip = s => `<span class="chip ${s === 'waiting_vendor' ? 'waiting_approval' : s}">${STATUS_LABEL[s] || s}</span>`;
const pri = p => `<span class="pri ${p}">${p}</span>`;
function fmtDate(d) { if (!d) return '—'; const dt = new Date((d + '').replace(' ', 'T')); return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function fmtDateFull(d) { if (!d) return '—'; const dt = new Date((d + '').replace(' ', 'T')); return dt.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }); }
function fmtDateTime(d) { if (!d) return '—'; const dt = new Date((d + '').replace(' ', 'T')); return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
function fmtTime(d) { const dt = new Date((d + '').replace(' ', 'T')); return dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
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
function paintConnState() {
  let el = document.getElementById('conn-bar');
  const O = window.Offline;
  const show = !O.online || O.pending > 0 || O.syncing;
  if (!show) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'conn-bar';
    document.body.appendChild(el);
  }
  if (!O.online) {
    el.className = 'conn-bar off';
    el.innerHTML = `<b>Working offline</b>${O.pending ? ` · ${O.pending} change${O.pending > 1 ? 's' : ''} waiting to sync` : ' · your work is being saved on this device'}`;
  } else if (O.syncing) {
    el.className = 'conn-bar sync';
    el.innerHTML = `<b>Syncing…</b>${O.pending ? ` ${O.pending} left` : ''}`;
  } else {
    el.className = 'conn-bar sync';
    el.innerHTML = `<b>${O.pending} change${O.pending > 1 ? 's' : ''} waiting to sync</b> · tap to retry`;
    el.onclick = () => window.Offline.sync();
  }
}
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }
function modal(html) {
  closeModal();
  const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.id = 'modal';
  bg.innerHTML = `<div class="modal"><button class="modal-close" onclick="closeModal()">×</button>${html}</div>`;
  bg.addEventListener('click', e => { if (e.target === bg) closeModal(); });
  document.body.appendChild(bg);
}
window.closeModal = () => { const m = document.getElementById('modal'); if (m) m.remove(); };
function confirmModal(title, body, onYes, yesLabel) {
  modal(`<h3>${esc(title)}</h3><div style="margin-bottom:16px;font-size:14.5px;color:var(--ink-2)">${body}</div>
    <div class="row2"><button class="btn sec full" onclick="closeModal()">Cancel</button>
    <button class="btn pri full" id="cf-yes">${esc(yesLabel || 'Confirm')}</button></div>`);
  document.getElementById('cf-yes').onclick = onYes;
}
function fv(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function fchk(id) { const el = document.getElementById(id); return el ? el.checked : false; }
function selOpts(arr, valKey, labelKey, selected) {
  return arr.map(o => `<option value="${o[valKey]}" ${o[valKey] == selected ? 'selected' : ''}>${esc(o[labelKey])}</option>`).join('');
}
const isMgmt = () => ME && (ME.role === 'owner' || ME.role === 'manager');
const canRead = () => ME && ['owner', 'manager', 'viewer'].includes(ME.role);
const canWrite = () => isMgmt();


/* ---------------- icon system ----------------
   Stroke icons on a 24px grid, inheriting currentColor. Replaces emoji, which
   render differently on every device and can't take on the UI's color. */
const ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  work: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/>',
  building: '<path d="M3 21V8l6-4 6 4v13"/><path d="M15 21V11l6 3v7"/><path d="M7 11h2M7 15h2M12 11h.01M12 15h.01"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 1 5 5L15 16l-3 5-3-3 5-3 4.7-4.7Z"/><path d="M9 9 4 4"/>',
  chart: '<path d="M3 21h18"/><rect x="5" y="12" width="3.5" height="6" rx="1"/><rect x="10.5" y="8" width="3.5" height="10" rx="1"/><rect x="16" y="4" width="3.5" height="14" rx="1"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 6.5a3 3 0 0 1 0 5.8M17 20a6 6 0 0 0-1.5-4"/>',
  truck: '<rect x="1" y="6" width="14" height="10" rx="1.5"/><path d="M15 9h4l3 3.5V16h-7"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="18.5" r="2"/>',
  bell: '<path d="M18 15V10a6 6 0 1 0-12 0v5l-2 3h16l-2-3Z"/><path d="M10 21h4"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1 5.3 5.3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M22 12h-2.5M4.5 12H2M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8M19.1 19.1l-1.8-1.8M6.7 6.7 4.9 4.9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5M12 17.5h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  dollar: '<path d="M12 2v20"/><path d="M17 6.5c0-2-2.2-3-5-3s-5 1-5 3.2c0 5 10 2.6 10 7.6 0 2.2-2.2 3.4-5 3.4s-5-1.2-5-3.2"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M4.5 5.5 3 13v6h18v-6l-1.5-7.5Z"/>',
  repeat: '<path d="M3 11V9a4 4 0 0 1 4-4h11"/><path d="m15 2 3 3-3 3"/><path d="M21 13v2a4 4 0 0 1-4 4H6"/><path d="m9 22-3-3 3-3"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  doc: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/><path d="M9 12h6M9 16h6"/>',
  camera: '<path d="M3 7h4l1.5-2h7L17 7h4v13H3z"/><circle cx="12" cy="13" r="3.5"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  car: '<path d="M4 16h16"/><path d="M6 16V11l2-4.5h8L18 11v5"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>',
  pin: '<path d="M12 22s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="11" r="2.5"/>',
  play: '<path d="M7 4.5 19 12 7 19.5Z"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 8 6 12l4 4M6 12h9"/>'
};
function ico(name, size) {
  const p = ICON_PATHS[name] || ICON_PATHS.doc;
  return `<svg class="ico" viewBox="0 0 24 24" width="${size || 22}" height="${size || 22}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

/* ---------------- shell / nav ---------------- */
const NAV_MGMT = [
  ['#/dashboard', 'home', 'Dashboard'], ['#/work-orders', 'work', 'Work Orders'], ['#/properties', 'building', 'Properties'],
  ['#/maintenance', 'wrench', 'Maintenance'], ['#/calendar', 'calendar', 'Calendar'], ['#/team', 'users', 'Team'],
  ['#/vendors', 'truck', 'Vendors'], ['#/analytics', 'chart', 'Analytics'], ['#/settings', 'gear', 'Settings'],
];
const NAV_TECH = [['#/today', 'sun', 'Today'], ['#/jobs', 'work', 'Jobs'], ['#/notifications', 'bell', 'Alerts'], ['#/profile', 'user', 'Profile']];
const TABS_MGMT = [['#/dashboard', 'home', 'Home'], ['#/work-orders', 'work', 'Work'], ['#/properties', 'building', 'Properties'], ['#/maintenance', 'inbox', 'Requests'], ['#/analytics', 'chart', 'Insights']];

let unreadCount = 0;
async function refreshUnread() { try { const n = await GET('/notifications'); unreadCount = n.filter(x => !x.read).length; } catch (e) {} }

function shell(content, route) {
  const nav = canRead() ? NAV_MGMT : NAV_TECH;
  const tabs = canRead() ? TABS_MGMT : NAV_TECH;
  $app.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><svg class="brand-mark" viewBox="0 0 112 112" xmlns="http://www.w3.org/2000/svg"><rect width="112" height="112" rx="26" fill="#0E5A50"/><rect x="30" y="56" width="52" height="34" rx="4" fill="#F4F6F5"/><rect x="49" y="68" width="14" height="22" rx="2" fill="#0E5A50"/><path d="M22 58 L56 30 L74 45 L96 20" fill="none" stroke="#FFCE34" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg> Steadhold</div>
      <div style="padding:0 12px 14px;font-size:12px;color:#8FA0A8;font-weight:600">${esc(ME.org_name || '')}</div>
      ${nav.map(([h, i, l]) => `<a class="nav-item ${route.startsWith(h) ? 'active' : ''}" href="${h}">${ico(i, 20)}${l}</a>`).join('')}
      <div class="nav-spacer"></div>
      <a class="nav-item ${route.startsWith('#/notifications') ? 'active' : ''}" href="#/notifications">${ico('bell', 20)}Notifications ${unreadCount ? `<span class="nav-count">${unreadCount}</span>` : ''}</a>
      <div class="nav-user"><div>${esc(ME.name)}</div><div class="role">${ME.role}${ME.role === 'viewer' ? ' · read-only' : ''}</div><button id="btn-logout">${ico('logout', 16)} Sign out</button></div>
    </aside>
    <div class="main">
      <div class="topbar">
        <div class="brand" style="display:${window.innerWidth >= 900 ? 'none' : 'flex'}"><svg class="brand-mark" viewBox="0 0 112 112" xmlns="http://www.w3.org/2000/svg"><rect width="112" height="112" rx="26" fill="#0E5A50"/><rect x="30" y="56" width="52" height="34" rx="4" fill="#F4F6F5"/><rect x="49" y="68" width="14" height="22" rx="2" fill="#0E5A50"/><path d="M22 58 L56 30 L74 45 L96 20" fill="none" stroke="#FFCE34" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg> Steadhold</div>
        <div class="grow"></div>
        ${canRead() ? `<button class="icon-btn" id="btn-search" aria-label="Search">${ico('search', 19)}</button>` : ''}
        <a class="icon-btn" href="#/notifications" aria-label="Notifications">${ico('bell', 19)}${unreadCount ? '<span class="badge-dot"></span>' : ''}</a>
        <button class="icon-btn acct-btn" id="btn-acct" aria-label="Account menu">${ico('user', 19)}</button>
      </div>
      <div class="page">${content}</div>
    </div>
  </div>
  <nav class="tabbar">${tabs.map(([h, i, l]) => `<a class="tab ${route.startsWith(h) ? 'active' : ''}" href="${h}"><span class="ti">${ico(i, 23)}</span>${l}</a>`).join('')}</nav>`;
  const lo = document.getElementById('btn-logout');
  if (lo) lo.onclick = doLogout;
  const sb = document.getElementById('btn-search');
  if (sb) sb.onclick = openSearch;
  const ab = document.getElementById('btn-acct');
  if (ab) ab.onclick = openAccountMenu;
  paintConnState();
}
function loadingShell(route) { shell('<div class="skel"></div><div class="skel"></div><div class="skel" style="height:180px"></div>', route); }

/* ---- phone push (web push) ---- */
function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function isIOSNotInstalled() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return ios && !installed;
}
function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function enablePush() {
  if (isIOSNotInstalled()) {
    modal(`<h3>One step first (iPhone)</h3>
      <div class="s" style="margin-bottom:10px">iPhones only allow notifications for installed web apps. Takes 10 seconds:</div>
      <div class="s" style="line-height:1.9">1. Tap the <b>Share</b> button in Safari<br>2. Choose <b>Add to Home Screen</b><br>3. Open <b>Steadhold</b> from your home screen<br>4. Come back here and tap Enable again</div>
      <button class="btn pri full" style="margin-top:14px" onclick="closeModal()">Got it</button>`);
    return false;
  }
  if (!pushSupported()) { toast('This browser does not support push notifications'); return false; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications were not allowed — check your browser settings'); return false; }
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const { key } = await GET('/push/vapid-public-key');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    const r = await POST('/push/subscribe', { subscription: sub.toJSON() });
    toast('Phone notifications on for this device' + (r.devices > 1 ? ` (${r.devices} devices total)` : ''));
    return true;
  } catch (e) { toast('Could not enable notifications: ' + e.message); return false; }
}
async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) { await POST('/push/unsubscribe', { subscription: sub.toJSON() }); await sub.unsubscribe(); }
    toast('Phone notifications off for this device');
  } catch (e) { toast(e.message); }
}
window.enablePush = enablePush; window.disablePush = disablePush;

async function doLogout() {
  try { await POST('/auth/logout', {}); } catch (e) {}
  ME = null; location.hash = '#/login'; location.reload();
}
function openAccountMenu() {
  const links = canRead()
    ? [['#/calendar', 'calendar', 'Calendar'], ['#/team', 'users', 'Team'], ['#/vendors', 'truck', 'Vendors'], ['#/notifications', 'bell', 'Notifications'], ['#/settings', 'gear', 'Settings']]
    : [['#/notifications', 'bell', 'Notifications'], ['#/profile', 'user', 'Profile']];
  modal(`
    <div style="padding:2px 2px 10px">
      <div style="font-weight:800;font-family:var(--font-d);font-size:17px">${esc(ME.name)}</div>
      <div class="s" style="color:var(--muted)">${esc(ME.email)} · ${ME.role}${ME.role === 'viewer' ? ' (read-only)' : ''}</div>
      <div class="s" style="color:var(--muted)">${esc(ME.org_name || '')}</div>
    </div>
    ${links.map(([h, i, l]) => `<a class="list-item menu-row" href="${h}" onclick="closeModal()"><span class="mi">${ico(i, 19)}</span><div class="body"><div class="t">${l}</div></div><div class="end">›</div></a>`).join('')}
    <button class="btn danger full" style="margin-top:14px" onclick="doLogout()">Sign out</button>`);
}
window.doLogout = doLogout;

/* ---------------- login / signup / join ---------------- */
function renderLogin(msg, mode) {
  mode = mode || 'login';
  const forms = {
    login: `
      <div class="field"><label>Email</label><input id="li-email" type="email" autocomplete="username" placeholder="owner@demo.com"></div>
      <div class="field"><label>Password</label><input id="li-pass" type="password" autocomplete="current-password" placeholder="demo123"></div>
      <button class="btn pri full" id="li-go">Sign in</button>
      <div style="text-align:center;margin-top:14px;font-size:13.5px">New here? <a href="#" id="to-signup" style="color:var(--pine);font-weight:700">Create an organization</a></div>
      <div style="font-size:12px;color:var(--muted);margin-top:18px;font-weight:600">Try a demo role (password: demo123)</div>
      <div class="demo-roles">
        <button data-e="owner@demo.com">Owner</button>
        <button data-e="manager@demo.com">Manager</button>
        <button data-e="tech@demo.com">Technician</button>
        <button data-e="vendor@demo.com">Vendor</button>
        <button data-e="viewer@demo.com">Viewer</button>
        <button data-e="owner@bayview.demo">2nd Org Owner</button>
      </div>`,
    signup: `
      <div class="field"><label>Organization name</label><input id="su-org" placeholder="Hawthorne Properties"></div>
      <div class="field"><label>Your name</label><input id="su-name"></div>
      <div class="row2">
        <div class="field"><label>Email</label><input id="su-email" type="email"></div>
        <div class="field"><label>Phone</label><input id="su-phone"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Approx. unit count</label><input id="su-units" type="number" inputmode="numeric"></div>
        <div class="field"><label>Primary market</label><input id="su-market" placeholder="Jacksonville, FL"></div>
      </div>
      <div class="field"><label>Password (8+ characters)</label><input id="su-pass" type="password" autocomplete="new-password"></div>
      <button class="btn pri full" id="su-go">Create organization</button>
      <div style="text-align:center;margin-top:14px;font-size:13.5px"><a href="#" id="to-login" style="color:var(--pine);font-weight:700">Back to sign in</a></div>`
  };
  $app.innerHTML = `
  <div class="login-wrap"><div class="login-card">
    <div class="brand"><svg class="brand-mark" viewBox="0 0 112 112" xmlns="http://www.w3.org/2000/svg"><rect width="112" height="112" rx="26" fill="#0E5A50"/><rect x="30" y="56" width="52" height="34" rx="4" fill="#F4F6F5"/><rect x="49" y="68" width="14" height="22" rx="2" fill="#0E5A50"/><path d="M22 58 L56 30 L74 45 L96 20" fill="none" stroke="#FFCE34" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg> Steadhold</div>
    <div class="login-sub">${mode === 'signup' ? 'Set up your organization — takes about a minute' : 'Maintenance operations for your rental portfolio'}</div>
    ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
    ${forms[mode]}
  </div></div>`;
  if (mode === 'login') {
    const go = async (email, pass) => {
      try { ME = await POST('/auth/login', { email, password: pass }); await bootMeta(); location.hash = canRead() ? '#/dashboard' : '#/today'; render(); }
      catch (e) { renderLogin(e.message, 'login'); }
    };
    document.getElementById('li-go').onclick = () => go(fv('li-email'), document.getElementById('li-pass').value);
    document.getElementById('li-pass').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('li-go').click(); });
    document.querySelectorAll('.demo-roles button').forEach(b => b.onclick = () => go(b.dataset.e, 'demo123'));
    document.getElementById('to-signup').onclick = e => { e.preventDefault(); renderLogin(null, 'signup'); };
  } else {
    document.getElementById('su-go').onclick = async () => {
      try {
        ME = await POST('/auth/signup', { org_name: fv('su-org'), name: fv('su-name'), email: fv('su-email'),
          phone: fv('su-phone'), approx_units: fv('su-units'), primary_market: fv('su-market'),
          password: document.getElementById('su-pass').value });
        await bootMeta(); location.hash = '#/onboarding'; render();
      } catch (e) { renderLogin(e.message, 'signup'); }
    };
    document.getElementById('to-login').onclick = e => { e.preventDefault(); renderLogin(null, 'login'); };
  }
}

function renderJoin(qs) {
  const token = new URLSearchParams(qs || '').get('token') || '';
  GET('/auth/invite/' + token).then(inv => {
    $app.innerHTML = `
    <div class="login-wrap"><div class="login-card">
      <div class="brand"><svg class="brand-mark" viewBox="0 0 112 112" xmlns="http://www.w3.org/2000/svg"><rect width="112" height="112" rx="26" fill="#0E5A50"/><rect x="30" y="56" width="52" height="34" rx="4" fill="#F4F6F5"/><rect x="49" y="68" width="14" height="22" rx="2" fill="#0E5A50"/><path d="M22 58 L56 30 L74 45 L96 20" fill="none" stroke="#FFCE34" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg> Steadhold</div>
      <div class="login-sub">You've been invited to join <b>${esc(inv.org_name)}</b> as a ${esc(inv.role)}.</div>
      <div class="field"><label>Your name</label><input id="j-name" value="${esc(inv.name || '')}"></div>
      <div class="field"><label>Email</label><input value="${esc(inv.email)}" disabled></div>
      <div class="field"><label>Choose a password (8+ characters)</label><input id="j-pass" type="password" autocomplete="new-password"></div>
      <button class="btn pri full" id="j-go">Join ${esc(inv.org_name)}</button>
    </div></div>`;
    document.getElementById('j-go').onclick = async () => {
      try {
        const r = await POST('/auth/accept-invite', { token, name: fv('j-name'), password: document.getElementById('j-pass').value });
        ME = await GET('/auth/me'); await bootMeta();
        location.hash = ['owner', 'manager', 'viewer'].includes(r.role) ? '#/dashboard' : '#/today'; render();
      } catch (e) { toast(e.message); }
    };
  }).catch(() => {
    $app.innerHTML = `<div class="login-wrap"><div class="login-card"><div class="brand"><svg class="brand-mark" viewBox="0 0 112 112" xmlns="http://www.w3.org/2000/svg"><rect width="112" height="112" rx="26" fill="#0E5A50"/><rect x="30" y="56" width="52" height="34" rx="4" fill="#F4F6F5"/><rect x="49" y="68" width="14" height="22" rx="2" fill="#0E5A50"/><path d="M22 58 L56 30 L74 45 L96 20" fill="none" stroke="#FFCE34" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg> Steadhold</div>
      <div class="err">This invitation link is no longer valid. Ask your manager to send a new one.</div>
      <button class="btn pri full" onclick="location.hash='#/login';location.reload()">Go to sign in</button></div></div>`;
  });
}

/* ---------------- public tenant report form ---------------- */
async function renderReport(token) {
  document.title = 'Report a maintenance issue — Steadhold';
  let info;
  try {
    const r = await fetch('/api/intake/' + encodeURIComponent(token));
    if (!r.ok) throw new Error();
    info = await r.json();
  } catch (e) {
    $app.innerHTML = `<div class="login-wrap"><div class="login-card">
      <div class="brand"><svg class="brand-mark" viewBox="0 0 112 112" xmlns="http://www.w3.org/2000/svg"><rect width="112" height="112" rx="26" fill="#0E5A50"/><rect x="30" y="56" width="52" height="34" rx="4" fill="#F4F6F5"/><rect x="49" y="68" width="14" height="22" rx="2" fill="#0E5A50"/><path d="M22 58 L56 30 L74 45 L96 20" fill="none" stroke="#FFCE34" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg> Steadhold</div>
      <div class="err">This link isn't valid anymore. Please contact your property manager directly.</div></div></div>`;
    return;
  }
  $app.innerHTML = `<div class="login-wrap"><div class="login-card" style="max-width:520px">
    <div class="brand"><span class="brand-mark">O</span> ${esc(info.org)}</div>
    <div class="login-sub">Report a maintenance issue at <b>${esc(info.property)}</b>. Your property manager is notified immediately.</div>
    <div class="banner warn" style="margin-bottom:14px">If this is a fire, gas leak, or someone is in danger, call 911 first.</div>
    ${info.units.length ? `<div class="field"><label>Your unit</label><select id="tr-unit"><option value="">Not sure / whole property</option>${info.units.map(u => `<option value="${u.id}">Unit ${esc(u.label)}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label>What kind of issue?</label><select id="tr-cat">${info.categories.map(c => `<option>${c}</option>`).join('')}</select></div>
    <div class="field"><label>Describe what's happening</label><textarea id="tr-desc" placeholder="What's wrong, where it is, when it started…"></textarea></div>
    <div class="tglrow"><span>🚨 <b>This is an emergency</b> (flooding, no heat/AC in extreme weather, unsafe conditions)</span><input type="checkbox" class="tgl" id="tr-emerg"></div>
    <div class="pill-row" style="margin:6px 0 12px">
      <label class="btn sec" style="padding:7px 12px;font-size:12.5px"><input type="checkbox" id="trf-water" style="margin-right:5px">💧 Water leak</label>
      <label class="btn sec" style="padding:7px 12px;font-size:12.5px"><input type="checkbox" id="trf-elec" style="margin-right:5px">⚡ Electrical</label>
      <label class="btn sec" style="padding:7px 12px;font-size:12.5px"><input type="checkbox" id="trf-hvac" style="margin-right:5px">❄ No heat/AC</label>
      <label class="btn sec" style="padding:7px 12px;font-size:12.5px"><input type="checkbox" id="trf-safety" style="margin-right:5px">⚠ Safety hazard</label>
    </div>
    <div class="field"><label>Photos (up to 3 — really helps us fix it faster)</label>
      <input id="tr-photos" type="file" accept="image/*" capture="environment" multiple>
      <div class="s" id="tr-photo-count" style="margin-top:4px"></div></div>
    <div class="row2">
      <div class="field"><label>Your name</label><input id="tr-name" autocomplete="name"></div>
      <div class="field"><label>Phone</label><input id="tr-phone" inputmode="tel" autocomplete="tel"></div>
    </div>
    <div class="field"><label>Email (optional)</label><input id="tr-email" type="email" autocomplete="email"></div>
    <div class="tglrow"><span>You may enter to make the repair if I'm not home</span><input type="checkbox" class="tgl" id="tr-pte" checked></div>
    <div class="field"><label>Access notes (lockbox, gate code, parking…)</label><input id="tr-access"></div>
    <div class="row2">
      <div class="field"><label>Pets at home</label><input id="tr-pets" placeholder="Dog, cat…"></div>
      <div class="field"><label>Best times for a visit</label><input id="tr-avail" placeholder="Weekdays after 3pm"></div>
    </div>
    <button class="btn pri full big" id="tr-go">Submit request</button>
    <div class="s" style="text-align:center;margin-top:10px;color:var(--muted)">No account needed — this goes straight to the maintenance team.</div>
  </div></div>`;
  const ph = document.getElementById('tr-photos');
  ph.onchange = () => {
    if (ph.files.length > 3) { toast('Please choose up to 3 photos'); ph.value = ''; return; }
    document.getElementById('tr-photo-count').textContent = ph.files.length ? ph.files.length + ' photo' + (ph.files.length > 1 ? 's' : '') + ' attached' : '';
  };
  document.getElementById('tr-go').onclick = async () => {
    const btn = document.getElementById('tr-go');
    btn.disabled = true; btn.textContent = 'Sending…';
    const fd = new FormData();
    const set = (k, v) => fd.append(k, v);
    set('category', fv('tr-cat')); set('description', fv('tr-desc'));
    set('reported_by', fv('tr-name')); set('reporter_phone', fv('tr-phone')); set('reporter_email', fv('tr-email'));
    const un = document.getElementById('tr-unit'); if (un && un.value) set('unit_id', un.value);
    set('is_emergency', fchk('tr-emerg') ? '1' : '0');
    set('flag_water', fchk('trf-water') ? '1' : '0'); set('flag_electrical', fchk('trf-elec') ? '1' : '0');
    set('flag_hvac_out', fchk('trf-hvac') ? '1' : '0'); set('flag_safety', fchk('trf-safety') ? '1' : '0');
    set('permission_to_enter', fchk('tr-pte') ? '1' : '0');
    set('access_instructions', fv('tr-access')); set('pets', fv('tr-pets')); set('preferred_availability', fv('tr-avail'));
    for (const f of ph.files) fd.append('photos', f);
    try {
      const r = await fetch('/api/intake/' + encodeURIComponent(token), { method: 'POST', body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Something went wrong');
      $app.innerHTML = `<div class="login-wrap"><div class="login-card" style="text-align:center">
        <div style="font-size:48px;margin-bottom:8px">${data.emergency ? '🚨' : '✅'}</div>
        <h3 style="margin-bottom:6px">Request received</h3>
        <div class="s" style="margin-bottom:12px">Reference <b>${esc(data.reference)}</b>. ${data.emergency ? 'Marked as an emergency — the maintenance team has been alerted.' : 'The maintenance team has been notified and will follow up.'}</div>
        <div class="s" style="color:var(--muted)">You can close this page. Save the link to report future issues.</div>
      </div></div>`;
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Submit request'; }
  };
}

/* ---------------- onboarding ---------------- */
async function renderOnboarding() {
  await bootMeta();
  let step = META.properties.length ? (META.units.length ? 3 : 2) : 1;
  const draw = () => {
    const steps = [1, 2, 3, 4, 5].map(i => `<div class="st ${i <= step ? 'on' : ''}"></div>`).join('');
    const bodies = {
      1: `<h3>Add your first property</h3>
        <div class="field"><label>Name</label><input id="ob-name" placeholder="Oak Street Duplex"></div>
        <div class="field"><label>Address</label><input id="ob-addr"></div>
        <div class="row2"><div class="field"><label>City</label><input id="ob-city"></div>
        <div class="field"><label>Type</label><select id="ob-type"><option>duplex</option><option>quadplex</option><option>single-family</option><option>small multifamily</option></select></div></div>
        <button class="btn pri full" id="ob-go">Add property</button>`,
      2: `<h3>Add units</h3>
        <div class="s" style="color:var(--muted);margin-bottom:12px">Add each rentable unit (A, B, 1, 2…). You can add more later.</div>
        <div class="field"><label>Unit labels (comma-separated)</label><input id="ob-units" placeholder="A, B"></div>
        <button class="btn pri full" id="ob-go">Add units</button>`,
      3: `<h3>Invite your team</h3>
        <div class="s" style="color:var(--muted);margin-bottom:12px">Invite a manager or technician — they'll get a join link you can text them.</div>
        <div class="row2"><div class="field"><label>Email</label><input id="ob-email" type="email"></div>
        <div class="field"><label>Role</label><select id="ob-role"><option>technician</option><option>manager</option><option>viewer</option></select></div></div>
        <button class="btn pri full" id="ob-go">Send invite</button>`,
      4: `<h3>Add a vendor</h3>
        <div class="row2"><div class="field"><label>Company</label><input id="ob-vco" placeholder="ABC Plumbing"></div>
        <div class="field"><label>Trade</label><input id="ob-vtr" placeholder="Plumbing"></div></div>
        <button class="btn pri full" id="ob-go">Add vendor</button>`,
      5: `<h3>Create your first work order</h3>
        <div class="field"><label>What needs doing?</label><input id="ob-wt" placeholder="Fix leaking kitchen faucet — Unit A"></div>
        <div class="field"><label>Category</label><select id="ob-wc"><option>Plumbing</option><option>HVAC</option><option>Electrical</option><option>Appliance</option><option>General</option></select></div>
        <button class="btn pri full" id="ob-go">Create work order</button>`
    };
    $app.innerHTML = `<div class="login-wrap"><div class="login-card">
      <div class="brand"><svg class="brand-mark" viewBox="0 0 112 112" xmlns="http://www.w3.org/2000/svg"><rect width="112" height="112" rx="26" fill="#0E5A50"/><rect x="30" y="56" width="52" height="34" rx="4" fill="#F4F6F5"/><rect x="49" y="68" width="14" height="22" rx="2" fill="#0E5A50"/><path d="M22 58 L56 30 L74 45 L96 20" fill="none" stroke="#FFCE34" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg> ${esc(ME.org_name || 'Steadhold')}</div>
      <div class="login-sub">Step ${step} of 5</div>
      <div class="steps">${steps}</div>
      ${bodies[step]}
      <div style="display:flex;justify-content:space-between;margin-top:14px;font-size:13.5px">
        <a href="#" id="ob-skip" style="color:var(--muted);font-weight:600">Skip this step</a>
        <a href="#" id="ob-done" style="color:var(--pine);font-weight:700">Finish setup ›</a>
      </div>
    </div></div>`;
    document.getElementById('ob-skip').onclick = e => { e.preventDefault(); step++; step > 5 ? finish() : draw(); };
    document.getElementById('ob-done').onclick = e => { e.preventDefault(); finish(); };
    document.getElementById('ob-go').onclick = async () => {
      try {
        if (step === 1) { await POST('/properties', { name: fv('ob-name'), address: fv('ob-addr'), city: fv('ob-city'), type: fv('ob-type') }); await bootMeta(); }
        if (step === 2) {
          const pid = META.properties[0].id;
          for (const l of fv('ob-units').split(',').map(s => s.trim()).filter(Boolean)) await POST(`/properties/${pid}/units`, { label: l });
          await bootMeta();
        }
        if (step === 3) { const r = await POST('/team/invites', { email: fv('ob-email'), role: fv('ob-role') }); toast('Invite link created — share it from Settings → Team'); }
        if (step === 4) { await POST('/vendors', { company: fv('ob-vco'), trade: fv('ob-vtr') }); await bootMeta(); }
        if (step === 5) { await POST('/work-orders', { property_id: META.properties[0].id, title: fv('ob-wt'), category: fv('ob-wc') }); }
        step++; step > 5 ? finish() : draw();
      } catch (e) { toast(e.message); }
    };
  };
  const finish = () => { location.hash = '#/dashboard'; render(); };
  draw();
}

async function bootMeta() { try { META = await GET('/meta'); } catch (e) {} await refreshUnread(); warmCache(); }

// Pre-load the screens this person will need if they lose signal mid-shift.
// Runs quietly in the background; failures are irrelevant since it's only a warm-up.
let _warmed = false;
async function warmCache() {
  if (_warmed || !window.Offline.online || !ME) return;
  _warmed = true;
  const paths = canRead()
    ? ['/auth/me', '/meta', '/dashboard', '/work-orders?open=1', '/properties', '/requests', '/notifications']
    : ['/auth/me', '/meta', '/work-orders', '/work-orders?open=1', '/notifications'];
  for (const p of paths) { try { await GET(p); } catch (e) {} }
  // Each open job's full detail, so a tech can work a job with no bars at all
  try {
    const jobs = await GET('/work-orders?open=1');
    for (const w of (jobs || []).slice(0, 25)) { try { await GET('/work-orders/' + w.id); } catch (e) {} }
  } catch (e) {}
}

/* ---------------- dashboard: Attention Center ---------------- */
const ATTN_ICO = { emergency: 'alert', approval: 'dollar', overdue: 'clock', triage: 'inbox', owner_review: 'user', repeat: 'repeat', pm: 'calendar', anomaly: 'chart', rvr: 'swap', quote: 'doc' };
async function renderDashboard() {
  loadingShell('#/dashboard');
  const d = await GET('/dashboard');
  const s = d.stats;
  const totalWOs = Object.entries(d.status_counts).filter(([k]) => k !== 'completed').reduce((a, [, v]) => a + v, 0) || 1;
  const barOrder = ['new', 'assigned', 'scheduled', 'in_progress', 'waiting_parts', 'waiting_approval', 'waiting_vendor'];
  const spendDelta = s.spend_prev_month ? Math.round(((s.spend_month - s.spend_prev_month) / s.spend_prev_month) * 100) : null;

  shell(`
    <div class="section-title" style="margin-top:0">What needs my attention?</div>
    ${d.attention.length ? d.attention.map((g, i) => `
      <div class="attn-group">
        <div class="attn-head lvl-${g.level || 'watch'}" onclick="${g.items.length ? `document.getElementById('ag${i}').style.display=document.getElementById('ag${i}').style.display==='none'?'block':'none'` : `location.hash='${g.link || '#/dashboard'}'`}">
          <span class="attn-ico">${ico(ATTN_ICO[g.type] || 'alert', 19)}</span>
          <span class="cnt">${g.count}</span>
          <span class="t">${esc(g.title)}</span>
          <span class="go">${g.items.length ? '▾' : '›'}</span>
        </div>
        ${g.items.length ? `<div class="attn-items" id="ag${i}" style="display:${g.type === 'emergency' || g.type === 'approval' ? 'block' : 'none'}">
          ${g.items.map(it => `<a href="${it.link}"><div>${esc(it.t)}</div><div class="s">${esc(it.s)}</div></a>`).join('')}
        </div>` : ''}
      </div>`).join('') : `<div class="card empty">Nothing needs your attention right now. Everything is on track.</div>`}

    <div class="section-title">Operations at a glance</div>
    <div class="stat-row">
      <div class="stat"><div class="v">${s.open}</div><div class="l">Open work orders</div></div>
      <div class="stat ${s.urgent ? 'warn' : ''}"><div class="v">${s.urgent}</div><div class="l">Urgent issues</div></div>
      <div class="stat ${s.overdue ? 'bad' : ''}"><div class="v">${s.overdue}</div><div class="l">Overdue</div></div>
      <div class="stat"><div class="v">${s.completed_month}</div><div class="l">Completed this month</div></div>
      <div class="stat"><div class="v">${money(s.spend_month)}</div><div class="l">Spend this month${spendDelta != null ? ` (${spendDelta > 0 ? '+' : ''}${spendDelta}%)` : ''}</div></div>
      <div class="stat"><div class="v">${s.avg_completion_days ?? '—'}<span style="font-size:14px">d</span></div><div class="l">Avg completion time</div></div>
    </div>

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
        <a class="more" href="#/properties?view=compare" style="display:block;padding-top:8px;font-size:13px;color:var(--pine);font-weight:600">Compare all properties ›</a>
      </div>
    </div>
  `, '#/dashboard');
}

/* ---------------- maintenance: triage + PM ---------------- */
const REPORTER_TYPES = ['tenant', 'owner', 'manager', 'technician', 'inspection', 'preventive'];
async function renderMaintenance() {
  loadingShell('#/maintenance');
  const [reqs, pm] = await Promise.all([GET('/requests'), GET('/pm')]);
  const open = reqs.filter(r => r.status === 'open');
  const ownerRev = reqs.filter(r => r.status === 'owner_review');
  const info = reqs.filter(r => r.status === 'info_needed');
  const closed = reqs.filter(r => !['open', 'info_needed', 'owner_review'].includes(r.status)).slice(0, 8);
  const today = new Date().toISOString().slice(0, 10);
  const flags = r => [r.is_emergency && '🚨 Emergency', r.flag_safety && '⚠ Safety', r.flag_water && '💧 Water', r.flag_electrical && '⚡ Electrical', r.flag_hvac_out && '❄ HVAC out'].filter(Boolean);

  const reqCard = r => `
    <div class="attn-group"><div style="padding:13px 14px;border-left:4px solid ${r.priority === 'emergency' ? 'var(--red)' : r.priority === 'high' ? 'var(--amber)' : 'var(--line)'}">
      <div class="s">${pri(r.priority)} · ${esc(r.category)} · ${fmtDate(r.created_at)} · via ${esc(r.reporter_type || 'manager')}</div>
      <div style="font-weight:700;margin:2px 0">${esc(r.property_name)}${r.unit_label ? ' · Unit ' + esc(r.unit_label) : ''}</div>
      <div style="font-size:14px">${esc(r.description)}</div>
      ${flags(r).length ? `<div class="s" style="margin-top:4px;font-weight:700;color:#9A6B00">${flags(r).join(' · ')}</div>` : ''}
      <div class="s" style="margin-top:3px;color:var(--muted)">${esc(r.reported_by || '')}${r.reporter_phone ? ' · ' + esc(r.reporter_phone) : ''}${r.access_instructions ? ' · ' + esc(r.access_instructions) : ''}${r.pets ? ' · Pets: ' + esc(r.pets) : ''}${r.preferred_availability ? ' · ' + esc(r.preferred_availability) : ''}</div>
      ${r.photos && r.photos.length ? `<div class="photo-row" style="margin-top:7px">${r.photos.map(p => `<img src="${p.url}" loading="lazy" onclick="window.open('${p.url}')">`).join('')}</div>` : ''}
      ${r.status === 'info_needed' ? `<div class="s" style="color:var(--amber);font-weight:700;margin-top:3px">Waiting for more information${r.triage_note ? ': ' + esc(r.triage_note) : ''}</div>` : ''}
      ${r.status === 'owner_review' ? (ME.role === 'owner' ? `<div class="pill-row">
        <button class="btn pri" onclick="ownerReview(${r.id},'release')">✓ Send to maintenance</button>
        <button class="btn danger" onclick="ownerReview(${r.id},'reject')">Decline</button>
      </div>` : `<div class="s" style="margin-top:6px;font-weight:700;color:#9A6B00">👤 Held for owner review — the owner decides whether this goes to maintenance.</div>`)
      : canWrite() ? `<div class="pill-row">
        <button class="btn pri" onclick="triageConvert(${r.id})">→ Work order</button>
        <button class="btn sec" onclick="triagePriority(${r.id},'${r.priority}')">Priority</button>
        <button class="btn sec" onclick="triageNote(${r.id},'info','Request more information')">Need info</button>
        <button class="btn sec" onclick="triageNote(${r.id},'duplicate','Mark duplicate')">Duplicate</button>
        <button class="btn danger" onclick="triageNote(${r.id},'reject','Reject request')">Reject</button>
      </div>` : ''}
    </div></div>`;

  shell(`
    ${ownerRev.length ? `<div class="section-title" style="margin-top:0">👤 Waiting for owner review</div>${ownerRev.map(reqCard).join('')}` : ''}
    <div class="section-title" ${ownerRev.length ? '' : 'style="margin-top:0"'}>Needs triage ${canWrite() || ME.role === 'viewer' ? `<button class="btn pri" style="padding:8px 14px" id="r-new">+ Request</button>` : ''}</div>
    ${open.length ? open.map(reqCard).join('') : `<div class="card empty">No requests waiting for triage.<br><br>${canWrite() || ME.role === 'viewer' ? '<button class="btn pri" id="r-new2">Create a maintenance request</button>' : ''}</div>`}
    ${info.length ? `<div class="section-title">Waiting on information</div>${info.map(reqCard).join('')}` : ''}
    ${closed.length ? `<div class="section-title">Recently triaged</div><div class="card">
      ${closed.map(r => `<div class="list-item"><div class="body"><div class="t" style="color:var(--muted)">${esc(r.description.slice(0, 70))}</div><div class="s">${esc(r.property_name)}</div></div><div class="end">${chip(r.status)}${r.work_order_id ? `<div><a class="more" href="#/work-orders/${r.work_order_id}" style="font-size:12px">View WO ›</a></div>` : ''}</div></div>`).join('')}
    </div>` : ''}
    <div class="section-title">Preventive maintenance ${canWrite() ? `<button class="more" onclick="generatePM()">Generate due WOs ›</button>` : ''}</div>
    <div class="card">${pm.map(s => `
      <div class="list-item"><div class="body"><div class="t">${esc(s.title)}</div><div class="s">${esc(s.property_name)} · every ${s.interval_days} days · ${esc(s.tech_name || s.vendor_company || 'Unassigned queue')}</div></div>
      <div class="end ${s.next_due < today ? 'pri emergency' : 's'}" style="font-size:12.5px">${s.next_due < today ? 'Overdue ' : ''}${fmtDate(s.next_due)}</div></div>`).join('') || '<div class="empty">No schedules yet — add one from a property page to automate recurring work.</div>'}
    </div>`, '#/maintenance');
  const openIntake = () => intakeModal();
  const b1 = document.getElementById('r-new'); if (b1) b1.onclick = openIntake;
  const b2 = document.getElementById('r-new2'); if (b2) b2.onclick = openIntake;
}

function intakeModal() {
  modal(`<h3>New maintenance request</h3>
    <div class="field"><label>Property</label><select id="r-prop">${selOpts(META.properties, 'id', 'name')}</select></div>
    <div class="row2">
      <div class="field"><label>Unit</label><select id="r-unit"></select></div>
      <div class="field"><label>Category</label><select id="r-cat">${META.categories.map(c => `<option>${c}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Describe the issue</label><textarea id="r-desc"></textarea></div>
    <div class="row2">
      <div class="field"><label>Priority</label><select id="r-pri"><option>normal</option><option>high</option><option>low</option></select></div>
      <div class="field"><label>Reported via</label><select id="r-rtype">${REPORTER_TYPES.map(t => `<option>${t}</option>`).join('')}</select></div>
    </div>
    <div class="tglrow"><span>🚨 This is an emergency</span><input type="checkbox" class="tgl" id="r-emerg"></div>
    <div class="pill-row" style="margin:6px 0 10px">
      <label class="btn sec" style="padding:7px 12px;font-size:12.5px"><input type="checkbox" id="rf-safety" style="margin-right:5px">⚠ Safety</label>
      <label class="btn sec" style="padding:7px 12px;font-size:12.5px"><input type="checkbox" id="rf-water" style="margin-right:5px">💧 Water leak</label>
      <label class="btn sec" style="padding:7px 12px;font-size:12.5px"><input type="checkbox" id="rf-elec" style="margin-right:5px">⚡ Electrical</label>
      <label class="btn sec" style="padding:7px 12px;font-size:12.5px"><input type="checkbox" id="rf-hvac" style="margin-right:5px">❄ HVAC out</label>
    </div>
    <div id="r-tenant-fields" style="display:none">
      <div class="row2">
        <div class="field"><label>Reporter name</label><input id="r-rep"></div>
        <div class="field"><label>Reporter phone</label><input id="r-phone" inputmode="tel"></div>
      </div>
      <div class="field"><label>Access instructions</label><input id="r-access" placeholder="Lockbox code, gate, parking…"></div>
      <div class="tglrow"><span>Permission to enter</span><input type="checkbox" class="tgl" id="r-pte"></div>
      <div class="row2">
        <div class="field"><label>Pets at property</label><input id="r-pets" placeholder="Dog, cat…"></div>
        <div class="field"><label>Preferred availability</label><input id="r-avail" placeholder="Weekdays after 3pm"></div>
      </div>
    </div>
    <button class="btn pri full" id="r-go">Submit request</button>`);
  const fillUnits = () => { document.getElementById('r-unit').innerHTML = '<option value="">—</option>' + selOpts(META.units.filter(u => u.property_id === +fv('r-prop')), 'id', 'label'); };
  document.getElementById('r-prop').onchange = fillUnits; fillUnits();
  const rt = document.getElementById('r-rtype');
  const toggleTenant = () => { document.getElementById('r-tenant-fields').style.display = rt.value === 'tenant' ? 'block' : 'none'; };
  rt.onchange = toggleTenant;
  document.getElementById('r-go').onclick = async () => {
    try {
      await POST('/requests', {
        property_id: +fv('r-prop'), unit_id: +fv('r-unit') || null, category: fv('r-cat'), description: fv('r-desc'),
        priority: fv('r-pri'), reporter_type: fv('r-rtype'), reported_by: fv('r-rep') || undefined,
        reporter_phone: fv('r-phone') || undefined, access_instructions: fv('r-access') || undefined,
        permission_to_enter: fchk('r-pte'), pets: fv('r-pets') || undefined, preferred_availability: fv('r-avail') || undefined,
        is_emergency: fchk('r-emerg'), flag_safety: fchk('rf-safety'), flag_water: fchk('rf-water'),
        flag_electrical: fchk('rf-elec'), flag_hvac_out: fchk('rf-hvac')
      });
      closeModal(); toast('Request submitted for triage'); render();
    } catch (e) { toast(e.message); }
  };
}

window.ownerReview = (id, action) => {
  modal(`<h3>${action === 'release' ? 'Send to maintenance' : 'Decline this request'}</h3>
    <div class="s" style="margin-bottom:10px">${action === 'release' ? 'Your maintenance team will be notified and it enters the normal triage queue.' : 'The request is closed. Your note is kept on the record.'}</div>
    <div class="field"><label>Note (optional)</label><textarea id="or-note"></textarea></div>
    <button class="btn pri full" id="or-go">${action === 'release' ? 'Send to maintenance' : 'Decline request'}</button>`);
  document.getElementById('or-go').onclick = async () => {
    try { await POST(`/requests/${id}/review`, { action, note: fv('or-note') }); closeModal(); toast(action === 'release' ? 'Sent to maintenance' : 'Request declined'); render(); }
    catch (e) { toast(e.message); }
  };
};
window.triageConvert = id => {
  modal(`<h3>Create work order</h3>
    <div class="field"><label>Work order title</label><input id="tc-title" placeholder="Short, specific title"></div>
    <div class="row2">
      <div class="field"><label>Assign technician</label><select id="tc-tech"><option value="">— unassigned —</option>${selOpts(META.technicians, 'id', 'name')}</select></div>
      <div class="field"><label>Or vendor</label><select id="tc-vend"><option value="">—</option>${selOpts(META.vendors, 'id', 'company')}</select></div>
    </div>
    <div class="row2">
      <div class="field"><label>Schedule for</label><input id="tc-sched" type="date"></div>
      <div class="field"><label>Due date</label><input id="tc-due" type="date"></div>
    </div>
    <div class="s" style="color:var(--muted);margin-bottom:12px">Access instructions, pets, and availability from the request carry over automatically.</div>
    <button class="btn pri full" id="tc-go">Create work order</button>`);
  document.getElementById('tc-go').onclick = async () => {
    try {
      const r = await POST(`/requests/${id}/triage`, { action: 'convert', title: fv('tc-title') || undefined,
        assigned_user_id: +fv('tc-tech') || null, assigned_vendor_id: +fv('tc-vend') || null,
        scheduled_date: fv('tc-sched') || null, due_date: fv('tc-due') || null });
      closeModal(); toast(r.number + ' created'); location.hash = '#/work-orders/' + r.id;
    } catch (e) { toast(e.message); }
  };
};
window.triagePriority = (id, cur) => {
  modal(`<h3>Change priority</h3>
    <div class="field"><select id="tp-pri">${['emergency', 'high', 'normal', 'low'].map(p => `<option ${p === cur ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
    <button class="btn pri full" id="tp-go">Update priority</button>`);
  document.getElementById('tp-go').onclick = async () => {
    try { await POST(`/requests/${id}/triage`, { action: 'priority', priority: fv('tp-pri') }); closeModal(); render(); } catch (e) { toast(e.message); }
  };
};
window.triageNote = (id, action, title) => {
  modal(`<h3>${esc(title)}</h3>
    <div class="field"><label>Note (optional)</label><textarea id="tn-note"></textarea></div>
    <button class="btn pri full" id="tn-go">${esc(title)}</button>`);
  document.getElementById('tn-go').onclick = async () => {
    try { await POST(`/requests/${id}/triage`, { action, note: fv('tn-note') }); closeModal(); render(); } catch (e) { toast(e.message); }
  };
};
window.generatePM = async () => { try { await POST('/pm/generate', {}); toast('Preventive schedules checked — due work orders are created'); render(); } catch (e) { toast(e.message); } };

/* ---------------- work orders list ---------------- */
async function renderWorkOrders(qs) {
  loadingShell('#/work-orders');
  const params = new URLSearchParams(qs || '');
  const filt = params.get('f') || 'open';
  const q = filt === 'all' ? '' : (filt === 'open' ? '?open=1' : `?status=${filt}`);
  const wos = await GET('/work-orders' + q);
  const FILTERS = [['open', 'Open'], ['all', 'All'], ['new', 'New'], ['in_progress', 'In progress'], ['waiting_approval', 'Waiting approval'], ['waiting_vendor', 'Waiting vendor'], ['completed', 'Completed']];
  shell(`
    <div class="section-title" style="margin-top:0">Work orders ${canWrite() ? `<button class="btn pri" style="padding:8px 14px" id="wo-new">+ New</button>` : ''}</div>
    <div class="filters">${FILTERS.map(([k, l]) => `<a class="fpill ${filt === k ? 'on' : ''}" href="#/work-orders?f=${k}">${l}</a>`).join('')}</div>
    <div class="card" style="padding:6px 14px">
      ${wos.length ? wos.map(w => `
        <a class="list-item" href="#/work-orders/${w.id}">
          <div class="body">
            <div class="s">${w.number} · ${esc(w.category)} ${w.overdue ? '<b style="color:var(--red)">· OVERDUE</b>' : ''}</div>
            <div class="t">${esc(w.title)}</div>
            <div class="s">${esc(w.property_name)}${w.unit_label ? ' · Unit ' + esc(w.unit_label) : ''} · ${esc(w.tech_name || w.vendor_company || 'Unassigned')}</div>
          </div>
          <div class="end">${pri(w.priority)} ${chip(w.status)}${+w.total_cost ? `<div class="money" style="font-size:13px;margin-top:3px">${money(w.total_cost)}</div>` : ''}</div>
        </a>`).join('') : '<div class="empty">No work orders match this filter.</div>'}
    </div>`, '#/work-orders');
  const b = document.getElementById('wo-new'); if (b) b.onclick = () => openWOForm();
}

function openWOForm(preset) {
  preset = preset || {};
  modal(`<h3>New work order</h3>
    <div class="field"><label>Property</label><select id="w-prop">${selOpts(META.properties, 'id', 'name', preset.property_id)}</select></div>
    <div class="row2">
      <div class="field"><label>Unit</label><select id="w-unit"></select></div>
      <div class="field"><label>Category</label><select id="w-cat">${META.categories.map(c => `<option>${c}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Title</label><input id="w-title" placeholder="Short, specific title"></div>
    <div class="field"><label>Description</label><textarea id="w-desc"></textarea></div>
    <div class="field"><label>Instructions for tech (access codes, parking…)</label><input id="w-inst"></div>
    <div class="row2">
      <div class="field"><label>Priority</label><select id="w-pri"><option>normal</option><option>high</option><option>emergency</option><option>low</option></select></div>
      <div class="field"><label>Est. minutes</label><input id="w-est" type="number" inputmode="numeric" value="60"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Assign technician</label><select id="w-tech"><option value="">— unassigned —</option>${selOpts(META.technicians, 'id', 'name')}</select></div>
      <div class="field"><label>Or vendor</label><select id="w-vend"><option value="">—</option>${selOpts(META.vendors, 'id', 'company')}</select></div>
    </div>
    <div class="row2">
      <div class="field"><label>Schedule for</label><input id="w-sched" type="date"></div>
      <div class="field"><label>Due date</label><input id="w-due" type="date"></div>
    </div>
    <button class="btn pri full" id="w-go">Create work order</button>`);
  const fillUnits = () => { document.getElementById('w-unit').innerHTML = '<option value="">—</option>' + selOpts(META.units.filter(u => u.property_id === +fv('w-prop')), 'id', 'label', preset.unit_id); };
  document.getElementById('w-prop').onchange = fillUnits; fillUnits();
  document.getElementById('w-go').onclick = async () => {
    try {
      const r = await POST('/work-orders', {
        property_id: +fv('w-prop'), unit_id: +fv('w-unit') || null, category: fv('w-cat'), title: fv('w-title'),
        description: fv('w-desc') || undefined, instructions: fv('w-inst') || undefined, priority: fv('w-pri'),
        estimated_minutes: +fv('w-est') || 60, assigned_user_id: +fv('w-tech') || null,
        assigned_vendor_id: +fv('w-vend') || null, scheduled_date: fv('w-sched') || null, due_date: fv('w-due') || null
      });
      closeModal(); toast(r.number + ' created'); location.hash = '#/work-orders/' + r.id;
    } catch (e) { toast(e.message); }
  };
}

/* ---------------- work order detail ---------------- */
let CURRENT_WO = null;
async function renderWODetail(id) {
  loadingShell('#/work-orders');
  let d;
  try { d = await GET('/work-orders/' + id); } catch (e) {
    return shell(`<div class="card empty">This work order isn't available.<br><br><a class="btn sec" href="#/work-orders">Back to work orders</a></div>`, '#/work-orders');
  }
  CURRENT_WO = d;
  const w = d.wo;
  const isTech = ME.role === 'technician';
  const isVendor = ME.role === 'vendor';
  const openStatus = !['completed', 'cancelled'].includes(w.status);
  const beforePhotos = d.photos.filter(p => p.kind === 'before');
  const afterPhotos = d.photos.filter(p => p.kind === 'after');
  const receipts = d.photos.filter(p => p.kind === 'receipt');
  const generalPhotos = d.photos.filter(p => p.kind === 'general');
  const travelActive = d.time.find(t => t.kind === 'travel' && !t.ended_at && t.user_id === ME.id);
  const workActive = d.time.find(t => t.kind === 'work' && !t.ended_at && t.user_id === ME.id);
  const arrivedAlready = d.history.some(h => h.action === 'arrived' && h.user_id === ME.id);
  const pendingApproval = d.approvals.find(a => a.status === 'pending');
  const totalWorkMin = d.time.filter(t => t.kind === 'work' && t.minutes).reduce((s, t) => s + t.minutes, 0);
  const totalTravelMin = d.time.filter(t => t.kind === 'travel' && t.minutes).reduce((s, t) => s + t.minutes, 0);
  const myQuote = isVendor ? d.quotes.find(q => q.vendor_id === ME.vendor_id) : null;

  const checklist = d.completion.items.filter(i => i.required || i.done);
  const missing = d.completion.missing;

  shell(`
    <a class="more" href="${isTech ? '#/today' : isVendor ? '#/jobs' : '#/work-orders'}" style="font-size:13.5px">‹ Back</a>
    <div class="card" style="margin-top:10px">
      <div class="s">${w.number} · ${esc(w.category)} · ${w.source === 'preventive' ? 'Preventive' : w.source === 'request' ? 'From request' : 'Manual'}</div>
      <h2 style="margin:4px 0 8px;font-family:var(--font-d);font-size:21px">${esc(w.title)}</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${pri(w.priority)} ${chip(w.status)} ${w.overdue ? '<b style="color:var(--red);font-size:13px">OVERDUE</b>' : ''}</div>
      <div class="kv" style="margin-top:14px">
        <div><div class="k">Property</div><div class="v">${canRead() ? `<a href="#/properties/${w.property_id}" style="color:var(--pine)">${esc(w.property_name)}</a>` : esc(w.property_name)}${w.unit_label ? ' · Unit ' + esc(w.unit_label) : ''}</div></div>
        <div><div class="k">Address</div><div class="v"><span class="nav-link" onclick="openMaps('${esc(w.address)}, ${esc(w.city || '')}')">${ico('pin', 15)} ${esc(w.address)}${w.city ? ', ' + esc(w.city) : ''}</span></div></div>
        <div><div class="k">Assigned to</div><div class="v">${esc(w.tech_name || w.vendor_company || 'Unassigned')}</div></div>
        <div><div class="k">Scheduled</div><div class="v">${fmtDate(w.scheduled_date)} · due ${fmtDate(w.due_date)}</div></div>
        <div><div class="k">Cost so far</div><div class="v money">${money(w.total_cost)}</div></div>
        <div><div class="k">Time</div><div class="v">${fmtMin(totalWorkMin)} work${totalTravelMin ? ' + ' + fmtMin(totalTravelMin) + ' travel' : ''} (est ${fmtMin(w.estimated_minutes)})</div></div>
      </div>
      ${w.description ? `<div style="margin-top:12px;font-size:14.5px">${esc(w.description)}</div>` : ''}
      ${w.instructions ? `<div style="margin-top:8px;padding:10px 12px;background:var(--amber-soft);border-radius:10px;font-size:13.5px"><b>Instructions:</b> ${esc(w.instructions)}</div>` : ''}
      ${w.completion_notes ? `<div style="margin-top:8px;padding:10px 12px;background:var(--pine-soft);border-radius:10px;font-size:13.5px"><b>Completion notes:</b> ${esc(w.completion_notes)}</div>` : ''}
      ${canWrite() && openStatus ? `<div class="pill-row"><button class="btn sec" onclick="editWO()">Edit / reassign</button>${w.status !== 'cancelled' ? `<button class="btn danger" onclick="woStatus('cancelled')">Cancel job</button>` : ''}</div>` : ''}
    </div>

    ${pendingApproval ? `
    <div class="card" style="border-left:4px solid var(--amber)">
      <div class="card-title">Approval pending — ${money(pendingApproval.amount)}</div>
      <div class="s" style="margin-bottom:4px">${esc(pendingApproval.requested_by_name)}${pendingApproval.reason ? ' — ' + esc(pendingApproval.reason) : ''}</div>
      ${pendingApproval.required_role === 'owner' ? `<div class="s" style="font-weight:700;color:#9A6B00;margin-bottom:8px">Over ${money(d.approval_t2)} — requires an owner's sign-off</div>` : ''}
      ${canWrite() && (pendingApproval.required_role !== 'owner' || ME.role === 'owner') ? `
      <div class="row2" style="margin-top:6px">
        <button class="btn pri full" onclick="decide(${pendingApproval.id},'approved')">Approve</button>
        <button class="btn sec full" onclick="decide(${pendingApproval.id},'declined')">Decline</button>
      </div><button class="btn sec full" style="margin-top:8px" onclick="decide(${pendingApproval.id},'info_requested')">Request more info</button>` :
      canWrite() ? `<div class="s">Only an owner can decide this approval.</div>` : ''}
    </div>` : ''}

    ${(isTech || isVendor) && openStatus ? `
    <div class="card">
      <div class="card-title">Job actions</div>
      ${!workActive && !travelActive && !arrivedAlready && ['assigned', 'scheduled', 'new', 'waiting_vendor'].includes(w.status) ? `<button class="btn pri full big" onclick="travelStart()">${ico('car', 20)} Start travel</button>` : ''}
      ${travelActive ? `<button class="btn pri full big" onclick="arrived()">${ico('pin', 20)} I've arrived</button>` : ''}
      ${!workActive && !travelActive ? (() => {
        const needsBefore = d.completion.items.some(i => i.key === 'before_photo' && i.required && !i.done);
        return needsBefore
          ? `<label class="btn sec full big" style="margin-top:8px;display:block;text-align:center;cursor:pointer">${ico('camera', 20)} Take before photo to start<input type="file" accept="image/*" capture="environment" hidden onchange="uploadPhoto(this,'before')"></label>
             <div class="s" style="text-align:center;margin-top:6px;color:var(--muted)">A before photo is required for ${esc(w.category)} jobs.</div>`
          : `<button class="btn ${arrivedAlready ? 'pri' : 'sec'} full big" style="margin-top:8px" onclick="woStart()">${ico('play', 19)} Start work</button>`;
      })() : ''}
      ${workActive ? `
        <div class="timer-live">${ico('clock', 16)} Working since ${fmtTime(workActive.started_at)}</div>
        <button class="btn pri full big" onclick="openComplete()">${ico('check', 20)} Complete job</button>
        <div class="row2" style="margin-top:8px">
          <button class="btn sec full" onclick="woStatus('waiting_parts')">Waiting for parts</button>
          <button class="btn sec full" onclick="requestApproval()">Request approval</button>
        </div>` : ''}
      ${!workActive && ['in_progress', 'waiting_parts', 'waiting_approval'].includes(w.status) ? `<button class="btn pri full big" style="margin-top:8px" onclick="openComplete()">${ico('check', 20)} Complete job</button>` : ''}
    </div>` : ''}
    ${canWrite() && openStatus ? `<div class="card"><div class="card-title">Manage</div>
      <div class="row2">
        ${w.status !== 'completed' ? `<button class="btn pri full" onclick="openComplete()">Mark completed</button>` : ''}
        <button class="btn sec full" onclick="requestApproval()">Request approval</button>
      </div></div>` : ''}

    ${!isVendor || myQuote ? `
    <div class="card">
      <div class="card-title">Completion requirements <span class="s" style="font-weight:400">(${esc(w.category)})</span></div>
      <div class="checklist">
        ${checklist.length ? checklist.map(i => `
          <div class="ck ${i.done ? 'done' : ''} ${i.required ? 'req' : ''}">
            <span class="mark">${i.done ? '✓' : ''}</span><span class="lbl">${i.label}</span>
            ${!i.done && i.required && openStatus && !isVendor ? `<span class="fix">${{ before_photo: 'Add below', after_photo: 'Add below', completion_notes: 'On completion', materials: 'Add below', receipt: 'Add below', time_recorded: 'Start work' }[i.key] || ''}</span>` : ''}
          </div>`).join('') : '<div class="s">No specific requirements for this category.</div>'}
      </div>
    </div>` : ''}

    ${canWrite() || (isVendor && d.quotes.length) ? `
    <div class="card">
      <div class="card-title">Vendor quotes ${canWrite() && openStatus ? `<button class="more" onclick="requestQuotes()">Request quotes ›</button>` : ''}</div>
      ${d.quotes.length ? `<div class="${d.quotes.filter(q => q.status === 'submitted').length > 1 ? 'quote-grid' : ''}">
        ${d.quotes.map(q => `
        <div class="quote-card ${q.status === 'approved' ? 'approved' : ''}">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <b>${esc(q.vendor_company)}</b>
            <span class="chip ${q.status === 'approved' ? 'completed' : q.status === 'submitted' ? 'in_progress' : q.status === 'declined' ? 'cancelled' : 'new'}">${q.status}</span>
          </div>
          ${q.price != null ? `<div class="price money">${money(q.price)}</div>` : '<div class="s">Awaiting response</div>'}
          ${q.scope ? `<div class="s" style="margin-top:4px">${esc(q.scope)}</div>` : ''}
          ${q.est_start ? `<div class="s">Start ${fmtDate(q.est_start)} · done ${fmtDate(q.est_complete)}</div>` : ''}
          ${q.notes ? `<div class="s" style="font-style:italic">${esc(q.notes)}</div>` : ''}
          ${canWrite() && q.status === 'submitted' ? `<div class="row2" style="margin-top:8px">
            <button class="btn pri full" onclick="decideQuote(${q.id},'approved')">Approve & assign</button>
            <button class="btn sec full" onclick="decideQuote(${q.id},'declined')">Decline</button>
          </div>` : ''}
          ${isVendor && q.status === 'requested' && q.vendor_id === ME.vendor_id ? `<button class="btn pri full" style="margin-top:8px" onclick="submitQuote(${q.id})">Submit your quote</button>` : ''}
        </div>`).join('')}</div>` : '<div class="s">No quotes requested for this job.</div>'}
    </div>` : ''}

    <div class="card">
      <div class="card-title">Photos</div>
      ${['before', 'after'].map(k => {
        const arr = k === 'before' ? beforePhotos : afterPhotos;
        return `<div class="s" style="font-weight:700;margin:6px 0 4px;text-transform:capitalize">${k} (${arr.length})</div>
        <div class="photo-row">${arr.map(p => `<img src="${p.url}" loading="lazy" onclick="window.open('${p.url}')">`).join('')}
        ${openStatus && !isVendor || (isVendor && w.assigned_vendor_id === ME.vendor_id && openStatus) ? `<label class="photo-add">+<input type="file" accept="image/*" capture="environment" hidden onchange="uploadPhoto(this,'${k}')"></label>` : ''}</div>`;
      }).join('')}
      ${receipts.length || openStatus ? `<div class="s" style="font-weight:700;margin:6px 0 4px">Receipts (${receipts.length})</div>
      <div class="photo-row">${receipts.map(p => `<img src="${p.url}" loading="lazy" onclick="window.open('${p.url}')">`).join('')}
      ${openStatus ? `<label class="photo-add">+<input type="file" accept="image/*" capture="environment" hidden onchange="uploadPhoto(this,'receipt')"></label>` : ''}</div>` : ''}
      ${generalPhotos.length ? `<div class="s" style="font-weight:700;margin:6px 0 4px">Other</div>
      <div class="photo-row">${generalPhotos.map(p => `<img src="${p.url}" loading="lazy" onclick="window.open('${p.url}')">`).join('')}</div>` : ''}
    </div>

    <div class="card">
      <div class="card-title">Materials & expenses</div>
      ${d.materials.map(m => `<div class="list-item"><div class="body"><div class="t">${esc(m.name)}</div><div class="s">${m.qty} × ${money(m.unit_cost)}</div></div><div class="end money">${money(m.qty * m.unit_cost)}</div></div>`).join('')}
      ${d.expenses.filter(e => e.category !== 'materials').map(e => `<div class="list-item"><div class="body"><div class="t">${esc(e.description || e.category)}</div><div class="s">${esc(e.category)}</div></div><div class="end money">${money(e.amount)}</div></div>`).join('')}
      ${!d.materials.length && !d.expenses.length ? '<div class="s">Nothing recorded yet.</div>' : ''}
      ${openStatus && !isVendor || (isVendor && w.assigned_vendor_id === ME.vendor_id && openStatus) ? `<div class="row2" style="margin-top:10px">
        <button class="btn sec full" onclick="addMaterial()">+ Material</button>
        <button class="btn sec full" onclick="addExpense()">+ Expense</button>
      </div>` : ''}
    </div>

    <div class="card">
      <div class="card-title">Notes</div>
      ${d.comments.map(c => `<div class="note"><div class="s"><b>${esc(c.user_name)}</b> · ${fmtDateTime(c.created_at)}${c.is_voice_note ? ' · 🎙 voice' : ''}</div><div>${esc(c.body)}</div></div>`).join('') || '<div class="s">No notes yet.</div>'}
      ${openStatus ? `
      <div class="field" style="margin-top:10px"><textarea id="note-body" placeholder="Add a note…"></textarea></div>
      <div class="row2">
        <button class="btn sec full" id="voice-btn" onclick="voiceNote()">🎙 Voice note</button>
        <button class="btn pri full" onclick="addNote(false)">Add note</button>
      </div>` : ''}
    </div>

    <div class="card">
      <div class="card-title">Activity timeline</div>
      ${d.history.map(h => `<div class="tl-item"><div class="tl-dot ${h.action === 'completion_override' ? 'warn' : ''}"></div>
        <div><div class="s">${fmtDateTime(h.created_at)}${h.user_name ? ' · ' + esc(h.user_name) : ''}</div>
        <div style="font-size:13.5px">${esc(h.detail || h.action)}${h.old_value != null && h.new_value != null ? ` <span class="s">(${esc(STATUS_LABEL[h.old_value] || h.old_value)} → ${esc(STATUS_LABEL[h.new_value] || h.new_value)})</span>` : ''}</div></div></div>`).join('')}
    </div>
  `, isTech ? '#/today' : isVendor ? '#/jobs' : '#/work-orders');
}

/* --- WO detail action helpers --- */
// Hand the destination to whichever maps app the tech already uses
window.openMaps = addr => window.open('https://maps.google.com/?q=' + encodeURIComponent(addr), '_blank');
window.travelStart = async () => { try { const r = await POST(`/work-orders/${CURRENT_WO.wo.id}/travel/start`, {}); toast(isQueued(r) ? 'Travel started — saved offline' : 'Travel started'); render(); } catch (e) { toast(e.message); } };
window.arrived = async () => { try { const r = await POST(`/work-orders/${CURRENT_WO.wo.id}/arrived`, {}); toast(isQueued(r) ? 'Arrival saved offline' : 'Arrival recorded'); render(); } catch (e) { toast(e.message); } };
window.woStart = async (override) => {
  try { const r = await POST(`/work-orders/${CURRENT_WO.wo.id}/time/start`, override ? { override: true, override_note: override } : {}); toast(isQueued(r) ? 'Work started — saved offline' : 'Work timer started'); render(); }
  catch (e) {
    if (e.data && e.data.needs === 'before_photo' && canWrite()) {
      confirmModal('Start without a before photo?', 'A before photo is required for this category. Starting anyway will be logged.',
        () => { closeModal(); woStart('Manager started without before photo'); }, 'Start anyway');
    } else toast(e.message);
  }
};
window.woStatus = async s => { try { await PATCH(`/work-orders/${CURRENT_WO.wo.id}`, { status: s }); render(); } catch (e) { toast(e.message); } };

window.openComplete = () => {
  const d = CURRENT_WO;
  const missing = d.completion.missing.filter(m => m.key !== 'completion_notes');
  modal(`<h3>Complete job</h3>
    <div class="checklist" style="margin-bottom:10px">
      ${d.completion.items.filter(i => i.required).map(i => `
        <div class="ck ${i.done || i.key === 'completion_notes' ? 'done' : ''} req"><span class="mark">${i.done || i.key === 'completion_notes' ? '✓' : ''}</span><span class="lbl">${i.label}</span></div>`).join('') || '<div class="s">No requirements configured for this category.</div>'}
    </div>
    ${missing.length ? `<div class="err" style="margin-bottom:10px">Still needed: ${missing.map(m => m.label).join(', ')}. Close this and add them${canWrite() ? ', or override below' : ''}.</div>` : ''}
    <div class="field"><label>Completion notes${d.completion.items.some(i => i.key === 'completion_notes' && i.required) ? ' (required)' : ''}</label><textarea id="cmp-notes" placeholder="What was done, parts used, anything the owner should know…"></textarea></div>
    ${canWrite() && missing.length ? `
      <div class="tglrow"><span><b>Manager override</b> — complete anyway</span><input type="checkbox" class="tgl" id="cmp-ovr"></div>
      <div class="field" id="ovr-note-w" style="display:none"><label>Override reason (logged)</label><input id="cmp-ovr-note"></div>` : ''}
    <button class="btn pri full" id="cmp-go" ${missing.length && !canWrite() ? 'disabled' : ''}>Complete job</button>`);
  const ovr = document.getElementById('cmp-ovr');
  if (ovr) ovr.onchange = () => { document.getElementById('ovr-note-w').style.display = ovr.checked ? 'block' : 'none'; };
  document.getElementById('cmp-go').onclick = async () => {
    try {
      const r = await PATCH(`/work-orders/${CURRENT_WO.wo.id}`, { status: 'completed', completion_notes: fv('cmp-notes') || undefined,
        override: ovr ? ovr.checked : false, override_note: fv('cmp-ovr-note') || undefined });
      closeModal(); toast(isQueued(r) ? 'Job completed — saved offline' : 'Job completed'); render();
    } catch (e) {
      toast(e.message);
    }
  };
};

window.uploadPhoto = async (input, kind) => {
  if (!input.files || !input.files[0]) return;
  const fd = new FormData();
  fd.append('photo', input.files[0]); fd.append('kind', kind);
  try { const r = await api(`/work-orders/${CURRENT_WO.wo.id}/photos`, { method: 'POST', body: fd }); toast(isQueued(r) ? 'Photo saved — will upload when you reconnect' : 'Photo added'); render(); }
  catch (e) { toast(e.message); }
};
window.addNote = async isVoice => {
  const body = fv('note-body');
  if (!body) return toast('Write a note first');
  try { await POST(`/work-orders/${CURRENT_WO.wo.id}/comments`, { body, is_voice_note: !!isVoice }); render(); } catch (e) { toast(e.message); }
};
window.voiceNote = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Voice input is not supported in this browser — type the note instead');
  const rec = new SR(); rec.lang = 'en-US'; rec.interimResults = false;
  const btn = document.getElementById('voice-btn'); btn.textContent = '🔴 Listening…';
  rec.onresult = e => { document.getElementById('note-body').value = e.results[0][0].transcript; btn.textContent = '🎙 Voice note'; addNote(true); };
  rec.onerror = () => { btn.textContent = '🎙 Voice note'; toast('Could not hear that — try again'); };
  rec.start();
};
window.addMaterial = () => {
  modal(`<h3>Add material</h3>
    <div class="field"><label>Material</label><input id="m-name" placeholder="e.g., 3/4&quot; PVC elbow"></div>
    <div class="row2">
      <div class="field"><label>Qty</label><input id="m-qty" type="number" inputmode="decimal" value="1"></div>
      <div class="field"><label>Unit cost ($)</label><input id="m-cost" type="number" inputmode="decimal" step="0.01"></div>
    </div>
    <button class="btn pri full" id="m-go">Add material</button>`);
  document.getElementById('m-go').onclick = async () => {
    try { await POST(`/work-orders/${CURRENT_WO.wo.id}/materials`, { name: fv('m-name'), qty: +fv('m-qty') || 1, unit_cost: +fv('m-cost') || 0 }); closeModal(); render(); }
    catch (e) { toast(e.message); }
  };
};
window.addExpense = () => {
  modal(`<h3>Add expense</h3>
    <div class="field"><label>Category</label><select id="e-cat"><option>labor</option><option>materials</option><option>vendor</option><option>permit</option><option>other</option></select></div>
    <div class="field"><label>Description</label><input id="e-desc"></div>
    <div class="field"><label>Amount ($)</label><input id="e-amt" type="number" inputmode="decimal" step="0.01"></div>
    <button class="btn pri full" id="e-go">Add expense</button>`);
  document.getElementById('e-go').onclick = async () => {
    try { await POST(`/work-orders/${CURRENT_WO.wo.id}/expenses`, { category: fv('e-cat'), description: fv('e-desc'), amount: +fv('e-amt') }); closeModal(); render(); }
    catch (e) { toast(e.message); }
  };
};
window.requestApproval = () => {
  const t1 = CURRENT_WO.approval_t1, t2 = CURRENT_WO.approval_t2;
  modal(`<h3>Request spending approval</h3>
    <div class="s" style="margin-bottom:10px">Under ${money(t1)}: no approval needed. ${money(t1)}–${money(t2)}: manager. Over ${money(t2)}: owner.</div>
    <div class="field"><label>Estimated amount ($)</label><input id="a-amt" type="number" inputmode="decimal" step="0.01"></div>
    <div class="field"><label>What's needed and why</label><textarea id="a-reason"></textarea></div>
    <button class="btn pri full" id="a-go">Send request</button>`);
  document.getElementById('a-go').onclick = async () => {
    try {
      const r = await POST(`/work-orders/${CURRENT_WO.wo.id}/approvals`, { amount: +fv('a-amt'), reason: fv('a-reason') });
      closeModal(); toast(r.required_role === 'owner' ? 'Sent — requires owner approval' : 'Approval requested'); render();
    } catch (e) { toast(e.message); }
  };
};
window.decide = (id, decision) => {
  modal(`<h3>${{ approved: 'Approve spending', declined: 'Decline request', info_requested: 'Request more information' }[decision]}</h3>
    <div class="field"><label>Note ${decision === 'approved' ? '(optional)' : ''}</label><textarea id="d-note"></textarea></div>
    <button class="btn pri full" id="d-go">Confirm</button>`);
  document.getElementById('d-go').onclick = async () => {
    try { await PATCH(`/approvals/${id}`, { decision, note: fv('d-note') }); closeModal(); render(); } catch (e) { toast(e.message); }
  };
};
window.requestQuotes = () => {
  modal(`<h3>Request vendor quotes</h3>
    <div class="s" style="margin-bottom:10px">Selected vendors are notified and can submit price, scope, and timing.</div>
    ${META.vendors.map(v => `<div class="tglrow"><span>${esc(v.company)}</span><input type="checkbox" class="tgl qv" value="${v.id}"></div>`).join('')}
    <button class="btn pri full" style="margin-top:12px" id="q-go">Send quote requests</button>`);
  document.getElementById('q-go').onclick = async () => {
    const ids = [...document.querySelectorAll('.qv:checked')].map(c => +c.value);
    try { await POST(`/work-orders/${CURRENT_WO.wo.id}/quotes/request`, { vendor_ids: ids }); closeModal(); toast('Quote requests sent'); render(); }
    catch (e) { toast(e.message); }
  };
};
window.submitQuote = qid => {
  modal(`<h3>Submit quote</h3>
    <div class="field"><label>Price ($)</label><input id="sq-price" type="number" inputmode="decimal" step="0.01"></div>
    <div class="field"><label>Scope of work</label><textarea id="sq-scope"></textarea></div>
    <div class="row2">
      <div class="field"><label>Can start</label><input id="sq-start" type="date"></div>
      <div class="field"><label>Complete by</label><input id="sq-end" type="date"></div>
    </div>
    <div class="field"><label>Notes</label><input id="sq-notes"></div>
    <button class="btn pri full" id="sq-go">Submit quote</button>`);
  document.getElementById('sq-go').onclick = async () => {
    try { await POST(`/quotes/${qid}/submit`, { price: +fv('sq-price'), scope: fv('sq-scope'), est_start: fv('sq-start') || null, est_complete: fv('sq-end') || null, notes: fv('sq-notes') || null }); closeModal(); toast('Quote submitted'); render(); }
    catch (e) { toast(e.message); }
  };
};
window.decideQuote = (id, decision) => {
  confirmModal(decision === 'approved' ? 'Approve this quote?' : 'Decline this quote?',
    decision === 'approved' ? 'The job will be assigned to this vendor and other submitted quotes declined.' : 'The vendor will be notified.',
    async () => { try { await PATCH(`/quotes/${id}`, { decision }); closeModal(); render(); } catch (e) { toast(e.message); } },
    decision === 'approved' ? 'Approve & assign' : 'Decline');
};
window.editWO = () => {
  const w = CURRENT_WO.wo;
  modal(`<h3>Edit work order</h3>
    <div class="field"><label>Title</label><input id="ew-title" value="${esc(w.title)}"></div>
    <div class="row2">
      <div class="field"><label>Priority</label><select id="ew-pri">${['emergency', 'high', 'normal', 'low'].map(p => `<option ${p === w.priority ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div class="field"><label>Status</label><select id="ew-status">${Object.keys(STATUS_LABEL).map(s => `<option value="${s}" ${s === w.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></div>
    </div>
    <div class="row2">
      <div class="field"><label>Technician</label><select id="ew-tech"><option value="">— unassigned —</option>${selOpts(META.technicians, 'id', 'name', w.assigned_user_id)}</select></div>
      <div class="field"><label>Vendor</label><select id="ew-vend"><option value="">—</option>${selOpts(META.vendors, 'id', 'company', w.assigned_vendor_id)}</select></div>
    </div>
    <div class="row2">
      <div class="field"><label>Scheduled</label><input id="ew-sched" type="date" value="${w.scheduled_date || ''}"></div>
      <div class="field"><label>Due</label><input id="ew-due" type="date" value="${w.due_date || ''}"></div>
    </div>
    <div class="field"><label>Instructions</label><input id="ew-inst" value="${esc(w.instructions || '')}"></div>
    <button class="btn pri full" id="ew-go">Save changes</button>`);
  document.getElementById('ew-go').onclick = async () => {
    try {
      await PATCH(`/work-orders/${w.id}`, { title: fv('ew-title'), priority: fv('ew-pri'), status: fv('ew-status'),
        assigned_user_id: +fv('ew-tech') || null, assigned_vendor_id: +fv('ew-vend') || null,
        scheduled_date: fv('ew-sched') || null, due_date: fv('ew-due') || null, instructions: fv('ew-inst') || null });
      closeModal(); render();
    } catch (e) { toast(e.message); }
  };
};

/* ---------------- technician: today / jobs / profile ---------------- */
function jobCard(w, emphasized) {
  return `<a class="job-card ${emphasized ? 'next' : ''} ${w.priority === 'emergency' ? 'emergency' : ''}" href="#/work-orders/${w.id}">
    ${emphasized ? '<div class="next-label">NEXT JOB</div>' : ''}
    <div class="s">${w.number} · ${esc(w.category)} ${w.overdue ? '<b style="color:var(--red)">· OVERDUE</b>' : ''}</div>
    <div class="t">${esc(w.title)}</div>
    <div class="s">${esc(w.property_name)}${w.unit_label ? ' · Unit ' + esc(w.unit_label) : ''}</div>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">${pri(w.priority)} ${chip(w.status)} <span class="s">est ${fmtMin(w.estimated_minutes)}</span></div>
    <span class="nav-link" onclick="event.preventDefault();event.stopPropagation();openMaps('${esc(w.address)}, ${esc(w.city || '')}')">${ico('pin', 16)} ${esc(w.address)}</span>
  </a>`;
}
async function renderToday() {
  loadingShell('#/today');
  const wos = await GET('/work-orders?open=1');
  const staleNote = wos.__offline ? `<div class="banner off">${ico('alert', 15)} Offline — showing the jobs saved on this phone. Anything you do now syncs when you reconnect.</div>` : '';
  const today = new Date().toISOString().slice(0, 10);
  const emergencies = wos.filter(w => w.priority === 'emergency');
  const todays = wos.filter(w => w.priority !== 'emergency' && (w.scheduled_date === today || !w.scheduled_date || w.scheduled_date < today));
  const active = wos.find(w => w.status === 'in_progress');
  const waiting = wos.filter(w => ['waiting_parts', 'waiting_approval'].includes(w.status));
  const queue = todays.filter(w => !['waiting_parts', 'waiting_approval', 'in_progress'].includes(w.status));
  shell(`
    ${staleNote}
    <div class="hello">Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${esc(ME.name.split(' ')[0])}.
      <div class="s">${emergencies.length ? `🚨 ${emergencies.length} emergency — handle first` : `${queue.length + (active ? 1 : 0)} job${queue.length + (active ? 1 : 0) === 1 ? '' : 's'} on your plate today`}</div>
    </div>
    ${emergencies.length ? `<div class="section-title">🚨 Emergencies</div>${emergencies.map(w => jobCard(w, true)).join('')}` : ''}
    ${active ? `<div class="section-title">In progress</div>${jobCard(active, !emergencies.length)}` : ''}
    ${queue.length ? `<div class="section-title">Up next</div>${queue.map((w, i) => jobCard(w, !emergencies.length && !active && i === 0)).join('')}` : ''}
    ${waiting.length ? `<div class="section-title">Waiting</div>${waiting.map(w => jobCard(w)).join('')}` : ''}
    ${!wos.length ? '<div class="card empty">No open jobs assigned to you. Enjoy the quiet while it lasts.</div>' : ''}
  `, '#/today');
}
async function renderJobs() {
  loadingShell('#/jobs');
  const wos = await GET('/work-orders');
  const open = wos.filter(w => !['completed', 'cancelled'].includes(w.status));
  const done = wos.filter(w => w.status === 'completed').slice(0, 20);
  shell(`
    <div class="section-title" style="margin-top:0">Open jobs (${open.length})</div>
    ${open.map(w => jobCard(w)).join('') || '<div class="card empty">No open jobs.</div>'}
    <div class="section-title">Recently completed</div>
    <div class="card">${done.map(w => `<a class="list-item" href="#/work-orders/${w.id}"><div class="body"><div class="t">${esc(w.title)}</div><div class="s">${esc(w.property_name)} · ${fmtDate(w.completed_at)}</div></div><div class="end money">${money(w.total_cost)}</div></a>`).join('') || '<div class="s">Nothing yet.</div>'}</div>
  `, '#/jobs');
}
async function renderProfile() {
  loadingShell('#/profile');
  shell(`
    <div class="card"><div class="card-title">${esc(ME.name)}</div>
      <div class="s">${esc(ME.email)} · ${ME.role}</div>
      <button class="btn danger full" style="margin-top:12px" onclick="doLogout()">Sign out</button>
    </div>
    <div class="card"><div class="card-title">Notification preferences</div><div id="np-slot"><div class="skel"></div></div></div>
  `, '#/profile');
  mountNotifPrefs('np-slot');
}

/* ---------------- properties ---------------- */
async function renderProperties(qs) {
  const params = new URLSearchParams(qs || '');
  if (params.get('view') === 'compare') return renderComparison();
  loadingShell('#/properties');
  const props = await GET('/properties');
  shell(`
    <div class="section-title" style="margin-top:0">Properties
      <span><a class="btn sec" style="padding:8px 12px;margin-right:6px" href="#/properties?view=compare">Compare</a>
      ${canWrite() ? `<button class="btn pri" style="padding:8px 14px" id="p-new">+ Property</button>` : ''}</span>
    </div>
    <div class="prop-grid">
      ${props.map(p => `
        <a class="prop-card" href="#/properties/${p.id}">
          <div class="prop-hero" style="${propGradient(p.id)}"><span>${esc(p.name.split(' ').map(w => w[0]).join('').slice(0, 3))}</span></div>
          <div class="prop-body">
            <div style="display:flex;justify-content:space-between;align-items:center"><b>${esc(p.name)}</b>${healthRing(p.health)}</div>
            <div class="s">${esc(p.address)}${p.city ? ', ' + esc(p.city) : ''}</div>
            <div class="s" style="margin-top:5px">${p.unit_count} unit${p.unit_count === 1 ? '' : 's'} · ${p.open_wos} open · <span class="money">${money(p.ytd_cost)}</span> YTD</div>
          </div>
        </a>`).join('')}
    </div>
    ${!props.length ? `<div class="card empty">No properties yet.${canWrite() ? '<br><br><button class="btn pri" id="p-new2">Add your first property</button>' : ''}</div>` : ''}
  `, '#/properties');
  const open = () => {
    modal(`<h3>Add property</h3>
      <div class="field"><label>Name</label><input id="p-name"></div>
      <div class="field"><label>Address</label><input id="p-addr"></div>
      <div class="row2"><div class="field"><label>City</label><input id="p-city" value="Jacksonville"></div>
      <div class="field"><label>State</label><input id="p-state" value="FL"></div></div>
      <div class="row2"><div class="field"><label>Type</label><select id="p-type"><option>duplex</option><option>quadplex</option><option>single-family</option><option>small multifamily</option></select></div>
      <div class="field"><label>Year built</label><input id="p-year" type="number"></div></div>
      <button class="btn pri full" id="p-go">Add property</button>`);
    document.getElementById('p-go').onclick = async () => {
      try { const r = await POST('/properties', { name: fv('p-name'), address: fv('p-addr'), city: fv('p-city'), state: fv('p-state'), type: fv('p-type'), year_built: fv('p-year') }); await bootMeta(); closeModal(); location.hash = '#/properties/' + r.id; }
      catch (e) { toast(e.message); }
    };
  };
  const b = document.getElementById('p-new'); if (b) b.onclick = open;
  const b2 = document.getElementById('p-new2'); if (b2) b2.onclick = open;
}

async function renderComparison() {
  loadingShell('#/properties');
  const rows = await GET('/comparison');
  let sortKey = 'per_unit', sortDir = -1;
  const draw = () => {
    const sorted = [...rows].sort((a, b) => ((a[sortKey] ?? -1) < (b[sortKey] ?? -1) ? 1 : -1) * sortDir);
    const th = (k, l) => `<th class="sortable" data-k="${k}">${l}${sortKey === k ? (sortDir === -1 ? ' ▾' : ' ▴') : ''}</th>`;
    document.getElementById('cmp-body').innerHTML = `
      <div style="overflow-x:auto"><table class="tbl">
        <thead><tr>${th('name', 'Property')}${th('unit_count', 'Units')}${th('spend12', '12-mo spend')}${th('per_unit', '$/unit')}${th('open_wos', 'Open')}${th('overdue_wos', 'Overdue')}${th('repeat_warnings', 'Repeat ⚠')}${th('pm_compliance', 'PM %')}${th('upcoming_capex', 'CapEx 24mo')}</tr></thead>
        <tbody>${sorted.map(r => `<tr onclick="location.hash='#/properties/${r.id}'" style="cursor:pointer">
          <td><b>${esc(r.name)}</b></td><td>${r.unit_count}</td><td class="money">${money(r.spend12)}</td>
          <td class="money">${money(r.per_unit)}</td><td>${r.open_wos}</td>
          <td>${r.overdue_wos ? `<b style="color:var(--red)">${r.overdue_wos}</b>` : 0}</td>
          <td>${r.repeat_warnings ? `<b style="color:#9A6B00">${r.repeat_warnings}</b>` : '—'}</td>
          <td>${r.pm_compliance == null ? '—' : r.pm_compliance + '%'}</td>
          <td class="money">${r.upcoming_capex ? money(r.upcoming_capex) : '—'}</td></tr>`).join('')}</tbody>
      </table></div>`;
    document.querySelectorAll('th.sortable').forEach(t => t.onclick = () => {
      const k = t.dataset.k;
      if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; }
      draw();
    });
  };
  shell(`
    <a class="more" href="#/properties" style="font-size:13.5px">‹ Properties</a>
    <div class="section-title">Property comparison <span class="s" style="font-weight:400">tap a column to sort</span></div>
    <div class="card" id="cmp-body"></div>
  `, '#/properties');
  draw();
}

async function renderPropertyDetail(id, qs) {
  loadingShell('#/properties');
  let d;
  try { d = await GET('/properties/' + id); } catch (e) {
    return shell(`<div class="card empty">This property isn't available.<br><br><a class="btn sec" href="#/properties">Back</a></div>`, '#/properties');
  }
  const p = d.property, s = d.snapshot;
  const params = new URLSearchParams(qs || '');
  const tab = params.get('tab') || 'overview';
  let tlCat = params.get('cat') || '', tlUnit = params.get('unit') || '';
  const cats = [...new Set(d.timeline.map(t => t.category).filter(Boolean))];
  const tl = d.timeline.filter(t => (!tlCat || t.category === tlCat) && (!tlUnit || String(t.unit_id) === tlUnit));

  const TABS = [['overview', 'Overview'], ['timeline', `History (${d.timeline.length})`], ['assets', `Assets (${d.assets.length})`], ['expenses', 'Expenses'], ['pm', `PM (${d.pm.length})`]];
  shell(`
    <a class="more" href="#/properties" style="font-size:13.5px">‹ Properties</a>
    <div class="prop-hero lg" style="${propGradient(p.id)};margin-top:10px"><span>${esc(p.name)}</span></div>
    <div class="s" style="margin:8px 0 2px">${esc(p.address)}${p.city ? ', ' + esc(p.city) : ''} · ${esc(p.type || '')}${p.year_built ? ' · built ' + p.year_built : ''}</div>

    <div class="snap" style="margin-top:12px">
      <div class="cell"><div class="v ${s.open_wos ? '' : ''}">${s.open_wos}</div><div class="l">Open work orders</div></div>
      <div class="cell"><div class="v money">${money(s.spend_ytd)}</div><div class="l">Spend YTD</div></div>
      <div class="cell"><div class="v ${s.pm_overdue ? 'bad' : ''}">${s.pm_overdue ? s.pm_overdue + ' overdue' : s.pm_upcoming}</div><div class="l">${s.pm_overdue ? 'PM overdue' : 'PM upcoming'}</div></div>
      <div class="cell"><div class="v ${s.assets_near_replacement ? 'warn' : ''}">${s.assets_near_replacement}</div><div class="l">Assets near replacement</div></div>
    </div>
    ${s.repeat_warnings ? `<div class="banner warn">${ico('repeat', 16)} ${s.repeat_warnings} repeat-repair pattern${s.repeat_warnings > 1 ? 's' : ''} at this property — see health details.</div>` : ''}

    <div class="filters">${TABS.map(([k, l]) => `<a class="fpill ${tab === k ? 'on' : ''}" href="#/properties/${id}?tab=${k}">${l}</a>`).join('')}</div>

    ${tab === 'overview' ? `
      <div class="card">
        <div class="card-title">Condition score ${healthRing(d.health.score)}</div>
        ${d.health.reasons.length ? d.health.reasons.map(r => `<div class="hr-item"><span class="pts">${r.points}</span> ${esc(r.reason)}</div>`).join('') : '<div class="s">No issues detected — score reflects a clean recent record.</div>'}
        <div class="s" style="margin-top:8px;color:var(--muted)">Score starts at 100 and subtracts for open issues, overdue work, emergencies, repeat repairs, aging equipment, and cost spikes.</div>
      </div>
      ${canWrite() ? `<div class="card" style="border-left:4px solid var(--pine)">
        <div class="card-title">Tenant request link</div>
        <div class="s" style="margin-bottom:10px">Tenants report issues here — no app, no login. Text them the link once, or print the QR for the laundry room and unit doors. Requests land in your triage queue with photos and access details.</div>
        <div class="field"><input value="${location.origin}/#/report/${esc(p.intake_token)}" readonly onclick="this.select()"></div>
        <div class="row2">
          <button class="btn pri full" onclick="navigator.clipboard.writeText('${location.origin}/#/report/${esc(p.intake_token)}');toast('Tenant link copied')">Copy link</button>
          <button class="btn sec full" onclick="showQR('intake',${p.id})">Print QR poster</button>
        </div>
        <button class="btn sec full" style="margin-top:8px" onclick="rotateIntake(${p.id})">Reset link (old one stops working)</button>
        <div style="border-top:1px solid var(--line);margin-top:12px;padding-top:10px">
          <div class="s" style="font-weight:700;margin-bottom:6px">Where do tenant requests go first?</div>
          <div class="tglrow"><span>Straight to maintenance triage</span><input type="radio" name="rt${p.id}" class="tgl" ${p.tenant_routing !== 'owner' ? 'checked' : ''} onchange="setRouting(${p.id},'maintenance')" ${ME.role === 'owner' ? '' : 'disabled'}></div>
          <div class="tglrow"><span>Owner reviews first, then releases to maintenance</span><input type="radio" name="rt${p.id}" class="tgl" ${p.tenant_routing === 'owner' ? 'checked' : ''} onchange="setRouting(${p.id},'owner')" ${ME.role === 'owner' ? '' : 'disabled'}></div>
          <div class="s" style="color:var(--muted);margin-top:4px">Emergencies always go straight to maintenance regardless of this setting.${ME.role === 'owner' ? '' : ' Only an owner can change routing.'}</div>
        </div>
      </div>` : ''}
      <div class="card">
        <div class="card-title">Units (${d.units.length}) ${canWrite() ? `<button class="more" onclick="addUnit(${p.id})">+ Add ›</button>` : ''}</div>
        ${d.units.map(u => `<div class="list-item"><div class="body"><div class="t">Unit ${esc(u.label)}</div><div class="s">${u.beds || '—'} bd · ${u.baths || '—'} ba${u.sqft ? ' · ' + u.sqft + ' sqft' : ''}</div></div>
          <div class="end">${canWrite()
            ? `<button class="chip ${u.occupied ? 'completed' : 'cancelled'}" style="border:none;cursor:pointer" onclick="toggleOccupied(${u.id},${u.occupied ? 0 : 1})">${u.occupied ? 'Occupied' : 'Vacant'}</button>`
            : (u.occupied ? '<span class="chip completed">Occupied</span>' : '<span class="chip cancelled">Vacant</span>')}</div></div>`).join('') || '<div class="s">No units recorded.</div>'}
      </div>
      <div class="card">
        <div class="card-title">Open work orders (${d.open_wos.length}) ${canWrite() ? `<button class="more" onclick='openWOForm({property_id:${p.id}})'>+ New ›</button>` : ''}</div>
        ${d.open_wos.map(w => `<a class="list-item" href="#/work-orders/${w.id}"><div class="body"><div class="t">${esc(w.title)}</div><div class="s">${w.number} · ${esc(w.tech_name || w.vendor_company || 'Unassigned')}</div></div><div class="end">${pri(w.priority)} ${chip(w.status)}</div></a>`).join('') || '<div class="s">Nothing open.</div>'}
      </div>` : ''}

    ${tab === 'timeline' ? `
      <div class="filters">
        <select id="tl-cat" class="fpill" style="border:none">${['<option value="">All categories</option>', ...cats.map(c => `<option ${tlCat === c ? 'selected' : ''}>${c}</option>`)].join('')}</select>
        <select id="tl-unit" class="fpill" style="border:none"><option value="">All units</option>${d.units.map(u => `<option value="${u.id}" ${tlUnit == u.id ? 'selected' : ''}>Unit ${esc(u.label)}</option>`).join('')}</select>
      </div>
      <div class="card">
        ${tl.map(t => `<div class="tl-item"><div class="tl-dot"></div><div style="flex:1">
          <div class="s">${fmtDateFull(t.date)}${t.who ? ` · ${esc(t.who)}${t.who_type === 'vendor' ? ' (vendor)' : ''}` : ''}${t.unit ? ' · Unit ' + esc(t.unit) : ''}</div>
          <div style="font-size:14px"><span class="tl-badge ${t.kind}">${t.kind}</span>${t.link ? `<a href="${t.link}" style="color:var(--pine);font-weight:600">${esc(t.title)}</a>` : `<b>${esc(t.title)}</b>`}${t.has_photos ? ' 📷' : ''}</div>
          ${t.note ? `<div class="s">${esc(t.note)}</div>` : ''}
        </div>${t.cost ? `<div class="end money">${money(t.cost)}</div>` : ''}</div>`).join('') || '<div class="s">No history matches these filters.</div>'}
      </div>` : ''}

    ${tab === 'assets' ? `
      <div class="card">
        <div class="card-title">Equipment & assets ${canWrite() ? `<button class="more" onclick="addAsset(${p.id})">+ Add ›</button>` : ''}</div>
        ${d.assets.map(a => {
          const age = a.install_date && a.useful_life_years ? (Date.now() - new Date(a.install_date)) / (365.25 * 864e5) : null;
          const pct = age != null ? age / a.useful_life_years : null;
          return `<div class="list-item" style="cursor:pointer" onclick="location.hash='#/scan/asset/${a.id}'">
            <div class="body"><div class="t">${esc(a.name)}</div>
            <div class="s">${esc(a.category)}${a.location ? ' · ' + esc(a.location) : ''}${a.manufacturer ? ' · ' + esc(a.manufacturer) : ''}${a.install_date ? ' · installed ' + a.install_date.slice(0, 4) : ''}${a.condition ? ' · ' + esc(a.condition) : ''}</div>
            ${pct != null ? `<div class="lifebar"><div style="width:${Math.min(100, pct * 100)}%;background:${pct >= 1 ? 'var(--red)' : pct >= .85 ? 'var(--amber)' : 'var(--pine)'}"></div></div>` : ''}</div>
            <div class="end"><button class="btn sec" style="padding:6px 10px;font-size:12px" onclick="event.stopPropagation();showQR('asset',${a.id})">QR</button></div>
          </div>`;
        }).join('') || '<div class="s">No assets tracked yet — add water heaters, HVAC units, and appliances to unlock lifecycle forecasting.</div>'}
      </div>` : ''}

    ${tab === 'expenses' ? `
      <div class="card">
        <div class="card-title">Expenses <span class="s" style="font-weight:400">12 mo: <span class="money">${money(s.spend_12mo)}</span></span></div>
        ${d.expenses.slice(0, 60).map(e => `<div class="list-item"><div class="body"><div class="t">${esc(e.description || e.category)}</div><div class="s">${e.incurred_on} · ${esc(e.category)}${e.wo_number ? ' · ' + e.wo_number : ''}</div></div><div class="end money">${money(e.amount)}</div></div>`).join('') || '<div class="s">No expenses recorded.</div>'}
      </div>` : ''}

    ${tab === 'pm' ? `
      <div class="card">
        <div class="card-title">Preventive schedules ${canWrite() ? `<button class="more" onclick="addPM(${p.id})">+ Add ›</button>` : ''}</div>
        ${d.pm.map(sch => `<div class="list-item"><div class="body"><div class="t">${esc(sch.title)}</div><div class="s">Every ${sch.interval_days} days · next ${sch.next_due}</div></div></div>`).join('') || '<div class="s">No schedules — recurring tasks like HVAC filters and gutter cleaning belong here.</div>'}
      </div>` : ''}
  `, '#/properties');
  const tc = document.getElementById('tl-cat');
  if (tc) tc.onchange = () => location.hash = `#/properties/${id}?tab=timeline&cat=${encodeURIComponent(tc.value)}&unit=${tlUnit}`;
  const tu = document.getElementById('tl-unit');
  if (tu) tu.onchange = () => location.hash = `#/properties/${id}?tab=timeline&cat=${encodeURIComponent(tlCat)}&unit=${tu.value}`;
}

window.setRouting = async (pid, mode) => {
  try { await PATCH('/properties/' + pid, { tenant_routing: mode }); toast(mode === 'owner' ? 'Tenant requests now go to the owner first' : 'Tenant requests go straight to maintenance'); }
  catch (e) { toast(e.message); render(); }
};
window.rotateIntake = pid => confirmModal('Reset the tenant link?', 'The current link and any printed QR codes stop working immediately. Use this if the link leaked or a tenant moved out on bad terms.', async () => {
  try { await POST(`/properties/${pid}/intake-token/rotate`, {}); closeModal(); toast('New tenant link generated'); render(); } catch (e) { toast(e.message); }
}, 'Reset link');
window.showQR = (kind, id) => {
  modal(`<h3>Printable QR label</h3>
    <div style="text-align:center;padding:8px"><img src="/api/qr/${kind}/${id}" style="width:220px;height:220px"></div>
    <div class="s" style="text-align:center;margin-bottom:12px">Print and stick this on the equipment. Scanning it with a phone camera opens this ${kind}'s page with full repair history.</div>
    <button class="btn sec full" onclick="window.open('/api/qr/${kind}/${id}')">Open full size to print</button>`);
};
window.addUnit = pid => {
  modal(`<h3>Add unit</h3>
    <div class="row2"><div class="field"><label>Label</label><input id="u-label" placeholder="A"></div>
    <div class="field"><label>Sq ft</label><input id="u-sqft" type="number"></div></div>
    <div class="row2"><div class="field"><label>Beds</label><input id="u-beds" type="number"></div>
    <div class="field"><label>Baths</label><input id="u-baths" type="number" step="0.5"></div></div>
    <div class="tglrow"><span>Currently occupied</span><input type="checkbox" class="tgl" id="u-occ"></div>
    <button class="btn pri full" style="margin-top:10px" id="u-go">Add unit</button>`);
  document.getElementById('u-go').onclick = async () => {
    try { await POST(`/properties/${pid}/units`, { label: fv('u-label'), beds: fv('u-beds'), baths: fv('u-baths'), sqft: fv('u-sqft'), occupied: fchk('u-occ') }); await bootMeta(); closeModal(); render(); }
    catch (e) { toast(e.message); }
  };
};
window.toggleOccupied = async (uid, occ) => {
  try { await PATCH('/units/' + uid, { occupied: occ }); render(); } catch (e) { toast(e.message); }
};
window.addAsset = pid => {
  modal(`<h3>Add asset</h3>
    <div class="row2">
      <div class="field"><label>Type</label><select id="as-cat">${META.asset_types.map(c => `<option>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Unit</label><select id="as-unit"><option value="">Whole property</option>${selOpts(META.units.filter(u => u.property_id === pid), 'id', 'label')}</select></div>
    </div>
    <div class="field"><label>Name</label><input id="as-name" placeholder="Water heater — Unit A"></div>
    <div class="row2"><div class="field"><label>Location</label><input id="as-loc" placeholder="Garage, closet…"></div>
    <div class="field"><label>Condition</label><select id="as-cond"><option></option><option>Excellent</option><option>Good</option><option>Fair</option><option>Poor</option></select></div></div>
    <div class="row2"><div class="field"><label>Manufacturer</label><input id="as-mfr"></div><div class="field"><label>Model</label><input id="as-model"></div></div>
    <div class="row2"><div class="field"><label>Serial #</label><input id="as-serial"></div><div class="field"><label>Install date</label><input id="as-inst" type="date"></div></div>
    <div class="row2"><div class="field"><label>Useful life (yrs)</label><input id="as-life" type="number"></div><div class="field"><label>Replacement cost ($)</label><input id="as-repl" type="number"></div></div>
    <div class="field"><label>Warranty expires</label><input id="as-warr" type="date"></div>
    <button class="btn pri full" id="as-go">Add asset</button>`);
  document.getElementById('as-go').onclick = async () => {
    try {
      await POST(`/properties/${pid}/assets`, { category: fv('as-cat'), name: fv('as-name'), unit_id: +fv('as-unit') || null,
        location: fv('as-loc') || null, condition: fv('as-cond') || null,
        manufacturer: fv('as-mfr') || null, model: fv('as-model') || null, serial: fv('as-serial') || null,
        install_date: fv('as-inst') || null, useful_life_years: fv('as-life') || null,
        replacement_cost: fv('as-repl') || null, warranty_expires: fv('as-warr') || null });
      closeModal(); render();
    } catch (e) { toast(e.message); }
  };
};
window.addPM = pid => {
  modal(`<h3>Add preventive schedule</h3>
    <div class="field"><label>Task</label><input id="pm-title" placeholder="Replace HVAC filters"></div>
    <div class="row2">
      <div class="field"><label>Category</label><select id="pm-cat">${META.categories.map(c => `<option>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Every N days</label><input id="pm-int" type="number" value="90"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Next due</label><input id="pm-due" type="date"></div>
      <div class="field"><label>Assign to</label><select id="pm-tech"><option value="">Unassigned queue</option>${selOpts(META.technicians, 'id', 'name')}</select></div>
    </div>
    <div class="field"><label>Instructions</label><input id="pm-inst"></div>
    <button class="btn pri full" id="pm-go">Add schedule</button>`);
  document.getElementById('pm-go').onclick = async () => {
    try { await POST('/pm', { property_id: pid, title: fv('pm-title'), category: fv('pm-cat'), interval_days: +fv('pm-int'), next_due: fv('pm-due'), instructions: fv('pm-inst') || null, assigned_user_id: +fv('pm-tech') || null }); closeModal(); render(); }
    catch (e) { toast(e.message); }
  };
};

/* ---------------- QR scan landing ---------------- */
async function renderScanAsset(id) {
  loadingShell('#/properties');
  let d;
  try { d = await GET('/assets/' + id); } catch (e) {
    return shell(`<div class="card empty">This equipment isn't in your organization's records.</div>`, '#/properties');
  }
  const a = d.asset;
  shell(`
    ${canRead() ? `<a class="more" href="#/properties/${a.property_id}?tab=assets" style="font-size:13.5px">‹ ${esc(a.property)}</a>` : ''}
    <div class="card" style="margin-top:10px">
      <div class="s">${esc(a.category)} · ${esc(a.property)}${a.unit_label ? ' · Unit ' + esc(a.unit_label) : ''}${a.location ? ' · ' + esc(a.location) : ''}</div>
      <h2 style="margin:4px 0 10px;font-family:var(--font-d);font-size:21px">${esc(a.name)}</h2>
      <div class="kv">
        <div><div class="k">Make / model</div><div class="v">${esc(a.manufacturer || '—')} ${esc(a.model || '')}</div></div>
        <div><div class="k">Serial</div><div class="v">${esc(a.serial || '—')}</div></div>
        <div><div class="k">Installed</div><div class="v">${a.install_date || '—'}${d.age ? ` (${d.age.ageYears} yrs old)` : ''}</div></div>
        <div><div class="k">Warranty</div><div class="v">${esc(d.warranty_status)}</div></div>
        <div><div class="k">Repairs on record</div><div class="v">${d.repair_count}</div></div>
        <div><div class="k">Last service</div><div class="v">${fmtDate(d.last_service)}</div></div>
      </div>
      ${d.age && d.age.pct >= 0.85 ? `<div class="banner warn" style="margin-top:10px">${d.age.pct >= 1 ? 'Past expected useful life' : 'Approaching expected replacement age'} — ${d.age.ageYears} of ${a.useful_life_years} years.</div>` : ''}
      ${canWrite() ? `<button class="btn pri full" style="margin-top:12px" onclick='openWOForm({property_id:${a.property_id},unit_id:${a.unit_id || 'null'}})'>+ Create repair for this equipment</button>` : ''}
    </div>
    ${d.open_wos.length ? `<div class="card"><div class="card-title">Open jobs on this equipment</div>
      ${d.open_wos.map(w => `<a class="list-item" href="#/work-orders/${w.id}"><div class="body"><div class="t">${esc(w.title)}</div><div class="s">${w.number}</div></div><div class="end">${chip(w.status)}</div></a>`).join('')}</div>` : ''}
    <div class="card"><div class="card-title">Service history</div>
      ${d.repairs.filter(w => w.status === 'completed').map(w => `<a class="list-item" href="#/work-orders/${w.id}"><div class="body"><div class="t">${esc(w.title)}</div><div class="s">${fmtDate(w.completed_at)} · ${esc(w.tech_name || w.vendor_company || '')}</div></div><div class="end money">${money(w.total_cost)}</div></a>`).join('') || '<div class="s">No completed repairs on record.</div>'}
    </div>
  `, '#/properties');
}

/* ---------------- calendar ---------------- */
async function renderCalendar() {
  loadingShell('#/calendar');
  const d = await GET('/calendar');
  const byDate = {};
  d.work_orders.forEach(w => { (byDate[w.scheduled_date] = byDate[w.scheduled_date] || []).push({ type: 'wo', ...w }); });
  d.pm.forEach(s => { (byDate[s.next_due] = byDate[s.next_due] || []).push({ type: 'pm', ...s }); });
  const dates = Object.keys(byDate).sort();
  const today = new Date().toISOString().slice(0, 10);
  shell(`
    <div class="section-title" style="margin-top:0">Schedule</div>
    ${dates.length ? dates.map(dt => `
      <div class="cal-day ${dt < today ? 'past' : ''} ${dt === today ? 'today' : ''}">
        <div class="cal-date">${dt === today ? 'Today' : fmtDateFull(dt)}${dt < today ? ' · past due' : ''}</div>
        ${byDate[dt].map(it => it.type === 'wo'
          ? `<a class="list-item" href="#/work-orders/${it.id}"><div class="body"><div class="t">${esc(it.title)}</div><div class="s">${esc(it.property_name)} · ${esc(it.tech_name || it.vendor_company || 'Unassigned')}</div></div><div class="end">${pri(it.priority)}</div></a>`
          : `<div class="list-item"><div class="body"><div class="t">🔁 ${esc(it.title)}</div><div class="s">${esc(it.property_name)} · preventive</div></div></div>`).join('')}
      </div>`).join('') : '<div class="card empty">Nothing scheduled. Assign dates to work orders to build the calendar.</div>'}
  `, '#/calendar');
}

/* ---------------- team / vendors ---------------- */
async function renderTeam() {
  loadingShell('#/team');
  const team = await GET('/team');
  shell(`
    <div class="section-title" style="margin-top:0">Technician scorecards ${canWrite() ? `<a class="more" href="#/settings?tab=team">Manage team ›</a>` : ''}</div>
    ${team.map(t => `
      <div class="card ${!t.active ? 'inactive' : ''}">
        <div class="card-title">${esc(t.name)} ${!t.active ? '<span class="chip cancelled">Inactive</span>' : ''}</div>
        <div class="kv" style="grid-template-columns:repeat(3,1fr)">
          <div><div class="k">Jobs completed</div><div class="v">${t.jobs_completed}</div></div>
          <div><div class="k">Avg time on site</div><div class="v">${fmtMin(t.avg_completion_minutes)}</div></div>
          <div><div class="k">First-time fix</div><div class="v">${t.first_time_fix_rate == null ? '—' : t.first_time_fix_rate + '%'}</div></div>
          <div><div class="k">Repeat within 30d</div><div class="v">${t.repeat_repair_rate == null ? '—' : t.repeat_repair_rate + '%'}</div></div>
          <div><div class="k">Avg cost / job</div><div class="v money">${t.avg_cost_per_wo == null ? '—' : money(t.avg_cost_per_wo)}</div></div>
          <div><div class="k">Open now</div><div class="v">${t.currently_assigned}</div></div>
        </div>
      </div>`).join('') || '<div class="card empty">No technicians yet — invite them from Settings → Team.</div>'}
  `, '#/team');
}

async function renderVendors() {
  loadingShell('#/vendors');
  const vendors = await GET('/vendors');
  shell(`
    <div class="section-title" style="margin-top:0">Vendors ${canWrite() ? `<button class="btn pri" style="padding:8px 14px" id="v-new">+ Vendor</button>` : ''}</div>
    ${vendors.map(v => `
      <div class="card">
        <div class="card-title">${esc(v.company)} <span class="s" style="font-weight:400">${esc(v.trade || '')}</span>
          ${canWrite() ? `<button class="more" onclick='editVendor(${JSON.stringify(v).replace(/'/g, "&#39;")})'>Edit ›</button>` : ''}</div>
        <div class="s">${esc(v.contact_name || '')}${v.phone ? ' · ' + esc(v.phone) : ''}${v.email ? ' · ' + esc(v.email) : ''}</div>
        <div class="s">${v.service_area ? 'Serves ' + esc(v.service_area) : ''}${v.hourly_rate ? ' · ' + money(v.hourly_rate) + '/hr' : ''}${v.emergency_available ? ' · 🚨 emergency available' : ''}</div>
        ${v.insurance_expires ? `<div class="s" style="${v.insurance_expires < new Date().toISOString().slice(0, 10) ? 'color:var(--red);font-weight:700' : ''}">Insurance ${v.insurance_expires < new Date().toISOString().slice(0, 10) ? 'EXPIRED ' : 'through '}${v.insurance_expires}${v.license_number ? ' · Lic. ' + esc(v.license_number) : ''}</div>` : ''}
        <div class="kv" style="grid-template-columns:repeat(4,1fr);margin-top:10px">
          <div><div class="k">Jobs</div><div class="v">${v.metrics.completed_jobs}/${v.metrics.total_jobs}</div></div>
          <div><div class="k">Avg days</div><div class="v">${v.metrics.avg_completion_days ?? '—'}</div></div>
          <div><div class="k">Callback rate</div><div class="v">${v.metrics.callback_rate == null ? '—' : v.metrics.callback_rate + '%'}</div></div>
          <div><div class="k">Total spend</div><div class="v money">${money(v.metrics.total_spend)}</div></div>
        </div>
      </div>`).join('') || '<div class="card empty">No vendors yet.</div>'}
  `, '#/vendors');
  const b = document.getElementById('v-new');
  if (b) b.onclick = () => window.editVendor(null);
}
window.editVendor = v => {
  modal(`<h3>${v ? 'Edit vendor' : 'Add vendor'}</h3>
    <div class="row2"><div class="field"><label>Company</label><input id="vv-co" value="${esc(v?.company || '')}"></div>
    <div class="field"><label>Trade</label><input id="vv-tr" value="${esc(v?.trade || '')}"></div></div>
    <div class="row2"><div class="field"><label>Contact</label><input id="vv-cn" value="${esc(v?.contact_name || '')}"></div>
    <div class="field"><label>Phone</label><input id="vv-ph" value="${esc(v?.phone || '')}"></div></div>
    <div class="field"><label>Email</label><input id="vv-em" value="${esc(v?.email || '')}"></div>
    <div class="field"><label>Service area</label><input id="vv-sa" value="${esc(v?.service_area || '')}" placeholder="Duval + St. Johns counties"></div>
    <div class="row2"><div class="field"><label>Hourly rate ($)</label><input id="vv-hr" type="number" value="${v?.hourly_rate || ''}"></div>
    <div class="field"><label>License #</label><input id="vv-lic" value="${esc(v?.license_number || '')}"></div></div>
    <div class="field"><label>Insurance expires</label><input id="vv-ins" type="date" value="${v?.insurance_expires || ''}"></div>
    <div class="tglrow"><span>🚨 Available for emergencies</span><input type="checkbox" class="tgl" id="vv-emg" ${v?.emergency_available ? 'checked' : ''}></div>
    <button class="btn pri full" style="margin-top:10px" id="vv-go">${v ? 'Save changes' : 'Add vendor'}</button>`);
  document.getElementById('vv-go').onclick = async () => {
    const body = { company: fv('vv-co'), trade: fv('vv-tr') || null, contact_name: fv('vv-cn') || null,
      phone: fv('vv-ph') || null, email: fv('vv-em') || null, service_area: fv('vv-sa') || null,
      hourly_rate: fv('vv-hr') || null, license_number: fv('vv-lic') || null,
      insurance_expires: fv('vv-ins') || null, emergency_available: fchk('vv-emg') };
    try {
      if (v) await PATCH('/vendors/' + v.id, body); else await POST('/vendors', body);
      await bootMeta(); closeModal(); render();
    } catch (e) { toast(e.message); }
  };
};

/* ---------------- analytics ---------------- */
async function renderAnalytics(qs) {
  loadingShell('#/analytics');
  const params = new URLSearchParams(qs || '');
  const horizon = [12, 24, 60].includes(+params.get('capex')) ? +params.get('capex') : 24;
  const a = await GET('/analytics?capex_months=' + horizon);
  const maxMonth = Math.max(...a.monthly_spend.map(m => m.total), 1);
  const rvp = a.repair_vs_preventive;
  const rvpTotal = (rvp.repair + rvp.preventive) || 1;

  shell(`
    <div class="section-title" style="margin-top:0">Monthly maintenance spend</div>
    <div class="card"><div class="bars">
      ${a.monthly_spend.map(m => `<div class="bar-col"><div class="bar" style="height:${Math.max(6, (m.total / maxMonth) * 110)}px"></div><div class="bar-v">${money(m.total)}</div><div class="bar-l">${m.m.slice(5)}</div></div>`).join('') || '<div class="s">No expense history yet.</div>'}
    </div></div>

    ${a.repair_vs_replace.length ? `
    <div class="section-title">Repair vs. replace</div>
    ${a.repair_vs_replace.map(r => `
      <div class="card rvr">
        <div class="card-title">${esc(r.name)} — ${esc(r.property)}</div>
        <div class="kv" style="grid-template-columns:repeat(4,1fr)">
          <div><div class="k">Age</div><div class="v">${r.age_years ?? '—'}${r.useful_life_years ? '/' + r.useful_life_years : ''} yrs</div></div>
          <div><div class="k">Repairs 12mo</div><div class="v">${r.repairs_12mo}</div></div>
          <div><div class="k">Spend 12mo</div><div class="v money">${money(r.spend_12mo)}</div></div>
          <div><div class="k">Replace est.</div><div class="v money">${r.est_replacement_cost ? money(r.est_replacement_cost) : '—'}</div></div>
        </div>
        <div style="margin-top:8px">${r.reasons.map(x => `<div class="hr-item"><span class="pts">•</span> ${esc(x)}</div>`).join('')}</div>
        <div class="s" style="margin-top:6px;color:var(--muted)">${esc(r.disclaimer)}</div>
        ${canWrite() ? `<div class="pill-row">
          <button class="btn pri" onclick="rvrAct(${r.asset_id},'quote_requested','Marked — request vendor quotes from the work order')">Get quotes</button>
          <button class="btn sec" onclick="rvrAct(${r.asset_id},'marked_replacement','Marked for replacement')">Mark for replacement</button>
          <button class="btn sec" onclick="rvrAct(${r.asset_id},'continue_repair','Noted — will continue repairing')">Keep repairing</button>
          <button class="btn sec" onclick="rvrAct(${r.asset_id},'dismissed','Dismissed for 90 days')">Dismiss 90d</button>
        </div>` : ''}
      </div>`).join('')}` : ''}

    ${a.anomalies.length ? `
    <div class="section-title">Cost anomalies</div>
    ${a.anomalies.map(x => `
      <div class="card" style="border-left:4px solid var(--amber)">
        <div class="card-title"><a href="#/properties/${x.property_id}" style="color:inherit">${esc(x.property)}</a></div>
        <div class="s">${esc(x.message)}</div>
        <div class="kv" style="grid-template-columns:repeat(3,1fr);margin-top:8px">
          <div><div class="k">12-mo spend</div><div class="v money">${money(x.spend_12mo)}</div></div>
          <div><div class="k">Per unit</div><div class="v money">${money(x.per_unit)}</div></div>
          <div><div class="k">Portfolio avg</div><div class="v money">${money(x.portfolio_avg_per_unit)}</div></div>
        </div>
      </div>`).join('')}` : ''}

    ${a.repeat_repairs.length ? `
    <div class="section-title">Repeat repair patterns</div>
    ${a.repeat_repairs.map(r => `
      <div class="card" style="border-left:4px solid var(--amber)">
        <div class="card-title">${esc(r.category)} — <a href="#/properties/${r.property_id}" style="color:inherit">${esc(r.property)}</a>${r.unit_label ? ' · Unit ' + esc(r.unit_label) : ''}</div>
        <div class="s">${esc(r.message)} Total spent: <b class="money">${money(r.total_spent)}</b>. ${esc(r.action)}</div>
      </div>`).join('')}` : ''}

    <div class="section-title">Replacement forecast
      <span>${[12, 24, 60].map(h => `<a class="fpill ${h === horizon ? 'on' : ''}" href="#/analytics?capex=${h}" style="margin-left:4px">${h === 60 ? '5 yr' : h + ' mo'}</a>`).join('')}</span>
    </div>
    <div class="card">
      <div class="s" style="margin-bottom:8px">Estimated total next ${horizon === 60 ? '5 years' : horizon + ' months'}: <b class="money">${money(a.capex.estimated_total)}</b> across ${a.capex.properties_affected} propert${a.capex.properties_affected === 1 ? 'y' : 'ies'}</div>
      ${a.capex.items.map(i => `
        <div class="list-item"><div class="body">
          <div class="t">${esc(i.name)} ${i.overdue ? '<b style="color:var(--red)">· past useful life</b>' : ''}</div>
          <div class="s">${esc(i.property)} · ${i.age_years}/${i.useful_life_years} yrs · ~${i.months_remaining} mo remaining · <span class="chip ${i.confidence === 'high' ? 'completed' : i.confidence === 'medium' ? 'in_progress' : 'new'}" style="font-size:10px">${i.confidence} confidence</span></div>
        </div><div class="end money">${i.est_replacement_cost ? money(i.est_replacement_cost) : '—'}</div></div>`).join('') || '<div class="s">No assets due in this window — or asset install dates aren\'t recorded yet.</div>'}
      <div class="s" style="margin-top:8px;color:var(--muted)">${esc(a.capex.disclaimer)}</div>
    </div>

    <div class="section-title">Where the money goes (6 mo)</div>
    <div class="card">${a.by_category.map(c => `<div class="list-item"><div class="body"><div class="t">${esc(c.category)}</div><div class="s">${c.wos} work orders</div></div><div class="end money">${money(c.total)}</div></div>`).join('')}</div>

    <div class="row2">
      <div class="card"><div class="card-title">By vendor (12 mo)</div>
        ${a.by_vendor.map(v => `<div class="list-item"><div class="body"><div class="t">${esc(v.company)}</div></div><div class="end money">${money(v.total)}</div></div>`).join('') || '<div class="s">No vendor spend.</div>'}</div>
      <div class="card"><div class="card-title">By technician (12 mo)</div>
        ${a.by_technician.map(t => `<div class="list-item"><div class="body"><div class="t">${esc(t.name)}</div></div><div class="end money">${money(t.total)}</div></div>`).join('') || '<div class="s">No tech spend.</div>'}</div>
    </div>

    <div class="card"><div class="card-title">Reactive vs. preventive (12 mo)</div>
      <div class="status-bars"><div style="width:${(rvp.repair / rvpTotal) * 100}%;background:var(--amber)"></div><div style="width:${(rvp.preventive / rvpTotal) * 100}%;background:var(--pine)"></div></div>
      <div class="legend"><span><span class="sw" style="background:var(--amber)"></span>Reactive repairs · <b class="money">${money(rvp.repair)}</b></span>
      <span><span class="sw" style="background:var(--pine)"></span>Preventive · <b class="money">${money(rvp.preventive)}</b></span></div>
      <div class="s" style="margin-top:6px">Avg cost per completed work order: <b class="money">${a.avg_cost_per_wo ? money(a.avg_cost_per_wo) : '—'}</b></div>
    </div>
  `, '#/analytics');
}
window.rvrAct = async (assetId, action, msg) => {
  try { await POST(`/assets/${assetId}/rvr`, { action }); toast(msg); render(); } catch (e) { toast(e.message); }
};

/* ---------------- notifications ---------------- */
async function renderNotifications() {
  loadingShell('#/notifications');
  const notifs = await GET('/notifications');
  shell(`
    <div class="section-title" style="margin-top:0">Notifications ${notifs.some(n => !n.read) ? `<button class="more" onclick="markAllRead()">Mark all read ›</button>` : ''}</div>
    <div class="card">
      ${notifs.map(n => `
        <a class="list-item ${n.read ? 'read' : ''}" href="${n.link || '#'}" onclick="markRead(${n.id})">
          <div class="body"><div class="t">${n.read ? '' : '<span class="dot"></span>'}${esc(n.title)}</div>
          <div class="s">${esc(n.body || '')}</div><div class="s" style="color:var(--muted)">${fmtDateTime(n.created_at)}</div></div>
        </a>`).join('') || '<div class="empty">Nothing here yet.</div>'}
    </div>`, '#/notifications');
}
window.markRead = async id => { try { await POST('/notifications/read', { id }); refreshUnread(); } catch (e) {} };
window.markAllRead = async () => { try { await POST('/notifications/read', {}); render(); } catch (e) {} };

/* ---------------- notification prefs widget ---------------- */
const NOTIF_KINDS = [['emergency', 'Emergency requests'], ['assigned', 'Job assigned to me'], ['approval', 'Approval requests'],
  ['approval_decision', 'Approval decisions'], ['completed', 'Jobs completed'], ['quote', 'Vendor quotes'],
  ['pm_due', 'Preventive maintenance due'], ['repeat', 'Repeat-repair warnings'], ['request', 'New maintenance requests'], ['high_cost', 'Unusually high costs']];
async function mountNotifPrefs(slotId) {
  const [prefs, status] = await Promise.all([GET('/notification-prefs'), GET('/push/status').catch(() => ({ devices: 0 }))]);
  const slot = document.getElementById(slotId);
  if (!slot) return;
  slot.innerHTML = `
    <div style="border:1.5px solid var(--line);border-radius:12px;padding:12px 13px;margin-bottom:14px">
      <div style="font-weight:700;margin-bottom:4px">📱 Phone notifications</div>
      <div class="s" style="margin-bottom:10px">${status.devices ? `On for ${status.devices} device${status.devices > 1 ? 's' : ''}. Emergencies, assignments, and approvals reach your phone even when the app is closed.` : 'Get alerts on your phone even when the app is closed — emergencies, new assignments, approvals.'}</div>
      <div class="row2">
        <button class="btn pri full" onclick="enablePush().then(ok=>ok&&render())">${status.devices ? 'Add this device' : 'Enable on this device'}</button>
        ${status.devices ? `<button class="btn sec full" onclick="disablePush().then(()=>render())">Turn off this device</button>` : '<span></span>'}
      </div>
      <details style="margin-top:10px"><summary class="s" style="cursor:pointer;font-weight:600">Also use Pushover${status.pushover_configured ? ' ✓ connected' : ''}</summary>
        <div class="s" style="margin:8px 0 6px">${status.pushover_available ? 'Paste your Pushover user key to also receive alerts through the Pushover app.' : 'Ask your admin to set the PUSHOVER_TOKEN environment variable on the server, then paste your Pushover user key here.'}</div>
        <div class="field"><input id="po-key" placeholder="Pushover user key" value=""></div>
        <button class="btn sec full" onclick="savePushover()">Save Pushover key</button>
      </details>
    </div>
    <div class="s" style="margin-bottom:6px;font-weight:700">What to send, per channel</div>
    <div class="tglrow" style="font-size:12px;color:var(--muted);font-weight:700"><span></span><span style="display:flex;gap:22px"><span>In-app</span><span>Phone</span></span></div>
    ${NOTIF_KINDS.map(([k, l]) => `<div class="tglrow"><span>${l}</span><span style="display:flex;gap:34px">
      <input type="checkbox" class="tgl npk" data-k="${k}" ${prefs[k] && prefs[k].in_app ? 'checked' : ''}>
      <input type="checkbox" class="tgl npp" data-k="${k}" ${prefs[k] && prefs[k].push ? 'checked' : ''}>
    </span></div>`).join('')}
    <button class="btn pri full" style="margin-top:10px" id="np-save">Save preferences</button>`;
  document.getElementById('np-save').onclick = async () => {
    const body = {};
    document.querySelectorAll('.npk').forEach(c => body[c.dataset.k] = { in_app: c.checked, push: 0, email: 0, sms: 0 });
    document.querySelectorAll('.npp').forEach(c => { if (body[c.dataset.k]) body[c.dataset.k].push = c.checked ? 1 : 0; });
    try { await PUT('/notification-prefs', body); toast('Preferences saved'); } catch (e) { toast(e.message); }
  };
}
window.savePushover = async () => {
  try { await PATCH('/push/pushover-key', { key: fv('po-key') }); toast('Pushover key saved'); render(); } catch (e) { toast(e.message); }
};

/* ---------------- settings ---------------- */
async function renderSettings(qs) {
  loadingShell('#/settings');
  const params = new URLSearchParams(qs || '');
  const tab = params.get('tab') || 'org';
  const TABS = [['org', 'Organization'], ['team', 'Team'], ['completion', 'Job requirements'], ['notifs', 'Notifications']];
  let inner = '';
  if (tab === 'org') {
    const org = await GET('/org');
    const ro = ME.role !== 'owner' ? 'disabled' : '';
    inner = `
      <div class="card"><div class="card-title">Organization ${ME.role !== 'owner' ? '<span class="s" style="font-weight:400">(owner can edit)</span>' : ''}</div>
        <div class="field"><label>Name</label><input id="o-name" value="${esc(org.name || '')}" ${ro}></div>
        <div class="row2">
          <div class="field"><label>Primary contact</label><input id="o-owner" value="${esc(org.owner_name || '')}" ${ro}></div>
          <div class="field"><label>Phone</label><input id="o-phone" value="${esc(org.phone || '')}" ${ro}></div>
        </div>
        <div class="row2">
          <div class="field"><label>Approx. units</label><input id="o-units" type="number" value="${org.approx_units || ''}" ${ro}></div>
          <div class="field"><label>Primary market</label><input id="o-market" value="${esc(org.primary_market || '')}" ${ro}></div>
        </div>
      </div>
      <div class="card"><div class="card-title">Approval tiers</div>
        <div class="s" style="margin-bottom:10px">Spending under the first amount needs no approval. Between the two: a manager can approve. Above the second: only an owner.</div>
        <div class="row2">
          <div class="field"><label>Manager approval above ($)</label><input id="o-t1" type="number" value="${org.approval_t1}" ${ro}></div>
          <div class="field"><label>Owner approval above ($)</label><input id="o-t2" type="number" value="${org.approval_t2}" ${ro}></div>
        </div>
      </div>
      ${ME.role === 'owner' ? `<button class="btn pri full" id="o-save">Save organization settings</button>` : ''}`;
  }
  if (tab === 'completion') {
    const reqs = await GET('/completion-requirements');
    const KEYS = [['before_photo', 'Before photo'], ['after_photo', 'After photo'], ['completion_notes', 'Notes'], ['materials', 'Materials'], ['receipt', 'Receipt'], ['time_recorded', 'Time']];
    const catRow = r => `<tr data-cat="${esc(r.category)}">
      <td><b>${r.category === '*' ? 'All categories (default)' : esc(r.category)}</b></td>
      ${KEYS.map(([k]) => `<td style="text-align:center"><input type="checkbox" class="tgl crk" data-k="${k}" ${r[k] ? 'checked' : ''} ${canWrite() ? '' : 'disabled'}></td>`).join('')}
    </tr>`;
    const missing = META.categories.filter(c => !reqs.some(r => r.category === c));
    inner = `
      <div class="card"><div class="card-title">What's required to complete a job</div>
        <div class="s" style="margin-bottom:10px">Technicians can't mark a job complete until these are done. Managers can override with a logged reason.</div>
        <div style="overflow-x:auto"><table class="tbl">
          <thead><tr><th>Category</th>${KEYS.map(([, l]) => `<th style="text-align:center;font-size:11px">${l}</th>`).join('')}</tr></thead>
          <tbody>${reqs.map(catRow).join('')}</tbody>
        </table></div>
        ${canWrite() ? `<div class="row2" style="margin-top:12px">
          ${missing.length ? `<select id="cr-new" class="fpill" style="border:1px solid var(--line)">${missing.map(c => `<option>${c}</option>`).join('')}</select>` : '<span></span>'}
          ${missing.length ? `<button class="btn sec" id="cr-add">+ Category override</button>` : ''}
        </div>
        <button class="btn pri full" style="margin-top:10px" id="cr-save">Save requirements</button>` : ''}
      </div>`;
  }
  if (tab === 'notifs') inner = `<div class="card"><div class="card-title">Notification preferences</div><div id="np-slot"><div class="skel"></div></div></div>`;
  if (tab === 'team') {
    const t = await GET('/team/users');
    const ROLE_DESC = { owner: 'Full control incl. billing-level settings', manager: 'Runs day-to-day operations', technician: 'Sees only assigned jobs', viewer: 'Read-only owner view (investors, accountants)', vendor: 'Sees only their company\'s jobs' };
    inner = `
      <div class="card"><div class="card-title">People ${canWrite() ? `<button class="more" id="tm-invite">+ Invite ›</button>` : ''}</div>
        ${t.users.map(u => `
          <div class="list-item">
            <div class="body"><div class="t">${esc(u.name)} ${u.id === ME.id ? '<span class="s">(you)</span>' : ''} ${!u.active ? '<span class="chip cancelled">Deactivated</span>' : ''}</div>
            <div class="s">${esc(u.email)} · <b>${u.role}</b></div></div>
            ${canWrite() && u.id !== ME.id ? `<div class="end"><button class="btn sec" style="padding:6px 10px;font-size:12px" onclick='manageUser(${JSON.stringify({ id: u.id, name: u.name, role: u.role, active: u.active }).replace(/'/g, "&#39;")})'>Manage</button></div>` : ''}
          </div>`).join('')}
      </div>
      ${t.invites.length ? `<div class="card"><div class="card-title">Pending invites</div>
        ${t.invites.map(i => `<div class="list-item"><div class="body"><div class="t">${esc(i.email)}</div><div class="s">${i.role} · invited ${fmtDate(i.created_at)}</div></div>
          <div class="end"><button class="btn sec" style="padding:6px 10px;font-size:12px" onclick="copyInvite('${i.token}')">Copy link</button>
          ${canWrite() ? `<button class="btn danger" style="padding:6px 10px;font-size:12px;margin-left:6px" onclick="revokeInvite(${i.id})">Revoke</button>` : ''}</div></div>`).join('')}
      </div>` : ''}
      <div class="card"><div class="card-title">Roles</div>
        ${Object.entries(ROLE_DESC).map(([r, d]) => `<div class="s" style="padding:4px 0"><b style="text-transform:capitalize">${r}:</b> ${d}</div>`).join('')}
      </div>`;
  }
  shell(`
    <div class="filters" style="margin-top:0">${TABS.map(([k, l]) => `<a class="fpill ${tab === k ? 'on' : ''}" href="#/settings?tab=${k}">${l}</a>`).join('')}</div>
    ${inner}
  `, '#/settings');

  if (tab === 'org' && ME.role === 'owner') {
    const b = document.getElementById('o-save');
    if (b) b.onclick = async () => {
      try {
        await PATCH('/org', { name: fv('o-name'), owner_name: fv('o-owner'), phone: fv('o-phone'),
          approx_units: fv('o-units'), primary_market: fv('o-market'), approval_t1: +fv('o-t1'), approval_t2: +fv('o-t2') });
        ME.org_name = fv('o-name'); toast('Saved'); render();
      } catch (e) { toast(e.message); }
    };
  }
  if (tab === 'completion' && canWrite()) {
    const save = document.getElementById('cr-save');
    if (save) save.onclick = async () => {
      try {
        for (const tr of document.querySelectorAll('tr[data-cat]')) {
          const body = { category: tr.dataset.cat };
          tr.querySelectorAll('.crk').forEach(c => body[c.dataset.k] = c.checked);
          await PUT('/completion-requirements', body);
        }
        toast('Requirements saved');
      } catch (e) { toast(e.message); }
    };
    const add = document.getElementById('cr-add');
    if (add) add.onclick = async () => {
      try { await PUT('/completion-requirements', { category: fv('cr-new') }); render(); } catch (e) { toast(e.message); }
    };
  }
  if (tab === 'notifs') mountNotifPrefs('np-slot');
  if (tab === 'team' && canWrite()) {
    const b = document.getElementById('tm-invite');
    if (b) b.onclick = () => {
      modal(`<h3>Invite someone</h3>
        <div class="field"><label>Email</label><input id="iv-email" type="email"></div>
        <div class="field"><label>Name (optional)</label><input id="iv-name"></div>
        <div class="field"><label>Role</label><select id="iv-role">
          <option value="technician">Technician</option><option value="manager">Manager</option>
          <option value="viewer">Viewer (read-only)</option><option value="vendor">Vendor</option>
          ${ME.role === 'owner' ? '<option value="owner">Owner</option>' : ''}</select></div>
        <div class="field" id="iv-vend-w" style="display:none"><label>Link to vendor company</label><select id="iv-vend">${selOpts(META.vendors, 'id', 'company')}</select></div>
        <button class="btn pri full" id="iv-go">Create invite link</button>`);
      const rs = document.getElementById('iv-role');
      rs.onchange = () => { document.getElementById('iv-vend-w').style.display = rs.value === 'vendor' ? 'block' : 'none'; };
      document.getElementById('iv-go').onclick = async () => {
        try {
          const r = await POST('/team/invites', { email: fv('iv-email'), name: fv('iv-name') || undefined, role: fv('iv-role'),
            vendor_id: fv('iv-role') === 'vendor' ? +fv('iv-vend') || null : null });
          closeModal();
          modal(`<h3>Invite created</h3>
            <div class="s" style="margin-bottom:10px">Text or email this link — it opens a join page for your organization:</div>
            <div class="field"><input id="iv-link" value="${location.origin}${r.link}" readonly onclick="this.select()"></div>
            <button class="btn pri full" onclick="navigator.clipboard.writeText(document.getElementById('iv-link').value).then(()=>{closeModal();location.reload()})">Copy link & close</button>`);
        } catch (e) { toast(e.message); }
      };
    };
  }
}
window.copyInvite = token => { navigator.clipboard.writeText(location.origin + '/#/join?token=' + token); toast('Invite link copied'); };
window.revokeInvite = id => confirmModal('Revoke this invite?', 'The link will stop working immediately.', async () => {
  try { await POST(`/team/invites/${id}/revoke`, {}); closeModal(); render(); } catch (e) { toast(e.message); }
}, 'Revoke');
window.manageUser = u => {
  modal(`<h3>${esc(u.name)}</h3>
    <div class="field"><label>Role</label><select id="mu-role">
      ${['manager', 'technician', 'viewer', 'vendor'].concat(ME.role === 'owner' ? ['owner'] : []).map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
    <div class="s" style="margin-bottom:12px">Deactivating removes access immediately but keeps all their job history intact.</div>
    <div class="row2">
      <button class="btn ${u.active ? 'danger' : 'pri'} full" id="mu-tgl">${u.active ? 'Deactivate' : 'Reactivate'}</button>
      <button class="btn pri full" id="mu-save">Save role</button>
    </div>`);
  document.getElementById('mu-save').onclick = async () => {
    try { await PATCH('/team/users/' + u.id, { role: fv('mu-role') }); closeModal(); render(); } catch (e) { toast(e.message); }
  };
  document.getElementById('mu-tgl').onclick = async () => {
    try { await PATCH('/team/users/' + u.id, { active: u.active ? 0 : 1 }); closeModal(); render(); } catch (e) { toast(e.message); }
  };
};

/* ---------------- global search ---------------- */
function openSearch() {
  modal(`<h3>Search</h3>
    <div class="field"><input id="s-q" placeholder="Properties, units, work orders, assets, vendors, people…" autofocus></div>
    <div id="s-results"></div>`);
  const input = document.getElementById('s-q');
  let t;
  input.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { document.getElementById('s-results').innerHTML = ''; return; }
      const r = await GET('/search?q=' + encodeURIComponent(q));
      const sec = (title, arr, fn) => arr.length ? `<div class="s" style="font-weight:700;margin:10px 0 4px">${title}</div>${arr.map(fn).join('')}` : '';
      document.getElementById('s-results').innerHTML =
        sec('Properties', r.properties, p => `<a class="list-item" href="#/properties/${p.id}" onclick="closeModal()"><div class="body"><div class="t">${esc(p.name)}</div><div class="s">${esc(p.address)}</div></div></a>`) +
        sec('Units', r.units, u => `<a class="list-item" href="#/properties/${u.property_id}" onclick="closeModal()"><div class="body"><div class="t">Unit ${esc(u.label)}</div><div class="s">${esc(u.property_name)}</div></div></a>`) +
        sec('Work orders', r.work_orders, w => `<a class="list-item" href="#/work-orders/${w.id}" onclick="closeModal()"><div class="body"><div class="t">${esc(w.title)}</div><div class="s">${w.number} · ${esc(w.property_name)}</div></div><div class="end">${chip(w.status)}</div></a>`) +
        sec('Requests', r.requests, x => `<a class="list-item" href="#/maintenance" onclick="closeModal()"><div class="body"><div class="t">${esc(x.description.slice(0, 60))}</div><div class="s">${esc(x.property_name)} · ${x.status}</div></div></a>`) +
        sec('Assets', r.assets, a2 => `<a class="list-item" href="#/scan/asset/${a2.id}" onclick="closeModal()"><div class="body"><div class="t">${esc(a2.name)}</div><div class="s">${esc(a2.property_name)}</div></div></a>`) +
        sec('Vendors', r.vendors, v => `<a class="list-item" href="#/vendors" onclick="closeModal()"><div class="body"><div class="t">${esc(v.company)}</div><div class="s">${esc(v.trade || '')}</div></div></a>`) +
        sec('People', r.people, p => `<a class="list-item" href="#/team" onclick="closeModal()"><div class="body"><div class="t">${esc(p.name)}</div><div class="s">${p.role}</div></div></a>`) ||
        '<div class="s" style="margin-top:8px">No matches.</div>';
    }, 220);
  };
}

/* ---------------- router ---------------- */
async function render() { try { await routeRender(); } catch (err) { renderLoadError(err); } }

function renderLoadError(err) {
  const offline = err && (err.offline || !window.Offline.online);
  const body = offline
    ? `<div class="card empty"><div style="font-weight:700;margin-bottom:6px">This screen isn't available offline</div>
       <div class="s">It hasn't been opened on this phone yet. Your saved jobs are still available, and anything you do now will sync when you're back in signal.</div>
       <div class="row2" style="margin-top:14px"><a class="btn pri full" href="${canRead() ? '#/dashboard' : '#/today'}">Go to ${canRead() ? 'dashboard' : "today's jobs"}</a>
       <button class="btn sec full" onclick="render()">Try again</button></div></div>`
    : `<div class="card empty"><div style="font-weight:700;margin-bottom:6px">Couldn't load this screen</div>
       <div class="s">${esc((err && err.message) || 'Something went wrong.')}</div>
       <button class="btn pri full" style="margin-top:14px" onclick="render()">Try again</button></div>`;
  try { shell(body, location.hash || '#/'); } catch (e) { $app.innerHTML = body; }
  paintConnState();
}

async function routeRender() {
  const hash = location.hash || '#/';
  const [path, qs] = hash.split('?');
  if (path.startsWith('#/report/')) return renderReport(path.split('/')[2]);
  if (!ME) {
    if (path.startsWith('#/join')) return renderJoin(qs);
    try { ME = await GET('/auth/me'); await bootMeta(); }
    catch (e) {
      if (e.offline) {                      // opened with no signal — trust the cached session
        const cached = await window.Offline.request('/auth/me').catch(() => null);
        if (cached && cached.id) { ME = cached; await bootMeta(); }
        else return renderLogin('You appear to be offline. Sign in once with a connection and the app will work without one afterwards.', 'login');
      } else return renderLogin(null, path === '#/signup' ? 'signup' : 'login');
    }
  }
  if (path.startsWith('#/join')) return renderJoin(qs);
  const seg = path.split('/').filter(Boolean);   // ['#','work-orders','12']
  const page = seg[1] || (canRead() ? 'dashboard' : 'today');
  const id = seg[2];

  if (!canRead()) {
    // technicians + vendors
    const routes = { today: renderToday, jobs: renderJobs, notifications: renderNotifications, profile: renderProfile };
    if (page === 'work-orders' && id) return renderWODetail(id);
    if (page === 'scan' && seg[2] === 'asset' && seg[3] && ME.role === 'technician') return renderScanAsset(seg[3]);
    return (routes[page] || renderToday)();
  }
  const routes = {
    dashboard: renderDashboard,
    onboarding: renderOnboarding,
    'work-orders': () => id ? renderWODetail(id) : renderWorkOrders(qs),
    properties: () => id ? renderPropertyDetail(id, qs) : renderProperties(qs),
    maintenance: renderMaintenance,
    calendar: renderCalendar,
    team: renderTeam,
    vendors: renderVendors,
    analytics: () => renderAnalytics(qs),
    notifications: renderNotifications,
    settings: () => renderSettings(qs),
    scan: () => seg[2] === 'asset' && seg[3] ? renderScanAsset(seg[3]) : renderDashboard()
  };
  (routes[page] || renderDashboard)();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Reflect connection + queue state in the UI, and refresh the view when a sync lands
let _lastPending = -1, _lastOnline = null;
window.Offline.onChange(() => {
  paintConnState();
  const p = window.Offline.pending, on = window.Offline.online;
  if (_lastPending > 0 && p === 0 && on) render();   // queue drained — pull the real server state
  if (_lastOnline === false && on) render();
  _lastPending = p; _lastOnline = on;
  const rej = window.Offline.takeRejected();
  if (rej.length) toast(`${rej.length} queued change${rej.length > 1 ? 's' : ''} couldn't be applied: ${rej[0].reason}`);
});

window.addEventListener('hashchange', render);
render();
})();
