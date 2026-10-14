const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { createLedger } = require('../lib/ledger');
const { migrate } = require('../db/migrate');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('ledger', () => {
    let db;
    let ledger;
    let tmpPath;

    before(async () => {
        tmpPath = path.join(os.tmpdir(), `formbank-ledger-test-${Date.now()}.db`);
        db = new sqlite3.Database(tmpPath);
        await new Promise((resolve, reject) => {
            db.exec(`
                CREATE TABLE credit_loans (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    borrower_formbar_user_id INTEGER NOT NULL,
                    principal INTEGER NOT NULL,
                    interest_rate REAL DEFAULT 0.20,
                    amount_owed INTEGER NOT NULL,
                    amount_paid INTEGER DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    paid_at DATETIME
                );
                CREATE TABLE credit_limits (
                    borrower_formbar_user_id INTEGER PRIMARY KEY,
                    current_limit INTEGER DEFAULT 500,
                    paid_off_count INTEGER DEFAULT 0
                );
                CREATE TABLE checks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sender_formbar_user_id INTEGER NOT NULL,
                    receiver_formbar_user_id INTEGER,
                    amount INTEGER NOT NULL,
                    fee_charged INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'failed',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    memo TEXT,
                    pin_for_redemption TEXT
                );
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username VARCHAR(50) UNIQUE NOT NULL,
                    formbar_id INTEGER UNIQUE
                );
            `, (err) => (err ? reject(err) : resolve()));
        });
        await migrate(db);
        ledger = createLedger(db);
    });

    after(() => new Promise((resolve) => {
        db.close(() => {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
            resolve();
        });
    }));

    it('beginPending is idempotent', async () => {
        const a = await ledger.beginPending({
            idempotency_key: 'test:idem:1',
            type: 'loan_issue',
            requested_amount: 100,
            gross_transfer_amount: 100
        });
        const b = await ledger.beginPending({
            idempotency_key: 'test:idem:1',
            type: 'loan_issue',
            requested_amount: 100,
            gross_transfer_amount: 100
        });
        assert.equal(a.existing, false);
        assert.equal(b.existing, true);
        assert.equal(a.id, b.id);
    });

    it('marks completed, failed, and reconciliation_required', async () => {
        const p = await ledger.beginPending({
            idempotency_key: 'test:states:1',
            type: 'loan_repay',
            requested_amount: 50,
            gross_transfer_amount: 50
        });
        await ledger.markCompleted(p.id);
        let row = await ledger.findByIdempotencyKey('test:states:1');
        assert.equal(row.status, 'completed');

        const p2 = await ledger.beginPending({
            idempotency_key: 'test:states:2',
            type: 'loan_repay',
            requested_amount: 50,
            gross_transfer_amount: 50
        });
        await ledger.markFailed(p2.id, 'no funds', 'failure');
        row = await ledger.findByIdempotencyKey('test:states:2');
        assert.equal(row.status, 'failed');
        assert.equal(row.formbar_outcome, 'failure');

        const p3 = await ledger.beginPending({
            idempotency_key: 'test:states:3',
            type: 'loan_repay',
            requested_amount: 50,
            gross_transfer_amount: 50
        });
        await ledger.markReconciliationRequired(p3.id, 'timeout', 'timeout');
        row = await ledger.findByIdempotencyKey('test:states:3');
        assert.equal(row.status, 'reconciliation_required');
        assert.equal(row.formbar_outcome, 'timeout');
    });

    it('simulates Formbar OK then domain failure as reconciliation', async () => {
        const p = await ledger.beginPending({
            idempotency_key: 'test:dbfail:1',
            type: 'loan_repay',
            related_loan_id: 1,
            requested_amount: 25,
            gross_transfer_amount: 25,
            principal_component: 25,
            interest_component: 0
        });
        await ledger.markReconciliationRequired(
            p.id,
            'Formbar transfer succeeded but loan payment update failed',
            'success'
        );
        const row = await ledger.findByIdempotencyKey('test:dbfail:1');
        assert.equal(row.status, 'reconciliation_required');
        assert.equal(row.formbar_outcome, 'success');
    });

    it('tracks check deposit without payout as funded obligation', async () => {
        const checkId = await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO checks (sender_formbar_user_id, receiver_formbar_user_id, amount, fee_charged, status)
                 VALUES (10, 20, 100, 5, 'funded_unpaid')`,
                function (err) {
                    if (err) return reject(err);
                    resolve(this.lastID);
                }
            );
        });
        await ledger.insertCompleted({
            idempotency_key: `test:dep:${checkId}`,
            type: 'check_deposit',
            related_check_id: checkId,
            actor_formbar_user_id: 10,
            requested_amount: 100,
            gross_transfer_amount: 130,
            fee_amount: 5
        });
        const payoutPending = await ledger.beginPending({
            idempotency_key: `test:pay:${checkId}`,
            type: 'check_payout',
            related_check_id: checkId,
            counterparty_formbar_user_id: 20,
            requested_amount: 100,
            gross_transfer_amount: 112
        });
        await ledger.markFailed(payoutPending.id, 'payout failed', 'failure');

        const deposit = await ledger.findByIdempotencyKey(`test:dep:${checkId}`);
        const payout = await ledger.findByIdempotencyKey(`test:pay:${checkId}`);
        assert.equal(deposit.status, 'completed');
        assert.equal(payout.status, 'failed');

        const check = await new Promise((resolve, reject) => {
            db.get('SELECT status FROM checks WHERE id = ?', [checkId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        assert.equal(check.status, 'funded_unpaid');
    });
});
