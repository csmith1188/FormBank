const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeLoanUpdate,
    normalizeCreditLimitUpdate
} = require('../lib/adminEdits');

describe('adminEdits', () => {
    const baseLoan = {
        principal: 100,
        amount_owed: 120,
        amount_paid: 20,
        status: 'active',
        paid_at: null
    };

    it('normalizes loan balance edits', () => {
        const u = normalizeLoanUpdate(baseLoan, { amount_paid: 60 });
        assert.equal(u.amount_paid, 60);
        assert.equal(u.status, 'active');
        assert.equal(u.paid_at, null);
    });

    it('marks loan paid when amount_paid covers owed', () => {
        const u = normalizeLoanUpdate(baseLoan, { amount_paid: 120 });
        assert.equal(u.status, 'paid');
        assert.ok(u.paid_at);
    });

    it('rejects amount_paid above amount_owed', () => {
        assert.throws(
            () => normalizeLoanUpdate(baseLoan, { amount_paid: 200 }),
            /cannot exceed/
        );
    });

    it('normalizes credit limit update', () => {
        const u = normalizeCreditLimitUpdate({
            formbarUserId: 42,
            current_limit: 1500,
            paid_off_count: 2,
            note: 'manual bump'
        });
        assert.deepEqual(
            { formbarUserId: u.formbarUserId, currentLimit: u.currentLimit, paidOffCount: u.paidOffCount },
            { formbarUserId: 42, currentLimit: 1500, paidOffCount: 2 }
        );
    });
});
