/**
 * FormBank credit score model (FICO-like 300–850).
 *
 * Core loop: take loans → repay them fully and quickly → score rises →
 * higher limit, lower APR, smaller check fees.
 *
 * Mobility: the same good/bad behavior moves the score a lot near 300 and
 * very little near 850, so high scores (and large credit lines) take time.
 *
 * Score factors (weights inspired by real FICO categories):
 * - Payment history / paid-in-full
 * - Credit utilization vs available limit
 * - Unpaid balance burden on open loans
 * - Portion repaid (progress on open + lifetime)
 * - Speed of payoff / time open
 * - Due dates / on-time streaks & missed payments
 */

const SCORE_MIN = 300;
const SCORE_MAX = 850;
/** Thin-file / new borrower starting score (minimum / Poor). */
const BASE_SCORE = SCORE_MIN;
/** Borrowing limit at SCORE_MIN / SCORE_MAX. */
const LIMIT_AT_MIN_SCORE = 250;
const LIMIT_AT_MAX_SCORE = 100_000;
/**
 * Credit-limit curve exponent (>1 = slow early growth, steep only at high scores).
 * Higher ⇒ large lines of credit require nearer-to-perfect scores.
 */
const LIMIT_CURVE_EXPONENT = 2.75;
/**
 * Score mobility multipliers by band position (t=0 at 300, t=1 at 850).
 * Low scores: large gains/losses. High scores: sticky / hard to move.
 */
const MOBILITY_AT_MIN = 2.25;
const MOBILITY_AT_MAX = 0.18;
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

/** 0 at SCORE_MIN, 1 at SCORE_MAX. */
function scoreProgress(score) {
    return clamp((Number(score) - SCORE_MIN) / (SCORE_MAX - SCORE_MIN), 0, 1);
}

/**
 * How strongly a raw point of gain/loss applies at the current score.
 * Low score ≈ MOBILITY_AT_MIN, high score ≈ MOBILITY_AT_MAX.
 */
function mobilityAt(score) {
    const t = scoreProgress(score);
    return lerp(t, 0, 1, MOBILITY_AT_MIN, MOBILITY_AT_MAX);
}

/**
 * Apply a raw (unscaled) delta onto base with position-dependent mobility.
 * Walks point-by-point so climbing into high scores naturally slows down.
 */
