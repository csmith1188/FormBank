/**
 * CSV export helpers (no PINs or secrets).
 */

function csvEscape(value) {
    if (value == null) return '';
    const s = String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function rowsToCsv(headers, rows) {
    const lines = [headers.map(csvEscape).join(',')];
    for (const row of rows) {
        lines.push(headers.map((h) => csvEscape(row[h])).join(','));
    }
    return lines.join('\n') + '\n';
}

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

async function exportTransactions(db, { from, to, type, status } = {}) {
    const clauses = [];
    const params = [];
    if (from) {
        clauses.push('created_at >= ?');
        params.push(from);
    }
    if (to) {
        clauses.push('created_at <= ?');
        params.push(to);
    }
    if (type) {
        clauses.push('type = ?');
        params.push(type);
    }
    if (status) {
        clauses.push('status = ?');
        params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await allAsync(db, `
        SELECT id, created_at, type, status, actor_formbar_user_id, counterparty_formbar_user_id,
               related_loan_id, related_check_id, requested_amount, gross_transfer_amount,
               net_amount, tax_amount, fee_amount, principal_component, interest_component,
               formbar_outcome
        FROM financial_transactions
        ${where}
        ORDER BY created_at DESC
        LIMIT 10000
    `, params);
    const headers = [
        'id', 'created_at', 'type', 'status', 'actor_formbar_user_id', 'counterparty_formbar_user_id',
        'related_loan_id', 'related_check_id', 'requested_amount', 'gross_transfer_amount',
        'net_amount', 'tax_amount', 'fee_amount', 'principal_component', 'interest_component',
        'formbar_outcome'
    ];
    return rowsToCsv(headers, rows);
}

async function exportLending(db) {
    const rows = await allAsync(db, `
        SELECT id, borrower_formbar_user_id, principal, interest_rate, amount_owed, amount_paid,
               status, created_at, paid_at
        FROM credit_loans
        WHERE status IN ('active', 'paid')
        ORDER BY created_at DESC
    `);
    return rowsToCsv(
        ['id', 'borrower_formbar_user_id', 'principal', 'interest_rate', 'amount_owed', 'amount_paid', 'status', 'created_at', 'paid_at'],
        rows
    );
}

async function exportChecks(db) {
    const rows = await allAsync(db, `
        SELECT id, sender_formbar_user_id, receiver_formbar_user_id, amount, fee_charged,
               status, created_at, cashed_at, memo
        FROM checks
        ORDER BY created_at DESC
        LIMIT 10000
    `);
    // Truncate memo; never export pin_for_redemption
    const safe = rows.map((r) => ({
        ...r,
        memo: r.memo ? String(r.memo).slice(0, 80) : ''
    }));
    return rowsToCsv(
        ['id', 'sender_formbar_user_id', 'receiver_formbar_user_id', 'amount', 'fee_charged', 'status', 'created_at', 'cashed_at', 'memo'],
        safe
    );
}

async function exportFinancialSummary(db, summary, pnl) {
    const rows = [
        { metric: 'outstanding_principal', value: summary.assets.outstandingPrincipal },
        { metric: 'outstanding_balances', value: summary.assets.outstandingBalances },
        { metric: 'uncashed_obligations', value: summary.liabilities.uncashedObligations },
        { metric: 'interest_collected', value: summary.revenue.interestCollected },
        { metric: 'check_fee_revenue', value: summary.revenue.checkFeeRevenue },
        { metric: 'formbar_taxes', value: summary.expenses.formbarTaxes },
        { metric: 'net_realized_profit', value: summary.cashFlow.netRealizedProfit },
        { metric: 'available_funds', value: summary.assets.availableFundsLabel }
    ];
    if (pnl && pnl.totals) {
        rows.push({ metric: 'pnl_revenue_total', value: pnl.totals.revenue });
        rows.push({ metric: 'pnl_expenses_total', value: pnl.totals.expenses });
    }
    return rowsToCsv(['metric', 'value'], rows);
}

module.exports = {
    exportTransactions,
    exportLending,
    exportChecks,
    exportFinancialSummary,
    rowsToCsv
};
