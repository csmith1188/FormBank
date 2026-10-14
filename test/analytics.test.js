const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { migrate } = require('../db/migrate');
const { createLedger } = require('../lib/ledger');
const analytics = require('../lib/analytics');
const { getReconciliationReport } = require('../lib/reconcile');
const { parseDateRange } = require('../lib/analytics/dateRange');

describe('analytics filters and reports', () => {
    let db;
    let tmpPath;

    before(async () => {
        tmpPath = path.join(os.tmpdir(), `formbank-analytics-test-${Date.now()}.db`);
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
        const ledger = createLedger(db);

        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO credit_loans (borrower_formbar_user_id, principal, interest_rate, amount_owed, amount_paid, status)
                 VALUES (5, 100, 0.2, 120, 0, 'active')`,
                (err) => (err ? reject(err) : resolve())
            );
        });
        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO credit_limits (borrower_formbar_user_id, current_limit, paid_off_count) VALUES (5, 500, 0)`,
                (err) => (err ? reject(err) : resolve())
            );
        });
        await ledger.insertCompleted({
            idempotency_key: 'test:issue:1',
            type: 'loan_issue',
            counterparty_formbar_user_id: 5,
            related_loan_id: 1,
            requested_amount: 100,
            gross_transfer_amount: 100,
            tax_amount: 10,
            net_amount: 90
        });
        await ledger.insertCompleted({
            idempotency_key: 'test:fee:1',
            type: 'check_fee',
            actor_formbar_user_id: 5,
            fee_amount: 5,
            net_amount: 5,
            requested_amount: 5
        });
        await ledger.beginPending({
            idempotency_key: 'test:recon:1',
            type: 'loan_repay',
            actor_formbar_user_id: 5,
            requested_amount: 20,
            gross_transfer_amount: 20
        }).then((p) => ledger.markReconciliationRequired(p.id, 'timeout', 'timeout'));
    });

    after(() => new Promise((resolve) => {
        db.close(() => {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
            resolve();
        });
    }));

    it('parses date ranges', () => {
        const r = parseDateRange({ range: '7d' });
        assert.equal(r.range, '7d');
        assert.ok(r.from);
        assert.ok(r.to);
        const all = parseDateRange({ range: 'all' });
        assert.equal(all.from, null);
    });

    it('summary separates assets liabilities revenue', async () => {
        const summary = await analytics.getSummary(db, { from: null, to: null });
        assert.equal(summary.assets.outstandingPrincipal, 100);
        assert.equal(summary.assets.outstandingBalances, 120);
        assert.equal(summary.assets.availableFunds, null);
        assert.equal(summary.liabilities.borrowerCreditBalances, 0);
        assert.equal(summary.revenue.checkFeeRevenue, 5);
        assert.ok(summary.cashFlow.netRealizedProfit !== undefined);
    });

    it('loan analytics age buckets exist', async () => {
        const loans = await analytics.getLoanAnalytics(db, {});
        assert.equal(loans.activeCount, 1);
        assert.ok(loans.ageDistribution['0-7'] >= 0);
    });

    it('reconciliation surfaces unknown outcomes', async () => {
        const report = await getReconciliationReport(db);
        assert.ok(report.needsReconciliation >= 1);
        const kinds = report.alerts.map((a) => a.kind);
        assert.ok(kinds.includes('reconciliation_required') || kinds.includes('formbar_balance_unverified'));
    });

    it('CSV export omits secrets', async () => {
        const csv = await analytics.exportTransactions(db, {});
        assert.ok(csv.includes('type'));
        assert.ok(!csv.includes('idempotency_key'));
        assert.ok(!csv.toLowerCase().includes('pin'));
        assert.ok(csv.includes('loan_issue') || csv.includes('check_fee'));
    });
});
