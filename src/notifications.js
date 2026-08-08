const crypto = require('crypto');
const db = require('./db');
const push = require('./push');

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
let appUrl = (process.env.APP_URL || '').replace(/\/$/, '');

function setAppUrl(url) { if (!appUrl && url) appUrl = String(url).replace(/\/$/, ''); }
function absoluteLink(link) {
  if (!link) return appUrl || '';
  if (/^https?:\/\//i.test(link)) return link;
  return (appUrl || '') + (link.startsWith('/') || link.startsWith('#') ? '/' : '/') + link.replace(/^\//, '');
}

function queue(orgId, channel, recipient, subject, body, link, payload) {
  if (!recipient) return null;
  return db.prepare(`INSERT INTO outbox (organization_id,channel,recipient,subject,body,link,payload,run_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(orgId || null, channel, recipient, subject || null, body || null,
      link || null, payload ? JSON.stringify(payload) : null, sqlNow(), sqlNow()).lastInsertRowid;
}

function notify(orgId, userIds, kind, title, body, link) {
  const ids = [...new Set([].concat(userIds || []).filter(Boolean).map(Number))];
  const insert = db.prepare(`INSERT INTO notifications
    (organization_id,user_id,kind,title,body,link,created_at) VALUES (?,?,?,?,?,?,?)`);
  const pref = db.prepare('SELECT * FROM notification_prefs WHERE user_id=? AND kind=?');
  const user = db.prepare('SELECT id,email,phone FROM users WHERE id=? AND organization_id=? AND active=1');
  for (const id of ids) {
    const u = user.get(id, orgId);
    if (!u) continue;
    const p = pref.get(id, kind) || { in_app: 1, push: 1, email: 0, sms: 0 };
    if (p.in_app) insert.run(orgId, id, kind, title, body || null, link || null, sqlNow());
    if (p.push == null || p.push) {
      try { push.deliverToPhone(id, kind, title, body, link, appUrl); } catch (error) {}
    }
    if (p.email && u.email) queue(orgId, 'email', u.email, title, body, link, { kind, user_id: id });
    if (p.sms && u.phone) queue(orgId, 'sms', u.phone, title, body, link, { kind, user_id: id });
  }
}

function residentUpdate(requestId, body, subject = 'Maintenance update', workOrderId = null) {
  const r = db.prepare(`SELECT r.*, p.name property_name FROM requests r
    JOIN properties p ON p.id=r.property_id WHERE r.id=?`).get(requestId);
  if (!r) return null;
  db.prepare(`INSERT INTO resident_messages
    (organization_id,request_id,work_order_id,direction,channel,body,created_at)
    VALUES (?,?,?,'outbound','portal',?,?)`).run(r.organization_id, r.id, workOrderId || r.work_order_id || null, body, sqlNow());
  db.prepare(`UPDATE requests SET resident_status='updated', last_resident_message_at=? WHERE id=?`).run(sqlNow(), r.id);
  const link = '#/track/' + r.tracking_token;
  if (r.reporter_email) queue(r.organization_id, 'email', r.reporter_email, subject, body, link, { request_id: r.id });
  if (r.reporter_phone) queue(r.organization_id, 'sms', r.reporter_phone, subject, body, link, { request_id: r.id });
  return link;
}

function endpointWants(endpoint, event) {
  const raw = (endpoint.event_types || '*').trim();
  if (raw === '*') return true;
  try { return JSON.parse(raw).includes(event); }
  catch (error) { return raw.split(',').map(s => s.trim()).includes(event); }
}

function emitWebhook(orgId, event, data) {
  const endpoints = db.prepare(`SELECT * FROM webhook_endpoints
    WHERE organization_id=? AND direction='outbound' AND active=1 AND url IS NOT NULL`).all(orgId);
  for (const endpoint of endpoints) {
    if (!endpointWants(endpoint, event)) continue;
    queue(orgId, 'webhook', endpoint.url, event, null, null,
      { event, data, occurred_at: new Date().toISOString(), secret: endpoint.secret || '' });
  }
}

function htmlEscape(value) {
  return String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendEmail(row) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) throw new Error('Email delivery is not configured');
  const link = absoluteLink(row.link);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM, to: [row.recipient], subject: row.subject || 'Steadhold update',
      html: `<div style="font-family:Arial,sans-serif;line-height:1.5"><p>${htmlEscape(row.body)}</p>${link ? `<p><a href="${htmlEscape(link)}">Open update</a></p>` : ''}</div>`
    })
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
}

async function sendSms(row) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) throw new Error('SMS delivery is not configured');
  const text = [row.subject, row.body, absoluteLink(row.link)].filter(Boolean).join('\n').slice(0, 1500);
  const form = new URLSearchParams({ To: row.recipient, From: from, Body: text });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded' }, body: form
  });
  if (!response.ok) throw new Error(`SMS provider returned ${response.status}`);
}

function publicWebhookUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    const plainHost = host.replace(/^\[|\]$/g, '');
    return !['localhost', '0.0.0.0', '::', '::1'].includes(plainHost) &&
      !host.endsWith('.local') && !host.endsWith('.internal') &&
      !/^127\./.test(plainHost) && !/^10\./.test(plainHost) && !/^192\.168\./.test(plainHost) &&
      !/^169\.254\./.test(plainHost) && !/^172\.(1[6-9]|2\d|3[01])\./.test(plainHost) &&
      !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(plainHost) &&
      !/^(fc|fd|fe8|fe9|fea|feb)/i.test(plainHost);
  } catch (error) { return false; }
}

async function sendWebhook(row) {
  if (!publicWebhookUrl(row.recipient)) throw new Error('Webhook URL must be a public HTTP(S) address');
  const parsed = JSON.parse(row.payload || '{}');
  const secret = parsed.secret || '';
  delete parsed.secret;
  const body = JSON.stringify(parsed);
  const signature = secret ? crypto.createHmac('sha256', secret).update(body).digest('hex') : '';
  const response = await fetch(row.recipient, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Steadhold-Event': parsed.event || '',
      ...(signature ? { 'X-Steadhold-Signature': `sha256=${signature}` } : {}) }, body,
    redirect: 'error',
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
}

async function flushOutbox(limit = 25) {
  const rows = db.prepare(`SELECT * FROM outbox WHERE status='pending' AND run_at<=datetime('now')
    ORDER BY id LIMIT ?`).all(limit);
  for (const row of rows) {
    try {
      if (row.channel === 'email') await sendEmail(row);
      else if (row.channel === 'sms') await sendSms(row);
      else if (row.channel === 'webhook') await sendWebhook(row);
      else throw new Error('Unknown delivery channel');
      db.prepare(`UPDATE outbox SET status='sent', sent_at=?, last_error=NULL WHERE id=?`).run(sqlNow(), row.id);
    } catch (error) {
      const unconfigured = /not configured/.test(error.message);
      const attempts = row.attempts + 1;
      const status = unconfigured ? 'skipped' : (attempts >= 5 ? 'failed' : 'pending');
      const delay = Math.min(360, Math.pow(2, attempts)) + ' minutes';
      db.prepare(`UPDATE outbox SET status=?, attempts=?, last_error=?, run_at=datetime('now',?) WHERE id=?`)
        .run(status, attempts, error.message.slice(0, 300), `+${delay}`, row.id);
    }
  }
  return rows.length;
}

function deliveryStatus() {
  return {
    email: !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
    sms: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER),
    ai: !!process.env.OPENAI_API_KEY
  };
}

module.exports = { setAppUrl, queue, notify, residentUpdate, emitWebhook, flushOutbox, deliveryStatus, publicWebhookUrl };
