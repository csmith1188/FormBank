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

async function getLoanAnalytics(db, { from, to } = {}) {
    const totals = await getAsync(db, `
        SELECT
            COUNT(*) AS total_issued,
            COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active_count,
            COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END), 0) AS repaid_count,
            COALESCE(SUM(principal), 0) AS principal_loaned,
            COALESCE(SUM(CASE WHEN amount_paid > principal THEN principal ELSE amount_paid END), 0) AS principal_recovered,
            COALESCE(SUM(CASE WHEN status = 'active' THEN amount_owed - amount_paid ELSE 0 END), 0) AS outstanding_balances,
            COALESCE(SUM(amount_owed - principal), 0) AS interest_charged,
            COALESCE(SUM(CASE WHEN amount_paid > principal THEN amount_paid - principal ELSE 0 END), 0) AS interest_collected
        FROM credit_loans
        WHERE status IN ('active', 'paid')
    `);

    const sizes = await allAsync(db, `
        SELECT principal FROM credit_loans WHERE status IN ('active', 'paid')
    `);
    const principals = sizes.map((r) => r.principal);

    const durations = await allAsync(db, `
        SELECT (julianday(paid_at) - julianday(created_at)) AS days
        FROM credit_loans
        WHERE status = 'paid' AND paid_at IS NOT NULL
    `);
    const durationDays = durations.map((r) => r.days).filter((d) => d != null && !Number.isNaN(d));

    const completionRate = totals.total_issued > 0
        ? totals.repaid_count / totals.total_issued
        : null;

    const df = dateFilterSql(from, to, 'ft.created_at');
    const repayRows = await allAsync(db, `
        SELECT ft.*, l.amount_owed, l.principal
        FROM financial_transactions ft
        LEFT JOIN credit_loans l ON l.id = ft.related_loan_id
        WHERE ft.type = 'loan_repay' AND ft.status = 'completed' ${df.sql}
    `, df.params);

    let partialRepays = 0;
    let fullRepays = 0;
    for (const r of repayRows) {
        if (r.metadata_json && r.metadata_json.includes('legacy_aggregate')) {
            if (r.gross_transfer_amount >= (r.amount_owed || 0)) fullRepays += 1;
            else partialRepays += 1;
        } else if (r.interest_component > 0 && r.principal_component + r.interest_component >= (r.amount_owed || Infinity)) {
            fullRepays += 1;
        } else {
            // Heuristic: full if payment equals remaining wasn't stored; count as partial unless metadata says full
            if (r.metadata_json && r.metadata_json.includes('"full":true')) fullRepays += 1;
            else partialRepays += 1;
        }
    }

    const borrowerCounts = await allAsync(db, `
        SELECT borrower_formbar_user_id, COUNT(*) AS cnt
        FROM credit_loans
        WHERE status IN ('active', 'paid')
        GROUP BY borrower_formbar_user_id
    `);
    const repeatBorrowers = borrowerCounts.filter((b) => b.cnt >= 2).length;
    const uniqueBorrowers = borrowerCounts.length;
    const repeatRate = uniqueBorrowers > 0 ? repeatBorrowers / uniqueBorrowers : null;

    const issuedSeries = await allAsync(db, `
        SELECT date(created_at) AS day, COUNT(*) AS count, COALESCE(SUM(principal), 0) AS amount
        FROM credit_loans
        WHERE status IN ('active', 'paid')
        ${from ? 'AND created_at >= ?' : ''}
        ${to ? 'AND created_at <= ?' : ''}
        GROUP BY date(created_at)
        ORDER BY day ASC
    `, [from, to].filter(Boolean));

    const repaySeries = await allAsync(db, `
        SELECT date(ft.created_at) AS day, COUNT(*) AS count,
               COALESCE(SUM(ft.gross_transfer_amount), 0) AS amount
        FROM financial_transactions ft
        WHERE ft.type = 'loan_repay' AND ft.status = 'completed' ${df.sql}
        GROUP BY date(ft.created_at)
        ORDER BY day ASC
    `, df.params);

    const ageBuckets = await getAsync(db, `
        SELECT
            COALESCE(SUM(CASE WHEN age_days <= 7 THEN 1 ELSE 0 END), 0) AS d0_7,
            COALESCE(SUM(CASE WHEN age_days BETWEEN 8 AND 14 THEN 1 ELSE 0 END), 0) AS d8_14,
            COALESCE(SUM(CASE WHEN age_days BETWEEN 15 AND 30 THEN 1 ELSE 0 END), 0) AS d15_30,
            COALESCE(SUM(CASE WHEN age_days > 30 THEN 1 ELSE 0 END), 0) AS d30_plus
        FROM (
            SELECT CAST((julianday('now') - julianday(created_at)) AS INTEGER) AS age_days
            FROM credit_loans
            WHERE status = 'active'
        )
    `);

    return {
        totalIssued: totals.total_issued || 0,
        activeCount: totals.active_count || 0,
        repaidCount: totals.repaid_count || 0,
        principalLoaned: totals.principal_loaned || 0,
        principalRecovered: totals.principal_recovered || 0,
        outstandingBalances: totals.outstanding_balances || 0,
        interestCharged: totals.interest_charged || 0,
        interestCollected: totals.interest_collected || 0,
        avgLoanSize: accounting.average(principals),
        medianLoanSize: accounting.median(principals),
        avgRepaymentDays: accounting.average(durationDays),
        medianRepaymentDays: accounting.median(durationDays),
        completionRate,
        partialRepayments: partialRepays,
        fullRepayments: fullRepays,
        repeatBorrowingRate: repeatRate,
        uniqueBorrowers,
        repeatBorrowers,
        issuedOverTime: issuedSeries,
        repaymentsOverTime: repaySeries,
        ageDistribution: {
            '0-7': ageBuckets.d0_7 || 0,
            '8-14': ageBuckets.d8_14 || 0,
            '15-30': ageBuckets.d15_30 || 0,
            '30+': ageBuckets.d30_plus || 0
        }
    };
}

module.exports = { getLoanAnalytics };
