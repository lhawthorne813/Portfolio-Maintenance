// insights.js — Property Health, repeat-repair detection, technician scorecards, CapEx forecast.
// Every score is explainable: each deduction returns a human-readable reason.
const db = require('./db');

const OPEN_STATUSES = "('new','assigned','scheduled','in_progress','waiting_parts','waiting_approval')";

function repeatRepairs() {
  // Same property + category with 3+ completed/open work orders in past 180 days
  const rows = db.prepare(`
    SELECT w.property_id, p.name AS property, p.address, w.category,
           COUNT(*) AS count,
           COALESCE((SELECT SUM(e.amount) FROM expenses e
                     WHERE e.work_order_id IN (
                       SELECT id FROM work_orders w2 WHERE w2.property_id=w.property_id AND w2.category=w.category
                       AND w2.created_at >= datetime('now','-180 days'))),0) AS total_spent
    FROM work_orders w JOIN properties p ON p.id=w.property_id
    WHERE w.created_at >= datetime('now','-180 days') AND w.status != 'cancelled'
      AND w.source != 'preventive'
    GROUP BY w.property_id, w.category
    HAVING count >= 3
    ORDER BY count DESC`).all();
  return rows.map(r => ({
    ...r,
    total_spent: +(+r.total_spent).toFixed(2),
    message: `${r.category} has required ${r.count} service calls in the past 6 months.`,
    action: 'Evaluate replacement versus continued repair.'
  }));
}

function assetAgeStatus(a) {
  if (!a.install_date || !a.useful_life_years) return null;
  const ageYears = (Date.now() - new Date(a.install_date).getTime()) / (365.25 * 86400000);
  const pct = ageYears / a.useful_life_years;
  return { ageYears: +ageYears.toFixed(1), pct, remaining: +(a.useful_life_years - ageYears).toFixed(1) };
}

