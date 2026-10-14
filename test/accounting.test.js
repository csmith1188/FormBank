const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const accounting = require('../lib/accounting');

describe('accounting', () => {
    it('grosses up for Formbar tax', () => {
        assert.equal(accounting.sendAmountForNet(90), 100);
        assert.equal(accounting.netAfterTax(100), 90);
        assert.equal(accounting.taxOnGross(100), 10);
    });

    it('computes check fee and charge', () => {
        assert.equal(accounting.calcCheckFee(100), 5);
        const payout = accounting.checkPayoutFromFormBank(100);
        assert.equal(payout, 112); // ceil(100/0.9)
        const charge = accounting.checkChargeToFormBank(100);
        assert.ok(charge >= payout + 5);
    });

    it('computes loan amount owed', () => {
        assert.equal(accounting.loanAmountOwed(100), 120);
        assert.equal(accounting.loanAmountOwed(1), 2); // ceil(1.2)
    });

    it('allocates repayment principal-first', () => {
        const a = accounting.allocateRepayment(100, 0, 40);
        assert.deepEqual(a, { principalComponent: 40, interestComponent: 0 });
        const b = accounting.allocateRepayment(100, 90, 40);
        assert.deepEqual(b, { principalComponent: 10, interestComponent: 30 });
        const c = accounting.allocateRepayment(100, 100, 20);
        assert.deepEqual(c, { principalComponent: 0, interestComponent: 20 });
    });

    it('computes interest collected on loan', () => {
        assert.equal(accounting.interestCollectedOnLoan(100, 80), 0);
        assert.equal(accounting.interestCollectedOnLoan(100, 120), 20);
    });

    it('computes triangular credit limit progress', () => {
        const step = 500;
        const p0 = accounting.computeCreditLimitProgress(step, 500, 0, 499);
        assert.equal(p0.increments, 0);
        const p1 = accounting.computeCreditLimitProgress(step, 500, 0, 500);
        assert.equal(p1.increments, 1);
        assert.equal(p1.newLimit, 1000);
        const p2 = accounting.computeCreditLimitProgress(step, 1000, 1, 1500);
        assert.equal(p2.increments, 1);
        assert.equal(p2.newLimit, 1500);
    });

    it('median and average handle empty', () => {
        assert.equal(accounting.median([]), null);
        assert.equal(accounting.average([]), null);
        assert.equal(accounting.median([1, 3, 2]), 2);
        assert.equal(accounting.average([2, 4]), 3);
    });
});
