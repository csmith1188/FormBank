/**
 * Repeatable SQLite migrations for FormBank.
 * Applies SQL files in db/migrations/ in sorted order, then runs data backfill once.
 */

const fs = require('fs');
const path = require('path');
const accounting = require('../lib/accounting');
const { createLedger } = require('../lib/ledger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
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

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function execAsync(db, sql) {
    return new Promise((resolve, reject) => {
        db.exec(sql, (err) => (err ? reject(err) : resolve()));
    });
}

async function ensureMigrationsTable(db) {
    await execAsync(db, `
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

async function columnExists(db, table, column) {
    const cols = await allAsync(db, `PRAGMA table_info(${table})`);
    return cols.some((c) => c.name === column);
}

async function applySchemaFixes(db) {
    // cashed_at on checks (forward-only redeem timestamp)
    if (!(await columnExists(db, 'checks', 'cashed_at'))) {
        await runAsync(db, 'ALTER TABLE checks ADD COLUMN cashed_at DATETIME');
    }

    // Resolve duplicate active loans before unique index (keep newest)
    const dupes = await allAsync(db, `
        SELECT borrower_formbar_user_id, COUNT(*) AS cnt
        FROM credit_loans WHERE status = 'active'
        GROUP BY borrower_formbar_user_id HAVING cnt > 1
    `);
    for (const d of dupes) {
        const loans = await allAsync(db,
            `SELECT id FROM credit_loans WHERE borrower_formbar_user_id = ? AND status = 'active' ORDER BY id DESC`,
            [d.borrower_formbar_user_id]
        );
        for (let i = 1; i < loans.length; i++) {
            await runAsync(db,
                `UPDATE credit_loans SET status = 'superseded' WHERE id = ?`,
                [loans[i].id]
            );
            console.warn(`Migration: marked duplicate active loan ${loans[i].id} as superseded`);
        }
    }

    await runAsync(db, `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_loan
        ON credit_loans(borrower_formbar_user_id) WHERE status = 'active'
    `);

    await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_loans_borrower ON credit_loans(borrower_formbar_user_id)');
    await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_loans_status ON credit_loans(status)');
    await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_checks_status ON checks(status)');
    await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_checks_sender ON checks(sender_formbar_user_id)');
    await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_checks_receiver ON checks(receiver_formbar_user_id)');
}

/**
 * Backfill ledger from existing loans/checks without inventing unknown cash movements.
 */
async function backfillLedger(db) {
    const flag = await getAsync(db, `SELECT name FROM schema_migrations WHERE name = ?`, ['backfill_ledger_v1']);
    if (flag) return;

    const ledger = createLedger(db);
    const loans = await allAsync(db, 'SELECT * FROM credit_loans ORDER BY id ASC');

    for (const loan of loans) {
        const net = accounting.netAfterTax(loan.principal);
        const tax = accounting.taxOnGross(loan.principal);
        await ledger.insertCompleted({
            idempotency_key: `legacy:loan_issue:${loan.id}`,
            type: 'loan_issue',
            actor_formbar_user_id: null,
            counterparty_formbar_user_id: loan.borrower_formbar_user_id,
            related_loan_id: loan.id,
            requested_amount: loan.principal,
            gross_transfer_amount: loan.principal,
            net_amount: net,
            tax_amount: tax,
            created_at: loan.created_at,
            metadata: { legacy: true }
        });

        if (loan.amount_paid > 0) {
            const split = accounting.allocateRepayment(loan.principal, 0, loan.amount_paid);
            await ledger.insertCompleted({
                idempotency_key: `legacy:loan_repay:${loan.id}`,
                type: 'loan_repay',
                actor_formbar_user_id: loan.borrower_formbar_user_id,
                counterparty_formbar_user_id: null,
                related_loan_id: loan.id,
                requested_amount: loan.amount_paid,
                gross_transfer_amount: loan.amount_paid,
                net_amount: accounting.netAfterTax(loan.amount_paid),
                tax_amount: accounting.taxOnGross(loan.amount_paid),
                principal_component: split.principalComponent,
                interest_component: split.interestComponent,
                created_at: loan.paid_at || loan.created_at,
                metadata: { legacy: true, legacy_aggregate: true }
            });
        }
    }

    const checks = await allAsync(db, 'SELECT * FROM checks ORDER BY id ASC');
    for (const check of checks) {
        const groupId = `legacy:check:${check.id}`;
        const fee = check.fee_charged || accounting.calcCheckFee(check.amount);
        const charge = accounting.checkChargeToFormBank(check.amount);
        const payout = accounting.checkPayoutFromFormBank(check.amount);
        const depositTax = accounting.taxOnGross(charge);
        const payoutTax = accounting.taxOnGross(payout);

        if (check.status === 'uncashed' || check.status === 'completed' || check.status === 'funded_unpaid') {
            await ledger.insertCompleted({
                idempotency_key: `legacy:check_deposit:${check.id}`,
                type: 'check_deposit',
                actor_formbar_user_id: check.sender_formbar_user_id,
                counterparty_formbar_user_id: null,
                related_check_id: check.id,
                parent_group_id: groupId,
                requested_amount: check.amount,
                gross_transfer_amount: charge,
                net_amount: accounting.netAfterTax(charge),
                tax_amount: depositTax,
                fee_amount: fee,
                created_at: check.created_at,
                metadata: { legacy: true }
            });
            await ledger.insertCompleted({
                idempotency_key: `legacy:check_fee:${check.id}`,
                type: 'check_fee',
                actor_formbar_user_id: check.sender_formbar_user_id,
                related_check_id: check.id,
                parent_group_id: groupId,
                requested_amount: fee,
                gross_transfer_amount: 0,
                net_amount: fee,
                fee_amount: fee,
                created_at: check.created_at,
                metadata: { legacy: true }
            });
            if (depositTax > 0) {
                await ledger.insertCompleted({
                    idempotency_key: `legacy:check_deposit_tax:${check.id}`,
                    type: 'formbar_tax',
                    actor_formbar_user_id: check.sender_formbar_user_id,
                    related_check_id: check.id,
                    parent_group_id: groupId,
                    requested_amount: depositTax,
                    gross_transfer_amount: charge,
                    tax_amount: depositTax,
                    created_at: check.created_at,
                    metadata: { legacy: true, leg: 'deposit' }
                });
            }
        }

        if (check.status === 'completed') {
            await ledger.insertCompleted({
                idempotency_key: `legacy:check_payout:${check.id}`,
                type: 'check_payout',
                actor_formbar_user_id: null,
                counterparty_formbar_user_id: check.receiver_formbar_user_id,
                related_check_id: check.id,
                parent_group_id: groupId,
                requested_amount: check.amount,
                gross_transfer_amount: payout,
                net_amount: check.amount,
                tax_amount: payoutTax,
                created_at: check.cashed_at || check.created_at,
                metadata: { legacy: true }
            });
            if (payoutTax > 0) {
                await ledger.insertCompleted({
                    idempotency_key: `legacy:check_payout_tax:${check.id}`,
                    type: 'formbar_tax',
                    counterparty_formbar_user_id: check.receiver_formbar_user_id,
                    related_check_id: check.id,
                    parent_group_id: groupId,
                    requested_amount: payoutTax,
                    gross_transfer_amount: payout,
                    tax_amount: payoutTax,
                    created_at: check.cashed_at || check.created_at,
                    metadata: { legacy: true, leg: 'payout' }
                });
            }
        }

        // Historical failed checks: do not invent successful deposits
        if (check.status === 'failed') {
            await ledger.insertCompleted({
                idempotency_key: `legacy:check_failed:${check.id}`,
                type: 'check_deposit',
                status: 'failed',
                actor_formbar_user_id: check.sender_formbar_user_id,
                counterparty_formbar_user_id: check.receiver_formbar_user_id,
                related_check_id: check.id,
                parent_group_id: groupId,
                requested_amount: check.amount,
                gross_transfer_amount: charge,
                fee_amount: fee,
                formbar_outcome: 'unknown',
                created_at: check.created_at,
                metadata: { legacy: true, ambiguous_failed_check: true }
            });
        }
    }

    await runAsync(db, `INSERT INTO schema_migrations (name) VALUES (?)`, ['backfill_ledger_v1']);
    console.log('Ledger backfill completed');
}

async function migrate(db) {
    await ensureMigrationsTable(db);

    if (!fs.existsSync(MIGRATIONS_DIR)) {
        fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
    }

    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        const applied = await getAsync(db, `SELECT name FROM schema_migrations WHERE name = ?`, [file]);
        if (applied) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        await execAsync(db, sql);
        await runAsync(db, `INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)`, [file]);
        console.log(`Applied migration: ${file}`);
    }

    await applySchemaFixes(db);
    await backfillLedger(db);
}

module.exports = { migrate };
