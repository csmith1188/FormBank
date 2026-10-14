const accounting = require('../accounting');
const { dateFilterSql } = require('./dateRange');

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function getAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || {});
        });
    });
}

async function getCheckAnalytics(db, { from, to } = {}) {
    const dateClause = [];
    const dateParams = [];
    if (from) {
        dateClause.push('created_at >= ?');
        dateParams.push(from);
    }
    if (to) {
        dateClause.push('created_at <= ?');
        dateParams.push(to);
    }
    const where = dateClause.length ? `WHERE ${dateClause.join(' AND ')}` : '';

    const totals = await getAsync(db, `
        SELECT
            COUNT(*) AS total_written,
            COALESCE(SUM(amount), 0) AS total_value,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count,
            COALESCE(SUM(CASE WHEN status = 'uncashed' THEN 1 ELSE 0 END), 0) AS uncashed_count,
            COALESCE(SUM(CASE WHEN status = 'funded_unpaid' THEN 1 ELSE 0 END), 0) AS funded_unpaid_count,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
            COALESCE(SUM(CASE WHEN status IN ('completed', 'uncashed', 'funded_unpaid') THEN fee_charged ELSE 0 END), 0) AS fees_on_funded,
            COALESCE(SUM(CASE WHEN status = 'uncashed' OR status = 'funded_unpaid' THEN amount ELSE 0 END), 0) AS escrow_face
        FROM checks
        ${where}
    `, dateParams);

    const amounts = await allAsync(db, `SELECT amount FROM checks ${where}`, dateParams);
    const amountValues = amounts.map((a) => a.amount);

    const df = dateFilterSql(from, to, 'ft.created_at');
    const ledgerFees = await getAsync(db, `
        SELECT
            COALESCE(SUM(CASE WHEN type = 'check_fee' AND status = 'completed' THEN fee_amount ELSE 0 END), 0) AS fees_earned,
            COALESCE(SUM(CASE WHEN type = 'formbar_tax' AND status = 'completed' AND metadata_json LIKE '%deposit%' THEN tax_amount ELSE 0 END), 0) AS deposit_taxes,
            COALESCE(SUM(CASE WHEN type = 'formbar_tax' AND status = 'completed' AND metadata_json LIKE '%payout%' THEN tax_amount ELSE 0 END), 0) AS payout_taxes,
            COALESCE(SUM(CASE WHEN type = 'check_deposit' AND status = 'completed' THEN 1 ELSE 0 END), 0) AS deposits_completed,
            COALESCE(SUM(CASE WHEN type = 'check_payout' AND status = 'completed' THEN 1 ELSE 0 END), 0) AS payouts_completed,
            COALESCE(SUM(CASE WHEN type = 'check_deposit' AND status = 'completed' THEN gross_transfer_amount ELSE 0 END), 0) AS deposit_gross,
            COALESCE(SUM(CASE WHEN type = 'check_payout' AND status = 'completed' THEN gross_transfer_amount ELSE 0 END), 0) AS payout_gross
        FROM financial_transactions ft
        WHERE 1=1 ${df.sql}
    `, df.params);

    const activity = await allAsync(db, `
        SELECT date(created_at) AS day, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
        FROM checks
        ${where}
        GROUP BY date(created_at)
        ORDER BY day ASC
    `, dateParams);

    const redeemTimes = await allAsync(db, `
        SELECT (julianday(cashed_at) - julianday(created_at)) AS days
        FROM checks
        WHERE status = 'completed' AND cashed_at IS NOT NULL
        ${from ? 'AND created_at >= ?' : ''}
        ${to ? 'AND created_at <= ?' : ''}
    `, dateParams);

    const topWriters = await allAsync(db, `
        SELECT sender_formbar_user_id AS user_id, COUNT(*) AS checks_written,
               COALESCE(SUM(amount), 0) AS total_amount
        FROM checks
        ${where}
        GROUP BY sender_formbar_user_id
        ORDER BY checks_written DESC
        LIMIT 20
    `, dateParams);

    const topRecipients = await allAsync(db, `
        SELECT receiver_formbar_user_id AS user_id, COUNT(*) AS checks_received,
               COALESCE(SUM(amount), 0) AS total_amount
        FROM checks
        WHERE receiver_formbar_user_id IS NOT NULL
        ${from ? 'AND created_at >= ?' : ''}
        ${to ? 'AND created_at <= ?' : ''}
        GROUP BY receiver_formbar_user_id
        ORDER BY checks_received DESC
        LIMIT 20
    `, dateParams);

    const pairs = await allAsync(db, `
        SELECT sender_formbar_user_id AS sender, receiver_formbar_user_id AS receiver, COUNT(*) AS times
        FROM checks
        WHERE receiver_formbar_user_id IS NOT NULL AND status = 'completed'
        ${from ? 'AND created_at >= ?' : ''}
        ${to ? 'AND created_at <= ?' : ''}
        GROUP BY sender_formbar_user_id, receiver_formbar_user_id
        HAVING times > 1
        ORDER BY times DESC
        LIMIT 20
    `, dateParams);

    const uniqueParticipants = await getAsync(db, `
        SELECT COUNT(DISTINCT uid) AS unique_participants FROM (
            SELECT sender_formbar_user_id AS uid FROM checks ${where}
            UNION
            SELECT receiver_formbar_user_id AS uid FROM checks
            WHERE receiver_formbar_user_id IS NOT NULL
            ${from ? 'AND created_at >= ?' : ''}
            ${to ? 'AND created_at <= ?' : ''}
        )
    `, [...dateParams, ...dateParams]);

    const redeemDays = redeemTimes.map((r) => r.days).filter((d) => d != null && !Number.isNaN(d));

    return {
        totalWritten: totals.total_written || 0,
        totalValue: totals.total_value || 0,
        completedCount: totals.completed_count || 0,
        uncashedCount: totals.uncashed_count || 0,
        fundedUnpaidCount: totals.funded_unpaid_count || 0,
        failedCount: totals.failed_count || 0,
        escrowFace: totals.escrow_face || 0,
        avgCheckValue: accounting.average(amountValues),
        medianCheckValue: accounting.median(amountValues),
        feesEarned: ledgerFees.fees_earned || 0,
        depositTaxes: ledgerFees.deposit_taxes || 0,
        payoutTaxes: ledgerFees.payout_taxes || 0,
        depositsCompleted: ledgerFees.deposits_completed || 0,
        payoutsCompleted: ledgerFees.payouts_completed || 0,
        depositGross: ledgerFees.deposit_gross || 0,
        payoutGross: ledgerFees.payout_gross || 0,
        activityOverTime: activity,
        avgDaysToRedeem: accounting.average(redeemDays),
        medianDaysToRedeem: accounting.median(redeemDays),
        topWriters,
        topRecipients,
        repeatPairs: pairs,
        uniqueParticipants: uniqueParticipants.unique_participants || 0
    };
}

module.exports = { getCheckAnalytics };
