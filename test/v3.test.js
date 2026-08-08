// Steadhold V3 Autopilot integration tests.
// Run with a freshly started server: node test/v3.test.js
const BASE = process.env.BASE_URL || 'http://localhost:3000/api';

const jars = {};
async function call(user, method, route, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (jars[user]) headers.Cookie = jars[user];
  const response = await fetch(BASE + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) jars[user] = cookie.split(';')[0];
  let data = null;
  try { data = await response.json(); } catch (error) {}
  return { status: response.status, data, headers: response.headers };
}

let passed = 0;
let failed = 0;
function ok(condition, name, extra) {
  if (condition) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra).slice(0, 220) : '')); }
}

async function processJobsUntil(token, predicate) {
  let state = null;
  for (let i = 0; i < 8; i++) {
    await call('manager', 'POST', '/automation/run', { action: 'jobs' });
    const response = await fetch(BASE + '/track/' + token);
    state = await response.json();
    if (predicate(state)) break;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  return state;
}

(async () => {
  console.log('Steadhold V3 Autopilot test suite\n');

  console.log('AUTOPILOT POLICY & DURABLE OPERATIONS');
  ok((await call('owner', 'POST', '/auth/login', { email: 'owner@demo.com', password: 'demo123' })).status === 200, 'owner login');
  ok((await call('manager', 'POST', '/auth/login', { email: 'manager@demo.com', password: 'demo123' })).status === 200, 'manager login');
  const config = await call('owner', 'GET', '/automation/config');
  ok(config.status === 200 && config.data.settings.autopilot_enabled, 'Autopilot is enabled by default');
  ok(config.data.policies.length === 4 && config.data.policies.every(p => p.actions.length), 'four executable maintenance playbooks are installed');
  ok(config.data.slas.length === 4, 'priority SLA matrix is installed');
  ok(config.data.delivery && typeof config.data.delivery.ai === 'boolean', 'delivery and optional AI adapter readiness is exposed');
  const tune = await call('owner', 'PUT', '/automation/config', {
    settings: { autopilot_enabled: true, auto_create_wo: true, auto_assign: true, auto_schedule: true, resident_updates: true },
    slas: [{ priority: 'emergency', acknowledge_minutes: 10, start_minutes: 45, resolve_hours: 12, enabled: true }]
  });
  ok(tune.status === 200, 'owner can update policy and SLA controls');
  const tuned = await call('owner', 'GET', '/automation/config');
  ok(tuned.data.slas.find(s => s.priority === 'emergency').acknowledge_minutes === 10, 'SLA changes persist');

  console.log('\nRESIDENT REQUEST → CLASSIFICATION → DISPATCH');
  const property = await call('owner', 'GET', '/properties/1');
  const intakeToken = property.data.property.intake_token;
  const form = new FormData();
  form.append('category', 'Plumbing');
  form.append('description', 'V3TEST active water is pouring under the kitchen sink near an outlet');
  form.append('reported_by', 'Autopilot Resident');
  form.append('reporter_phone', '904-555-0199');
  form.append('reporter_email', 'resident@example.test');
  form.append('permission_to_enter', '1');
  form.append('preferred_availability', 'Any time today');
  form.append('flag_water', '1');
  const submitted = await fetch(BASE + '/intake/' + intakeToken, { method: 'POST', body: form });
  const request = await submitted.json();
  ok(submitted.status === 200 && request.tracking_token && request.tracking_url, 'public intake returns a private resident tracking link');
  let tracked = await processJobsUntil(request.tracking_token, state => !!state.work_order);
  ok(tracked.request.playbook === 'water_leak' && tracked.work_order, 'water-leak playbook creates a work order automatically', tracked);
  ok(tracked.work_order.priority === 'emergency' && !!tracked.work_order.scheduled_date, 'risk rules raise priority and schedule the job');
  ok(tracked.messages.some(m => /shutoff|safe/i.test(m.body)), 'resident receives immediate, safety-conscious guidance');
  const workOrderId = tracked.work_order.id;
  const dispatch = await call('manager', 'GET', '/dispatch/recommend/' + workOrderId);
  ok(dispatch.status === 200 && dispatch.data.technicians.length > 0, 'smart dispatch scores the technician roster');
  ok(dispatch.data.technicians[0].reason && Number.isFinite(dispatch.data.technicians[0].score), 'dispatch recommendation is explainable');

  const vendors = await call('owner', 'GET', '/vendors');
  const roofer = vendors.data.find(v => /roof/i.test(v.trade));
  await call('owner', 'PATCH', '/vendors/' + roofer.id, { emergency_available: true, service_area: 'Jacksonville' });
  await call('owner', 'PUT', '/automation/config', { settings: { auto_vendor_emergency: true, vendor_fallback: true } });
  const vendorForm = new FormData();
  vendorForm.append('category', 'Roofing');
  vendorForm.append('description', 'V3TEST emergency roof opening with active rain entry');
  vendorForm.append('reported_by', 'Vendor Fallback Resident');
  vendorForm.append('reporter_phone', '904-555-0188');
  vendorForm.append('is_emergency', '1');
  const vendorSubmitted = await fetch(BASE + '/intake/' + intakeToken, { method: 'POST', body: vendorForm });
  const vendorRequest = await vendorSubmitted.json();
  const vendorTracked = await processJobsUntil(vendorRequest.tracking_token, state => !!(state.work_order && state.work_order.assigned_to));
  ok(vendorTracked.work_order.assigned_to === roofer.company, 'opt-in emergency vendor fallback assigns an eligible trade partner');
  const vendorDetail = await call('owner', 'GET', '/work-orders/' + vendorTracked.work_order.id);
  ok(vendorDetail.data.wo.auto_assigned === 1 && vendorDetail.data.wo.assigned_vendor_id === roofer.id, 'vendor fallback is recorded as an automated, auditable assignment');
  await call('owner', 'PUT', '/automation/config', { settings: { auto_vendor_emergency: false } });

  await call('owner', 'PUT', '/automation/config', { policies: [{ policy_key: 'routine_repair', enabled: false }] });
  const pausedForm = new FormData();
  pausedForm.append('category', 'Appliance');
  pausedForm.append('description', 'V3TEST refrigerator light is out but the appliance is still cooling');
  pausedForm.append('reported_by', 'Paused Policy Resident');
  pausedForm.append('reporter_phone', '904-555-0177');
  const pausedSubmitted = await fetch(BASE + '/intake/' + intakeToken, { method: 'POST', body: pausedForm });
  const pausedRequest = await pausedSubmitted.json();
  const pausedTracked = await processJobsUntil(pausedRequest.tracking_token, state => state.request.playbook === 'routine_repair');
  ok(!pausedTracked.work_order && pausedTracked.request.playbook === 'routine_repair', 'a paused playbook classifies but does not authorize work');
  const pausedExceptions = await call('manager', 'GET', '/exceptions');
  ok(pausedExceptions.data.some(x => x.kind === 'policy_disabled'), 'paused playbook creates one clear review exception');
  await call('owner', 'PUT', '/automation/config', { policies: [{ policy_key: 'routine_repair', enabled: true }] });
  const resumedTracked = await processJobsUntil(pausedRequest.tracking_token, state => !!state.work_order);
  ok(!!resumedTracked.work_order, 're-enabling a playbook reactivates its completed durable request job');

  console.log('\nRESIDENT CONVERSATION & VERIFIED CLOSEOUT');
  const reply = await fetch(BASE + '/track/' + request.tracking_token + '/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'The shutoff is closed and the dog is crated.' })
  });
  ok(reply.status === 200, 'resident can reply without an account');
  const evidence = new FormData();
  evidence.append('body', 'Here is a close-up after shutting off the water.');
  evidence.append('photo', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'follow-up.png');
  const evidenceResponse = await fetch(BASE + '/track/' + request.tracking_token + '/messages', { method: 'POST', body: evidence });
  ok(evidenceResponse.status === 200 && (await evidenceResponse.json()).attachment_url, 'resident can add follow-up photo evidence in the thread');
  const entryPermission = await fetch(BASE + '/track/' + request.tracking_token + '/actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'permission_to_enter', value: false })
  });
  ok(entryPermission.status === 200 && !(await (await fetch(BASE + '/track/' + request.tracking_token)).json()).request.permission_to_enter, 'resident can update permission to enter');
  const exceptions = await call('manager', 'GET', '/exceptions');
  const residentException = exceptions.data.find(x => x.kind === 'resident_reply' && x.source_id === workOrderId);
  ok(!!residentException, 'resident reply appears as a management exception');
  if (residentException) {
    ok((await call('manager', 'PATCH', '/exceptions/' + residentException.id, { action: 'snooze', hours: 1 })).status === 200, 'exception can be snoozed');
    ok((await call('manager', 'PATCH', '/exceptions/' + residentException.id, { action: 'reopen' })).status === 200, 'snoozed exception can be reopened');
  }
  const staffReply = await call('manager', 'POST', '/work-orders/' + workOrderId + '/resident-messages', {
    body: 'Thank you. The technician has the photo and your updated entry instructions.'
  });
  ok(staffReply.status === 200 && (await (await fetch(BASE + '/track/' + request.tracking_token)).json()).messages.some(m => /technician has the photo/i.test(m.body)), 'maintenance team can reply into the resident thread');
  const resolvedReplies = await call('manager', 'GET', '/exceptions?status=resolved');
  ok(residentException && resolvedReplies.data.some(x => x.id === residentException.id), 'staff response resolves the resident-reply exception automatically');
  const confirmed = await fetch(BASE + '/track/' + request.tracking_token + '/actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm_appointment' })
  });
  ok(confirmed.status === 200, 'resident can confirm the appointment from the magic link');
  const closed = await call('manager', 'PATCH', '/work-orders/' + workOrderId, {
    status: 'completed', completion_notes: 'Leak stopped; supply line replaced and area left dry.',
    override: true, override_note: 'Automated integration-test closeout'
  });
  ok(closed.status === 200, 'completion reaches verified closeout with an audited manager override');
  tracked = (await (await fetch(BASE + '/track/' + request.tracking_token)).json());
  ok(tracked.work_order.status === 'completed' && tracked.messages.some(m => /rate|complete/i.test(m.body)), 'completion automatically asks the resident to verify the repair');
  const rated = await fetch(BASE + '/track/' + request.tracking_token + '/actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'satisfied', score: 5 })
  });
  ok(rated.status === 200, 'resident can close the loop with a satisfaction rating');
  const reopenedResponse = await fetch(BASE + '/track/' + request.tracking_token + '/actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reopen', note: 'A small drip returned.' })
  });
  const reopened = await reopenedResponse.json();
  ok(reopenedResponse.status === 200 && reopened.id, 'resident reopening creates a priority callback automatically', reopened);
  const callback = await call('owner', 'GET', '/work-orders/' + reopened.id);
  ok(callback.data.wo.callback_of_id === workOrderId && callback.data.callback_of.id === workOrderId, 'callback is linked to the original repair for accountability');

  console.log('\nAUTOMATION AUDIT, EXCEPTIONS & OWNER VISIBILITY');
  const activity = await call('owner', 'GET', '/automation/activity');
  ok(activity.data.some(e => e.action === 'classified') && activity.data.some(e => e.action === 'callback_created'), 'automation decisions are captured in an audit feed');
  const reversible = activity.data.find(e => e.can_undo);
  ok(!!reversible, 'reversible automated decisions expose an undo action');
  if (reversible) ok((await call('owner', 'POST', '/automation/activity/' + reversible.id + '/undo', {})).status === 200, 'authorized user can undo a reversible decision');
  const scan = await call('manager', 'POST', '/automation/run', { action: 'sla_scan' });
  ok(scan.status === 200 && Number.isInteger(scan.data.exceptions_opened), 'SLA and stale-work scan runs on demand');
  const digest = await call('owner', 'POST', '/automation/run', { action: 'digest' });
  ok(digest.status === 200 && digest.data.zero_touch && Number.isFinite(digest.data.spend), 'weekly owner digest summarizes automation, spend, callbacks, and zero-touch rate');
  const digests = await call('owner', 'GET', '/digests');
  ok(digests.data.some(d => d.id === digest.data.id), 'owner digest is persisted');
  const dashboard = await call('owner', 'GET', '/dashboard');
  ok(dashboard.data.automation && Array.isArray(dashboard.data.exceptions) && Array.isArray(dashboard.data.automated_today), 'dashboard is centered on exceptions and automated actions');
  ok('verified_zero_touch_rate' in dashboard.data.stats, 'verified zero-touch resolution is a first-class KPI');

  console.log('\nCOST CAPTURE & INTEGRATION BRIDGES');
  const receipt = new FormData();
  receipt.append('kind', 'receipt');
  receipt.append('caption', 'V3TEST receipt');
  receipt.append('photo', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'receipt.png');
  const uploaded = await fetch(BASE + '/work-orders/' + reopened.id + '/photos', { method: 'POST', headers: { Cookie: jars.manager }, body: receipt });
  const uploadedPhoto = await uploaded.json();
  ok(uploaded.status === 200 && ['queued', 'not_configured'].includes(uploadedPhoto.analysis_status), 'receipt capture reports deterministic AI-adapter status');
  if (!config.data.delivery.ai) {
    const optionalAi = await call('manager', 'POST', '/photos/' + uploadedPhoto.id + '/analyze', {});
    ok(optionalAi.status === 409, 'receipt analysis degrades safely when no AI key is configured');
  }
  const imported = await call('owner', 'POST', '/integrations/import/properties', {
    csv: 'property_name,address,city,state,zip,unit_label,occupied\nV3 Test House,987 Automation Way,Jacksonville,FL,32201,A,false'
  });
  ok(imported.status === 200 && imported.data.properties_created === 1 && imported.data.units_created === 1, 'CSV bridge imports PMS property and unit data');
  const outboundPrivate = await call('owner', 'POST', '/integrations/webhooks', { name: 'Unsafe test', direction: 'outbound', url: 'http://127.0.0.1/hook' });
  ok(outboundPrivate.status === 400, 'outbound webhooks reject private-network destinations');
  const outboundIpv6 = await call('owner', 'POST', '/integrations/webhooks', { name: 'Unsafe IPv6 test', direction: 'outbound', url: 'http://[::1]/hook' });
  ok(outboundIpv6.status === 400, 'outbound webhooks reject private IPv6 destinations');
  const inbound = await call('owner', 'POST', '/integrations/webhooks', { name: 'PMS Sandbox', direction: 'inbound' });
  ok(inbound.status === 200 && inbound.data.inbound_token, 'token-scoped inbound PMS connector can be created');
  const inboundRequest = await fetch(BASE + '/integrations/inbound/' + inbound.data.inbound_token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      event: 'maintenance_request', property_id: 1, category: 'HVAC', priority: 'high',
      description: 'V3TEST no heat from PMS', reported_by: 'Synced resident'
    })
  });
  const inboundData = await inboundRequest.json();
  ok(inboundRequest.status === 202 && inboundData.tracking_url, 'PMS webhook creates a trackable maintenance request');
  const runs = await call('owner', 'GET', '/integrations');
  ok(runs.data.runs.some(r => r.direction === 'inbound'), 'integration runs are visible and auditable');
  const csvExport = await fetch(BASE + '/integrations/export/work-orders.csv', { headers: { Cookie: jars.owner } });
  const csvText = await csvExport.text();
  ok(csvExport.status === 200 && /text\/csv/.test(csvExport.headers.get('content-type') || '') && csvText.includes('number,property'), 'work-order export is accounting/PMS friendly');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
