const { dateFilterSql } = require('./dateRange');

function getAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || {});
        });
    });
}

/**
 * Financial position + period cash-flow summary cards.
 */
async function getSummary(db, { from, to } = {}) {
    const outstanding = await getAsync(db, `
        SELECT
            COALESCE(SUM(CASE WHEN amount_paid < principal THEN principal - amount_paid ELSE 0 END), 0) AS outstanding_principal,
            COALESCE(SUM(amount_owed - amount_paid), 0) AS outstanding_balances,
            COUNT(*) AS active_loan_count
        FROM credit_loans
        WHERE status = 'active'
    `);

    const escrow = await getAsync(db, `
        SELECT
            COALESCE(SUM(amount), 0) AS uncashed_face,
            COUNT(*) AS uncashed_count
        FROM checks
        WHERE status IN ('uncashed', 'funded_unpaid')
    `);

    const lifetimeLoans = await getAsync(db, `
        SELECT
            COUNT(*) AS loans_issued,
            COALESCE(SUM(principal), 0) AS principal_loaned,
            COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END), 0) AS loans_repaid,
            COALESCE(SUM(CASE WHEN amount_paid > principal THEN amount_paid - principal ELSE 0 END), 0) AS interest_collected_lifetime
        FROM credit_loans
        WHERE status IN ('active', 'paid')
    `);

    const df = dateFilterSql(from, to, 'ft.created_at');

    const period = await getAsync(db, `
        SELECT
            COALESCE(SUM(CASE WHEN type = 'loan_issue' AND status = 'completed' THEN gross_transfer_amount ELSE 0 END), 0) AS loans_issued_amount,
            COALESCE(SUM(CASE WHEN type = 'loan_issue' AND status = 'completed' THEN 1 ELSE 0 END), 0) AS loans_issued_count,
            COALESCE(SUM(CASE WHEN type = 'loan_repay' AND status = 'completed' THEN gross_transfer_amount ELSE 0 END), 0) AS repayments_amount,
            COALESCE(SUM(CASE WHEN type = 'loan_repay' AND status = 'completed' THEN 1 ELSE 0 END), 0) AS repayments_count,
            COALESCE(SUM(CASE WHEN type = 'loan_repay' AND status = 'completed' THEN interest_component ELSE 0 END), 0) AS interest_collected,
            COALESCE(SUM(CASE WHEN type = 'check_fee' AND status = 'completed' THEN fee_amount ELSE 0 END), 0) AS check_fee_revenue,
            COALESCE(SUM(CASE WHEN type = 'formbar_tax' AND status = 'completed' THEN tax_amount ELSE 0 END), 0) AS formbar_taxes,
            COALESCE(SUM(CASE WHEN type = 'adjustment' AND status = 'completed' AND fee_amount > 0 THEN fee_amount ELSE 0 END), 0) AS other_revenue,
            COALESCE(SUM(CASE WHEN type = 'adjustment' AND status = 'completed' AND tax_amount > 0 THEN tax_amount ELSE 0 END), 0) AS other_expenses
        FROM financial_transactions ft
        WHERE 1=1 ${df.sql}
    `, df.params);

    const activeUsers = await getAsync(db, `
        SELECT
            COUNT(DISTINCT CASE WHEN type IN ('loan_issue', 'loan_repay') THEN
                CASE WHEN type = 'loan_issue' THEN counterparty_formbar_user_id ELSE actor_formbar_user_id END
            END) AS active_borrowers,
            COUNT(DISTINCT CASE WHEN type = 'check_deposit' AND status = 'completed' THEN actor_formbar_user_id END) AS active_check_writers,
            COUNT(DISTINCT CASE WHEN type = 'check_payout' AND status = 'completed' THEN counterparty_formbar_user_id END) AS active_check_recipients
        FROM financial_transactions ft
        WHERE status IN ('completed', 'pending', 'reconciliation_required') ${df.sql}
    `, df.params);

    const unresolved = await getAsync(db, `
        SELECT COUNT(*) AS unresolved_count,
               COALESCE(SUM(gross_transfer_amount), 0) AS unresolved_notional
        FROM financial_transactions
        WHERE status IN ('reconciliation_required', 'pending')
    `);

    const revenue = (period.interest_collected || 0) + (period.check_fee_revenue || 0) + (period.other_revenue || 0);
    const expenses = (period.formbar_taxes || 0) + (period.other_expenses || 0);

    return {
        assets: {
            outstandingPrincipal: outstanding.outstanding_principal || 0,
            outstandingBalances: outstanding.outstanding_balances || 0,
            activeLoanCount: outstanding.active_loan_count || 0,
            availableFunds: null,
            availableFundsLabel: 'Unverified — Formbar balance API unavailable'
        },
        liabilities: {
            borrowerCreditBalances: 0,
            borrowerCreditBalancesNote: 'FormBank has no per-user overpayment wallet; held funds are check escrow / unresolved legs',
            uncashedObligations: escrow.uncashed_face || 0,
            uncashedCount: escrow.uncashed_count || 0,
            unresolvedNotional: unresolved.unresolved_notional || 0,
            unresolvedCount: unresolved.unresolved_count || 0
        },
        revenue: {
            interestCollected: period.interest_collected || 0,
            checkFeeRevenue: period.check_fee_revenue || 0,
            otherRevenue: period.other_revenue || 0,
            total: revenue
        },
        expenses: {
            formbarTaxes: period.formbar_taxes || 0,
            otherExpenses: period.other_expenses || 0,
            total: expenses
        },
        cashFlow: {
            loansIssuedAmount: period.loans_issued_amount || 0,
            loansIssuedCount: period.loans_issued_count || 0,
            repaymentsAmount: period.repayments_amount || 0,
            repaymentsCount: period.repayments_count || 0,
            netRealizedProfit: revenue - expenses
        },
        lifetime: {
            loansIssued: lifetimeLoans.loans_issued || 0,
            loansRepaid: lifetimeLoans.loans_repaid || 0,
            principalLoaned: lifetimeLoans.principal_loaned || 0,
            interestCollected: lifetimeLoans.interest_collected_lifetime || 0
        },
        activity: {
            activeBorrowers: activeUsers.active_borrowers || 0,
            activeCheckWriters: activeUsers.active_check_writers || 0,
            activeCheckRecipients: activeUsers.active_check_recipients || 0
        }
    };
}

module.exports = { getSummary };
