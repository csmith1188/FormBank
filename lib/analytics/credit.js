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

async function getCreditAnalytics(db, { from, to, creditLimitStep = 500 } = {}) {
    const limits = await allAsync(db, `
        SELECT borrower_formbar_user_id AS user_id, current_limit, paid_off_count
        FROM credit_limits
        ORDER BY current_limit DESC
    `);
    const limitValues = limits.map((l) => l.current_limit);

    const distribution = {};
    for (const l of limits) {
        const tier = String(l.current_limit);
        distribution[tier] = (distribution[tier] || 0) + 1;
    }

    const df = dateFilterSql(from, to, 'ft.created_at');
    const increases = await getAsync(db, `
        SELECT COUNT(*) AS increase_events,
               COALESCE(SUM(requested_amount), 0) AS total_increase_amount
        FROM financial_transactions ft
        WHERE ft.type = 'credit_limit_change' AND ft.status = 'completed' ${df.sql}
    `, df.params);

    const proxyIncreases = limits.reduce((s, l) => s + (l.paid_off_count || 0), 0);

    const byTier = await allAsync(db, `
        SELECT cl.current_limit AS tier,
               COUNT(DISTINCT cl.borrower_formbar_user_id) AS borrowers,
               COALESCE(SUM(CASE WHEN l.status = 'active' THEN l.amount_owed - l.amount_paid ELSE 0 END), 0) AS outstanding_debt,
               COALESCE(SUM(l.amount_paid), 0) AS total_repaid,
               COALESCE(AVG(CASE WHEN l.status = 'paid' AND l.paid_at IS NOT NULL
                    THEN (julianday(l.paid_at) - julianday(l.created_at)) END), NULL) AS avg_repay_days
        FROM credit_limits cl
        LEFT JOIN credit_loans l ON l.borrower_formbar_user_id = cl.borrower_formbar_user_id
            AND l.status IN ('active', 'paid')
        GROUP BY cl.current_limit
        ORDER BY cl.current_limit ASC
    `);

    const utilization = await allAsync(db, `
        SELECT cl.borrower_formbar_user_id AS user_id,
               cl.current_limit,
               COALESCE(SUM(CASE WHEN l.status = 'active' THEN l.amount_owed - l.amount_paid ELSE 0 END), 0) AS outstanding,
               CASE WHEN cl.current_limit > 0
                    THEN 1.0 * COALESCE(SUM(CASE WHEN l.status = 'active' THEN l.amount_owed - l.amount_paid ELSE 0 END), 0) / cl.current_limit
                    ELSE 0 END AS utilization
        FROM credit_limits cl
        LEFT JOIN credit_loans l ON l.borrower_formbar_user_id = cl.borrower_formbar_user_id
        GROUP BY cl.borrower_formbar_user_id
        ORDER BY utilization DESC
        LIMIT 50
    `);

    return {
        creditLimitStep,
        borrowerCount: limits.length,
        avgCreditLimit: accounting.average(limitValues),
        medianCreditLimit: accounting.median(limitValues),
        highestLimits: limits.slice(0, 10),
        distribution,
        limitIncreaseEvents: increases.increase_events || 0,
        limitIncreaseProxyTotal: proxyIncreases,
        limitIncreaseNote: increases.increase_events
            ? 'From ledger credit_limit_change events in range'
            : 'Pre-ledger increases approximated via paid_off_count',
        byTier,
        utilization
    };
}

async function getBorrowerProfile(db, formbarUserId) {
    const userId = Number(formbarUserId);
    const limit = await getAsync(db,
        'SELECT * FROM credit_limits WHERE borrower_formbar_user_id = ?',
        [userId]
    );
    const loans = await allAsync(db,
        'SELECT * FROM credit_loans WHERE borrower_formbar_user_id = ? ORDER BY created_at DESC',
        [userId]
    );
    const ledger = await allAsync(db, `
        SELECT * FROM financial_transactions
        WHERE actor_formbar_user_id = ? OR counterparty_formbar_user_id = ?
        ORDER BY created_at DESC
        LIMIT 200
    `, [userId, userId]);
    const outstanding = loans
        .filter((l) => l.status === 'active')
        .reduce((s, l) => s + (l.amount_owed - l.amount_paid), 0);
    const totalPaid = loans.reduce((s, l) => s + (l.amount_paid || 0), 0);
    const interestCollected = loans.reduce(
        (s, l) => s + accounting.interestCollectedOnLoan(l.principal, l.amount_paid),
        0
    );

    return {
        userId,
        creditLimit: limit ? limit.current_limit : null,
        paidOffCount: limit ? limit.paid_off_count : 0,
        loans,
        ledger,
        outstanding,
        totalPaid,
        interestCollected,
        utilization: limit && limit.current_limit > 0 ? outstanding / limit.current_limit : 0
    };
}

module.exports = { getCreditAnalytics, getBorrowerProfile };
