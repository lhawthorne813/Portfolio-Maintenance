const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const N = require('./notifications');
const AI = require('./ai');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const OPEN = "('new','assigned','scheduled','in_progress','waiting_parts','waiting_approval','waiting_vendor')";
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const dateOnly = date => (date || new Date()).toISOString().slice(0, 10);

function setting(orgId, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE organization_id=? AND key=?').get(orgId, key);
  return row ? row.value : fallback;
}
function setSetting(orgId, key, value) {
  db.transaction(() => {
    db.prepare('DELETE FROM settings WHERE organization_id=? AND key=?').run(orgId, key);
    db.prepare('INSERT INTO settings (organization_id,key,value) VALUES (?,?,?)').run(orgId, key, String(value));
  })();
}
const enabled = (orgId, key, fallback = true) => ['1', 'true', 'yes', 'on'].includes(String(setting(orgId, key, fallback ? '1' : '0')).toLowerCase());
const mgmtIds = orgId => db.prepare(`SELECT id FROM users WHERE organization_id=? AND role IN ('owner','manager') AND active=1`).all(orgId).map(r => r.id);
const ownerIds = orgId => db.prepare(`SELECT id FROM users WHERE organization_id=? AND role='owner' AND active=1`).all(orgId).map(r => r.id);

const PLAYBOOKS = {
  water_leak: {
    name: 'Active water leak', category: 'Plumbing', risk: 'high', acknowledge: 15,
    actions: ['raise priority', 'send shutoff guidance', 'create work order', 'dispatch plumbing skill', 'start emergency SLA'],
    resident: 'If it is safe, turn off the nearest water shutoff or the home’s main shutoff. Keep away from wet electrical fixtures. If anyone is in danger, call 911 first.'
  },
  hvac_outage: {
    name: 'Heating / cooling outage', category: 'HVAC', risk: 'medium', acknowledge: 60,
    actions: ['confirm outage', 'send safe thermostat checks', 'create work order', 'dispatch HVAC skill', 'start urgent SLA'],
    resident: 'Please check that the thermostat is on, the temperature setting is appropriate, and the HVAC breaker has not tripped. Do not remove panels or repeatedly reset a breaker.'
  },
  electrical_safety: {
    name: 'Electrical or safety hazard', category: 'Electrical', risk: 'high', acknowledge: 15,
    actions: ['raise priority', 'send safety guidance', 'create work order', 'dispatch electrical skill', 'start emergency SLA'],
    resident: 'Do not touch sparking, hot, smoking, or water-exposed electrical equipment. Leave the area and call 911 for fire, smoke, or immediate danger. Switch off a circuit only if you can do so safely.'
  },
  routine_repair: {
    name: 'Routine repair', category: null, risk: 'low', acknowledge: 240,
    actions: ['confirm request', 'create work order', 'recommend technician', 'schedule next available slot'],
    resident: 'Your request is in the maintenance queue. Photos, access instructions, pets, and your preferred visit times help the team complete it in one trip.'
  }
};

function ensureOrgDefaults(orgId) {
  if (!orgId) return;
  const defaults = {
    autopilot_enabled: 1, auto_create_wo: 1, auto_assign: 1, auto_schedule: 1,
    resident_updates: 1, weekly_digest: 1, vendor_fallback: 1, auto_vendor_emergency: 0,
    approval_t1: 150, approval_t2: 500
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!db.prepare('SELECT 1 FROM settings WHERE organization_id=? AND key=?').get(orgId, key)) setSetting(orgId, key, value);
  }

  const insertPolicy = db.prepare(`INSERT OR IGNORE INTO automation_policies
    (organization_id,policy_key,name,trigger_json,actions_json,risk_level,enabled,updated_at)
    VALUES (?,?,?,?,?,?,1,?)`);
  for (const [key, p] of Object.entries(PLAYBOOKS)) {
    insertPolicy.run(orgId, key, p.name, JSON.stringify({ playbook: key }), JSON.stringify(p.actions), p.risk, sqlNow());
  }
  const slas = { emergency: [15, 60, 24], high: [60, 240, 48], normal: [240, 1440, 120], low: [480, 2880, 240] };
  const insertSla = db.prepare(`INSERT OR IGNORE INTO sla_policies
    (organization_id,priority,acknowledge_minutes,start_minutes,resolve_hours) VALUES (?,?,?,?,?)`);
  Object.entries(slas).forEach(([priority, values]) => insertSla.run(orgId, priority, ...values));

  const techs = db.prepare(`SELECT id,name FROM users WHERE organization_id=? AND role='technician' AND active=1`).all(orgId);
  const insertProfile = db.prepare(`INSERT OR IGNORE INTO technician_profiles
    (user_id,organization_id,skills,emergency_on_call,updated_at) VALUES (?,?,?,?,?)`);
  for (const tech of techs) {
    const categories = db.prepare(`SELECT category,COUNT(*) c FROM work_orders WHERE organization_id=?
      AND assigned_user_id=? AND status='completed' GROUP BY category ORDER BY c DESC LIMIT 4`).all(orgId, tech.id).map(r => r.category);
    if (!categories.length) categories.push('General');
    const onCall = /mike|james/i.test(tech.name) ? 1 : 0;
    insertProfile.run(tech.id, orgId, JSON.stringify(categories), onCall, sqlNow());
  }
}

