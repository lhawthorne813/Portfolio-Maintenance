/* Steadhold offline engine
   Technicians work in basements, crawlspaces, and concrete stairwells. The app has to
   keep working with no signal: read what was last loaded, accept new work, and sync it
   the moment a bar comes back. Nothing is ever lost to a dead zone.

   Three parts:
     1. Read cache  — every successful GET is stored and served back when offline.
     2. Write queue — mutations made offline are stored (photos included) and replayed in order.
     3. Idempotency — each queued mutation carries an op id so a retry can't double-apply. */
(function () {
'use strict';

const DB_NAME = 'steadhold', DB_VER = 1;
let _db = null;

function idb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'path' });
      if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'op_id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => { _db = r.result; resolve(_db); };
    r.onerror = () => reject(r.error);
  });
}
function tx(store, mode, fn) {
  return idb().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  }));
}
const cachePut = (path, data) => tx('cache', 'readwrite', s => s.put({ path, data, at: Date.now() }));
const cacheGet = path => tx('cache', 'readonly', s => s.get(path)).then(r => r || null);
const queueAll = () => tx('queue', 'readonly', s => s.getAll()).then(r => (r || []).sort((a, b) => a.at - b.at));
const queuePut = item => tx('queue', 'readwrite', s => s.put(item));
const queueDel = id => tx('queue', 'readwrite', s => s.delete(id));

const opId = () => 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);

let online = navigator.onLine;
let syncing = false;
const listeners = [];
function onChange(fn) { listeners.push(fn); }
function emit() { listeners.forEach(f => { try { f(); } catch (e) {} }); }

/* ---------- queue count for the UI ---------- */
let pendingCount = 0;
async function refreshPending() {
  try { pendingCount = (await queueAll()).length; } catch (e) { pendingCount = 0; }
  emit();
  return pendingCount;
}

/* ---------- outbound request wrapper ---------- */
// GET: network first, fall back to the cached copy. Mutations: queue when offline.
async function request(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const isForm = opts.body instanceof FormData;

  if (method === 'GET') {
    try {
      const r = await fetch('/api' + path, { ...opts, credentials: 'same-origin' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(data.error || 'Request failed'); e.data = data; e.status = r.status; throw e; }
      cachePut(path, data).catch(() => {});
      if (!online) { online = true; emit(); sync(); }
      return data;
    } catch (err) {
      if (err.status) throw err;                    // a real server error, not a network failure
      const hit = await cacheGet(path).catch(() => null);
      if (hit) { online = false; emit(); return { ...hit.data, __offline: true, __cachedAt: hit.at }; }
      online = false; emit();
      const e = new Error("You're offline and this hasn't been loaded before. It'll be here once you reconnect.");
      e.offline = true; throw e;
    }
  }

  // ---- mutations ----
  const id = opId();
  const headers = { ...(opts.headers || {}), 'X-Client-Op-Id': id };
  let sendBody = opts.body;
  if (!isForm && sendBody && typeof sendBody !== 'string') { headers['Content-Type'] = 'application/json'; sendBody = JSON.stringify(sendBody); }

  if (online) {
    try {
      const r = await fetch('/api' + path, { method, headers, body: sendBody, credentials: 'same-origin' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(data.error || 'Request failed'); e.data = data; e.status = r.status; throw e; }
      return data;
    } catch (err) {
      if (err.status) throw err;                    // server said no — do not queue, surface it
      online = false; emit();
    }
  }

  // Offline: store the intent durably (serialising any photo into a blob) and confirm to the user
  const item = { op_id: id, path, method, at: Date.now(), form: null, body: null, label: describe(method, path) };
  if (isForm) {
    const fields = [];
    for (const [k, v] of opts.body.entries()) {
      if (v instanceof File || v instanceof Blob) fields.push({ k, blob: v, name: v.name || 'photo.jpg', type: v.type });
      else fields.push({ k, v });
    }
    item.form = fields;
  } else item.body = sendBody;
  await queuePut(item);
  await refreshPending();
  return { __queued: true, op_id: id };
}

function describe(method, path) {
  if (path.includes('/photos')) return 'Photo upload';
  if (path.includes('/time/start')) return 'Job started';
  if (path.includes('/travel/start')) return 'Travel started';
  if (path.includes('/arrived')) return 'Arrival';
  if (path.includes('/comments')) return 'Note';
  if (path.includes('/materials')) return 'Material';
  if (path.includes('/expenses')) return 'Expense';
  if (path.includes('/approvals')) return 'Approval request';
  if (path.includes('/requests')) return 'Maintenance request';
  if (method === 'PATCH' && path.includes('/work-orders')) return 'Job update';
  if (method === 'POST' && path.includes('/work-orders')) return 'New work order';
  return 'Change';
}

/* ---------- replay ---------- */
// Strict order: a photo queued before a completion must land before it, or the
// completion requirements check on the server would reject the job.
async function sync() {
  if (syncing || !navigator.onLine) return;
  syncing = true; emit();
  let failed = 0;
  try {
    const items = await queueAll();
    for (const it of items) {
      let body, headers = { 'X-Client-Op-Id': it.op_id };
      if (it.form) {
        body = new FormData();
        for (const f of it.form) f.blob ? body.append(f.k, f.blob, f.name) : body.append(f.k, f.v);
      } else { body = it.body; if (body) headers['Content-Type'] = 'application/json'; }
      try {
        const r = await fetch('/api' + it.path, { method: it.method, headers, body, credentials: 'same-origin' });
        if (r.status >= 500 || r.status === 0) { failed++; break; }   // server trouble: stop, keep the queue
        await queueDel(it.op_id);                                      // 2xx applied, or 4xx permanently rejected
        if (r.status >= 400 && r.status < 500) {
          const d = await r.json().catch(() => ({}));
          rejected.push({ label: it.label, reason: d.error || 'Rejected on sync' });
        }
      } catch (e) { failed++; break; }                                 // still offline: leave it queued
    }
    online = navigator.onLine && !failed;
  } finally {
    syncing = false;
    await refreshPending();
    emit();
  }
}
const rejected = [];

window.addEventListener('online', () => { online = true; emit(); sync(); });
window.addEventListener('offline', () => { online = false; emit(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
setInterval(() => { if (navigator.onLine && pendingCount) sync(); }, 30000);

window.Offline = {
  request, sync, onChange, refreshPending,
  get online() { return online && navigator.onLine; },
  get pending() { return pendingCount; },
  get syncing() { return syncing; },
  takeRejected() { return rejected.splice(0, rejected.length); },
  clearCache: () => tx('cache', 'readwrite', s => s.clear())
};
refreshPending();
})();
