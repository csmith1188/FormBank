/**
 * Reset all users' credit limits / progress to the default starting limit.
 * Keeps credit_loans rows and financial_transactions (ledger) intact.
 *
 * Historical repayments are excluded from future limit growth by setting
 * repaid_baseline = current SUM(amount_paid) per borrower.
 *
 * Does not touch Formbar balances, deposit digipogs, or loan/ledger rows.
 *
 * Usage:
 *   npm run reset-credit
 *   npm run reset-credit -- --yes
 *   RESET_CREDIT_YES=1 npm run reset-credit
 */

require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const accounting = require('../lib/accounting');

const DB_PATH = path.join(__dirname, 'database.db');
const CREDIT_LIMIT_STEP = Math.max(
    1,
    parseInt(process.env.CREDIT_LIMIT_STEP, 10) || accounting.CREDIT_LIMIT_STEP_DEFAULT
);

const forceYes =
    process.argv.includes('--yes') ||
    process.argv.includes('-y') ||
    process.env.RESET_CREDIT_YES === '1';

function runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function getAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

async function tableExists(db, name) {
    const row = await getAsync(
        db,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [name]
    );
    return !!row;
}

async function columnExists(db, table, column) {
    const cols = await allAsync(db, `PRAGMA table_info(${table})`);
    return cols.some((c) => c.name === column);
}

async function ensureRepaidBaselineColumn(db) {
    if (!(await tableExists(db, 'credit_limits'))) {
        throw new Error('credit_limits table not found. Run npm run init-db (or start the app) first.');
    }
    if (!(await columnExists(db, 'credit_limits', 'repaid_baseline'))) {
        await runAsync(
            db,
            'ALTER TABLE credit_limits ADD COLUMN repaid_baseline INTEGER NOT NULL DEFAULT 0'
        );
        console.log('Added credit_limits.repaid_baseline column');
    }
}

async function confirmOrExit() {
    if (forceYes) {
        console.log(`Proceeding with credit reset (limit → ${CREDIT_LIMIT_STEP})…`);
        return;
    }
    if (!process.stdin.isTTY) {
        console.error('Refusing to reset without confirmation. Re-run with --yes (or RESET_CREDIT_YES=1).');
        process.exit(1);
    }
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
        rl.question(
            `Reset ALL credit limits to ${CREDIT_LIMIT_STEP} and paid_off_count to 0?\n` +
                'Loan rows and financial_transactions will be kept. Type YES to continue: ',
            resolve
        );
    });
    rl.close();
    if (String(answer).trim() !== 'YES') {
        console.log('Aborted.');
        process.exit(0);
    }
}

async function main() {
    await confirmOrExit();

    const db = new sqlite3.Database(DB_PATH);
    try {
        await ensureRepaidBaselineColumn(db);

        const hasLoans = await tableExists(db, 'credit_loans');
        const borrowers = await allAsync(
            db,
            hasLoans
                ? `
                SELECT DISTINCT borrower_formbar_user_id AS user_id FROM (
                    SELECT borrower_formbar_user_id FROM credit_limits
                    UNION
                    SELECT borrower_formbar_user_id FROM credit_loans
                )
                `
                : `SELECT borrower_formbar_user_id AS user_id FROM credit_limits`
        );

        let updated = 0;
        let inserted = 0;

        for (const { user_id: userId } of borrowers) {
            let baseline = 0;
            if (hasLoans) {
                const sumRow = await getAsync(
                    db,
                    `SELECT COALESCE(SUM(amount_paid), 0) AS total_repaid
                     FROM credit_loans WHERE borrower_formbar_user_id = ?`,
                    [userId]
                );
                baseline = sumRow && typeof sumRow.total_repaid === 'number' ? sumRow.total_repaid : 0;
            }

            const existing = await getAsync(
                db,
                'SELECT borrower_formbar_user_id FROM credit_limits WHERE borrower_formbar_user_id = ?',
                [userId]
            );

            if (existing) {
                await runAsync(
                    db,
                    `UPDATE credit_limits
                     SET current_limit = ?, paid_off_count = 0, repaid_baseline = ?
                     WHERE borrower_formbar_user_id = ?`,
                    [CREDIT_LIMIT_STEP, baseline, userId]
                );
                updated += 1;
            } else {
                await runAsync(
                    db,
                    `INSERT INTO credit_limits
                     (borrower_formbar_user_id, current_limit, paid_off_count,
                      deposit_posted, deposit_held, deposit_refunded, repaid_baseline)
                     VALUES (?, ?, 0, 0, 0, 0, ?)`,
                    [userId, CREDIT_LIMIT_STEP, baseline]
                );
                inserted += 1;
            }
        }

        console.log(
            `Credit reset complete. Default limit=${CREDIT_LIMIT_STEP}. ` +
                `Updated ${updated} row(s), inserted ${inserted} row(s). ` +
                'Loan history and financial_transactions unchanged.'
        );
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error('reset-credit failed:', err);
    process.exit(1);
});
