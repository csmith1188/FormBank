/**
 * FormBank credit score model (FICO-like 300–850).
 *
 * Core loop: take loans → repay them fully and quickly → score rises →
 * higher limit, lower APR, smaller check fees.
 *
 * Score factors (weights inspired by real FICO categories):
 * - Payment history / paid-in-full (~35%)
 * - Credit utilization vs available limit (~25%)
 * - Unpaid balance burden on open loans (~15%)
 * - Portion repaid (progress on open + lifetime) (~15%)
 * - Speed of payoff / time open (~10%)
 * - Due dates / on-time streaks & missed payments (payment history severity)
 */

const SCORE_MIN = 300;
const SCORE_MAX = 850;
/** Thin-file / new borrower starting score (minimum / Poor). */
const BASE_SCORE = SCORE_MIN;
/** One-time origination fee on principal when a loan is issued. */
const ORIGINATION_FEE_RATE = 0.10;
/** Minimum payment = this fraction of remaining balance (floored by MIN_PAYMENT_FLOOR). */
const MIN_PAYMENT_RATE = 0.10;
const MIN_PAYMENT_FLOOR = 25;
/** Days between minimum-payment due dates (production). */
const PAYMENT_PERIOD_DAYS = 7;
/** Missed-payment score hit (harder than unpaid-balance alone). */
const MISSED_PAYMENT_PENALTY = 30;
const MISSED_PAYMENT_PENALTY_CAP = 150;
/** Extra hit while currently past due without meeting the minimum. */
const CURRENTLY_OVERDUE_PENALTY = 45;
/** On-time streak bonus per consecutive minimum met. */
const ON_TIME_STREAK_BONUS = 8;
const ON_TIME_STREAK_BONUS_CAP = 56;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

