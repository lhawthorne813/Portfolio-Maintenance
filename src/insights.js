// insights.js — V2: all functions org-scoped. Every score/recommendation is explainable.
const db = require('./db');

const OPEN_STATUSES = "('new','assigned','scheduled','in_progress','waiting_parts','waiting_approval','waiting_vendor')";

/* ---------- Repeat repairs: property+category AND unit-level patterns ---------- */
function repeatRepairs(orgId) {
  const propLevel = db.prepare(`
    SELECT w.property_id, NULL AS unit_id, p.name AS property, p.address, w.category,
           COUNT(*) AS count, MIN(w.created_at) AS first_seen
    FROM work_orders w JOIN properties p ON p.id=w.property_id
    WHERE w.organization_id=? AND w.created_at >= datetime('now','-180 days')
      AND w.status != 'cancelled' AND w.source != 'preventive'
    GROUP BY w.property_id, w.category HAVING count >= 3`).all(orgId);
  const unitLevel = db.prepare(`
    SELECT w.property_id, w.unit_id, p.name AS property, p.address, u.label AS unit_label, w.category,
           COUNT(*) AS count, MIN(w.created_at) AS first_seen
    FROM work_orders w JOIN properties p ON p.id=w.property_id JOIN units u ON u.id=w.unit_id
    WHERE w.organization_id=? AND w.unit_id IS NOT NULL AND w.created_at >= datetime('now','-90 days')
      AND w.status != 'cancelled' AND w.source != 'preventive'
    GROUP BY w.unit_id, w.category HAVING count >= 3`).all(orgId);
  const spend = db.prepare(`SELECT COALESCE(SUM(e.amount),0) s FROM expenses e
    WHERE e.organization_id=? AND e.work_order_id IN (
      SELECT id FROM work_orders WHERE property_id=? AND category=? AND created_at >= datetime('now','-180 days'))`);
  const seenUnits = new Set(unitLevel.map(r => r.property_id + '|' + r.category));
  const rows = [...unitLevel, ...propLevel.filter(r => !seenUnits.has(r.property_id + '|' + r.category))];
  return rows.map(r => ({
    ...r,
    total_spent: +spend.get(orgId, r.property_id, r.category).s.toFixed(2),
    window: r.unit_id ? '90 days' : '6 months',
    message: r.unit_id
      ? `Unit ${r.unit_label}: ${r.category} has generated ${r.count} work orders in 90 days.`
      : `${r.category} has required ${r.count} service calls in the past 6 months.`,
    action: 'Evaluate replacement versus continued repair.'
  })).sort((a, b) => b.count - a.count);
}

function assetAgeStatus(a) {
  if (!a.install_date || !a.useful_life_years) return null;
  const ageYears = (Date.now() - new Date(a.install_date).getTime()) / (365.25 * 86400000);
  return { ageYears: +ageYears.toFixed(1), pct: ageYears / a.useful_life_years,
    remaining: +(a.useful_life_years - ageYears).toFixed(1) };
}

