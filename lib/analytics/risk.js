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

const DEFAULTS = {
    topN: 10,
    rapidBorrowHours: 24,
    rapidBorrowMin: 2,
    largeTxMultiple: 3,
    failedTxWindowDays: 7,
    failedTxMin: 3,
    staleUncashedDays: 7
};

async function getRiskReport(db, options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    const alerts = [];

    const topBorrowers = await allAsync(db, `
        SELECT borrower_formbar_user_id AS user_id,
               COALESCE(SUM(amount_owed - amount_paid), 0) AS outstanding
        FROM credit_loans
        WHERE status = 'active'
        GROUP BY borrower_formbar_user_id
        ORDER BY outstanding DESC
        LIMIT ?
    `, [cfg.topN]);

    const totalOutstanding = topBorrowers.reduce((s, b) => s + b.outstanding, 0);
    const allOutstanding = await getAsync(db, `
        SELECT COALESCE(SUM(amount_owed - amount_paid), 0) AS total
        FROM credit_loans WHERE status = 'active'
    `);
    const total = allOutstanding.total || 0;
    const top5 = topBorrowers.slice(0, 5);
    const top5Sum = top5.reduce((s, b) => s + b.outstanding, 0);
    const concentration = total > 0 ? top5Sum / total : 0;

    alerts.push({
        kind: 'debt_concentration',
        severity: concentration >= 0.5 ? 'needs_reconciliation' : 'informational',
        message: `Top 5 borrowers hold ${(concentration * 100).toFixed(1)}% of outstanding debt`,
        concentration,
        topBorrowers
    });

    const aging = await allAsync(db, `
        SELECT id AS loan_id, borrower_formbar_user_id AS user_id,
               amount_owed - amount_paid AS outstanding,
               CAST((julianday('now') - julianday(created_at)) AS INTEGER) AS age_days
        FROM credit_loans
        WHERE status = 'active'
          AND (julianday('now') - julianday(created_at)) > 30
        ORDER BY age_days DESC
        LIMIT 50
    `);
    if (aging.length) {
        alerts.push({
            kind: 'aging_loans',
            severity: 'informational',
            message: `${aging.length} active loan(s) older than 30 days (age only — not overdue)`,
            loans: aging
        });
    }

    const rapid = await allAsync(db, `
        SELECT counterparty_formbar_user_id AS user_id, COUNT(*) AS issues
        FROM financial_transactions
        WHERE type = 'loan_issue' AND status = 'completed'
          AND created_at >= datetime('now', ?)
        GROUP BY counterparty_formbar_user_id
        HAVING issues >= ?
    `, [`-${cfg.rapidBorrowHours} hours`, cfg.rapidBorrowMin]);
    for (const r of rapid) {
        alerts.push({
            kind: 'rapid_borrowing',
            severity: 'informational',
            message: `User #${r.user_id} issued ${r.issues} loans in ${cfg.rapidBorrowHours}h`,
            userId: r.user_id,
            issues: r.issues
        });
    }

    const avgGross = await getAsync(db, `
        SELECT AVG(gross_transfer_amount) AS avg_gross
        FROM financial_transactions
        WHERE status = 'completed' AND gross_transfer_amount > 0
    `);
    const threshold = Math.max(1000, Math.floor((avgGross.avg_gross || 0) * cfg.largeTxMultiple));
    const large = await allAsync(db, `
        SELECT id, type, actor_formbar_user_id, gross_transfer_amount, created_at
        FROM financial_transactions
        WHERE status = 'completed' AND gross_transfer_amount >= ?
        ORDER BY gross_transfer_amount DESC
        LIMIT 20
    `, [threshold]);
    if (large.length) {
        alerts.push({
            kind: 'large_transactions',
            severity: 'informational',
            message: `${large.length} transaction(s) >= ${threshold} digipogs`,
            threshold,
            transactions: large
        });
    }

    const repeatedFails = await allAsync(db, `
        SELECT actor_formbar_user_id AS user_id, COUNT(*) AS fails
        FROM financial_transactions
        WHERE status = 'failed'
          AND actor_formbar_user_id IS NOT NULL
          AND created_at >= datetime('now', ?)
        GROUP BY actor_formbar_user_id
        HAVING fails >= ?
    `, [`-${cfg.failedTxWindowDays} days`, cfg.failedTxMin]);
    for (const r of repeatedFails) {
        alerts.push({
            kind: 'repeated_failures',
            severity: 'informational',
            message: `User #${r.user_id} has ${r.fails} failed transactions in ${cfg.failedTxWindowDays}d`,
            userId: r.user_id,
            fails: r.fails
        });
    }

    const stale = await allAsync(db, `
        SELECT id AS check_id, amount, sender_formbar_user_id, created_at,
               CAST((julianday('now') - julianday(created_at)) AS INTEGER) AS age_days
        FROM checks
        WHERE status = 'uncashed'
          AND (julianday('now') - julianday(created_at)) >= ?
        ORDER BY age_days DESC
        LIMIT 50
    `, [cfg.staleUncashedDays]);
    if (stale.length) {
        alerts.push({
            kind: 'stale_uncashed',
            severity: 'informational',
            message: `${stale.length} uncashed check(s) held >= ${cfg.staleUncashedDays} days`,
            checks: stale
        });
    }

    const fundedUnpaid = await allAsync(db, `
        SELECT id AS check_id, amount, status, sender_formbar_user_id, receiver_formbar_user_id, created_at
        FROM checks
        WHERE status = 'funded_unpaid'
        ORDER BY created_at DESC
        LIMIT 50
    `);
    if (fundedUnpaid.length) {
        alerts.push({
            kind: 'deposit_without_payout',
            severity: 'needs_reconciliation',
            message: `${fundedUnpaid.length} check(s) funded without confirmed payout`,
            checks: fundedUnpaid
        });
    }

    const unknown = await allAsync(db, `
        SELECT id, type, status, formbar_outcome, related_loan_id, related_check_id, created_at, error_message
        FROM financial_transactions
        WHERE status = 'reconciliation_required'
           OR formbar_outcome IN ('timeout', 'unknown')
        ORDER BY created_at DESC
        LIMIT 50
    `);
    if (unknown.length) {
        alerts.push({
            kind: 'unknown_outcomes',
            severity: 'needs_reconciliation',
            message: `${unknown.length} transfer(s) with unknown or timeout outcomes`,
            transactions: unknown
        });
    }

    alerts.push({
        kind: 'formbar_balance_discrepancy',
        severity: 'informational',
        message: 'Cannot compare FormBank records to Formbar balances — balance API unavailable'
    });

    return {
        topOutstandingBorrowers: topBorrowers,
        debtConcentrationTop5: concentration,
        totalOutstanding: total,
        alerts,
        needsReconciliation: alerts.filter((a) => a.severity === 'needs_reconciliation').length,
        informational: alerts.filter((a) => a.severity === 'informational').length
    };
}

module.exports = { getRiskReport, DEFAULTS };
