/**
 * Append-only financial transaction ledger.
 * Status transitions: pending → completed | failed | reconciliation_required
 */

const VALID_TYPES = new Set([
    'loan_issue',
    'loan_repay',
    'check_deposit',
    'check_payout',
    'check_fee',
    'formbar_tax',
    'credit_limit_change',
    'adjustment'
]);

const VALID_STATUSES = new Set([
    'pending',
    'completed',
    'failed',
    'reconciliation_required'
]);

/**
 * @param {import('sqlite3').Database} db
 */
function createLedger(db) {
    function run(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.run(sql, params, function (err) {
                if (err) return reject(err);
                resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    function get(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
            });
        });
    }

    function all(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
    }

    async function findByIdempotencyKey(key) {
        return get('SELECT * FROM financial_transactions WHERE idempotency_key = ?', [key]);
    }

    /**
     * Insert a pending ledger row. Fails if idempotency_key already exists
     * (returns existing row instead of inserting).
     * @param {object} entry
     * @returns {Promise<{id: number, existing: boolean, row?: object}>}
     */
    async function beginPending(entry) {
        if (!entry || !entry.idempotency_key) {
            throw new Error('idempotency_key is required');
        }
        if (!VALID_TYPES.has(entry.type)) {
            throw new Error(`Invalid ledger type: ${entry.type}`);
        }

        const existing = await findByIdempotencyKey(entry.idempotency_key);
        if (existing) {
            return { id: existing.id, existing: true, row: existing };
        }

        const metadataJson = entry.metadata != null
            ? JSON.stringify(entry.metadata)
            : (entry.metadata_json || null);

        const result = await run(
            `INSERT INTO financial_transactions (
                idempotency_key, type, status,
                actor_formbar_user_id, counterparty_formbar_user_id,
                related_loan_id, related_check_id, parent_group_id,
                requested_amount, gross_transfer_amount, net_amount,
                tax_amount, fee_amount, principal_component, interest_component,
                formbar_outcome, error_message, metadata_json, currency_note
            ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'digipog')`,
            [
                entry.idempotency_key,
                entry.type,
                entry.actor_formbar_user_id != null ? entry.actor_formbar_user_id : null,
                entry.counterparty_formbar_user_id != null ? entry.counterparty_formbar_user_id : null,
                entry.related_loan_id != null ? entry.related_loan_id : null,
                entry.related_check_id != null ? entry.related_check_id : null,
                entry.parent_group_id != null ? entry.parent_group_id : null,
                entry.requested_amount != null ? entry.requested_amount : 0,
                entry.gross_transfer_amount != null ? entry.gross_transfer_amount : 0,
                entry.net_amount != null ? entry.net_amount : 0,
                entry.tax_amount != null ? entry.tax_amount : 0,
                entry.fee_amount != null ? entry.fee_amount : 0,
                entry.principal_component != null ? entry.principal_component : 0,
                entry.interest_component != null ? entry.interest_component : 0,
                metadataJson
            ]
        );
        return { id: result.lastID, existing: false };
    }

    async function updateStatus(id, status, fields = {}) {
        if (!VALID_STATUSES.has(status)) {
            throw new Error(`Invalid ledger status: ${status}`);
        }
        const sets = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
        const params = [status];
        if (fields.formbar_outcome !== undefined) {
            sets.push('formbar_outcome = ?');
            params.push(fields.formbar_outcome);
        }
        if (fields.error_message !== undefined) {
            sets.push('error_message = ?');
            params.push(fields.error_message ? String(fields.error_message).slice(0, 500) : null);
        }
        if (fields.metadata !== undefined) {
            sets.push('metadata_json = ?');
            params.push(JSON.stringify(fields.metadata));
        }
        if (fields.related_loan_id !== undefined) {
            sets.push('related_loan_id = ?');
            params.push(fields.related_loan_id);
        }
        if (fields.related_check_id !== undefined) {
            sets.push('related_check_id = ?');
            params.push(fields.related_check_id);
        }
        if (fields.parent_group_id !== undefined) {
            sets.push('parent_group_id = ?');
            params.push(fields.parent_group_id);
        }
        params.push(id);
        await run(
            `UPDATE financial_transactions SET ${sets.join(', ')} WHERE id = ?`,
            params
        );
    }

    async function markCompleted(id, fields = {}) {
        return updateStatus(id, 'completed', { formbar_outcome: 'success', ...fields });
    }

    async function markFailed(id, errorMessage, formbarOutcome = 'failure') {
        return updateStatus(id, 'failed', {
            formbar_outcome: formbarOutcome,
            error_message: errorMessage
        });
    }

    async function markReconciliationRequired(id, errorMessage, formbarOutcome = 'unknown') {
        return updateStatus(id, 'reconciliation_required', {
            formbar_outcome: formbarOutcome,
            error_message: errorMessage
        });
    }

    /**
     * Insert a terminal row directly (backfill / non-transfer events like limit changes).
     */
    async function insertCompleted(entry) {
        if (!entry || !entry.idempotency_key) {
            throw new Error('idempotency_key is required');
        }
        const existing = await findByIdempotencyKey(entry.idempotency_key);
        if (existing) {
            return { id: existing.id, existing: true, row: existing };
        }
        const status = entry.status && VALID_STATUSES.has(entry.status) ? entry.status : 'completed';
        const metadataJson = entry.metadata != null
            ? JSON.stringify(entry.metadata)
            : (entry.metadata_json || null);
        const createdAt = entry.created_at || null;
        const result = await run(
            `INSERT INTO financial_transactions (
                idempotency_key, type, status,
                actor_formbar_user_id, counterparty_formbar_user_id,
                related_loan_id, related_check_id, parent_group_id,
                requested_amount, gross_transfer_amount, net_amount,
                tax_amount, fee_amount, principal_component, interest_component,
                formbar_outcome, error_message, metadata_json, currency_note,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'digipog',
                COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))`,
            [
                entry.idempotency_key,
                entry.type,
                status,
                entry.actor_formbar_user_id != null ? entry.actor_formbar_user_id : null,
                entry.counterparty_formbar_user_id != null ? entry.counterparty_formbar_user_id : null,
                entry.related_loan_id != null ? entry.related_loan_id : null,
                entry.related_check_id != null ? entry.related_check_id : null,
                entry.parent_group_id != null ? entry.parent_group_id : null,
                entry.requested_amount != null ? entry.requested_amount : 0,
                entry.gross_transfer_amount != null ? entry.gross_transfer_amount : 0,
                entry.net_amount != null ? entry.net_amount : 0,
                entry.tax_amount != null ? entry.tax_amount : 0,
                entry.fee_amount != null ? entry.fee_amount : 0,
                entry.principal_component != null ? entry.principal_component : 0,
                entry.interest_component != null ? entry.interest_component : 0,
                entry.formbar_outcome || (status === 'completed' ? 'success' : 'unknown'),
                entry.error_message || null,
                metadataJson,
                createdAt,
                createdAt
            ]
        );
        return { id: result.lastID, existing: false };
    }

    return {
        beginPending,
        markCompleted,
        markFailed,
        markReconciliationRequired,
        updateStatus,
        findByIdempotencyKey,
        insertCompleted,
        get,
        all,
        run
    };
}

module.exports = {
    createLedger,
    VALID_TYPES,
    VALID_STATUSES
};