/* ---------- Repair vs Replace: rules-based, transparent, dismissible ---------- */
function repairVsReplace(orgId) {
  const assets = db.prepare(`SELECT a.*, p.name AS property, p.address FROM assets a
    JOIN properties p ON p.id=a.property_id WHERE a.organization_id=?`).all(orgId);
  const out = [];
  for (const a of assets) {
    const dismissed = db.prepare(`SELECT 1 FROM rvr_actions WHERE asset_id=? AND action IN ('dismissed','marked_replacement')
      AND created_at >= datetime('now','-90 days') ORDER BY created_at DESC LIMIT 1`).get(a.id);
    const repairs12 = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM((SELECT SUM(amount) FROM expenses e WHERE e.work_order_id=w.id)),0) s
      FROM work_orders w WHERE w.asset_id=? AND w.source != 'preventive' AND w.status != 'cancelled'
      AND w.created_at >= datetime('now','-365 days')`).get(a.id);
    const st = assetAgeStatus(a);
    const reasons = [];
    let score = 0;
    if (st && st.pct >= 1) { score += 3; reasons.push(`Asset is past its expected useful life (${st.ageYears} yrs vs ${a.useful_life_years} yr life).`); }
    else if (st && st.pct >= 0.8) { score += 2; reasons.push(`Asset is approaching expected replacement age (${st.ageYears} of ${a.useful_life_years} yrs).`); }
    if (repairs12.c >= 3) { score += 3; reasons.push(`${repairs12.c} repairs in the last 12 months indicates increasing failure frequency.`); }
    else if (repairs12.c === 2) { score += 1; reasons.push(`2 repairs in the last 12 months.`); }
    if (a.replacement_cost && repairs12.s >= a.replacement_cost * 0.25) {
      score += 2; reasons.push(`12-month repair spending (${'$' + repairs12.s.toLocaleString()}) is ${Math.round((repairs12.s / a.replacement_cost) * 100)}% of estimated replacement cost.`);
    }
    if (a.warranty_expires && a.warranty_expires < new Date().toISOString().slice(0, 10)) reasons.push('Warranty has expired.');
    if (score >= 4 && !dismissed) {
      out.push({
        asset_id: a.id, property_id: a.property_id, property: a.property,
        name: a.name, category: a.category, manufacturer: a.manufacturer, model: a.model,
        age_years: st ? st.ageYears : null, useful_life_years: a.useful_life_years,
        repairs_12mo: repairs12.c, spend_12mo: +repairs12.s.toFixed(2),
        est_replacement_cost: a.replacement_cost || null,
        warranty_expired: a.warranty_expires ? a.warranty_expires < new Date().toISOString().slice(0, 10) : null,
        reasons,
        headline: 'Replacement review recommended',
        disclaimer: 'Rules-based estimate from asset age and repair history — not a certainty. Verify with an on-site evaluation.'
      });
    }
  }
  return out.sort((a, b) => b.spend_12mo - a.spend_12mo);
}

/* ---------- Cost anomalies: property vs portfolio average (per-unit, trailing 12mo) ---------- */
function costAnomalies(orgId) {
  const rows = db.prepare(`SELECT p.id, p.name, p.address,
      (SELECT COUNT(*) FROM units u WHERE u.property_id=p.id) unit_count,
      (SELECT COALESCE(SUM(amount),0) FROM expenses e WHERE e.property_id=p.id
        AND e.incurred_on >= date('now','-365 days')) spend12
    FROM properties p WHERE p.organization_id=? AND p.active=1`).all(orgId)
    .map(r => ({ ...r, per_unit: r.unit_count ? r.spend12 / r.unit_count : 0 }));
  const withSpend = rows.filter(r => r.unit_count > 0);
  if (withSpend.length < 3) return [];
  const avg = withSpend.reduce((s, r) => s + r.per_unit, 0) / withSpend.length;
  if (avg <= 0) return [];
  return withSpend.filter(r => r.per_unit >= avg * 1.8 && r.spend12 > 500)
    .map(r => ({
      property_id: r.id, property: r.name, address: r.address,
      spend_12mo: +r.spend12.toFixed(2), per_unit: +r.per_unit.toFixed(2),
      portfolio_avg_per_unit: +avg.toFixed(2),
      multiple: +(r.per_unit / avg).toFixed(1),
      message: `Trailing 12-month maintenance is ${(r.per_unit / avg).toFixed(1)}× the portfolio per-unit average.`
    }))
    .sort((a, b) => b.multiple - a.multiple);
}

/* ---------- Property health (secondary in V2, still explainable) ---------- */
function propertyHealth(orgId, propertyId) {
  let score = 100; const reasons = [];
  const deduct = (pts, why) => { score -= pts; reasons.push({ points: -pts, reason: why }); };
  const P = [orgId, propertyId];
  const open = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND property_id=? AND status IN ${OPEN_STATUSES}`).get(...P).c;
  if (open) deduct(Math.min(open * 3, 12), `${open} open work order${open > 1 ? 's' : ''}`);
  const overdue = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND property_id=? AND status IN ${OPEN_STATUSES} AND due_date < date('now')`).get(...P).c;
  if (overdue) deduct(Math.min(overdue * 5, 15), `${overdue} overdue work order${overdue > 1 ? 's' : ''}`);
  const emergencies = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND property_id=? AND priority='emergency' AND created_at >= datetime('now','-90 days')`).get(...P).c;
  if (emergencies) deduct(emergencies * 6, `${emergencies} emergency repair${emergencies > 1 ? 's' : ''} in the past 90 days`);
  repeatRepairs(orgId).filter(r => r.property_id === propertyId)
    .forEach(r => deduct(10, r.message));
  const pmOver = db.prepare(`SELECT COUNT(*) c FROM pm_schedules WHERE organization_id=? AND property_id=? AND active=1 AND next_due < date('now')`).get(...P).c;
  if (pmOver) deduct(Math.min(pmOver * 4, 12), `${pmOver} preventive maintenance item${pmOver > 1 ? 's' : ''} overdue`);
  for (const a of db.prepare(`SELECT * FROM assets WHERE organization_id=? AND property_id=?`).all(...P)) {
    const st = assetAgeStatus(a);
    if (st && st.pct >= 1) deduct(6, `${a.name} is past its expected useful life`);
    else if (st && st.pct >= 0.85) deduct(3, `${a.name} approaching expected replacement age`);
  }
  const cur = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE organization_id=? AND property_id=? AND incurred_on >= date('now','-90 days')`).get(...P).s;
  const prev = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE organization_id=? AND property_id=? AND incurred_on >= date('now','-180 days') AND incurred_on < date('now','-90 days')`).get(...P).s;
  if (prev > 100 && cur > prev * 1.6) deduct(5, `Maintenance spending up ${Math.round(((cur - prev) / prev) * 100)}% vs prior 90 days`);
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, open, overdue };
}

