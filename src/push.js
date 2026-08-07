// push.js — phone notification delivery: Web Push (browser/PWA) + Pushover.
// Fire-and-forget by design: a push failure must never break an API request.
const fs = require('fs');
const path = require('path');
const https = require('https');
const webpush = require('web-push');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// VAPID keys: generated once, persisted next to the database (like the session secret)
function loadVapid() {
  const f = path.join(DATA_DIR, '.vapid.json');
  try {
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    const keys = webpush.generateVAPIDKeys();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(keys), { mode: 0o600 });
    return keys;
  } catch (e) {
    return webpush.generateVAPIDKeys(); // ephemeral fallback
  }
}
const vapid = loadVapid();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@steadhold.app', vapid.publicKey, vapid.privateKey);

function publicKey() { return vapid.publicKey; }

function saveSubscription(userId, sub) {
  if (!sub || !sub.endpoint) return false;
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, sub_json, created_at)
    VALUES (?,?,?,datetime('now'))
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, sub_json=excluded.sub_json`)
    .run(userId, sub.endpoint, JSON.stringify(sub));
  return true;
}
function removeSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(userId, endpoint || '');
}
function subscriptionCount(userId) {
  return db.prepare('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id=?').get(userId).c;
}

// Send to every device a user has registered; prune dead endpoints (410/404)
function sendWebPush(userId, payload) {
  const subs = db.prepare('SELECT endpoint, sub_json FROM push_subscriptions WHERE user_id=?').all(userId);
  for (const row of subs) {
    let sub;
    try { sub = JSON.parse(row.sub_json); } catch (e) { continue; }
    webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 })
      .catch(err => {
        if (err.statusCode === 410 || err.statusCode === 404)
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(row.endpoint);
      });
  }
  return subs.length;
}

// Pushover: needs the org's app token (PUSHOVER_TOKEN env var) + the user's personal key
function sendPushover(userKey, title, message, url) {
  const token = process.env.PUSHOVER_TOKEN;
  if (!token || !userKey) return false;
  const body = new URLSearchParams({ token, user: userKey, title, message: message || title });
  if (url) { body.set('url', url); body.set('url_title', 'Open in Steadhold'); }
  const req = https.request({ hostname: 'api.pushover.net', path: '/1/messages.json', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => res.resume());
  req.on('error', () => {});
  req.end(body.toString());
  return true;
}

// Called from notify(): deliver one notification to one user's phone(s), honoring their per-kind push pref
function deliverToPhone(userId, kind, title, body, link, appUrl) {
  const pref = db.prepare('SELECT push FROM notification_prefs WHERE user_id=? AND kind=?').get(userId, kind);
  if (pref && !pref.push) return;   // explicitly disabled for this kind (default is on)
  const url = link ? (appUrl || '') + '/' + link.replace(/^#?\/?/, '#/') : (appUrl || '');
  sendWebPush(userId, { title, body: body || '', url, kind });
  const u = db.prepare('SELECT pushover_key FROM users WHERE id=?').get(userId);
  if (u && u.pushover_key) sendPushover(u.pushover_key, title, body, url);
}

module.exports = { publicKey, saveSubscription, removeSubscription, subscriptionCount, deliverToPhone };
