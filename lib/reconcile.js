/**
 * Reconciliation detectors for unresolved FormBank financial state.
 */

const STUCK_PENDING_MINUTES = 15;

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

/**
 * @returns {Promise<{alerts: object[], needsReconciliation: number, informational: number}>}
 */
async function getReconciliationReport(db) {
    const alerts = [];

    const unresolved = await allAsync(db, `
        SELECT id, type, status, formbar_outcome, related_loan_id, related_check_id,
               actor_formbar_user_id, requested_amount, gross_transfer_amount,
               error_message, created_at, updated_at, idempotency_key
        FROM financial_transactions
        WHERE status IN ('reconciliation_required', 'pending')
        ORDER BY created_at DESC
        LIMIT 200
    `);

    const pendingCutoff = new Date(Date.now() - STUCK_PENDING_MINUTES * 60 * 1000).toISOString();

    for (const row of unresolved) {
        const stuckPending = row.status === 'pending' && row.created_at < pendingCutoff;
        const severity = row.status === 'reconciliation_required' || stuckPending
            ? 'needs_reconciliation'
            : 'informational';
        alerts.push({
            kind: row.status === 'pending' ? (stuckPending ? 'stuck_pending' : 'pending') : 'reconciliation_required',
            severity,
            message: row.error_message || `Ledger ${row.type} is ${row.status}`,
            transaction: row
        });
    }

    const depositWithoutPayout = await allAsync(db, `
        SELECT c.id AS check_id, c.amount, c.status, c.sender_formbar_user_id,
               c.receiver_formbar_user_id, c.created_at
        FROM checks c
        WHERE c.status IN ('uncashed', 'funded_unpaid')
           OR (
                c.status = 'failed'
                AND EXISTS (
                    SELECT 1 FROM financial_transactions ft
                    WHERE ft.related_check_id = c.id
                      AND ft.type = 'check_deposit'
                      AND ft.status = 'completed'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM financial_transactions ft2
                    WHERE ft2.related_check_id = c.id
                      AND ft2.type = 'check_payout'
                      AND ft2.status = 'completed'
                )
           )
        ORDER BY c.created_at DESC
        LIMIT 100
    `);

    for (const c of depositWithoutPayout) {
        alerts.push({
            kind: 'deposit_without_payout',
            severity: c.status === 'funded_unpaid' || c.status === 'failed'
                ? 'needs_reconciliation'
                : 'informational',
            message: `Check #${c.check_id} has funded deposit without completed payout (status=${c.status})`,
            check: c
        });
    }

    const loanMismatches = await allAsync(db, `
        SELECT l.id AS loan_id, l.borrower_formbar_user_id, l.principal, l.status AS loan_status
        FROM credit_loans l
        WHERE l.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM financial_transactions ft
            WHERE ft.related_loan_id = l.id
              AND ft.type = 'loan_issue'
              AND ft.status = 'completed'
          )
        LIMIT 50
    `);

    for (const l of loanMismatches) {
        alerts.push({
            kind: 'loan_without_issue_ledger',
            severity: 'needs_reconciliation',
            message: `Active loan #${l.loan_id} has no completed loan_issue ledger entry`,
            loan: l
        });
    }

    const ambiguousFailed = await allAsync(db, `
        SELECT id, related_check_id, created_at, metadata_json
        FROM financial_transactions
        WHERE type = 'check_deposit'
          AND status = 'failed'
          AND metadata_json LIKE '%ambiguous_failed_check%'
        ORDER BY created_at DESC
        LIMIT 50
    `);

    for (const row of ambiguousFailed) {
        alerts.push({
            kind: 'ambiguous_failed_check',
            severity: 'informational',
            message: `Historical failed check #${row.related_check_id} — deposit outcome unknown`,
            transaction: row
        });
    }

    alerts.push({
        kind: 'formbar_balance_unverified',
        severity: 'informational',
        message: 'Formbar digipog balance API unavailable — vault funds cannot be verified automatically'
    });

    const needsReconciliation = alerts.filter((a) => a.severity === 'needs_reconciliation').length;
    const informational = alerts.filter((a) => a.severity === 'informational').length;

    return { alerts, needsReconciliation, informational };
}

module.exports = {
    getReconciliationReport,
    STUCK_PENDING_MINUTES
};