/* ---------- Technician scorecards ---------- */
function techScorecards(orgId) {
  const techs = db.prepare(`SELECT id,name,active FROM users WHERE organization_id=? AND role='technician'`).all(orgId);
  return techs.map(t => {
    const completed = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND assigned_user_id=? AND status='completed'`).get(orgId, t.id).c;
    const avgMin = db.prepare(`SELECT AVG(minutes) m FROM time_logs WHERE user_id=? AND kind='work' AND minutes IS NOT NULL`).get(t.id).m;
    const assigned = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND assigned_user_id=? AND status IN ${OPEN_STATUSES}`).get(orgId, t.id).c;
    const avgCost = db.prepare(`SELECT AVG(tot) a FROM (SELECT w.id, SUM(e.amount) tot FROM work_orders w
      JOIN expenses e ON e.work_order_id=w.id WHERE w.organization_id=? AND w.assigned_user_id=? AND w.status='completed' GROUP BY w.id)`).get(orgId, t.id).a;
    const onTime = db.prepare(`SELECT SUM(CASE WHEN due_date IS NULL OR date(completed_at) <= due_date THEN 1 ELSE 0 END)*1.0/COUNT(*) r
      FROM work_orders WHERE organization_id=? AND assigned_user_id=? AND status='completed'`).get(orgId, t.id).r;
    const rework = db.prepare(`SELECT COUNT(*) c FROM work_orders w1 WHERE w1.organization_id=? AND w1.assigned_user_id=? AND w1.status='completed'
      AND EXISTS (SELECT 1 FROM work_orders w2 WHERE w2.property_id=w1.property_id AND w2.category=w1.category
        AND w2.id != w1.id AND w2.created_at > w1.completed_at
        AND julianday(w2.created_at) - julianday(w1.completed_at) <= 30)`).get(orgId, t.id).c;
    return {
      id: t.id, name: t.name, active: t.active,
      jobs_completed: completed,
      avg_completion_minutes: avgMin ? Math.round(avgMin) : null,
      first_time_fix_rate: completed ? Math.round(((completed - rework) / completed) * 100) : null,
      repeat_repair_rate: completed ? Math.round((rework / completed) * 100) : null,
      avg_cost_per_wo: avgCost ? +avgCost.toFixed(2) : null,
      on_time_pct: onTime == null ? null : Math.round(onTime * 100),
      currently_assigned: assigned
    };
  });
}

