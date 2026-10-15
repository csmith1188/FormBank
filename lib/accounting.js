/**
 * Pure FormBank money math (no I/O).
 * Formbar keep rate 0.9 (10% tax); FormBank check fee 5% of face amount.
 */

const FORMBAR_KEEP_RATE = 0.9;
const FORMBANK_FEE_RATE = 0.05;
/** @deprecated Prefer loanInterestRate(currentLimit); kept as the high-limit floor. */
const LOAN_INTEREST_RATE = 0.25;
/** One-time security deposit required before borrowing. */
const LOAN_DEPOSIT_AMOUNT = 1000;
/**
 * Minimum deposit to retain while limit is below the deposit amount.
 * Keeps collateral high enough that climb-then-default stays bank-safe.
 */
const DEPOSIT_HOLD_FLOOR = Math.floor(LOAN_DEPOSIT_AMOUNT * 0.75); // 750
/** Default credit-limit step / starting limit. */
const CREDIT_LIMIT_STEP_DEFAULT = 250;

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

/**
 * Tiered interest by current credit limit at borrow time.
 * Higher rates at low limits; floor 25% (above Formbar tax break-even ~11.1%).
 * Rates calibrated so climb-then-default stays user-negative and bank-non-negative
 * with the deposit hold floor.
 */
function loanInterestRate(currentLimit) {
    const L = Math.max(0, Math.floor(Number(currentLimit) || 0));
    if (L <= 250) return 1.00;
    if (L <= 500) return 0.85;
    if (L <= 750) return 0.70;
    if (L <= 1000) return 0.55;
    if (L <= 1500) return 0.45;
    if (L <= 2000) return 0.40;
    if (L <= 2500) return 0.35;
    if (L <= 3000) return 0.30;
    return 0.25;
}

/**
 * Contracted amount owed for a loan principal.
 * @param {number} principal
 * @param {number} [rate] - Interest rate; defaults to LOAN_INTEREST_RATE floor
 */
function loanAmountOwed(principal, rate) {
    const p = Math.max(0, Math.floor(Number(principal) || 0));
    const r = rate == null || Number.isNaN(Number(rate))
        ? LOAN_INTEREST_RATE
        : Math.max(0, Number(rate));
    return Math.ceil(p * (1 + r));
}

/**
 * Target deposit still held after a limit update.
 * Holds at least max(currentLimit, DEPOSIT_HOLD_FLOOR), capped by posted amount,
 * so early refunds cannot strip collateral below a safe floor.
 */
function targetDepositHeld(depositPosted, currentLimit) {
    const posted = Math.max(0, Math.floor(Number(depositPosted) || 0));
    const limit = Math.max(0, Math.floor(Number(currentLimit) || 0));
    const floor = Math.min(posted, DEPOSIT_HOLD_FLOOR);
    return Math.min(posted, Math.max(limit, floor));
}

/** Net digipogs to refund from held deposit after a limit update. */
function depositRefundNet(depositHeld, depositPosted, currentLimit) {
    const held = Math.max(0, Math.floor(Number(depositHeld) || 0));
    const target = targetDepositHeld(depositPosted, currentLimit);
    return Math.max(0, held - target);
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

/**
 * Simulate max-borrow climb for `paidLoans` fully repaid loans, then optional default.
 * Used to verify users cannot profit and the bank stays non-negative.
 * @param {{ step?: number, deposit?: number, paidLoans: number, defaultAfter?: boolean }} opts
 * @returns {{ userNet: number, bankNet: number, finalLimit: number, depositHeld: number }}
 */
function simulateClimbThenDefault(opts = {}) {
    const step = Math.max(1, Math.floor(Number(opts.step) || CREDIT_LIMIT_STEP_DEFAULT));
    const deposit = Math.max(0, Math.floor(Number(opts.deposit) || LOAN_DEPOSIT_AMOUNT));
    const paidLoans = Math.max(0, Math.floor(Number(opts.paidLoans) || 0));
    const doDefault = opts.defaultAfter !== false;

    let limit = step;
    let increaseCount = 0;
    let totalRepaid = 0;
    let depositPosted = deposit;
    let depositHeld = deposit;
    let depositRefunded = 0;

    // User: pays deposit gross; bank nets after tax
    let userNet = -deposit;
    let bankNet = netAfterTax(deposit);

    for (let i = 0; i < paidLoans; i++) {
        const P = limit;
        const rate = loanInterestRate(limit);
        const owed = loanAmountOwed(P, rate);
        const received = netAfterTax(P);
        const repayNetToBank = netAfterTax(owed);

        // Borrow then fully repay
        userNet += received - owed;
        bankNet += -P + repayNetToBank;

        totalRepaid += owed;
        const progress = computeCreditLimitProgress(step, limit, increaseCount, totalRepaid);
        limit = progress.newLimit;
        increaseCount = progress.newIncreaseCount;

        const refundNet = depositRefundNet(depositHeld, depositPosted, limit);
        if (refundNet > 0) {
            const refundGross = sendAmountForNet(refundNet);
            userNet += refundNet; // user nets refundNet
            bankNet -= refundGross;
            depositHeld -= refundNet;
            depositRefunded += refundNet;
        }
    }

    if (doDefault && limit > 0) {
        const P = limit;
        const received = netAfterTax(P);
        userNet += received;
        bankNet -= P;
        // Remaining depositHeld stays with bank (already counted in bankNet from deposit)
    }

    return {
        userNet,
        bankNet,
        finalLimit: limit,
        depositHeld,
        depositRefunded,
        depositPosted
    };
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
    LOAN_DEPOSIT_AMOUNT,
    DEPOSIT_HOLD_FLOOR,
    CREDIT_LIMIT_STEP_DEFAULT,
    sendAmountForNet,
    netAfterTax,
    taxOnGross,
    calcCheckFee,
    checkPayoutFromFormBank,
    checkChargeToFormBank,
    loanInterestRate,
    loanAmountOwed,
    targetDepositHeld,
    depositRefundNet,
    allocateRepayment,
    interestCollectedOnLoan,
    outstandingPrincipal,
    creditLimitThreshold,
    computeCreditLimitProgress,
    simulateClimbThenDefault,
    median,
    average
};