function applyMobileDelta(baseScore, rawDelta) {
    let score = clamp(Number(baseScore) || BASE_SCORE, SCORE_MIN, SCORE_MAX);
    const delta = Number(rawDelta) || 0;
    if (delta === 0) return score;

    const direction = delta > 0 ? 1 : -1;
    // Sub-step for smoother integration when |delta| is large
    const steps = Math.min(400, Math.max(1, Math.round(Math.abs(delta))));
    const rawPerStep = Math.abs(delta) / steps;

    for (let i = 0; i < steps; i++) {
        const scale = mobilityAt(score);
        score += direction * rawPerStep * scale;
        score = clamp(score, SCORE_MIN, SCORE_MAX);
        // Early exit if pinned at a bound
        if (direction > 0 && score >= SCORE_MAX) break;
        if (direction < 0 && score <= SCORE_MIN) break;
    }
    return clamp(Math.round(score), SCORE_MIN, SCORE_MAX);
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

    // Provisional raw score (pre-mobility) only to estimate limit for utilization
    let provisionalRaw = 0;
    provisionalRaw += Math.min(175, paidLoans.length * 35);
    for (const loan of paidLoans) {
        provisionalRaw += quickPayoffBonus(loan);
    }
    const provisionalScore = applyMobileDelta(BASE_SCORE, provisionalRaw);
    const availableLimit = Math.max(
        LIMIT_AT_MIN_SCORE,
        Number(context.creditLimit) || creditLimitFromScore(provisionalScore)
    );

    let rawDelta = 0;
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

    // ----- 1. Payment history: fully paid loans + quick payoff -----
    // Later paid loans still count, but mobility will shrink their effect at high scores.
    let historyPts = Math.min(200, paidLoans.length * 28);
    let speedFromPaid = 0;
    for (const loan of paidLoans) {
        speedFromPaid += quickPayoffBonus(loan);
    }
    speedFromPaid = Math.min(70, speedFromPaid);
    breakdown.paymentHistory = historyPts;
    breakdown.speed += speedFromPaid;
    rawDelta += historyPts + speedFromPaid;

    // ----- 2. Utilization vs available credit limit -----
    if (!hasHistory) {
        breakdown.utilization = 0;
    } else if (!activeLoan) {
        breakdown.utilization = 70; // clean slate (smaller raw; mobility amplifies at low scores)
        rawDelta += 70;
    } else {
        const principal = Number(activeLoan.principal) || 0;
        const remaining = loanRemaining(activeLoan);
        const drawn = Math.max(principal, remaining);
        const utilization = availableLimit > 0 ? Math.min(1.5, drawn / availableLimit) : 1;
        // 0% util → +70, 50% → 0, 100% → -90, >100% → -120
        const utilPts = Math.round(70 - 160 * utilization);
        breakdown.utilization = clamp(utilPts, -120, 70);
        rawDelta += breakdown.utilization;
    }

    // ----- 3. Unpaid balance burden -----
    if (activeLoan) {
        const owed = Number(activeLoan.amount_owed) || 0;
        const remaining = loanRemaining(activeLoan);
        const unpaidRatio = owed > 0 ? remaining / owed : 1;
        const ratioPenalty = Math.round(-80 * unpaidRatio);
        const sizePenalty = -Math.min(40, Math.floor(remaining / 500));
        breakdown.unpaidBurden = ratioPenalty + sizePenalty;
        rawDelta += breakdown.unpaidBurden;
    }

    // ----- 4. Repayment progress gains -----
    if (activeLoan) {
        const owed = Number(activeLoan.amount_owed) || 0;
        const paid = Number(activeLoan.amount_paid) || 0;
        if (owed > 0 && paid > 0) {
            const portion = Math.min(1, paid / owed);
            const progressPts = Math.round(45 * portion);
            breakdown.repaymentProgress += progressPts;
            rawDelta += progressPts;
        }
    }
    const totalPaid = list.reduce((s, l) => s + (Number(l.amount_paid) || 0), 0);
    const totalOwedEver = list.reduce((s, l) => s + (Number(l.amount_owed) || 0), 0);
    if (totalOwedEver > 0) {
        const lifePortion = Math.min(1, totalPaid / totalOwedEver);
        const lifePts = Math.round(35 * lifePortion);
        breakdown.repaymentProgress += lifePts;
        rawDelta += lifePts;
    }

    // ----- 5. Speed / aging on open loans -----
    // History age is the main "takes time" lever into high bands.
    if (hasHistory) {
        let earliest = Date.now();
        for (const loan of list) {
            const t = new Date(loan.created_at).getTime();
            if (!isNaN(t) && t < earliest) earliest = t;
        }
        const weeks = Math.max(0, (Date.now() - earliest) / (7 * MS_PER_DAY));
        // Slower drip: ~1 pt / week, needs many weeks to matter after mobility compresses
        const agePts = Math.min(60, Math.floor(weeks * 1.0));
        breakdown.speed += agePts;
        rawDelta += agePts;
    }
    if (activeLoan && activeLoan.created_at) {
        const daysOpen = daysBetween(activeLoan.created_at, Date.now());
        const weeksLate = Math.max(0, (daysOpen - 7) / 7);
        const openPenalty = -Math.min(50, Math.floor(weeksLate * 3));
        breakdown.speed += openPenalty;
        rawDelta += openPenalty;
    }

    // ----- 6. New credit: open loan mild penalty until paid off -----
    if (activeLoan) {
        breakdown.newCredit = -15;
        rawDelta += -15;
    }

    // ----- 7. Due dates / on-time streaks & missed payments -----
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
    rawDelta += breakdown.paymentSchedule;

    return applyMobileDelta(BASE_SCORE, rawDelta);
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
 * Score 300 → 250, score 850 → 100,000 with a steep power curve so large
 * lines of credit require high scores built over time.
 */
function creditLimitFromScore(score) {
    const s = clamp(score, SCORE_MIN, SCORE_MAX);
    const t = scoreProgress(s);
    const shaped = Math.pow(t, LIMIT_CURVE_EXPONENT);
    const limit = LIMIT_AT_MIN_SCORE + (LIMIT_AT_MAX_SCORE - LIMIT_AT_MIN_SCORE) * shaped;
    return Math.max(LIMIT_AT_MIN_SCORE, Math.round(limit / 25) * 25);
}

/**
 * Recalculate current_limit for every row in credit_limits from stored credit_score.
 * @param {import('sqlite3').Database} db
 * @param {(err: Error|null, result?: { updated: number, total: number }) => void} callback
 */
function recalculateAllCreditLimits(db, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    db.all(
        'SELECT borrower_formbar_user_id AS user_id, credit_score, current_limit FROM credit_limits ORDER BY borrower_formbar_user_id ASC',
        [],
        (err, rows) => {
            if (err) return done(err);
            const list = rows || [];
            if (list.length === 0) return done(null, { updated: 0, total: 0 });

            let pending = list.length;
            let updated = 0;
            list.forEach((row) => {
                const score = row.credit_score != null ? Number(row.credit_score) : BASE_SCORE;
                const newLimit = creditLimitFromScore(score);
                db.run(
                    'UPDATE credit_limits SET current_limit = ? WHERE borrower_formbar_user_id = ?',
                    [newLimit, row.user_id],
                    function (updErr) {
                        if (!updErr && this.changes > 0) updated += 1;
                        if (updErr) {
                            console.error(`[recalc-limits] User ${row.user_id}:`, updErr.message);
                        } else {
                            console.log(
                                `[recalc-limits] User ${row.user_id}: score ${score}, limit ${row.current_limit} → ${newLimit}`
                            );
                        }
                        pending -= 1;
                        if (pending === 0) done(null, { updated, total: list.length });
                    }
                );
            });
        }
    );
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
    LIMIT_AT_MIN_SCORE,
    LIMIT_AT_MAX_SCORE,
    LIMIT_CURVE_EXPONENT,
    MOBILITY_AT_MIN,
    MOBILITY_AT_MAX,
    ORIGINATION_FEE_RATE,
    MIN_PAYMENT_RATE,
    MIN_PAYMENT_FLOOR,
    PAYMENT_PERIOD_DAYS,
    computeCreditScore,
    explainCreditScore,
    scoreLabel,
    scoreProgress,
    mobilityAt,
    applyMobileDelta,
    creditLimitFromScore,
    recalculateAllCreditLimits,
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