function logEvent(orgId, eventType, sourceType, sourceId, action, reason, confidence, undoPayload, actorUserId) {
  const id = db.prepare(`INSERT INTO automation_events
    (organization_id,event_type,source_type,source_id,action,reason,confidence,undo_payload,actor_user_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(orgId, eventType, sourceType || null, sourceId || null, action,
      reason || null, confidence == null ? null : confidence, undoPayload ? JSON.stringify(undoPayload) : null,
      actorUserId || null, sqlNow()).lastInsertRowid;
  N.emitWebhook(orgId, 'automation.action', { id, event_type: eventType, source_type: sourceType, source_id: sourceId, action, reason, confidence });
  return id;
}

function ensureException(orgId, kind, severity, title, detail, sourceType, sourceId, dueAt) {
  let row = db.prepare(`SELECT * FROM exceptions WHERE organization_id=? AND kind=?
    AND COALESCE(source_type,'')=COALESCE(?,'') AND COALESCE(source_id,-1)=COALESCE(?,-1)
    AND status IN ('open','snoozed') ORDER BY id DESC LIMIT 1`).get(orgId, kind, sourceType || null, sourceId || null);
  if (row) {
    if (row.status === 'snoozed' && row.snoozed_until && row.snoozed_until <= sqlNow()) {
      db.prepare(`UPDATE exceptions SET status='open',snoozed_until=NULL,title=?,detail=?,due_at=? WHERE id=?`)
        .run(title, detail || null, dueAt || null, row.id);
    }
    return { id: row.id, created: false };
  }
  const id = db.prepare(`INSERT INTO exceptions
    (organization_id,kind,severity,title,detail,source_type,source_id,due_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(orgId, kind, severity, title, detail || null, sourceType || null, sourceId || null, dueAt || null, sqlNow()).lastInsertRowid;
  N.notify(orgId, mgmtIds(orgId), severity === 'critical' ? 'emergency' : 'overdue', title, detail, sourceType === 'work_order' ? '#/work-orders/' + sourceId : '#/dashboard');
  N.emitWebhook(orgId, 'exception.created', { id, kind, severity, title, detail, source_type: sourceType, source_id: sourceId });
  return { id, created: true };
}

function resolveExceptions(orgId, sourceType, sourceId, kinds) {
  const params = [sqlNow(), orgId, sourceType, sourceId];
  let extra = '';
  if (kinds && kinds.length) { extra = ` AND kind IN (${kinds.map(() => '?').join(',')})`; params.push(...kinds); }
  db.prepare(`UPDATE exceptions SET status='resolved',resolved_at=? WHERE organization_id=? AND source_type=? AND source_id=?
    AND status IN ('open','snoozed')${extra}`).run(...params);
}

function classifyRequest(r) {
  const text = `${r.category || ''} ${r.description || ''}`.toLowerCase();
  const activeWater = r.flag_water || /(active leak|flood|flooding|burst|water pooling|pouring|ceiling.*water|tank.*leak)/.test(text);
  const electricalDanger = r.flag_safety || r.flag_electrical || /(spark|smoke|burning|hot outlet|exposed wire|electrical.*water|shock)/.test(text);
  let key = 'routine_repair';
  if (activeWater) key = 'water_leak';
  else if (r.flag_hvac_out || /\b(no heat|no ac|no a\/c|hvac.*out|not cooling|not heating)\b/.test(text)) key = 'hvac_outage';
  else if (electricalDanger || ['electrical', 'safety'].includes(String(r.category || '').toLowerCase())) key = 'electrical_safety';
  const policy = PLAYBOOKS[key];
  let priority = r.priority || 'normal';
  if (r.is_emergency || key === 'water_leak' || (key === 'electrical_safety' && electricalDanger)) priority = 'emergency';
  else if (key === 'hvac_outage' || key === 'electrical_safety') priority = 'high';
  const confidence = key === 'routine_repair' ? 0.82 : (r.is_emergency || r[`flag_${key === 'water_leak' ? 'water' : key === 'hvac_outage' ? 'hvac_out' : 'electrical'}`] ? 0.98 : 0.9);
  return { key, policy, priority, category: policy.category || r.category || 'General', confidence };
}

function nextBusinessDate(offset = 1) {
  const d = new Date();
  do { d.setUTCDate(d.getUTCDate() + 1); } while ([0, 6].includes(d.getUTCDay()));
  while (--offset > 0) do { d.setUTCDate(d.getUTCDate() + 1); } while ([0, 6].includes(d.getUTCDay()));
  return dateOnly(d);
}
function nextWONumber(orgId) {
  const row = db.prepare(`SELECT MAX(CAST(substr(number,4) AS INTEGER)) n FROM work_orders
    WHERE organization_id=? AND number GLOB 'WO-[0-9]*'`).get(orgId);
  return 'WO-' + ((row.n || 1000) + 1);
}
function slaPolicy(orgId, priority) {
  return db.prepare('SELECT * FROM sla_policies WHERE organization_id=? AND priority=? AND enabled=1').get(orgId, priority)
    || { acknowledge_minutes: priority === 'emergency' ? 15 : 240, start_minutes: 1440, resolve_hours: 120 };
}
function addMinutes(minutes) { return new Date(Date.now() + minutes * 60000).toISOString().replace('T', ' ').slice(0, 19); }

function parseSkills(raw) {
  try { return JSON.parse(raw || '[]').map(x => String(x).toLowerCase()); }
  catch (error) { return String(raw || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean); }
}

function dispatchRecommendations(orgId, job) {
  ensureOrgDefaults(orgId);
  const targetDate = job.scheduled_date || dateOnly(new Date());
  const day = new Date(targetDate + 'T12:00:00Z').getUTCDay();
  const rows = db.prepare(`SELECT u.id,u.name,u.hourly_rate,p.skills,p.service_area,p.work_days,p.max_daily_minutes,
      COALESCE(p.auto_assign,1) auto_assign,COALESCE(p.emergency_on_call,0) emergency_on_call
    FROM users u LEFT JOIN technician_profiles p ON p.user_id=u.id
    WHERE u.organization_id=? AND u.role='technician' AND u.active=1`).all(orgId);
  const technicians = rows.map(t => {
    const skills = parseSkills(t.skills);
    const exactSkill = skills.includes(String(job.category || '').toLowerCase());
    const history = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND assigned_user_id=?
      AND category=? AND status='completed'`).get(orgId, t.id, job.category).c;
    const familiarity = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND assigned_user_id=?
      AND property_id=? AND status='completed'`).get(orgId, t.id, job.property_id).c;
    const performance = db.prepare(`SELECT COUNT(*) completed,
      AVG(julianday(completed_at)-julianday(created_at)) avg_days FROM work_orders
      WHERE organization_id=? AND assigned_user_id=? AND status='completed'`).get(orgId, t.id);
    const callbacks = db.prepare(`SELECT COUNT(*) c FROM work_orders cb JOIN work_orders original ON original.id=cb.callback_of_id
      WHERE original.organization_id=? AND original.assigned_user_id=?`).get(orgId, t.id).c;
    const callbackRate = performance.completed ? Math.min(1, callbacks / performance.completed) : null;
    const workload = db.prepare(`SELECT COALESCE(SUM(estimated_minutes),0) m FROM work_orders WHERE organization_id=?
      AND assigned_user_id=? AND scheduled_date=? AND status IN ${OPEN}`).get(orgId, t.id, targetDate).m;
    const capacity = t.max_daily_minutes || 480;
    const scheduledDay = String(t.work_days || '1,2,3,4,5').split(',').map(Number).includes(day);
    const available = (scheduledDay || (job.priority === 'emergency' && t.emergency_on_call)) && workload < capacity;
    let score = 10 + (exactSkill ? 35 : 0) + Math.min(20, history * 4) + Math.min(10, familiarity * 2);
    score += Math.max(0, 15 * (1 - workload / capacity));
    score += callbackRate == null ? 4 : Math.round(10 * (1 - callbackRate));
    if (+t.hourly_rate > 0 && +t.hourly_rate <= 35) score += 5;
    if (job.priority === 'emergency' && t.emergency_on_call) score += 10;
    if (!available) score -= 30;
    return { id: t.id, name: t.name, score: Math.max(0, Math.min(100, Math.round(score))),
      skills, workload_minutes: workload, capacity_minutes: capacity, property_jobs: familiarity,
      category_jobs: history, completed_jobs: performance.completed, callback_rate: callbackRate == null ? null : +callbackRate.toFixed(2),
      avg_completion_days: performance.avg_days == null ? null : +performance.avg_days.toFixed(1), available, auto_assign: !!t.auto_assign,
      reason: [exactSkill ? `${job.category} skill` : history ? `${history} similar jobs` : 'general capability',
        `${workload}/${capacity} min scheduled`, familiarity ? `${familiarity} prior visits here` : 'new to property',
        performance.completed ? `${Math.round((1 - callbackRate) * 100)}% no-callback history` : 'building performance history',
        job.priority === 'emergency' && t.emergency_on_call ? 'on call' : null].filter(Boolean).join(' · ') };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const vendors = db.prepare(`SELECT * FROM vendors WHERE organization_id=? AND active=1`).all(orgId).map(v => {
    const trade = String(v.trade || '').toLowerCase();
    let score = trade.includes(String(job.category || '').toLowerCase()) ? 60 : 15;
    if (job.priority === 'emergency' && v.emergency_available) score += 20;
    if (v.service_area) score += 5;
    return { id: v.id, name: v.company, score: Math.min(100, score), trade: v.trade,
      available: job.priority !== 'emergency' || !!v.emergency_available,
      reason: [v.trade || 'general vendor', v.emergency_available ? 'emergency availability' : null, v.service_area || null].filter(Boolean).join(' · ') };
  }).sort((a, b) => b.score - a.score);
  const top = technicians[0];
  const gap = top ? top.score - (technicians[1] ? technicians[1].score : 0) : 0;
  const vendorTop = vendors.find(v => v.available) || null;
  const vendorGap = vendorTop ? vendorTop.score - (vendors.find(v => v.available && v.id !== vendorTop.id)?.score || 0) : 0;
  return { technicians, vendors, recommendation: top && top.available ? top : null,
    confidence: top ? +(Math.min(0.99, (top.score / 100) * (gap >= 8 ? 1 : 0.82)).toFixed(2)) : 0,
    auto_assign_safe: !!(top && top.available && top.auto_assign && top.score >= 55 && (gap >= 5 || technicians.length === 1)),
    vendor_recommendation: vendorTop,
    vendor_confidence: vendorTop ? +(Math.min(0.99, (vendorTop.score / 100) * (vendorGap >= 8 ? 1 : 0.82)).toFixed(2)) : 0,
    vendor_auto_assign_safe: !!(vendorTop && vendorTop.score >= 75 && (vendorGap >= 5 || vendors.filter(v => v.available).length === 1)) };
}

function requestInstructions(r) {
  return [r.access_instructions ? 'Access: ' + r.access_instructions : null,
    r.permission_to_enter ? 'Permission to enter granted' : null,
    r.pets ? 'Pets: ' + r.pets : null,
    r.preferred_availability ? 'Resident availability: ' + r.preferred_availability : null].filter(Boolean).join(' · ');
}

async function automateRequest(requestId) {
  const r = db.prepare(`SELECT r.*,p.name property_name,p.tenant_routing,u.label unit_label
    FROM requests r JOIN properties p ON p.id=r.property_id LEFT JOIN units u ON u.id=r.unit_id WHERE r.id=?`).get(requestId);
  if (!r || !['open', 'info_needed', 'owner_review'].includes(r.status)) return null;
  ensureOrgDefaults(r.organization_id);
  const c = classifyRequest(r);
  const policyRow = db.prepare(`SELECT enabled FROM automation_policies WHERE organization_id=? AND policy_key=?`).get(r.organization_id, c.key);
  const policyEnabled = !policyRow || !!policyRow.enabled;
  const sla = slaPolicy(r.organization_id, c.priority);
  const dueAt = addMinutes(sla.acknowledge_minutes);
  db.prepare(`UPDATE requests SET playbook=?,priority=?,triage_confidence=?,sla_due_at=?,automation_state=? WHERE id=?`)
    .run(c.key, c.priority, c.confidence, dueAt, r.status === 'owner_review' ? 'owner_review' : 'classified', r.id);
  if (!db.prepare(`SELECT 1 FROM automation_events WHERE source_type='request' AND source_id=? AND action='classified'`).get(r.id)) {
    logEvent(r.organization_id, 'request', 'request', r.id, 'classified',
      `${c.policy.name} playbook matched from category, flags, and request text`, c.confidence,
      { table: 'requests', id: r.id, fields: { priority: r.priority, playbook: r.playbook, triage_confidence: r.triage_confidence } });
    if (enabled(r.organization_id, 'resident_updates'))
      N.residentUpdate(r.id, `We received your ${c.policy.name.toLowerCase()} request at ${r.property_name}. ${c.policy.resident}`,
        'Request received');
  }
  if (r.status === 'owner_review') return { held_for_owner: true, playbook: c.key };
  if (!policyEnabled) {
    db.prepare(`UPDATE requests SET automation_state='policy_review' WHERE id=?`).run(r.id);
    ensureException(r.organization_id, 'policy_disabled', c.priority === 'emergency' ? 'critical' : 'action',
      `${c.policy.name} playbook is paused`, `${r.property_name} · review this request or re-enable the playbook`, 'request', r.id, dueAt);
    return { classified: true, playbook: c.key, policy_disabled: true };
  }
  if (!enabled(r.organization_id, 'autopilot_enabled') || !enabled(r.organization_id, 'auto_create_wo')) {
    ensureException(r.organization_id, 'triage_needed', c.priority === 'emergency' ? 'critical' : 'action',
      `Request ready for review: ${c.policy.name}`, `${r.property_name} · ${r.description.slice(0, 180)}`, 'request', r.id, dueAt);
    return { classified: true, playbook: c.key };
  }
  if (r.work_order_id) return { id: r.work_order_id, existing: true };
  resolveExceptions(r.organization_id, 'request', r.id, ['policy_disabled', 'triage_needed']);

  const scheduledDate = c.priority === 'emergency' || c.priority === 'high' ? dateOnly(new Date()) : nextBusinessDate();
  const dueDate = c.priority === 'emergency' ? scheduledDate : (c.priority === 'high' ? nextBusinessDate() : nextBusinessDate(2));
  const number = nextWONumber(r.organization_id);
  const woId = db.prepare(`INSERT INTO work_orders
    (organization_id,number,property_id,unit_id,category,title,description,instructions,priority,status,
     scheduled_date,due_date,estimated_minutes,source,created_at,sla_due_at,management_touches)
    VALUES (?,?,?,?,?,?,?,?,?,'new',?,?,?,?,?,?,0)`).run(r.organization_id, number, r.property_id, r.unit_id,
      c.category, r.description.slice(0, 90), r.description, requestInstructions(r) || null, c.priority,
      enabled(r.organization_id, 'auto_schedule') ? scheduledDate : null, dueDate, c.priority === 'emergency' ? 120 : 60,
      'request', sqlNow(), dueAt).lastInsertRowid;
  db.prepare(`UPDATE requests SET status='converted',work_order_id=?,automation_state='work_order_created' WHERE id=?`).run(woId, r.id);
  db.prepare('UPDATE photos SET work_order_id=? WHERE request_id=?').run(woId, r.id);
  db.prepare(`INSERT INTO wo_history (organization_id,work_order_id,action,detail,created_at)
    VALUES (?,?,'automation','Autopilot created this work order from the resident request',?)`).run(r.organization_id, woId, sqlNow());
  logEvent(r.organization_id, 'work_order', 'work_order', woId, 'created',
    `${c.policy.name} policy authorized work-order creation`, c.confidence, null);

  const job = db.prepare('SELECT * FROM work_orders WHERE id=?').get(woId);
  const dispatch = dispatchRecommendations(r.organization_id, job);
  if (enabled(r.organization_id, 'auto_assign') && dispatch.auto_assign_safe) {
    const tech = dispatch.recommendation;
    db.prepare(`UPDATE work_orders SET assigned_user_id=?,status=?,auto_assigned=1 WHERE id=?`)
      .run(tech.id, job.scheduled_date ? 'scheduled' : 'assigned', woId);
    db.prepare(`UPDATE requests SET automation_state='dispatched' WHERE id=?`).run(r.id);
    db.prepare(`INSERT INTO wo_history (organization_id,work_order_id,action,detail,new_value,created_at)
      VALUES (?,?,'assigned',?,?,?)`).run(r.organization_id, woId,
        `Autopilot assigned ${tech.name}: ${tech.reason}`, String(tech.id), sqlNow());
    logEvent(r.organization_id, 'dispatch', 'work_order', woId, 'auto_assigned',
      `${tech.name} scored ${tech.score}/100: ${tech.reason}`, dispatch.confidence,
      { table: 'work_orders', id: woId, fields: { assigned_user_id: null, status: 'new', auto_assigned: 0 } });
    N.notify(r.organization_id, tech.id, 'assigned', 'New job assigned', `${number} — ${job.title}`, '#/work-orders/' + woId);
    if (enabled(r.organization_id, 'resident_updates'))
      N.residentUpdate(r.id, `Your request is now ${number}. ${tech.name} is assigned${job.scheduled_date ? ` for ${job.scheduled_date}` : ''}. Use this page to reply or update access details.`,
        'Repair assigned', woId);
  } else if (enabled(r.organization_id, 'auto_assign') && enabled(r.organization_id, 'vendor_fallback') &&
      enabled(r.organization_id, 'auto_vendor_emergency', false) && c.priority === 'emergency' && dispatch.vendor_auto_assign_safe) {
    const vendor = dispatch.vendor_recommendation;
    db.prepare(`UPDATE work_orders SET assigned_vendor_id=?,status=?,auto_assigned=1 WHERE id=?`)
      .run(vendor.id, job.scheduled_date ? 'scheduled' : 'assigned', woId);
    db.prepare(`UPDATE requests SET automation_state='dispatched' WHERE id=?`).run(r.id);
    db.prepare(`INSERT INTO wo_history (organization_id,work_order_id,action,detail,new_value,created_at)
      VALUES (?,?,'assigned',?,?,?)`).run(r.organization_id, woId,
        `Emergency vendor fallback assigned ${vendor.name}: ${vendor.reason}`, String(vendor.id), sqlNow());
    logEvent(r.organization_id, 'dispatch', 'work_order', woId, 'auto_assigned_vendor',
      `${vendor.name} scored ${vendor.score}/100: ${vendor.reason}`, dispatch.vendor_confidence,
      { table: 'work_orders', id: woId, fields: { assigned_vendor_id: null, status: 'new', auto_assigned: 0 } });
    const vendorUsers = db.prepare(`SELECT id FROM users WHERE organization_id=? AND vendor_id=? AND role='vendor' AND active=1`).all(r.organization_id, vendor.id).map(u => u.id);
    N.notify(r.organization_id, vendorUsers, 'assigned', 'Emergency job assigned', `${number} — ${job.title}`, '#/work-orders/' + woId);
    if (enabled(r.organization_id, 'resident_updates'))
      N.residentUpdate(r.id, `Your emergency request is now ${number}. ${vendor.name} is assigned${job.scheduled_date ? ` for ${job.scheduled_date}` : ''}. Use this page to reply or update access details.`,
        'Emergency repair assigned', woId);
  } else {
    const best = dispatch.recommendation || (enabled(r.organization_id, 'vendor_fallback') ? dispatch.vendor_recommendation : null);
    ensureException(r.organization_id, 'dispatch_needed', c.priority === 'emergency' ? 'critical' : 'action',
      `Dispatch needed: ${number}`, best ? `${best.name} is the best match (${best.score}/100), but confidence or policy requires a manager decision.` : 'No available technician or eligible vendor matched this work.',
      'work_order', woId, dueAt);
    if (enabled(r.organization_id, 'resident_updates'))
      N.residentUpdate(r.id, `Your request is now ${number} and is being matched to the right technician. We will post the appointment here.`,
        'Repair created', woId);
  }
  N.emitWebhook(r.organization_id, 'request.converted', { request_id: r.id, work_order_id: woId, number, playbook: c.key });
  return { id: woId, number, playbook: c.key, dispatch };
}

function onRequestCreated(requestId) {
  const request = db.prepare('SELECT organization_id FROM requests WHERE id=?').get(requestId);
  return enqueue('request_automate', { request_id: requestId }, new Date(), `request:${requestId}`, request && request.organization_id);
}

function onWorkOrderChanged(workOrderId, change) {
  const row = db.prepare(`SELECT r.id request_id,r.organization_id,r.tracking_token,w.* FROM requests r
    JOIN work_orders w ON w.id=r.work_order_id WHERE w.id=?`).get(workOrderId);
  if (!row || !enabled(row.organization_id, 'resident_updates')) return;
  let message = null, subject = 'Maintenance update';
  if (change === 'assigned' || change === 'scheduled') {
    const tech = row.assigned_user_id ? db.prepare('SELECT name FROM users WHERE id=?').get(row.assigned_user_id) : null;
    const vendor = row.assigned_vendor_id ? db.prepare('SELECT company name FROM vendors WHERE id=?').get(row.assigned_vendor_id) : null;
    message = `${row.number} has been ${row.scheduled_date ? `scheduled for ${row.scheduled_date}` : 'assigned'}${tech || vendor ? ` to ${(tech || vendor).name}` : ''}.`;
    subject = 'Appointment update';
  } else if (change === 'in_progress') message = `${row.number} is now in progress.`;
  else if (change === 'waiting_parts') message = `${row.number} is waiting for parts. The team will update this page when the return visit is scheduled.`;
  else if (change === 'waiting_approval') message = `${row.number} needs an internal approval before work continues. No action is needed from you.`;
  if (message) N.residentUpdate(row.request_id, message, subject, workOrderId);
}

function onWorkOrderCompleted(workOrderId) {
  const row = db.prepare(`SELECT r.id request_id,r.organization_id,w.number,w.title FROM requests r
    JOIN work_orders w ON w.id=r.work_order_id WHERE w.id=?`).get(workOrderId);
  if (!row) return;
  resolveExceptions(row.organization_id, 'work_order', workOrderId);
  if (enabled(row.organization_id, 'resident_updates'))
    N.residentUpdate(row.request_id,
      `${row.number} is complete. Please rate the repair below. If the issue is not fixed, tap “Reopen” and Steadhold will create a linked callback job automatically.`,
      'Repair complete', workOrderId);
  logEvent(row.organization_id, 'completion', 'work_order', workOrderId, 'resident_closeout_started',
    'Verified completion evidence passed; resident confirmation requested', 1, null);
  N.emitWebhook(row.organization_id, 'work_order.completed', { work_order_id: workOrderId, number: row.number });
}

function recordManualTouch(workOrderId) {
  db.prepare('UPDATE work_orders SET management_touches=management_touches+1 WHERE id=?').run(workOrderId);
}

async function analyzeReceipt(photoId) {
  const p = db.prepare(`SELECT ph.*,w.organization_id,w.property_id,w.id work_order_id,w.number,w.title
    FROM photos ph JOIN work_orders w ON w.id=ph.work_order_id WHERE ph.id=?`).get(photoId);
  if (!p) return null;
  if (!process.env.OPENAI_API_KEY) {
    db.prepare(`UPDATE photos SET ocr_status='not_configured' WHERE id=?`).run(photoId);
    return { configured: false };
  }
  db.prepare(`UPDATE photos SET ocr_status='processing' WHERE id=?`).run(photoId);
  const result = await AI.analyzeReceipt(path.join(UPLOAD_DIR, path.basename(p.url)));
  db.prepare(`UPDATE photos SET ocr_status='complete',ai_analysis=? WHERE id=?`).run(JSON.stringify(result), p.id);
  if (!result || !(result.total > 0) || result.confidence < 0.65) {
    ensureException(p.organization_id, 'receipt_review', 'action', `Receipt needs manual entry: ${p.number}`,
      result ? `Extraction confidence ${Math.round((result.confidence || 0) * 100)}%${result.total ? ` · visible total $${(+result.total).toFixed(2)}` : ' · no reliable total'}` : 'No structured receipt result was returned',
      'work_order', p.work_order_id, null);
    return result;
  }
  if (result && result.total > 0 && result.confidence >= 0.65 &&
      !db.prepare('SELECT 1 FROM expenses WHERE receipt_photo_id=?').get(p.id)) {
    const expenseId = db.prepare(`INSERT INTO expenses
      (organization_id,work_order_id,property_id,category,description,amount,incurred_on,receipt_photo_id,source,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(p.organization_id, p.work_order_id, p.property_id,
        result.category || 'materials', result.merchant || 'Receipt capture', result.total,
        /^\d{4}-\d{2}-\d{2}$/.test(result.purchase_date || '') ? result.purchase_date : dateOnly(new Date()),
        p.id, 'receipt_ocr', sqlNow()).lastInsertRowid;
    const addMaterial = db.prepare(`INSERT INTO materials
      (organization_id,work_order_id,name,qty,unit_cost,created_at) VALUES (?,?,?,?,?,?)`);
    for (const item of result.items || []) addMaterial.run(p.organization_id, p.work_order_id, item.name,
      item.quantity || 1, item.unit_cost || 0, sqlNow());
    logEvent(p.organization_id, 'cost', 'work_order', p.work_order_id, 'receipt_captured',
      `Receipt #${p.id} created expense #${expenseId} for $${result.total.toFixed(2)} (${Math.round(result.confidence * 100)}% extraction confidence)`,
      result.confidence, null);
    const threshold = +setting(p.organization_id, 'approval_t1', 150);
    if (result.total > threshold) ensureException(p.organization_id, 'spend_policy', 'action',
      `Receipt above policy: $${result.total.toFixed(2)}`, `${p.number} · ${result.merchant || p.title} · review coding and approval`,
      'work_order', p.work_order_id, sqlNow());
    else if (result.confidence < 0.82) ensureException(p.organization_id, 'receipt_review', 'watch',
      `Check receipt extraction: ${p.number}`, `Confidence ${Math.round(result.confidence * 100)}% · $${result.total.toFixed(2)}`,
      'work_order', p.work_order_id, null);
  }
  return result;
}

async function analyzePhoto(photoId) {
  const p = db.prepare(`SELECT ph.*,w.organization_id,w.id work_order_id FROM photos ph
    JOIN work_orders w ON w.id=ph.work_order_id WHERE ph.id=?`).get(photoId);
  if (!p) return null;
  if (!process.env.OPENAI_API_KEY) {
    db.prepare(`UPDATE photos SET ocr_status='not_configured' WHERE id=?`).run(photoId);
    return { configured: false };
  }
  db.prepare(`UPDATE photos SET ocr_status='processing' WHERE id=?`).run(photoId);
  const result = await AI.analyzeMaintenancePhoto(path.join(UPLOAD_DIR, path.basename(p.url)));
  db.prepare(`UPDATE photos SET ocr_status='complete',ai_analysis=? WHERE id=?`).run(JSON.stringify(result), p.id);
  logEvent(p.organization_id, 'evidence', 'work_order', p.work_order_id, 'photo_interpreted',
    `AI interpreted photo #${p.id}; technician judgment remains authoritative`, result.confidence, null);
  if ((result.safety_flags || []).length) ensureException(p.organization_id, 'photo_safety', 'critical',
    'Photo may show a safety hazard', result.safety_flags.join(' · '), 'work_order', p.work_order_id, sqlNow());
  return result;
}

function scanSlas() {
  const orgs = db.prepare('SELECT id FROM organizations').all();
  let opened = 0;
  for (const { id: orgId } of orgs) {
    ensureOrgDefaults(orgId);
    const wos = db.prepare(`SELECT w.*,p.name property_name,
      (SELECT MAX(created_at) FROM wo_history h WHERE h.work_order_id=w.id) last_event
      FROM work_orders w JOIN properties p ON p.id=w.property_id
      WHERE w.organization_id=? AND w.status IN ${OPEN}`).all(orgId);
    for (const w of wos) {
      const policy = slaPolicy(orgId, w.priority);
      const ageMin = (Date.now() - new Date((w.created_at || sqlNow()).replace(' ', 'T') + 'Z').getTime()) / 60000;
      if (!w.assigned_user_id && !w.assigned_vendor_id && ageMin >= policy.acknowledge_minutes) {
        const x = ensureException(orgId, 'unassigned', w.priority === 'emergency' ? 'critical' : 'action',
          `Unassigned ${w.priority} job: ${w.number}`, `${w.property_name} · ${w.title} · waiting ${Math.round(ageMin)} minutes`,
          'work_order', w.id, w.sla_due_at); if (x.created) opened++;
      } else if ((w.assigned_user_id || w.assigned_vendor_id) && !w.accepted_at && ageMin >= policy.acknowledge_minutes) {
        const x = ensureException(orgId, 'unaccepted', w.priority === 'emergency' ? 'critical' : 'action',
          `Assignment not accepted: ${w.number}`, `${w.title} · assigned ${Math.round(ageMin)} minutes ago`,
          'work_order', w.id, w.sla_due_at); if (x.created) opened++;
      }
      if (w.due_date && w.due_date < dateOnly(new Date())) {
        const x = ensureException(orgId, 'overdue', 'action', `Overdue job: ${w.number}`,
          `${w.property_name} · ${w.title} · due ${w.due_date}`, 'work_order', w.id, w.due_date + ' 17:00:00'); if (x.created) opened++;
      }
      const last = new Date((w.last_event || w.created_at).replace(' ', 'T') + 'Z').getTime();
      const staleHours = (Date.now() - last) / 3600000;
      if (w.status === 'waiting_parts' && staleHours >= 72) {
        const x = ensureException(orgId, 'parts_stale', 'action', `Parts follow-up needed: ${w.number}`,
          `${Math.floor(staleHours / 24)} days without an update`, 'work_order', w.id, null); if (x.created) opened++;
      }
    }
    const approvals = db.prepare(`SELECT a.*,w.number,w.title FROM approvals a JOIN work_orders w ON w.id=a.work_order_id
      WHERE a.organization_id=? AND a.status='pending' AND a.created_at<datetime('now','-24 hours')`).all(orgId);
    for (const a of approvals) {
      const x = ensureException(orgId, 'approval_stale', 'action', `Approval waiting over 24h: ${a.work_order_id ? a.number : ''}`,
        `$${(+a.amount).toFixed(2)} · ${a.title}`, 'work_order', a.work_order_id, null); if (x.created) opened++;
    }
    const quotes = db.prepare(`SELECT q.*,w.number,w.title,v.company FROM vendor_quotes q JOIN work_orders w ON w.id=q.work_order_id
      JOIN vendors v ON v.id=q.vendor_id WHERE q.organization_id=? AND q.status='requested' AND q.created_at<datetime('now','-24 hours')`).all(orgId);
    for (const q of quotes) {
      const x = ensureException(orgId, 'quote_stale', 'action', `Quote follow-up: ${q.company}`,
        `${q.number} · ${q.title} · requested over 24 hours ago`, 'work_order', q.work_order_id, null); if (x.created) opened++;
    }
  }
  return opened;
}

function zeroTouchMetrics(orgId, days = 30) {
  const base = db.prepare(`SELECT COUNT(*) c FROM work_orders w WHERE w.organization_id=? AND w.source='request'
    AND w.status='completed' AND w.completed_at>=datetime('now',?)`).get(orgId, `-${days} days`).c;
  const verified = db.prepare(`SELECT COUNT(*) c FROM work_orders w WHERE w.organization_id=? AND w.source='request'
    AND w.status='completed' AND w.completed_at>=datetime('now',?) AND w.management_touches=0
    AND NOT EXISTS (SELECT 1 FROM wo_history h WHERE h.work_order_id=w.id AND h.action='completion_override')`).get(orgId, `-${days} days`).c;
  return { verified_zero_touch: verified, eligible_completed: base, rate: base ? Math.round(verified / base * 100) : 0 };
}

function createOwnerDigest(orgId) {
  ensureOrgDefaults(orgId);
  const periodEnd = dateOnly(new Date());
  const start = new Date(); start.setUTCDate(start.getUTCDate() - 7);
  const periodStart = dateOnly(start);
  const summary = {
    completed: db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND status='completed' AND completed_at>=?`).get(orgId, periodStart).c,
    opened: db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND created_at>=?`).get(orgId, periodStart).c,
    spend: +db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE organization_id=? AND incurred_on>=?`).get(orgId, periodStart).s.toFixed(2),
    automated_actions: db.prepare(`SELECT COUNT(*) c FROM automation_events WHERE organization_id=? AND created_at>=?`).get(orgId, periodStart).c,
    open_exceptions: db.prepare(`SELECT COUNT(*) c FROM exceptions WHERE organization_id=? AND status='open'`).get(orgId).c,
    callbacks: db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND callback_of_id IS NOT NULL AND created_at>=?`).get(orgId, periodStart).c,
    zero_touch: zeroTouchMetrics(orgId, 30)
  };
  const id = db.prepare(`INSERT INTO owner_digests (organization_id,period_start,period_end,summary_json,created_at)
    VALUES (?,?,?,?,?)`).run(orgId, periodStart, periodEnd, JSON.stringify(summary), sqlNow()).lastInsertRowid;
  const org = db.prepare('SELECT name FROM organizations WHERE id=?').get(orgId);
  const body = `${summary.completed} jobs completed, ${summary.opened} opened, $${summary.spend.toFixed(2)} spent. ` +
    `Autopilot handled ${summary.automated_actions} actions; verified zero-touch resolution is ${summary.zero_touch.rate}%. ` +
    `${summary.open_exceptions} exception${summary.open_exceptions === 1 ? '' : 's'} need attention.`;
  N.notify(orgId, ownerIds(orgId), 'weekly_digest', `Weekly owner digest — ${org.name}`, body, '#/dashboard');
  logEvent(orgId, 'digest', 'digest', id, 'weekly_digest_created', 'Scheduled seven-day owner summary', 1, null);
  N.emitWebhook(orgId, 'digest.created', { id, period_start: periodStart, period_end: periodEnd, summary });
  return { id, ...summary };
}

function generatePMWorkOrders() {
  const due = db.prepare(`SELECT s.*,p.name property_name FROM pm_schedules s JOIN properties p ON p.id=s.property_id
    WHERE s.organization_id IS NOT NULL AND s.active=1 AND s.next_due<=date('now','+7 days')`).all();
  let generated = 0;
  for (const s of due) {
    if (db.prepare(`SELECT 1 FROM work_orders WHERE pm_schedule_id=? AND status NOT IN ('completed','cancelled')`).get(s.id)) continue;
    const number = nextWONumber(s.organization_id);
    const status = (s.assigned_user_id || s.assigned_vendor_id) ? 'assigned' : 'new';
    const id = db.prepare(`INSERT INTO work_orders
      (organization_id,number,property_id,asset_id,category,title,description,instructions,priority,status,
       assigned_user_id,assigned_vendor_id,due_date,estimated_minutes,source,pm_schedule_id,created_at,management_touches)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(s.organization_id, number, s.property_id, s.asset_id,
        s.category, s.title, 'Auto-generated from preventive maintenance schedule.', s.instructions, 'normal', status,
        s.assigned_user_id || null, s.assigned_vendor_id || null, s.next_due, s.estimated_minutes || 60,
        'preventive', s.id, sqlNow()).lastInsertRowid;
    db.prepare(`INSERT INTO wo_history (organization_id,work_order_id,action,detail,created_at)
      VALUES (?,?,'created','Generated from preventive maintenance schedule',?)`).run(s.organization_id, id, sqlNow());
    N.notify(s.organization_id, mgmtIds(s.organization_id), 'pm_due', 'Preventive maintenance due',
      `${s.title} — ${s.property_name} (due ${s.next_due}). ${number} created.`, '#/work-orders/' + id);
    if (s.assigned_user_id) N.notify(s.organization_id, s.assigned_user_id, 'assigned', 'PM job assigned', `${s.title} — ${s.property_name}`, '#/work-orders/' + id);
    logEvent(s.organization_id, 'preventive', 'work_order', id, 'pm_generated', `Schedule #${s.id} reached its generation window`, 1, null);
    generated++;
  }
  return generated;
}

function enqueue(kind, payload = {}, runAt = new Date(), dedupeKey = null, orgId = null) {
  const when = (runAt instanceof Date ? runAt : new Date(runAt)).toISOString().replace('T', ' ').slice(0, 19);
  const result = db.prepare(`INSERT OR IGNORE INTO durable_jobs
    (organization_id,kind,payload,run_at,dedupe_key,created_at) VALUES (?,?,?,?,?,?)`)
    .run(orgId || null, kind, JSON.stringify(payload || {}), when, dedupeKey || null, sqlNow());
  if (result.changes) return result.lastInsertRowid;
  if (dedupeKey) {
    // A dedupe key blocks concurrent duplicates, but a completed/failed job may
    // need to run again (owner release, resident reply, or policy re-enable).
    const requeued = db.prepare(`UPDATE durable_jobs SET organization_id=?,kind=?,payload=?,run_at=?,status='queued',
      attempts=0,locked_at=NULL,completed_at=NULL,last_error=NULL WHERE dedupe_key=? AND status IN ('done','failed')`)
      .run(orgId || null, kind, JSON.stringify(payload || {}), when, dedupeKey);
    if (requeued.changes) return db.prepare('SELECT id FROM durable_jobs WHERE dedupe_key=?').get(dedupeKey).id;
  }
  return null;
}

function scheduleNext(kind, delayMs) {
  const when = new Date(Date.now() + delayMs);
  enqueue(kind, {}, when, `recurring:${kind}:${when.toISOString().slice(0, 16)}`);
}

async function processJob(job) {
  const payload = JSON.parse(job.payload || '{}');
  if (job.kind === 'request_automate') return automateRequest(payload.request_id);
  if (job.kind === 'receipt_analyze') return analyzeReceipt(payload.photo_id);
  if (job.kind === 'photo_analyze') return analyzePhoto(payload.photo_id);
  if (job.kind === 'sla_scan') { const r = scanSlas(); scheduleNext('sla_scan', 5 * 60000); return r; }
  if (job.kind === 'pm_generate') { const r = generatePMWorkOrders(); scheduleNext('pm_generate', 6 * 3600000); return r; }
  if (job.kind === 'outbox_flush') { const r = await N.flushOutbox(); scheduleNext('outbox_flush', 60000); return r; }
  if (job.kind === 'weekly_digest') {
    for (const org of db.prepare('SELECT id FROM organizations').all()) if (enabled(org.id, 'weekly_digest')) createOwnerDigest(org.id);
    scheduleNext('weekly_digest', 7 * 86400000); return true;
  }
  if (job.kind === 'cleanup') {
    db.prepare(`DELETE FROM client_ops WHERE created_at<datetime('now','-30 days')`).run();
    db.prepare('DELETE FROM sessions WHERE expire<=?').run(Date.now());
    db.prepare(`DELETE FROM durable_jobs WHERE status='done' AND completed_at<datetime('now','-30 days')`).run();
    scheduleNext('cleanup', 6 * 3600000); return true;
  }
  throw new Error('Unknown job kind: ' + job.kind);
}

let running = false;
async function runDueJobs(limit = 10) {
  if (running) return 0;
  running = true;
  let count = 0;
  try {
    db.prepare(`UPDATE durable_jobs SET status='queued',locked_at=NULL WHERE status='running' AND locked_at<datetime('now','-15 minutes')`).run();
    const rows = db.prepare(`SELECT * FROM durable_jobs WHERE status='queued' AND run_at<=datetime('now') ORDER BY run_at,id LIMIT ?`).all(limit);
    for (const job of rows) {
      const lock = db.prepare(`UPDATE durable_jobs SET status='running',locked_at=?,attempts=attempts+1 WHERE id=? AND status='queued'`).run(sqlNow(), job.id);
      if (!lock.changes) continue;
      try {
        await processJob(job);
        db.prepare(`UPDATE durable_jobs SET status='done',completed_at=?,last_error=NULL WHERE id=?`).run(sqlNow(), job.id);
      } catch (error) {
        const attempts = job.attempts + 1;
        const status = attempts >= 5 ? 'failed' : 'queued';
        const next = new Date(Date.now() + Math.min(60, Math.pow(2, attempts)) * 60000).toISOString().replace('T', ' ').slice(0, 19);
        db.prepare(`UPDATE durable_jobs SET status=?,run_at=?,locked_at=NULL,last_error=? WHERE id=?`)
          .run(status, next, String(error.message || error).slice(0, 500), job.id);
        if (status === 'failed' && job.organization_id) ensureException(job.organization_id, 'automation_failed', 'action',
          `Automation failed: ${job.kind}`, String(error.message || error), 'job', job.id, null);
      }
      count++;
    }
  } finally { running = false; }
  return count;
}

function seedRecurringJobs() {
  const seed = (kind, delay) => {
    if (!db.prepare(`SELECT 1 FROM durable_jobs WHERE kind=? AND status IN ('queued','running')`).get(kind))
      enqueue(kind, {}, new Date(Date.now() + delay), `startup:${kind}:${Date.now()}`);
  };
  seed('sla_scan', 1000);
  seed('pm_generate', 1500);
  seed('outbox_flush', 2000);
  seed('cleanup', 5000);
  if (!db.prepare(`SELECT 1 FROM durable_jobs WHERE kind='weekly_digest' AND status IN ('queued','running')`).get()) {
    const next = new Date();
    const days = (8 - next.getUTCDay()) % 7 || 7;
    next.setUTCDate(next.getUTCDate() + days); next.setUTCHours(13, 0, 0, 0);
    enqueue('weekly_digest', {}, next, `weekly:${dateOnly(next)}`);
  }
}

function startWorker() {
  seedRecurringJobs();
  runDueJobs().catch(error => console.error('Automation worker:', error));
  const timer = setInterval(() => runDueJobs().catch(error => console.error('Automation worker:', error)), 10000);
  if (timer.unref) timer.unref();
  return timer;
}

function undoEvent(orgId, eventId, userId) {
  const event = db.prepare(`SELECT * FROM automation_events WHERE id=? AND organization_id=? AND status='applied'`).get(eventId, orgId);
  if (!event || !event.undo_payload) return false;
  const undo = JSON.parse(event.undo_payload);
  const allowed = {
    requests: ['priority', 'playbook', 'triage_confidence'],
    work_orders: ['assigned_user_id', 'assigned_vendor_id', 'status', 'auto_assigned', 'scheduled_date']
  };
  if (!allowed[undo.table] || !undo.id) return false;
  const fields = Object.keys(undo.fields || {}).filter(k => allowed[undo.table].includes(k));
  if (!fields.length) return false;
  db.transaction(() => {
    db.prepare(`UPDATE ${undo.table} SET ${fields.map(k => `${k}=?`).join(',')} WHERE id=? AND organization_id=?`)
      .run(...fields.map(k => undo.fields[k]), undo.id, orgId);
    db.prepare(`UPDATE automation_events SET status='undone',undone_at=?,actor_user_id=? WHERE id=?`).run(sqlNow(), userId, event.id);
    if (undo.table === 'work_orders') db.prepare(`INSERT INTO wo_history
      (organization_id,work_order_id,user_id,action,detail,created_at) VALUES (?,?,?,'automation_undone',?,?)`)
      .run(orgId, undo.id, userId, `Reversed automated action: ${event.action}`, sqlNow());
  })();
  return true;
}

function metrics(orgId) {
  return {
    automated_today: db.prepare(`SELECT COUNT(*) c FROM automation_events WHERE organization_id=? AND created_at>=date('now') AND status='applied'`).get(orgId).c,
    open_exceptions: db.prepare(`SELECT COUNT(*) c FROM exceptions WHERE organization_id=? AND status='open'`).get(orgId).c,
    queued_jobs: db.prepare(`SELECT COUNT(*) c FROM durable_jobs WHERE (organization_id=? OR organization_id IS NULL) AND status='queued'`).get(orgId).c,
    outbox_pending: db.prepare(`SELECT COUNT(*) c FROM outbox WHERE organization_id=? AND status='pending'`).get(orgId).c,
    ...zeroTouchMetrics(orgId)
  };
}

module.exports = {
  PLAYBOOKS, ensureOrgDefaults, enabled, setting, setSetting, classifyRequest,
  dispatchRecommendations, onRequestCreated, automateRequest, onWorkOrderChanged,
  onWorkOrderCompleted, recordManualTouch, ensureException, resolveExceptions,
  analyzeReceipt, analyzePhoto, scanSlas, createOwnerDigest, generatePMWorkOrders,
  enqueue, runDueJobs, seedRecurringJobs, startWorker, undoEvent, metrics, zeroTouchMetrics,
  logEvent
};
