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

    it('computes tiered loan interest and amount owed', () => {
        assert.equal(accounting.loanInterestRate(250), 1.00);
        assert.equal(accounting.loanInterestRate(500), 0.85);
        assert.equal(accounting.loanInterestRate(750), 0.70);
        assert.equal(accounting.loanInterestRate(1000), 0.55);
        assert.equal(accounting.loanInterestRate(1500), 0.45);
        assert.equal(accounting.loanInterestRate(2000), 0.40);
        assert.equal(accounting.loanInterestRate(2500), 0.35);
        assert.equal(accounting.loanInterestRate(3000), 0.30);
        assert.equal(accounting.loanInterestRate(3001), 0.25);
        assert.equal(accounting.loanAmountOwed(100, 0.20), 120);
        assert.equal(accounting.loanAmountOwed(250, 1.00), 500);
        assert.equal(accounting.loanAmountOwed(1, 0.20), 2); // ceil(1.2)
    });

    it('computes deposit target held and refund net', () => {
        // Hold floor 750 while limit is below that
        assert.equal(accounting.targetDepositHeld(1000, 250), 750);
        assert.equal(accounting.targetDepositHeld(1000, 500), 750);
        assert.equal(accounting.targetDepositHeld(1000, 1500), 1000);
        assert.equal(accounting.depositRefundNet(1000, 1000, 250), 250);
        assert.equal(accounting.depositRefundNet(1000, 1000, 500), 250);
        assert.equal(accounting.depositRefundNet(750, 1000, 750), 0);
        assert.equal(accounting.depositRefundNet(1000, 1000, 1000), 0);
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
        const step = 250;
        const p0 = accounting.computeCreditLimitProgress(step, 250, 0, 249);
        assert.equal(p0.increments, 0);
        const p1 = accounting.computeCreditLimitProgress(step, 250, 0, 250);
        assert.equal(p1.increments, 1);
        assert.equal(p1.newLimit, 500);
        const p2 = accounting.computeCreditLimitProgress(step, 500, 1, 750);
        assert.equal(p2.increments, 1);
        assert.equal(p2.newLimit, 750);
    });

    it('floor 25% interest is bank-positive on full repayment', () => {
        const P = 1000;
        const owed = accounting.loanAmountOwed(P, 0.25);
        const bankNet = -P + accounting.netAfterTax(owed);
        assert.ok(bankNet > 0, `expected bank profit, got ${bankNet}`);
    });

    it('deposit then immediate default is user-negative and bank-positive', () => {
        const s = accounting.simulateClimbThenDefault({ paidLoans: 0, defaultAfter: true });
        assert.ok(s.userNet <= 0, `userNet ${s.userNet}`);
        assert.ok(s.bankNet >= 0, `bankNet ${s.bankNet}`);
    });

    it('climb-then-default never profits the user; bank stays non-negative', () => {
        for (let paid = 0; paid <= 20; paid++) {
            const s = accounting.simulateClimbThenDefault({ paidLoans: paid, defaultAfter: true });
            assert.ok(
                s.userNet <= 0,
                `paidLoans=${paid} userNet=${s.userNet} limit=${s.finalLimit}`
            );
            assert.ok(
                s.bankNet >= 0,
                `paidLoans=${paid} bankNet=${s.bankNet} limit=${s.finalLimit}`
            );
        }
    });

    it('median and average handle empty', () => {
        assert.equal(accounting.median([]), null);
        assert.equal(accounting.average([]), null);
        assert.equal(accounting.median([1, 3, 2]), 2);
        assert.equal(accounting.average([2, 4]), 3);
    });
});
