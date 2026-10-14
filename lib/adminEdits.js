/**
 * Admin bookkeeping edits (local DB only — does not move Formbar digipogs).
 */

const VALID_LOAN_STATUSES = new Set(['active', 'paid', 'void', 'superseded']);

function parseNonNegInt(value, fieldName) {
    const n = parseInt(value, 10);
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`Invalid ${fieldName}: must be a non-negative integer`);
    }
    return n;
}

function parsePositiveInt(value, fieldName) {
    const n = parseInt(value, 10);
    if (!Number.isInteger(n) || n < 1) {
        throw new Error(`Invalid ${fieldName}: must be a positive integer`);
    }
    return n;
}

/**
 * Normalize loan fields for an admin update.
 * @returns {{ principal: number, amount_owed: number, amount_paid: number, status: string, paid_at: string|null }}
 */
function normalizeLoanUpdate(existing, body) {
    const principal = body.principal !== undefined && body.principal !== ''
        ? parsePositiveInt(body.principal, 'principal')
        : existing.principal;
    const amountOwed = body.amount_owed !== undefined && body.amount_owed !== ''
        ? parseNonNegInt(body.amount_owed, 'amount_owed')
        : existing.amount_owed;
    const amountPaid = body.amount_paid !== undefined && body.amount_paid !== ''
        ? parseNonNegInt(body.amount_paid, 'amount_paid')
        : existing.amount_paid;

    if (amountOwed < principal && body.amount_owed !== undefined) {
        // Allow but warn via metadata — admin may intentionally reduce owed
    }
    if (amountPaid > amountOwed) {
        throw new Error('amount_paid cannot exceed amount_owed');
    }

    let status = body.status ? String(body.status).trim() : existing.status;
    if (!VALID_LOAN_STATUSES.has(status)) {
        throw new Error(`Invalid status (use active, paid, void, or superseded)`);
    }

    let paidAt = existing.paid_at || null;
    if (status === 'paid' || amountPaid >= amountOwed) {
        status = 'paid';
        paidAt = paidAt || new Date().toISOString();
    } else if (status === 'active') {
        paidAt = null;
    } else if (status === 'void' || status === 'superseded') {
        // keep paid_at as-is
    }

    return {
        principal,
        amount_owed: amountOwed,
        amount_paid: amountPaid,
        status,
        paid_at: paidAt
    };
}

function normalizeCreditLimitUpdate(body) {
    const formbarUserId = parsePositiveInt(body.formbarUserId || body.user_id, 'formbarUserId');
    const currentLimit = parsePositiveInt(body.current_limit || body.currentLimit, 'current_limit');
    let paidOffCount = 0;
    if (body.paid_off_count !== undefined && body.paid_off_count !== '') {
        paidOffCount = parseNonNegInt(body.paid_off_count, 'paid_off_count');
    } else if (body.paidOffCount !== undefined && body.paidOffCount !== '') {
        paidOffCount = parseNonNegInt(body.paidOffCount, 'paid_off_count');
    }
    const note = body.note ? String(body.note).slice(0, 200) : null;
    return { formbarUserId, currentLimit, paidOffCount, note };
}

module.exports = {
    VALID_LOAN_STATUSES,
    parseNonNegInt,
    parsePositiveInt,
    normalizeLoanUpdate,
    normalizeCreditLimitUpdate
};
