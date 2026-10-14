/**
 * Pure FormBank money math (no I/O).
 * Formbar keep rate 0.9 (10% tax); FormBank check fee 5% of face amount.
 */

const FORMBAR_KEEP_RATE = 0.9;
const FORMBANK_FEE_RATE = 0.05;
const LOAN_INTEREST_RATE = 0.20;

/**
 * Gross digipogs to send so the recipient nets at least `netDesired`
 * after Formbar tax (assumes recipient receives floor(sent * 0.9)).
 */
function sendAmountForNet(netDesired) {
    const net = Math.max(0, Math.floor(Number(netDesired) || 0));
    if (net <= 0) return 0;
    return Math.ceil(net / FORMBAR_KEEP_RATE);
}

/** Estimated net after Formbar tax on a pre-tax transfer amount. */
function netAfterTax(gross) {
    const g = Math.max(0, Math.floor(Number(gross) || 0));
    return Math.floor(g * FORMBAR_KEEP_RATE);
}

/** Tax portion of a pre-tax transfer (gross - net). */
function taxOnGross(gross) {
    const g = Math.max(0, Math.floor(Number(gross) || 0));
    return g - netAfterTax(g);
}

/** FormBank's intended net fee (5% of check amount). */
function calcCheckFee(amount) {
    const a = Math.max(0, Math.floor(Number(amount) || 0));
    return Math.ceil(a * FORMBANK_FEE_RATE);
}

/** Gross FormBank → receiver so they net the full check amount. */
function checkPayoutFromFormBank(amount) {
    return sendAmountForNet(amount);
}

/**
 * Gross sender → FormBank so that after tax FormBank can:
 * 1) pay the receiver (full net amount), and
 * 2) keep ~5% of the check amount.
 */
function checkChargeToFormBank(amount) {
    const payout = checkPayoutFromFormBank(amount);
    const fee = calcCheckFee(amount);
    return sendAmountForNet(payout + fee);
}

/** Contracted amount owed for a loan principal (ceil(P * 1.2)). */
function loanAmountOwed(principal) {
    const p = Math.max(0, Math.floor(Number(principal) || 0));
    return Math.ceil(p * (1 + LOAN_INTEREST_RATE));
}

/**
 * Allocate a repayment principal-first, then interest.
 * @param {number} principal - Original loan principal
 * @param {number} amountPaidBefore - Cumulative paid before this repayment
 * @param {number} repayment - This repayment amount (debt reduction)
 * @returns {{ principalComponent: number, interestComponent: number }}
 */
function allocateRepayment(principal, amountPaidBefore, repayment) {
    const p = Math.max(0, Math.floor(Number(principal) || 0));
    const paid = Math.max(0, Math.floor(Number(amountPaidBefore) || 0));
    const r = Math.max(0, Math.floor(Number(repayment) || 0));
    const principalRemaining = Math.max(0, p - paid);
    const principalComponent = Math.min(r, principalRemaining);
    const interestComponent = r - principalComponent;
    return { principalComponent, interestComponent };
}

/** Interest collected so far on a loan (principal-first). */
function interestCollectedOnLoan(principal, amountPaid) {
    return Math.max(0, Math.floor(Number(amountPaid) || 0) - Math.floor(Number(principal) || 0));
}

/** Outstanding principal remaining on a loan. */
function outstandingPrincipal(principal, amountPaid) {
    const p = Math.max(0, Math.floor(Number(principal) || 0));
    const paid = Math.max(0, Math.floor(Number(amountPaid) || 0));
    return Math.max(0, p - Math.min(paid, p));
}

/**
 * Triangular repayment threshold for credit-limit increase index i (0-based).
 * threshold(i) = STEP * (n*(n+1)/2) where n = i+1
 */
function creditLimitThreshold(step, increaseIndex) {
    const s = Math.max(1, Math.floor(Number(step) || 1));
    const i = Math.max(0, Math.floor(Number(increaseIndex) || 0));
    const n = i + 1;
    return s * (n * (n + 1) / 2);
}

/**
 * Compute how many limit increases totalRepaid supports given current paid_off_count.
 * @returns {{ newLimit: number, newIncreaseCount: number, increments: number }}
 */
function computeCreditLimitProgress(step, currentLimit, paidOffCount, totalRepaid) {
    const s = Math.max(1, Math.floor(Number(step) || 1));
    let limit = Math.max(0, Math.floor(Number(currentLimit) || 0));
    let increaseCount = Math.max(0, Math.floor(Number(paidOffCount) || 0));
    const repaid = Math.max(0, Math.floor(Number(totalRepaid) || 0));
    let increments = 0;
    while (repaid >= creditLimitThreshold(s, increaseCount)) {
        limit += s;
        increaseCount += 1;
        increments += 1;
    }
    return { newLimit: limit, newIncreaseCount: increaseCount, increments };
}

/** Median of a numeric array (sorted copy). */
function median(values) {
    const arr = (values || []).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
    if (arr.length === 0) return null;
    const mid = Math.floor(arr.length / 2);
    if (arr.length % 2 === 0) return (arr[mid - 1] + arr[mid]) / 2;
    return arr[mid];
}

/** Average of a numeric array. */
function average(values) {
    const arr = (values || []).map(Number).filter((n) => !Number.isNaN(n));
    if (arr.length === 0) return null;
    return arr.reduce((s, n) => s + n, 0) / arr.length;
}

module.exports = {
    FORMBAR_KEEP_RATE,
    FORMBANK_FEE_RATE,
    LOAN_INTEREST_RATE,
    sendAmountForNet,
    netAfterTax,
    taxOnGross,
    calcCheckFee,
    checkPayoutFromFormBank,
    checkChargeToFormBank,
    loanAmountOwed,
    allocateRepayment,
    interestCollectedOnLoan,
    outstandingPrincipal,
    creditLimitThreshold,
    computeCreditLimitProgress,
    median,
    average
};
