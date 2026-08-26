/**
 * FormBank credit score model (FICO-like 300–850).
 *
 * Score is derived from loan history, then used to set:
 * - credit limit (higher score → more borrowing power)
 * - interest rate (higher score → cheaper loans)
 * - check fees (higher score → lower rate and minimum)
 */

const SCORE_MIN = 300;
const SCORE_MAX = 850;
/** Thin-file / new borrower starting score (Fair). */
const BASE_SCORE = 580;

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

function lerp(x, x0, x1, y0, y1) {
    if (x1 === x0) return y0;
    return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

/**
 * Compute a 300–850 credit score from loan records.
 *
 * Components (mirrors real scoring weights):
 * - Payment history (~35%): paid loans + progress on an open loan
 * - Amounts owed / utilization (~30%): share of open loan still unpaid
 * - Length of credit history (~15%): age of first loan
 * - Credit experience / volume (~10%): total digipogs repaid
 * - New credit (~10%): open active loan is a mild penalty
 *
 * @param {Array<{status: string, amount_paid?: number, amount_owed?: number, created_at?: string}>} loans
 * @returns {number}
 */
function computeCreditScore(loans) {
    const list = loans || [];
    const paidLoans = list.filter((l) => l.status === 'paid');
    const activeLoan = list.find((l) => l.status === 'active') || null;
    const hasHistory = list.length > 0;
    const totalRepaid = list.reduce((sum, l) => sum + (Number(l.amount_paid) || 0), 0);

    let score = BASE_SCORE;

    // Payment history (0–175)
    score += Math.min(175, paidLoans.length * 30);
    if (activeLoan && (Number(activeLoan.amount_paid) || 0) > 0) {
        score += 15;
    }

    // Amounts owed / utilization (0–120) — only once history exists
    // Full utilization still earns a base 60 (current account); paying down unlocks the rest.
    if (hasHistory) {
        if (!activeLoan) {
            score += 120;
        } else {
            const owed = Number(activeLoan.amount_owed) || 0;
            const paid = Number(activeLoan.amount_paid) || 0;
            const remaining = Math.max(0, owed - paid);
            const utilization = owed > 0 ? remaining / owed : 0;
            score += Math.round(60 + 60 * (1 - utilization));
        }
    }

    // Length of credit history (0–75): +1.5 pts per week since first loan
    if (hasHistory) {
        let earliest = Date.now();
        for (const loan of list) {
            const t = new Date(loan.created_at).getTime();
            if (!isNaN(t) && t < earliest) earliest = t;
        }
        const weeks = Math.max(0, (Date.now() - earliest) / (7 * 24 * 60 * 60 * 1000));
        score += Math.min(75, Math.floor(weeks * 1.5));
    }

    // Credit volume / experience (0–60): +1 per 50 digipogs repaid
    score += Math.min(60, Math.floor(totalRepaid / 50));

    // New credit / open account
    if (activeLoan) {
        score -= 20;
    }

    return clamp(Math.round(score), SCORE_MIN, SCORE_MAX);
}

function scoreLabel(score) {
    if (score >= 800) return 'Exceptional';
    if (score >= 740) return 'Very Good';
    if (score >= 670) return 'Good';
    if (score >= 580) return 'Fair';
    return 'Poor';
}

/**
 * Map score → borrowing limit (digipogs), rounded to nearest 25.
 * Poor ≈ 100–250, Fair ≈ 250–500, Good ≈ 500–1000,
 * Very Good ≈ 1000–2000, Exceptional ≈ 2000–3500.
 */
function creditLimitFromScore(score) {
    const s = clamp(score, SCORE_MIN, SCORE_MAX);
    let limit;
    if (s < 580) limit = lerp(s, 300, 580, 100, 250);
    else if (s < 670) limit = lerp(s, 580, 670, 250, 500);
    else if (s < 740) limit = lerp(s, 670, 740, 500, 1000);
    else if (s < 800) limit = lerp(s, 740, 800, 1000, 2000);
    else limit = lerp(s, 800, 850, 2000, 3500);
    return Math.max(100, Math.round(limit / 25) * 25);
}

/**
 * Interest rate on principal (one-shot at origination).
 * Score 300 → 30%, score 850 → 8%.
 */
function interestRateFromScore(score) {
    const s = clamp(score, SCORE_MIN, SCORE_MAX);
    const rate = 0.30 - ((s - 300) / 550) * 0.22;
    return Math.round(rate * 1000) / 1000;
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
 */
function getCreditTerms(loans) {
    const score = computeCreditScore(loans);
    const feeTerms = checkFeeTermsFromScore(score);
    return {
        score,
        scoreLabel: scoreLabel(score),
        creditLimit: creditLimitFromScore(score),
        interestRate: interestRateFromScore(score),
        checkFeeRate: feeTerms.rate,
        checkFeeMin: feeTerms.minFee
    };
}

module.exports = {
    SCORE_MIN,
    SCORE_MAX,
    BASE_SCORE,
    computeCreditScore,
    scoreLabel,
    creditLimitFromScore,
    interestRateFromScore,
    checkFeeTermsFromScore,
    checkFeeFromScore,
    getCreditTerms
};
