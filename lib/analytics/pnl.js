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

/**
 * @param {'day'|'week'|'month'|'lifetime'} granularity
 */
async function getProfitAndLoss(db, { from, to, granularity = 'day' } = {}) {
    const df = dateFilterSql(from, to, 'ft.created_at');

    let bucketExpr = `date(ft.created_at)`;
    if (granularity === 'week') {
        bucketExpr = `strftime('%Y-W%W', ft.created_at)`;
    } else if (granularity === 'month') {
        bucketExpr = `strftime('%Y-%m', ft.created_at)`;
    } else if (granularity === 'lifetime') {
        bucketExpr = `'lifetime'`;
    }

    const series = await allAsync(db, `
        SELECT
            ${bucketExpr} AS period,
            COALESCE(SUM(CASE WHEN type = 'loan_repay' AND status = 'completed' THEN interest_component ELSE 0 END), 0) AS interest_collected,
            COALESCE(SUM(CASE WHEN type = 'check_fee' AND status = 'completed' THEN fee_amount ELSE 0 END), 0) AS check_fees,
            COALESCE(SUM(CASE WHEN type = 'formbar_tax' AND status = 'completed' THEN tax_amount ELSE 0 END), 0) AS formbar_taxes,
            COALESCE(SUM(CASE WHEN type = 'adjustment' AND status = 'completed' AND fee_amount > 0 THEN fee_amount ELSE 0 END), 0) AS other_revenue,
            COALESCE(SUM(CASE WHEN type = 'adjustment' AND status = 'completed' AND tax_amount > 0 THEN tax_amount ELSE 0 END), 0) AS other_expenses
        FROM financial_transactions ft
        WHERE 1=1 ${df.sql}
        GROUP BY period
        ORDER BY period ASC
    `, df.params);

    const rows = series.map((r) => {
        const revenue = (r.interest_collected || 0) + (r.check_fees || 0) + (r.other_revenue || 0);
        const expenses = (r.formbar_taxes || 0) + (r.other_expenses || 0);
        return {
            period: r.period,
            interestCollected: r.interest_collected || 0,
            checkFees: r.check_fees || 0,
            otherRevenue: r.other_revenue || 0,
            formbarTaxes: r.formbar_taxes || 0,
            otherExpenses: r.other_expenses || 0,
            revenue,
            expenses,
            netRealizedProfit: revenue - expenses
        };
    });

    const totals = rows.reduce((acc, r) => {
        acc.interestCollected += r.interestCollected;
        acc.checkFees += r.checkFees;
        acc.otherRevenue += r.otherRevenue;
        acc.formbarTaxes += r.formbarTaxes;
        acc.otherExpenses += r.otherExpenses;
        acc.revenue += r.revenue;
        acc.expenses += r.expenses;
        acc.netRealizedProfit += r.netRealizedProfit;
        return acc;
    }, {
        interestCollected: 0,
        checkFees: 0,
        otherRevenue: 0,
        formbarTaxes: 0,
        otherExpenses: 0,
        revenue: 0,
        expenses: 0,
        netRealizedProfit: 0
    });

    const position = await getAsync(db, `
        SELECT
            (SELECT COALESCE(SUM(amount_owed - amount_paid), 0) FROM credit_loans WHERE status = 'active') AS loan_receivables,
            (SELECT COALESCE(SUM(amount), 0) FROM checks WHERE status IN ('uncashed', 'funded_unpaid')) AS uncashed_obligations,
            (SELECT COUNT(*) FROM financial_transactions WHERE status IN ('pending', 'reconciliation_required')) AS unresolved_count
    `);

    return {
        granularity,
        series: rows,
        totals,
        position: {
            outstandingLoanReceivables: position.loan_receivables || 0,
            borrowerCreditBalanceLiabilities: 0,
            uncashedCheckObligations: position.uncashed_obligations || 0,
            availableFunds: null,
            availableFundsLabel: 'Unverified — Formbar balance API unavailable',
            unresolvedTransactions: position.unresolved_count || 0
        }
    };
}

module.exports = { getProfitAndLoss };