function lerp(x, x0, x1, y0, y1) {
    if (x1 === x0) return y0;
    return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

function daysBetween(a, b) {
    const t0 = new Date(a).getTime();
    const t1 = new Date(b).getTime();
    if (isNaN(t0) || isNaN(t1)) return 0;
    return Math.max(0, (t1 - t0) / MS_PER_DAY);
}

function loanRemaining(loan) {
    const owed = Number(loan.amount_owed) || 0;
    const paid = Number(loan.amount_paid) || 0;
    return Math.max(0, owed - paid);
}

/** Payment period length in ms (7 days, or 30 min when COMPOUND_TEST). */
function getPaymentPeriodMs(compoundTest) {
    if (compoundTest) return 30 * 60 * 1000;
    return PAYMENT_PERIOD_DAYS * MS_PER_DAY;
}

/** Minimum payment due for a given remaining balance. */
function calcMinPayment(remaining) {
    const rem = Math.max(0, Math.floor(Number(remaining) || 0));
    if (rem <= 0) return 0;
    if (rem <= MIN_PAYMENT_FLOOR) return rem;
    return Math.max(MIN_PAYMENT_FLOOR, Math.ceil(rem * MIN_PAYMENT_RATE));
}

function nextDueAtFrom(fromDate, compoundTest) {
    const start = fromDate ? new Date(fromDate).getTime() : Date.now();
    const base = isNaN(start) ? Date.now() : start;
    return new Date(base + getPaymentPeriodMs(compoundTest)).toISOString();
}

/** True if the loan's current minimum was not met and the due date has passed. */
function isCurrentlyOverdue(loan, now = Date.now()) {
    if (!loan || loan.status !== 'active' || !loan.next_due_at) return false;
    const due = new Date(loan.next_due_at).getTime();
    if (isNaN(due) || now < due) return false;
    const periodPaid = Number(loan.period_paid) || 0;
    const minDue = Number(loan.min_payment_due) || 0;
    return periodPaid < minDue;
}

/**
 * Quick-payoff bonus for a fully paid loan (encourages paying back fast).
 * Same day → +35, ≤3 days → +25, ≤7 → +15, ≤14 → +8, else 0.
 */
function quickPayoffBonus(loan) {
    if (loan.status !== 'paid' || !loan.paid_at || !loan.created_at) return 0;
    const days = daysBetween(loan.created_at, loan.paid_at);
    if (days <= 1) return 35;
    if (days <= 3) return 25;
    if (days <= 7) return 15;
    if (days <= 14) return 8;
    return 0;
}

/**
 * Compute a 300–850 credit score from loan records.
 *
 * @param {Array<object>} loans
 * @param {{ creditLimit?: number }} [context] - prior/available limit for utilization
 * @returns {number}
 */
function computeCreditScore(loans, context = {}) {
    const list = loans || [];
    const paidLoans = list.filter((l) => l.status === 'paid');
    const activeLoan = list.find((l) => l.status === 'active') || null;
    const hasHistory = list.length > 0;

    // --- Provisional score (no limit utilization) to derive a limit if none provided ---
    let provisional = BASE_SCORE;
    provisional += Math.min(175, paidLoans.length * 35);
    for (const loan of paidLoans) {
        provisional += quickPayoffBonus(loan);
    }
    provisional = clamp(provisional, SCORE_MIN, SCORE_MAX);
    const availableLimit = Math.max(
        250,
        Number(context.creditLimit) || creditLimitFromScore(provisional)
    );

    let score = BASE_SCORE;
    const breakdown = {
        base: BASE_SCORE,
        paymentHistory: 0,
        utilization: 0,
        unpaidBurden: 0,
        repaymentProgress: 0,
        speed: 0,
        newCredit: 0,
        paymentSchedule: 0
    };

    // ----- 1. Payment history (~35%): fully paid loans + quick payoff -----
    // Each paid-in-full loan: +35 (cap 5 → +175)
    let historyPts = Math.min(175, paidLoans.length * 35);
    // Quick payoff bonuses (cap +70 total)
    let speedFromPaid = 0;
    for (const loan of paidLoans) {
        speedFromPaid += quickPayoffBonus(loan);
    }
    speedFromPaid = Math.min(70, speedFromPaid);
    breakdown.paymentHistory = historyPts;
    breakdown.speed += speedFromPaid;
    score += historyPts + speedFromPaid;

    // ----- 2. Utilization vs available credit limit (~25%) -----
    // Lose score for using a large share of your limit at once.
    if (!hasHistory) {
        breakdown.utilization = 0;
    } else if (!activeLoan) {
        breakdown.utilization = 90; // clean slate / paid off
        score += 90;
    } else {
        const principal = Number(activeLoan.principal) || 0;
        const remaining = loanRemaining(activeLoan);
        // Use the larger of principal-drawn or current remaining vs limit
        const drawn = Math.max(principal, remaining);
        const utilization = availableLimit > 0 ? Math.min(1.5, drawn / availableLimit) : 1;
        // 0% util → +90, 50% → 0, 100% → -90, >100% → -120
        const utilPts = Math.round(90 - 180 * utilization);
        breakdown.utilization = clamp(utilPts, -120, 90);
        score += breakdown.utilization;
    }

    // ----- 3. Unpaid balance burden (~15%) -----
    // Lose score for how much of an open loan is still unpaid.
    if (activeLoan) {
        const owed = Number(activeLoan.amount_owed) || 0;
        const remaining = loanRemaining(activeLoan);
        const unpaidRatio = owed > 0 ? remaining / owed : 1;
        // Full unpaid → -80, half paid → -40, nearly paid → ~0
        const ratioPenalty = Math.round(-80 * unpaidRatio);
        // Extra drag for large absolute balances (soft)
        const sizePenalty = -Math.min(40, Math.floor(remaining / 500));
        breakdown.unpaidBurden = ratioPenalty + sizePenalty;
        score += breakdown.unpaidBurden;
    }

    // ----- 4. Repayment progress gains (~15%) -----
    // Gain score for portion paid back (active loan + lifetime).
    if (activeLoan) {
        const owed = Number(activeLoan.amount_owed) || 0;
        const paid = Number(activeLoan.amount_paid) || 0;
        if (owed > 0 && paid > 0) {
            const portion = Math.min(1, paid / owed);
            const progressPts = Math.round(50 * portion);
            breakdown.repaymentProgress += progressPts;
            score += progressPts;
        }
    }
    // Lifetime: total paid vs total ever owed across all loans
    const totalPaid = list.reduce((s, l) => s + (Number(l.amount_paid) || 0), 0);
    const totalOwedEver = list.reduce((s, l) => s + (Number(l.amount_owed) || 0), 0);
    if (totalOwedEver > 0) {
        const lifePortion = Math.min(1, totalPaid / totalOwedEver);
        const lifePts = Math.round(40 * lifePortion);
        breakdown.repaymentProgress += lifePts;
        score += lifePts;
    }

    // ----- 5. Speed / aging on open loans (~10%) -----
    // Reward history length lightly; penalize loans left open a long time.
    if (hasHistory) {
        let earliest = Date.now();
        for (const loan of list) {
            const t = new Date(loan.created_at).getTime();
            if (!isNaN(t) && t < earliest) earliest = t;
        }
        const weeks = Math.max(0, (Date.now() - earliest) / (7 * MS_PER_DAY));
        const agePts = Math.min(40, Math.floor(weeks * 1.25));
        breakdown.speed += agePts;
        score += agePts;
    }
    if (activeLoan && activeLoan.created_at) {
        const daysOpen = daysBetween(activeLoan.created_at, Date.now());
        // Grace ~7 days, then -2/day equivalent via weeks: -3 per week after week 1, cap -50
        const weeksLate = Math.max(0, (daysOpen - 7) / 7);
        const openPenalty = -Math.min(50, Math.floor(weeksLate * 3));
        breakdown.speed += openPenalty;
        score += openPenalty;
    }

    // ----- 6. New credit: open loan mild penalty until paid off -----
    if (activeLoan) {
        breakdown.newCredit = -15;
        score += -15;
    }

    // ----- 7. Due dates / on-time streaks & missed payments -----
    // Missed minimums hurt more than merely carrying an unpaid balance.
    let totalMissed = 0;
    let bestStreak = 0;
    for (const loan of list) {
        totalMissed += Number(loan.missed_payments) || 0;
        bestStreak = Math.max(bestStreak, Number(loan.on_time_streak) || 0);
    }
    if (activeLoan) {
        bestStreak = Math.max(bestStreak, Number(activeLoan.on_time_streak) || 0);
    }
    const streakPts = Math.min(ON_TIME_STREAK_BONUS_CAP, bestStreak * ON_TIME_STREAK_BONUS);
    const missedPts = -Math.min(MISSED_PAYMENT_PENALTY_CAP, totalMissed * MISSED_PAYMENT_PENALTY);
    let overduePts = 0;
    if (activeLoan && isCurrentlyOverdue(activeLoan)) {
        overduePts = -CURRENTLY_OVERDUE_PENALTY;
    }
    breakdown.paymentSchedule = streakPts + missedPts + overduePts;
    score += breakdown.paymentSchedule;

    const finalScore = clamp(Math.round(score), SCORE_MIN, SCORE_MAX);
    return finalScore;
}

/**
 * Detailed score + factor breakdown (for UI / debugging).
 */
function explainCreditScore(loans, context = {}) {
    const list = loans || [];
    // Recompute with the same logic; capture by running compute and deriving limit
    const priorLimit = context.creditLimit;
    const score = computeCreditScore(list, { creditLimit: priorLimit });
    const limit = creditLimitFromScore(score);
    const activeLoan = list.find((l) => l.status === 'active') || null;
    const paidCount = list.filter((l) => l.status === 'paid').length;
    let utilization = 0;
    let unpaidRatio = 0;
    let paidPortion = 0;
    let onTimeStreak = 0;
    let missedPayments = 0;
    let currentlyOverdue = false;
    let nextDueAt = null;
    let minPaymentDue = 0;
    let periodPaid = 0;
    if (activeLoan) {
        const remaining = loanRemaining(activeLoan);
        const principal = Number(activeLoan.principal) || 0;
        utilization = limit > 0 ? Math.min(1.5, Math.max(principal, remaining) / limit) : 0;
        const owed = Number(activeLoan.amount_owed) || 0;
        unpaidRatio = owed > 0 ? remaining / owed : 0;
        paidPortion = owed > 0 ? Math.min(1, (Number(activeLoan.amount_paid) || 0) / owed) : 0;
        onTimeStreak = Number(activeLoan.on_time_streak) || 0;
        missedPayments = Number(activeLoan.missed_payments) || 0;
        currentlyOverdue = isCurrentlyOverdue(activeLoan);
        nextDueAt = activeLoan.next_due_at || null;
        minPaymentDue = Number(activeLoan.min_payment_due) || 0;
        periodPaid = Number(activeLoan.period_paid) || 0;
    }
    const totalMissed = list.reduce((s, l) => s + (Number(l.missed_payments) || 0), 0);
    return {
        score,
        scoreLabel: scoreLabel(score),
        creditLimit: limit,
        paidLoans: paidCount,
        utilization,
        unpaidRatio,
        paidPortion,
        hasActiveLoan: !!activeLoan,
        onTimeStreak,
        missedPayments: totalMissed,
        currentlyOverdue,
        nextDueAt,
        minPaymentDue,
        periodPaid
    };
}

function scoreLabel(score) {
    if (score >= 800) return 'Exceptional';
    if (score >= 740) return 'Very Good';
    if (score >= 670) return 'Good';
    if (score >= 580) return 'Fair';
    return 'Poor';
}

/**
 * Map score → borrowing limit (digipogs).
 * Score 300 → 250, score 850 → 1,000,000 (linear), rounded to nearest 25.
 */
function creditLimitFromScore(score) {
    const s = clamp(score, SCORE_MIN, SCORE_MAX);
    const limit = lerp(s, SCORE_MIN, SCORE_MAX, 250, 1_000_000);
    return Math.max(250, Math.round(limit / 25) * 25);
}

/**
 * Annual interest rate (APR) that compounds on the outstanding balance.
 * Score 300 → 24% APR, score 850 → 4% APR.
 */
function interestRateFromScore(score) {
    const s = clamp(score, SCORE_MIN, SCORE_MAX);
    const rate = 0.24 - ((s - 300) / 550) * 0.20;
    return Math.round(rate * 10000) / 10000;
}

/** Effective rate for one compounding period from an annual APR (daily by default). */
function periodRateFromAnnual(annualRate, periodsPerYear = 365) {
    const annual = Number(annualRate) || 0;
    const n = Math.max(1, Number(periodsPerYear) || 365);
    if (annual <= 0) return 0;
    return Math.pow(1 + annual, 1 / n) - 1;
}

/** Starting balance owed after the one-time 10% origination fee. */
function amountOwedAfterOriginationFee(principal) {
    return Math.ceil(Number(principal) * (1 + ORIGINATION_FEE_RATE));
}

function checkFeeTermsFromScore(score) {
    if (score >= 800) return { rate: 0.015, minFee: 2 };
    if (score >= 740) return { rate: 0.025, minFee: 3 };
    if (score >= 670) return { rate: 0.035, minFee: 4 };
    if (score >= 580) return { rate: 0.05, minFee: 5 };
    return { rate: 0.08, minFee: 8 };
}

function checkFeeFromScore(score, amount) {
    const { rate, minFee } = checkFeeTermsFromScore(score);
    return Math.max(Math.ceil(Number(amount) * rate), minFee);
}

/**
 * Full terms package for a borrower given their loan history.
 * @param {Array} loans
 * @param {number} [priorLimit] - last known limit (for utilization); optional
 */
function getCreditTerms(loans, priorLimit) {
    const score = computeCreditScore(loans || [], {
        creditLimit: priorLimit != null ? priorLimit : undefined
    });
    // Second pass with the newly implied limit so utilization matches the score band
    const limit = creditLimitFromScore(score);
    const refinedScore = computeCreditScore(loans || [], { creditLimit: limit });
    const refinedLimit = creditLimitFromScore(refinedScore);
    const feeTerms = checkFeeTermsFromScore(refinedScore);
    return {
        score: refinedScore,
        scoreLabel: scoreLabel(refinedScore),
        creditLimit: refinedLimit,
        interestRate: interestRateFromScore(refinedScore),
        checkFeeRate: feeTerms.rate,
        checkFeeMin: feeTerms.minFee
    };
}

module.exports = {
    SCORE_MIN,
    SCORE_MAX,
    BASE_SCORE,
    ORIGINATION_FEE_RATE,
    MIN_PAYMENT_RATE,
    MIN_PAYMENT_FLOOR,
    PAYMENT_PERIOD_DAYS,
    computeCreditScore,
    explainCreditScore,
    scoreLabel,
    creditLimitFromScore,
    interestRateFromScore,
    periodRateFromAnnual,
    amountOwedAfterOriginationFee,
    getPaymentPeriodMs,
    calcMinPayment,
    nextDueAtFrom,
    isCurrentlyOverdue,
    loanRemaining,
    checkFeeTermsFromScore,
    checkFeeFromScore,
    getCreditTerms
};