function propertyHealth(propertyId) {
  let score = 100;
  const reasons = [];
  const deduct = (pts, why) => { score -= pts; reasons.push({ points: -pts, reason: why }); };

  const open = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE property_id=? AND status IN ${OPEN_STATUSES}`).get(propertyId).c;
  if (open > 0) deduct(Math.min(open * 3, 12), `${open} open work order${open > 1 ? 's' : ''}`);

  const overdue = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE property_id=? AND status IN ${OPEN_STATUSES}
    AND due_date IS NOT NULL AND due_date < date('now')`).get(propertyId).c;
  if (overdue > 0) deduct(Math.min(overdue * 5, 15), `${overdue} overdue work order${overdue > 1 ? 's' : ''}`);

  const emergencies = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE property_id=? AND priority='emergency'
    AND created_at >= datetime('now','-90 days')`).get(propertyId).c;
  if (emergencies > 0) deduct(emergencies * 6, `${emergencies} emergency repair${emergencies > 1 ? 's' : ''} in the past 90 days`);

  const repeats = repeatRepairs().filter(r => r.property_id === propertyId);
  repeats.forEach(r => deduct(10, `${r.category} has required ${r.count} repairs in 6 months`));

  const pmOverdue = db.prepare(`SELECT COUNT(*) c FROM pm_schedules WHERE property_id=? AND active=1 AND next_due < date('now')`).get(propertyId).c;
  if (pmOverdue > 0) deduct(Math.min(pmOverdue * 4, 12), `${pmOverdue} preventive maintenance item${pmOverdue > 1 ? 's' : ''} overdue`);

  const assets = db.prepare(`SELECT * FROM assets WHERE property_id=?`).all(propertyId);
  for (const a of assets) {
    const st = assetAgeStatus(a);
    if (st && st.pct >= 1) deduct(6, `${a.name} is past its expected useful life`);
    else if (st && st.pct >= 0.85) deduct(3, `${a.name} approaching expected replacement age`);
  }

  // Spending trend: last 90d vs prior 90d
  const cur = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE property_id=? AND incurred_on >= date('now','-90 days')`).get(propertyId).s;
  const prev = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE property_id=? AND incurred_on >= date('now','-180 days') AND incurred_on < date('now','-90 days')`).get(propertyId).s;
  if (prev > 100 && cur > prev * 1.6) deduct(5, `Maintenance spending up ${Math.round(((cur - prev) / prev) * 100)}% vs prior 90 days`);

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons, open, overdue };
}

function techScorecards() {
  const techs = db.prepare(`SELECT id,name,hourly_rate FROM users WHERE role='technician' AND active=1`).all();
  return techs.map(t => {
    const completed = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE assigned_user_id=? AND status='completed'`).get(t.id).c;
    const avgMin = db.prepare(`SELECT AVG(minutes) m FROM time_logs WHERE user_id=? AND minutes IS NOT NULL`).get(t.id).m;
    const assigned = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE assigned_user_id=? AND status IN ${OPEN_STATUSES}`).get(t.id).c;
    const avgCost = db.prepare(`SELECT AVG(tot) a FROM (SELECT w.id, SUM(e.amount) tot FROM work_orders w
      JOIN expenses e ON e.work_order_id=w.id WHERE w.assigned_user_id=? AND w.status='completed' GROUP BY w.id)`).get(t.id).a;
    const onTime = db.prepare(`SELECT
        SUM(CASE WHEN due_date IS NULL OR date(completed_at) <= due_date THEN 1 ELSE 0 END)*1.0/COUNT(*) r
      FROM work_orders WHERE assigned_user_id=? AND status='completed'`).get(t.id).r;
    // First-time fix: completed WOs NOT followed within 30 days by another WO on same property+category
    const rework = db.prepare(`SELECT COUNT(*) c FROM work_orders w1 WHERE w1.assigned_user_id=? AND w1.status='completed'
      AND EXISTS (SELECT 1 FROM work_orders w2 WHERE w2.property_id=w1.property_id AND w2.category=w1.category
        AND w2.id != w1.id AND w2.created_at > w1.completed_at
        AND julianday(w2.created_at) - julianday(w1.completed_at) <= 30)`).get(t.id).c;
    const ftf = completed ? (completed - rework) / completed : null;
    return {
      id: t.id, name: t.name,
      jobs_completed: completed,
      avg_completion_minutes: avgMin ? Math.round(avgMin) : null,
      first_time_fix_rate: ftf === null ? null : +(ftf * 100).toFixed(0),
      repeat_repair_rate: completed ? +((rework / completed) * 100).toFixed(0) : null,
      avg_cost_per_wo: avgCost ? +avgCost.toFixed(2) : null,
      on_time_pct: onTime === null ? null : +(onTime * 100).toFixed(0),
      currently_assigned: assigned
    };
  });
}

function capexForecast(months = 24) {
  const assets = db.prepare(`SELECT a.*, p.name AS property, p.address FROM assets a JOIN properties p ON p.id=a.property_id
    WHERE a.install_date IS NOT NULL AND a.useful_life_years IS NOT NULL`).all();
  const items = [];
  for (const a of assets) {
    const st = assetAgeStatus(a);
    if (!st) continue;
    const monthsRemaining = st.remaining * 12;
    if (monthsRemaining <= months) {
      items.push({
        id: a.id, property: a.property, address: a.address, category: a.category, name: a.name,
        age_years: st.ageYears, useful_life_years: a.useful_life_years,
        months_remaining: Math.max(0, Math.round(monthsRemaining)),
        est_replacement_cost: a.replacement_cost || null,
        overdue: st.pct >= 1
      });
    }
  }
  items.sort((x, y) => x.months_remaining - y.months_remaining);
  const total = items.reduce((s, i) => s + (i.est_replacement_cost || 0), 0);
  const byCat = {};
  items.forEach(i => { byCat[i.category] = (byCat[i.category] || 0) + 1; });
  return { window_months: months, items, estimated_total: +total.toFixed(2), by_category: byCat,
    disclaimer: 'Projections are estimates based on asset age and typical useful life. Actual timing and cost will vary.' };
}

module.exports = { repeatRepairs, propertyHealth, techScorecards, capexForecast, assetAgeStatus, OPEN_STATUSES };