/* ---------- Vendor performance ---------- */
function vendorMetrics(orgId, vendorId) {
  const total = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND assigned_vendor_id=?`).get(orgId, vendorId).c;
  const completed = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE organization_id=? AND assigned_vendor_id=? AND status='completed'`).get(orgId, vendorId).c;
  const avgDays = db.prepare(`SELECT AVG(julianday(completed_at)-julianday(created_at)) d FROM work_orders
    WHERE organization_id=? AND assigned_vendor_id=? AND status='completed'`).get(orgId, vendorId).d;
  const callbacks = db.prepare(`SELECT COUNT(*) c FROM work_orders w1 WHERE w1.organization_id=? AND w1.assigned_vendor_id=? AND w1.status='completed'
    AND EXISTS (SELECT 1 FROM work_orders w2 WHERE w2.property_id=w1.property_id AND w2.category=w1.category
      AND w2.id != w1.id AND w2.created_at > w1.completed_at
      AND julianday(w2.created_at) - julianday(w1.completed_at) <= 30)`).get(orgId, vendorId).c;
  const spend = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE organization_id=? AND vendor_id=?`).get(orgId, vendorId).s;
  return {
    total_jobs: total, completed_jobs: completed,
    avg_completion_days: avgDays ? +avgDays.toFixed(1) : null,
    callback_rate: completed ? Math.round((callbacks / completed) * 100) : null,
    total_spend: +spend.toFixed(2)
  };
}

/* ---------- CapEx with horizons + data-quality confidence ---------- */
function capexForecast(orgId, months = 24) {
  const assets = db.prepare(`SELECT a.*, p.name AS property, p.address FROM assets a JOIN properties p ON p.id=a.property_id
    WHERE a.organization_id=? AND a.install_date IS NOT NULL AND a.useful_life_years IS NOT NULL`).all(orgId);
  const items = [];
  for (const a of assets) {
    const st = assetAgeStatus(a);
    if (!st) continue;
    const mRem = st.remaining * 12;
    if (mRem <= months) {
      let confidence = 'high';
      if (!a.replacement_cost) confidence = 'low';
      else if (!a.manufacturer || !a.model) confidence = 'medium';
      items.push({
        id: a.id, property_id: a.property_id, property: a.property, category: a.category, name: a.name,
        age_years: st.ageYears, useful_life_years: a.useful_life_years,
        months_remaining: Math.max(0, Math.round(mRem)),
        est_replacement_cost: a.replacement_cost || null,
        overdue: st.pct >= 1, confidence
      });
    }
  }
  items.sort((x, y) => x.months_remaining - y.months_remaining);
  const byCat = {};
  items.forEach(i => { byCat[i.category] = (byCat[i.category] || 0) + 1; });
  return {
    window_months: months, items,
    estimated_total: +items.reduce((s, i) => s + (i.est_replacement_cost || 0), 0).toFixed(2),
    by_category: byCat,
    properties_affected: [...new Set(items.map(i => i.property))].length,
    disclaimer: 'Projections are estimates based on asset age and typical useful life. Actual timing and cost will vary.'
  };
}

/* ---------- PM compliance (for property comparison) ---------- */
function pmCompliance(orgId, propertyId) {
  const total = db.prepare(`SELECT COUNT(*) c FROM pm_schedules WHERE organization_id=? AND property_id=? AND active=1`).get(orgId, propertyId).c;
  if (!total) return null;
  const onTrack = db.prepare(`SELECT COUNT(*) c FROM pm_schedules WHERE organization_id=? AND property_id=? AND active=1 AND next_due >= date('now')`).get(orgId, propertyId).c;
  return Math.round((onTrack / total) * 100);
}

module.exports = { repeatRepairs, propertyHealth, techScorecards, capexForecast, assetAgeStatus,
  repairVsReplace, costAnomalies, vendorMetrics, pmCompliance, OPEN_STATUSES };
