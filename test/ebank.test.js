const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeTransaction,
    extractTransactionList,
    buildEbankAnalytics
} = require('../lib/analytics/ebank');

describe('ebank analytics', () => {
    it('extracts nested transaction arrays', () => {
        assert.equal(extractTransactionList([{ id: 1 }]).length, 1);
        assert.equal(extractTransactionList({ data: [{ id: 2 }] }).length, 1);
        assert.equal(extractTransactionList({ data: { transactions: [{ id: 3 }] } }).length, 1);
    });

    it('normalizes mixed field names', () => {
        const tx = normalizeTransaction({
            id: 9,
            from_user: 10,
            to_user: 57,
            digipogs: 25,
            memo: 'FormBank loan',
            createdAt: '2026-01-02T00:00:00Z'
        });
        assert.equal(tx.fromId, 10);
        assert.equal(tx.toId, 57);
        assert.equal(tx.amount, 25);
        assert.equal(tx.reason, 'FormBank loan');
    });

    it('computes inflow/outflow for eBank user', () => {
        const result = buildEbankAnalytics(57, { displayName: 'eBank', digipogs: 900 }, {
            data: [
                { from: 1, to: 57, amount: 100, reason: 'deposit', created_at: '2026-03-01' },
                { from: 57, to: 2, amount: 40, reason: 'FormBank payout', created_at: '2026-03-02' }
            ]
        });
        assert.equal(result.available, true);
        assert.equal(result.inflow, 100);
        assert.equal(result.outflow, 40);
        assert.equal(result.net, 60);
        assert.equal(result.formbankRelatedCount, 1);
        assert.equal(result.digipogs, 900);
        assert.equal(result.topCounterparties.length, 2);
    });
});
