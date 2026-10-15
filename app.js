// Imports
require('dotenv').config();
const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const session = require('express-session');
const { io } = require('socket.io-client');
const sqlite3 = require('sqlite3').verbose();
const SQLiteStore = require('connect-sqlite3')(session);
const formbarApi = require('./formbarApi');
const QRCode = require('qrcode');
const accounting = require('./lib/accounting');
const { createLedger } = require('./lib/ledger');
const { migrate } = require('./db/migrate');
const { getReconciliationReport } = require('./lib/reconcile');
const analytics = require('./lib/analytics');
const adminEdits = require('./lib/adminEdits');
const ebankAnalytics = require('./lib/analytics/ebank');

let ledger = null;

// Database setup
const db = new sqlite3.Database('./db/database.db', (err) => {
    if (err) {
        console.error('Error connecting to database:', err);
    } else {
        console.log('Connected to database');
        db.run(
            'CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_formbar_user_id INTEGER NOT NULL, receiver_formbar_user_id INTEGER, amount INTEGER NOT NULL, fee_charged INTEGER NOT NULL, status TEXT NOT NULL DEFAULT \'failed\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, memo TEXT, pin_for_redemption TEXT)',
            (err) => {
                if (err) return console.error('Error ensuring checks table:', err);
                db.all('PRAGMA table_info(checks)', (err, cols) => {
                    if (err || !cols) return;
                    const receiverCol = cols.find(c => c.name === 'receiver_formbar_user_id');
                    const hasPinCol = cols.some(c => c.name === 'pin_for_redemption');
                    if (receiverCol && receiverCol.notnull === 1) {
                        db.serialize(() => {
                            db.run('ALTER TABLE checks RENAME TO checks_backup');
                            db.run('CREATE TABLE checks (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_formbar_user_id INTEGER NOT NULL, receiver_formbar_user_id INTEGER, amount INTEGER NOT NULL, fee_charged INTEGER NOT NULL, status TEXT NOT NULL DEFAULT \'failed\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, memo TEXT, pin_for_redemption TEXT)');
                            db.run('INSERT INTO checks (id, sender_formbar_user_id, receiver_formbar_user_id, amount, fee_charged, status, created_at, memo) SELECT id, sender_formbar_user_id, receiver_formbar_user_id, amount, fee_charged, status, created_at, memo FROM checks_backup');
                            db.run('DROP TABLE checks_backup', () => { });
                        });
                    } else if (!hasPinCol) {
                        db.run('ALTER TABLE checks ADD COLUMN pin_for_redemption TEXT', () => { });
                    }
                });
            }
        );
        // Ensure users table has formbar_id for ID → username cache
        db.run(
            'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username VARCHAR(50) UNIQUE NOT NULL, formbar_id INTEGER UNIQUE)',
            (err) => {
                if (err) return console.error('Error ensuring users table:', err);
                db.all('PRAGMA table_info(users)', (err, cols) => {
                    if (err || !cols) return;
                    if (!cols.some(c => c.name === 'formbar_id')) {
                        db.run('ALTER TABLE users ADD COLUMN formbar_id INTEGER', (alterErr) => {
                            if (alterErr) return console.error('Error adding formbar_id to users:', alterErr);
                            db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_formbar_id ON users(formbar_id)', () => { });
                        });
                    } else {
                        db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_formbar_id ON users(formbar_id)', () => { });
                    }
                });
            }
        );
        migrate(db)
            .then(() => {
                ledger = createLedger(db);
                console.log('Database migrations applied');
            })
            .catch((migErr) => {
                console.error('Migration error:', migErr);
            });
    }
});

//Constants
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'your_secret_key';
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:420';
const THIS_URL = process.env.THIS_URL || `http://localhost:${PORT}`;
const LOGIN_REDIRECT_URL = `${THIS_URL}/login`;
const API_KEY = process.env.API_KEY || 'your_api_key';
const LENDER_USER_ID = parseInt(process.env.LENDER_USER_ID) || 1;
const LENDER_PIN = parseInt(process.env.LENDER_PIN) || 3639; // PIN must be a number per Formbar docs
/** Formbar user ID for eBank analytics (transaction history source). */
const EBANK_USER_ID = Math.max(1, parseInt(process.env.EBANK_USER_ID, 10) || 28);
/** Formbar digipog pool for check deposits/payouts. Blank/0 falls back to the lender user. */
const POOL_ID = parseInt(process.env.POOL_ID, 10);
const USE_CHECK_POOL = Number.isInteger(POOL_ID) && POOL_ID > 0;
const CHECK_FUNDS = USE_CHECK_POOL
    ? { id: POOL_ID, type: 'pool' }
    : { id: LENDER_USER_ID, type: 'user' };
const CHECK_FUNDS_LABEL = USE_CHECK_POOL ? 'FormBank pool' : 'FormBank';
/** Starting credit limit and amount added each time the repayment threshold is met. */
const CREDIT_LIMIT_STEP = Math.max(1, parseInt(process.env.CREDIT_LIMIT_STEP, 10) || 500);
/** Public Formbar origin for profile links (defaults to production Formbar). */
const FORMBAR_URL = (process.env.FORMBAR_URL || 'https://formbar.yorktechapps.com')
    .replace(/\/oauth\/?$/, '')
    .replace(/\/$/, '') || 'https://formbar.yorktechapps.com';
/** API base for user lookups (same Formbar instance as OAuth when FORMBAR_URL unset). */
const FORMBAR_API_URL = (process.env.FORMBAR_URL || process.env.AUTH_URL || FORMBAR_URL)
    .replace(/\/oauth\/?$/, '')
    .replace(/\/$/, '') || FORMBAR_URL;

// Middleware
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Render a Formbar profile link for a user ID (username from map, or User #id fallback). */
app.locals.formbarUserLink = function (formbarUserId, userNames) {
    if (formbarUserId == null || formbarUserId === '') return 'Anyone (uncashed)';
    const id = Number(formbarUserId);
    const name = (userNames && (userNames[id] || userNames[String(id)])) || `User #${id}`;
    const url = `${FORMBAR_URL}/profile/${id}`;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>`;
};

app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: './db' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false
}))

function isAuthenticated(req, res, next) {
    if (req.session.user) next()
    else res.redirect('/login')
}

// Database helper functions for credit system
function getCreditLimit(userId, callback) {
    db.get('SELECT current_limit, paid_off_count FROM credit_limits WHERE borrower_formbar_user_id = ?', [userId], (err, row) => {
        if (err) return callback(err, null);
        if (!row) {
            // Initialize with default limit
            db.run('INSERT INTO credit_limits (borrower_formbar_user_id, current_limit, paid_off_count) VALUES (?, ?, 0)', [userId, CREDIT_LIMIT_STEP], function (err) {
                if (err) return callback(err, null);
                callback(null, { current_limit: CREDIT_LIMIT_STEP, paid_off_count: 0 });
            });
        } else {
            callback(null, row);
        }
    });
}

function getActiveLoan(userId, callback) {
    db.get('SELECT * FROM credit_loans WHERE borrower_formbar_user_id = ? AND status = ?', [userId, 'active'], callback);
}

function getLoanHistory(userId, callback) {
    db.all('SELECT * FROM credit_loans WHERE borrower_formbar_user_id = ? ORDER BY created_at DESC', [userId], callback);
}

function createLoan(userId, principal, callback) {
    const interestRate = accounting.LOAN_INTEREST_RATE;
    const amountOwed = accounting.loanAmountOwed(principal);
    db.run(
        'INSERT INTO credit_loans (borrower_formbar_user_id, principal, interest_rate, amount_owed, amount_paid, status) VALUES (?, ?, ?, ?, 0, ?)',
        [userId, principal, interestRate, amountOwed, 'active'],
        function (err) {
            if (err) return callback(err, null);
            callback(null, { id: this.lastID, principal, amountOwed });
        }
    );
}

function updateLoanPayment(loanId, additionalPayment, callback) {
    db.get('SELECT amount_paid, amount_owed FROM credit_loans WHERE id = ?', [loanId], (err, loan) => {
        if (err) return callback(err);
        const newAmountPaid = loan.amount_paid + additionalPayment;
        const isPaid = newAmountPaid >= loan.amount_owed;

        const updateData = {
            amount_paid: newAmountPaid,
            status: isPaid ? 'paid' : 'active',
            paid_at: isPaid ? new Date().toISOString() : null
        };

        db.run(
            'UPDATE credit_loans SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?',
            [updateData.amount_paid, updateData.status, updateData.paid_at, loanId],
            function (err) {
                if (err) return callback(err);
                callback(null, { isPaid, newAmountPaid, amountOwed: loan.amount_owed });
            }
        );
    });
}

// Recalculate credit limit based on total repayments.
// Credit limit starts at CREDIT_LIMIT_STEP and increases by +CREDIT_LIMIT_STEP whenever
// the user's total repayments reach their current credit limit.
function updateCreditLimitFromRepayments(userId, callback) {
    getCreditLimit(userId, (err, limitRow) => {
        if (err) return callback(err, null);

        db.get(
            'SELECT COALESCE(SUM(amount_paid), 0) AS total_repaid FROM credit_loans WHERE borrower_formbar_user_id = ?',
            [userId],
            (err, row) => {
                if (err) return callback(err, null);

                const totalRepaid = row && typeof row.total_repaid === 'number'
                    ? row.total_repaid
                    : 0;

                const progress = accounting.computeCreditLimitProgress(
                    CREDIT_LIMIT_STEP,
                    limitRow.current_limit,
                    limitRow.paid_off_count || 0,
                    totalRepaid
                );

                if (progress.increments === 0) {
                    return callback(null, {
                        increased: false,
                        increments: 0,
                        newLimit: progress.newLimit
                    });
                }

                const previousLimit = limitRow.current_limit;
                db.run(
                    'UPDATE credit_limits SET current_limit = ?, paid_off_count = ? WHERE borrower_formbar_user_id = ?',
                    [progress.newLimit, progress.newIncreaseCount, userId],
                    (err) => {
                        if (err) return callback(err, null);
                        if (ledger) {
                            const bump = progress.newLimit - previousLimit;
                            ledger.insertCompleted({
                                idempotency_key: `credit_limit:${userId}:${progress.newIncreaseCount}`,
                                type: 'credit_limit_change',
                                actor_formbar_user_id: userId,
                                requested_amount: bump,
                                gross_transfer_amount: 0,
                                net_amount: bump,
                                metadata: {
                                    previousLimit,
                                    newLimit: progress.newLimit,
                                    increments: progress.increments,
                                    totalRepaid
                                }
                            }).catch((ledgerErr) => {
                                console.error('Failed to record credit_limit_change:', ledgerErr.message);
                            });
                        }
                        callback(null, {
                            increased: true,
                            increments: progress.increments,
                            newLimit: progress.newLimit
                        });
                    }
                );
            }
        );
    });
}

const sendAmountForNet = accounting.sendAmountForNet;
const calcCheckFee = accounting.calcCheckFee;
const checkPayoutFromFormBank = accounting.checkPayoutFromFormBank;
const checkChargeToFormBank = accounting.checkChargeToFormBank;

/**
 * Pay a funded check from FormBank (pool if POOL_ID is set, otherwise the lender user).
 * Payouts use `LENDER_PIN` (pool owner PIN, or lender PIN).
 * @returns {Promise<{success: boolean, error?: string}>}
 */
function payCheckFromFormBank(check, receiverId) {
    const payout = checkPayoutFromFormBank(check.amount);
    const memo = check.memo
        ? `Check #${check.id}: ${check.memo}`
        : `Check #${check.id} payout`;
    return formbarApi.transferDigipogs(
        socket,
        CHECK_FUNDS,
        receiverId,
        payout,
        memo,
        LENDER_PIN
    );
}

function createCheck(senderId, receiverId, amount, fee, status, memo, pinForRedemption, callback) {
    if (typeof pinForRedemption === 'function') {
        callback = pinForRedemption;
        pinForRedemption = null;
    }
    db.run(
        'INSERT INTO checks (sender_formbar_user_id, receiver_formbar_user_id, amount, fee_charged, status, memo, pin_for_redemption) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [senderId, receiverId == null ? null : receiverId, amount, fee, status, memo || null, pinForRedemption || null],
        function (err) {
            if (err) return callback(err, null);
            callback(null, { id: this.lastID });
        }
    );
}

function clearCheckPin(checkId, callback) {
    db.run('UPDATE checks SET pin_for_redemption = NULL WHERE id = ?', [checkId], callback || (() => { }));
}

function getChecksForUser(userId, callback) {
    db.all(
        'SELECT * FROM checks WHERE sender_formbar_user_id = ? OR (receiver_formbar_user_id = ? AND status = ?) ORDER BY created_at DESC',
        [userId, userId, 'completed'],
        callback
    );
}

/** All checks system-wide (admin). */
function getAllChecks(callback) {
    db.all('SELECT * FROM checks ORDER BY created_at DESC', [], callback);
}

function getCheckById(id, callback) {
    db.get('SELECT * FROM checks WHERE id = ?', [id], callback);
}

function claimUncashedCheck(checkId, userId, callback) {
    db.run(
        'UPDATE checks SET receiver_formbar_user_id = ? WHERE id = ? AND receiver_formbar_user_id IS NULL',
        [userId, checkId],
        function (err) {
            if (err) return callback(err, false);
            callback(null, this.changes > 0);
        }
    );
}

function setCheckStatus(checkId, status, callback) {
    if (status === 'completed') {
        db.run(
            'UPDATE checks SET status = ?, cashed_at = COALESCE(cashed_at, CURRENT_TIMESTAMP) WHERE id = ?',
            [status, checkId],
            callback
        );
    } else {
        db.run('UPDATE checks SET status = ? WHERE id = ?', [status, checkId], callback);
    }
}

/** Top N borrowers by current credit limit. */
function getTopCreditLimits(limit, callback) {
    const n = Math.max(1, parseInt(limit, 10) || 50);
    db.all(
        'SELECT borrower_formbar_user_id AS user_id, current_limit, paid_off_count ' +
        'FROM credit_limits ORDER BY current_limit DESC, paid_off_count DESC, borrower_formbar_user_id ASC LIMIT ?',
        [n],
        (err, rows) => {
            if (err) return callback(err, null);
            callback(null, rows || []);
        }
    );
}

/** Upsert local users cache keyed by Formbar ID + display name. */
function upsertFormbarUser(formbarId, displayName, callback) {
    const done = typeof callback === 'function' ? callback : () => { };
    if (formbarId == null || !displayName) return done();

    db.get('SELECT id FROM users WHERE formbar_id = ?', [formbarId], (err, byFormbar) => {
        if (err) return done(err);
        if (byFormbar) {
            return db.run('UPDATE users SET username = ? WHERE id = ?', [displayName, byFormbar.id], done);
        }
        db.get('SELECT id, formbar_id FROM users WHERE username = ?', [displayName], (err2, byName) => {
            if (err2) return done(err2);
            if (byName) {
                if (byName.formbar_id == null) {
                    return db.run('UPDATE users SET formbar_id = ? WHERE id = ?', [formbarId, byName.id], done);
                }
            }
            db.run(
                'INSERT INTO users (username, formbar_id) VALUES (?, ?)',
                [displayName, formbarId],
                (insertErr) => {
                    if (!insertErr) return done();
                    db.run(
                        'UPDATE users SET username = ? WHERE formbar_id = ?',
                        [displayName, formbarId],
                        done
                    );
                }
            );
        });
    });
}

/** Resolve display names for Formbar user IDs (local cache, then Formbar API). */
async function resolveUserNames(ids) {
    const unique = [...new Set(
        (ids || [])
            .filter(id => id != null && id !== '')
            .map(id => Number(id))
            .filter(id => !isNaN(id) && id > 0)
    )];
    const names = {};
    if (unique.length === 0) return names;

    await Promise.all(unique.map(async (id) => {
        const cached = await new Promise((resolve) => {
            db.get('SELECT username FROM users WHERE formbar_id = ?', [id], (err, row) => {
                resolve(err || !row ? null : row.username);
            });
        });
        if (cached) {
            names[id] = cached;
            return;
        }
        const remote = await formbarApi.getUserById(FORMBAR_API_URL, API_KEY, id);
        if (remote && remote.displayName) {
            names[id] = remote.displayName;
            upsertFormbarUser(id, remote.displayName);
        }
    }));

    return names;
}

// Routes
app.get('/', isAuthenticated, (req, res) => {
    const userId = req.session.userId;
    res.render('index', {
        user: req.session.user,
        isAdmin: userId === LENDER_USER_ID
    });
});

app.get('/login', (req, res) => {
    if (req.query.token) {
        let tokenData = jwt.decode(req.query.token);
        req.session.token = tokenData;
        req.session.user = tokenData.displayName;
        req.session.userId = tokenData.id; // Store Formbar user ID

        upsertFormbarUser(tokenData.id, tokenData.displayName, function (err) {
            if (err) {
                return console.error(err.message);
            }
            console.log(`User ${tokenData.displayName} (Formbar ID ${tokenData.id}) saved to database.`);
        });

        res.redirect('/');

    } else {
        res.redirect(`${AUTH_URL}/oauth?redirectURL=${LOGIN_REDIRECT_URL}`);
    };
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Admin routes (default user only)
function requireAdmin(req, res) {
    const userId = req.session.userId;
    if (!userId) {
        res.status(400).send('User ID not found in session');
        return null;
    }
    if (userId !== LENDER_USER_ID) {
        res.status(403).send('Admin panel is only available to the default user.');
        return null;
    }
    return userId;
}

app.get('/admin', isAuthenticated, (req, res) => {
    const userId = requireAdmin(req, res);
    if (!userId) return;

    db.all(
        'SELECT borrower_formbar_user_id AS user_id, current_limit, paid_off_count ' +
        'FROM credit_limits ' +
        'ORDER BY user_id ASC',
        [],
        (err, rows) => {
            if (err) {
                console.error('Error loading admin data:', err);
                return res.status(500).send('Error loading admin data');
            }
            db.all(
                `SELECT id, borrower_formbar_user_id, principal, amount_owed, amount_paid, status, created_at, paid_at
                 FROM credit_loans
                 WHERE status IN ('active', 'paid', 'void', 'superseded')
                 ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END, created_at DESC
                 LIMIT 200`,
                [],
                (loanErr, loanRows) => {
                    if (loanErr) {
                        console.error('Error loading admin loans:', loanErr);
                        return res.status(500).send('Error loading admin data');
                    }
                    const users = rows || [];
                    const loans = loanRows || [];
                    const ids = users.map(u => u.user_id)
                        .concat(loans.map(l => l.borrower_formbar_user_id))
                        .concat([userId]);
                    resolveUserNames(ids).then((userNames) => {
                        res.render('admin', {
                            user: req.session.user,
                            userId,
                            isAdmin: true,
                            users,
                            loans,
                            userNames,
                            flash: req.query.msg || null,
                            flashError: req.query.err || null
                        });
                    });
                }
            );
        }
    );
});

function adminRedirect(res, returnTo, query) {
    const base = returnTo && String(returnTo).startsWith('/admin')
        ? String(returnTo).split('?')[0]
        : '/admin';
    const params = new URLSearchParams();
    if (query.msg) params.set('msg', query.msg);
    if (query.err) params.set('err', query.err);
    const qs = params.toString();
    res.redirect(qs ? `${base}?${qs}` : base);
}

async function recordAdminAdjustment(entry) {
    if (!ledger) return;
    const key = entry.idempotency_key || `admin_adj:${entry.type}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await ledger.insertCompleted({
        ...entry,
        idempotency_key: key,
        type: entry.type || 'adjustment',
        status: 'completed',
        formbar_outcome: 'success',
        metadata: {
            admin_edit: true,
            ...(entry.metadata || {})
        }
    });
}

/** Set or create a borrower's credit limit (local only — no Formbar transfer). */
app.post('/admin/credit-limit', isAuthenticated, async (req, res) => {
    const adminId = requireAdmin(req, res);
    if (!adminId) return;
    const returnTo = req.body.returnTo || '/admin';

    let parsed;
    try {
        parsed = adminEdits.normalizeCreditLimitUpdate(req.body);
    } catch (e) {
        return adminRedirect(res, returnTo, { err: e.message });
    }

    db.get(
        'SELECT current_limit, paid_off_count FROM credit_limits WHERE borrower_formbar_user_id = ?',
        [parsed.formbarUserId],
        async (err, existing) => {
            if (err) {
                return adminRedirect(res, returnTo, { err: 'Database error' });
            }

            const previousLimit = existing ? existing.current_limit : null;
            const previousCount = existing ? existing.paid_off_count : null;
            const sql = existing
                ? 'UPDATE credit_limits SET current_limit = ?, paid_off_count = ? WHERE borrower_formbar_user_id = ?'
                : 'INSERT INTO credit_limits (current_limit, paid_off_count, borrower_formbar_user_id) VALUES (?, ?, ?)';

            db.run(sql, [parsed.currentLimit, parsed.paidOffCount, parsed.formbarUserId], async (updateErr) => {
                if (updateErr) {
                    return adminRedirect(res, returnTo, { err: 'Failed to update credit limit' });
                }
                try {
                    await recordAdminAdjustment({
                        idempotency_key: `admin_credit_limit:${parsed.formbarUserId}:${Date.now()}`,
                        type: 'credit_limit_change',
                        actor_formbar_user_id: adminId,
                        counterparty_formbar_user_id: parsed.formbarUserId,
                        requested_amount: parsed.currentLimit - (previousLimit || 0),
                        net_amount: parsed.currentLimit,
                        metadata: {
                            previousLimit,
                            newLimit: parsed.currentLimit,
                            previousPaidOffCount: previousCount,
                            newPaidOffCount: parsed.paidOffCount,
                            note: parsed.note,
                            created: !existing
                        }
                    });
                } catch (ledgerErr) {
                    console.error('Admin credit limit ledger error:', ledgerErr.message);
                }
                return adminRedirect(res, returnTo, {
                    msg: `Credit limit for user #${parsed.formbarUserId} set to ${parsed.currentLimit}`
                });
            });
        }
    );
});

/** Edit loan principal / balances / status (local only — no Formbar transfer). */
app.post('/admin/loans/:id', isAuthenticated, async (req, res) => {
    const adminId = requireAdmin(req, res);
    if (!adminId) return;
    const loanId = parseInt(req.params.id, 10);
    const returnTo = req.body.returnTo || '/admin';
    if (!loanId) {
        return adminRedirect(res, returnTo, { err: 'Invalid loan id' });
    }

    db.get('SELECT * FROM credit_loans WHERE id = ?', [loanId], async (err, loan) => {
        if (err) return adminRedirect(res, returnTo, { err: 'Database error' });
        if (!loan) return adminRedirect(res, returnTo, { err: 'Loan not found' });

        let next;
        try {
            next = adminEdits.normalizeLoanUpdate(loan, req.body);
        } catch (e) {
            return adminRedirect(res, returnTo, { err: e.message });
        }

        const finishUpdate = () => {
            db.run(
                `UPDATE credit_loans
                 SET principal = ?, amount_owed = ?, amount_paid = ?, status = ?, paid_at = ?
                 WHERE id = ?`,
                [next.principal, next.amount_owed, next.amount_paid, next.status, next.paid_at, loanId],
                async (updateErr) => {
                    if (updateErr) {
                        return adminRedirect(res, returnTo, { err: 'Failed to update loan' });
                    }
                    try {
                        await recordAdminAdjustment({
                            idempotency_key: `admin_loan:${loanId}:${Date.now()}`,
                            type: 'adjustment',
                            actor_formbar_user_id: adminId,
                            counterparty_formbar_user_id: loan.borrower_formbar_user_id,
                            related_loan_id: loanId,
                            requested_amount: next.amount_owed - next.amount_paid,
                            principal_component: next.principal,
                            interest_component: Math.max(0, next.amount_owed - next.principal),
                            metadata: {
                                before: {
                                    principal: loan.principal,
                                    amount_owed: loan.amount_owed,
                                    amount_paid: loan.amount_paid,
                                    status: loan.status
                                },
                                after: next,
                                note: req.body.note ? String(req.body.note).slice(0, 200) : null
                            }
                        });
                    } catch (ledgerErr) {
                        console.error('Admin loan ledger error:', ledgerErr.message);
                    }
                    return adminRedirect(res, returnTo, {
                        msg: `Loan #${loanId} updated (${next.status}; paid ${next.amount_paid}/${next.amount_owed})`
                    });
                }
            );
        };

        if (next.status === 'active' && loan.status !== 'active') {
            db.get(
                'SELECT id FROM credit_loans WHERE borrower_formbar_user_id = ? AND status = ? AND id != ?',
                [loan.borrower_formbar_user_id, 'active', loanId],
                (activeErr, other) => {
                    if (activeErr) return adminRedirect(res, returnTo, { err: 'Database error' });
                    if (other) {
                        return adminRedirect(res, returnTo, {
                            err: `Borrower already has active loan #${other.id}; void or pay it first`
                        });
                    }
                    finishUpdate();
                }
            );
        } else {
            finishUpdate();
        }
    });
});

/** Void an active loan without Formbar refund (bookkeeping only). */
app.post('/admin/loans/:id/void', isAuthenticated, async (req, res) => {
    const adminId = requireAdmin(req, res);
    if (!adminId) return;
    req.body = { ...req.body, status: 'void' };
    // Reuse loan edit handler by setting status
    const loanId = parseInt(req.params.id, 10);
    const returnTo = req.body.returnTo || '/admin';
    if (!loanId) return adminRedirect(res, returnTo, { err: 'Invalid loan id' });

    db.get('SELECT * FROM credit_loans WHERE id = ?', [loanId], async (err, loan) => {
        if (err || !loan) return adminRedirect(res, returnTo, { err: 'Loan not found' });
        const next = {
            principal: loan.principal,
            amount_owed: loan.amount_owed,
            amount_paid: loan.amount_paid,
            status: 'void',
            paid_at: loan.paid_at
        };
        db.run(
            'UPDATE credit_loans SET status = ? WHERE id = ?',
            ['void', loanId],
            async (updateErr) => {
                if (updateErr) return adminRedirect(res, returnTo, { err: 'Failed to void loan' });
                try {
                    await recordAdminAdjustment({
                        idempotency_key: `admin_loan_void:${loanId}:${Date.now()}`,
                        type: 'adjustment',
                        actor_formbar_user_id: adminId,
                        counterparty_formbar_user_id: loan.borrower_formbar_user_id,
                        related_loan_id: loanId,
                        requested_amount: 0,
                        metadata: { action: 'void', before: loan.status, after: next, note: req.body.note || null }
                    });
                } catch (ledgerErr) {
                    console.error('Admin void ledger error:', ledgerErr.message);
                }
                return adminRedirect(res, returnTo, { msg: `Loan #${loanId} voided (local only)` });
            }
        );
    });
});

/** Load eBank analytics from Formbar transaction history for EBANK_USER_ID. */
async function loadEbankAnalytics() {
    try {
        const [profile, txResult] = await Promise.all([
            formbarApi.getUserProfile(FORMBAR_API_URL, API_KEY, EBANK_USER_ID),
            formbarApi.getUserTransactions(FORMBAR_API_URL, API_KEY, EBANK_USER_ID)
        ]);
        const user = profile || await formbarApi.getUserById(FORMBAR_API_URL, API_KEY, EBANK_USER_ID);
        if (!txResult.ok) {
            return ebankAnalytics.unavailableEbank(
                EBANK_USER_ID,
                txResult.error || 'Formbar transaction history unavailable'
            );
        }
        return ebankAnalytics.buildEbankAnalytics(EBANK_USER_ID, user, txResult.transactions);
    } catch (err) {
        console.error('eBank analytics error:', err.message);
        return ebankAnalytics.unavailableEbank(EBANK_USER_ID, err.message);
    }
}

app.get('/admin/analytics', isAuthenticated, async (req, res) => {
    const userId = requireAdmin(req, res);
    if (!userId) return;

    try {
        const dateRange = analytics.parseDateRange(req.query);
        const granularity = ['day', 'week', 'month', 'lifetime'].includes(req.query.granularity)
            ? req.query.granularity
            : 'day';

        await analytics.ensureTodaySnapshot(db);

        const [
            summary,
            loans,
            pnl,
            credit,
            checks,
            users,
            risk,
            reconciliation,
            snapshots,
            ebank
        ] = await Promise.all([
            analytics.getSummary(db, dateRange),
            analytics.getLoanAnalytics(db, dateRange),
            analytics.getProfitAndLoss(db, { ...dateRange, granularity }),
            analytics.getCreditAnalytics(db, { ...dateRange, creditLimitStep: CREDIT_LIMIT_STEP }),
            analytics.getCheckAnalytics(db, dateRange),
            analytics.getUserAnalytics(db, dateRange),
            analytics.getRiskReport(db),
            getReconciliationReport(db),
            analytics.getRecentSnapshots(db, 90),
            loadEbankAnalytics()
        ]);

        const nameIds = [];
        (credit.highestLimits || []).forEach((u) => nameIds.push(u.user_id));
        (risk.topOutstandingBorrowers || []).forEach((u) => nameIds.push(u.user_id));
        (users.topBorrowers || []).forEach((u) => nameIds.push(u.user_id));
        (users.topCheckUsers || []).forEach((u) => nameIds.push(u.user_id));
        (checks.topWriters || []).forEach((u) => nameIds.push(u.user_id));
        (checks.topRecipients || []).forEach((u) => nameIds.push(u.user_id));
        (ebank.topCounterparties || []).forEach((u) => nameIds.push(u.userId));
        (ebank.recentTransactions || []).forEach((t) => {
            if (t.fromId != null) nameIds.push(t.fromId);
            if (t.toId != null) nameIds.push(t.toId);
        });
        nameIds.push(userId, EBANK_USER_ID);

        const userNames = await resolveUserNames(nameIds);
        res.render('admin-analytics', {
            user: req.session.user,
            userId,
            isAdmin: true,
            formbarUrl: FORMBAR_URL,
            dateRange,
            granularity,
            summary,
            loans,
            pnl,
            credit,
            checks,
            users,
            risk,
            reconciliation,
            snapshots,
            ebank,
            userNames,
            ledgerCoverageNote: 'Ledger coverage begins at migration; earlier repayments may be aggregated into a single legacy event per loan.'
        });
    } catch (err) {
        console.error('Error loading analytics:', err);
        res.status(500).send('Error loading analytics');
    }
});

app.get('/admin/analytics/api/summary', isAuthenticated, async (req, res) => {
    const userId = requireAdmin(req, res);
    if (!userId) return;
    try {
        const dateRange = analytics.parseDateRange(req.query);
        const summary = await analytics.getSummary(db, dateRange);
        const loans = await analytics.getLoanAnalytics(db, dateRange);
        const pnl = await analytics.getProfitAndLoss(db, {
            ...dateRange,
            granularity: req.query.granularity || 'day'
        });
        res.json({ dateRange, summary, loans, pnl });
    } catch (err) {
        console.error('Analytics API error:', err);
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});

app.get('/admin/analytics/borrowers/:formbarUserId', isAuthenticated, async (req, res) => {
    const userId = requireAdmin(req, res);
    if (!userId) return;
    const targetId = parseInt(req.params.formbarUserId, 10);
    if (!targetId) return res.status(400).send('Invalid user id');
    try {
        const profile = await analytics.getBorrowerProfile(db, targetId);
        const userNames = await resolveUserNames([targetId, userId]);
        res.render('admin-borrower', {
            user: req.session.user,
            userId,
            isAdmin: true,
            formbarUrl: FORMBAR_URL,
            profile,
            userNames,
            flash: req.query.msg || null,
            flashError: req.query.err || null
        });
    } catch (err) {
        console.error('Borrower profile error:', err);
        res.status(500).send('Error loading borrower profile');
    }
});

app.get('/admin/analytics/export/:report.csv', isAuthenticated, async (req, res) => {
    const userId = requireAdmin(req, res);
    if (!userId) return;
    const report = String(req.params.report || '').toLowerCase();
    try {
        const dateRange = analytics.parseDateRange(req.query);
        let csv = '';
        let filename = 'formbank-export.csv';
        if (report === 'transactions') {
            csv = await analytics.exportTransactions(db, {
                ...dateRange,
                type: req.query.type,
                status: req.query.status
            });
            filename = 'formbank-transactions.csv';
        } else if (report === 'lending') {
            csv = await analytics.exportLending(db);
            filename = 'formbank-lending.csv';
        } else if (report === 'checks') {
            csv = await analytics.exportChecks(db);
            filename = 'formbank-checks.csv';
        } else if (report === 'summary') {
            const summary = await analytics.getSummary(db, dateRange);
            const pnl = await analytics.getProfitAndLoss(db, { ...dateRange, granularity: 'lifetime' });
            csv = await analytics.exportFinancialSummary(db, summary, pnl);
            filename = 'formbank-summary.csv';
        } else {
            return res.status(404).send('Unknown export');
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (err) {
        console.error('Export error:', err);
        res.status(500).send('Export failed');
    }
});

app.get('/admin/checks', isAuthenticated, (req, res) => {
    const userId = requireAdmin(req, res);
    if (!userId) return;

    getAllChecks((err, rows) => {
        if (err) {
            console.error('Error loading admin checks:', err);
            return res.status(500).send('Error loading checks');
        }
        const checks = (rows || []).map((c) => {
            const isFormBankSender = c.sender_formbar_user_id === LENDER_USER_ID;
            const funded = c.status === 'uncashed' || c.status === 'completed' || c.status === 'funded_unpaid';
            const senderPaid = funded
                ? (isFormBankSender ? 0 : checkChargeToFormBank(c.amount))
                : 0;
            const receiverGot = (c.status === 'completed') ? c.amount : 0;
            return {
                ...c,
                sender_paid: senderPaid,
                receiver_received: receiverGot
            };
        });
        const ids = [];
        checks.forEach((c) => {
            ids.push(c.sender_formbar_user_id, c.receiver_formbar_user_id);
        });
        ids.push(userId);
        resolveUserNames(ids).then((userNames) => {
            res.render('admin-checks', {
                user: req.session.user,
                userId,
                isAdmin: true,
                checks,
                userNames
            });
        });
    });
});

// Credit routes
app.get('/credit', isAuthenticated, (req, res) => {
    const userId = req.session.userId;
    if (!userId) {
        return res.status(400).send('User ID not found in session');
    }

    // Get all credit data
    getCreditLimit(userId, (err, limitData) => {
        if (err) {
            console.error('Error getting credit limit:', err);
            return res.status(500).send('Error loading credit data');
        }

        getActiveLoan(userId, (err, activeLoan) => {
            if (err) {
                console.error('Error getting active loan:', err);
                return res.status(500).send('Error loading credit data');
            }

            getLoanHistory(userId, (err, loanHistory) => {
                if (err) {
                    console.error('Error getting loan history:', err);
                    return res.status(500).send('Error loading credit data');
                }

                getTopCreditLimits(50, (hsErr, highscores) => {
                    if (hsErr) {
                        console.error('Error loading credit limit highscores:', hsErr);
                    }
                    const board = highscores || [];
                    const ids = board.map((r) => r.user_id);
                    resolveUserNames(ids).then((userNames) => {
                        res.render('credit', {
                            user: req.session.user,
                            userId,
                            creditLimit: limitData.current_limit,
                            activeLoan: activeLoan,
                            loanHistory: loanHistory || [],
                            highscores: board,
                            userNames,
                            isAdmin: userId === LENDER_USER_ID
                        });
                    });
                });
            });
        });
    });
});

app.post('/credit/borrow', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    if (!userId) {
        return res.status(400).json({ error: 'User ID not found in session' });
    }

    const principal = parseInt(req.body.amount);
    if (!principal || principal <= 0) {
        return res.status(400).json({ error: 'Invalid loan amount' });
    }

    // Check for active loan
    getActiveLoan(userId, (err, activeLoan) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (activeLoan) {
            return res.status(400).json({ error: 'You already have an active loan' });
        }

        // Check credit limit
        getCreditLimit(userId, (err, limitData) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            if (principal > limitData.current_limit) {
                return res.status(400).json({ error: `Loan amount exceeds your credit limit of ${limitData.current_limit} digipogs` });
            }

            // Create loan record first (before transfer)
            createLoan(userId, principal, async (err, loan) => {
                if (err) {
                    return res.status(500).json({ error: 'Failed to create loan record' });
                }

                let ledgerId = null;
                try {
                    if (ledger) {
                        const pending = await ledger.beginPending({
                            idempotency_key: `loan_issue:${loan.id}`,
                            type: 'loan_issue',
                            actor_formbar_user_id: LENDER_USER_ID,
                            counterparty_formbar_user_id: userId,
                            related_loan_id: loan.id,
                            requested_amount: principal,
                            gross_transfer_amount: principal,
                            net_amount: accounting.netAfterTax(principal),
                            tax_amount: accounting.taxOnGross(principal)
                        });
                        ledgerId = pending.id;
                        if (pending.existing && pending.row && pending.row.status === 'completed') {
                            return res.json({
                                success: true,
                                message: `Loan of ${principal} digipogs already issued.`
                            });
                        }
                    }
                } catch (ledgerErr) {
                    db.run('DELETE FROM credit_loans WHERE id = ?', [loan.id], () => { });
                    return res.status(500).json({ error: 'Failed to record pending loan transfer' });
                }

                formbarApi.transferDigipogs(
                    socket,
                    LENDER_USER_ID,
                    userId,
                    principal,
                    `FormBank loan: ${principal} digipogs`,
                    LENDER_PIN
                ).then(async (result) => {
                    if (result.success) {
                        if (ledger && ledgerId) {
                            await ledger.markCompleted(ledgerId);
                        }
                        return res.json({
                            success: true,
                            message: `Loan of ${principal} digipogs issued successfully. You received ${accounting.netAfterTax(principal)} digipogs (after 10% tax). You owe ${loan.amountOwed} digipogs.`
                        });
                    }

                    const outcome = result.outcome || 'failure';
                    if (outcome === 'timeout' || outcome === 'unknown') {
                        if (ledger && ledgerId) {
                            await ledger.markReconciliationRequired(
                                ledgerId,
                                result.error || 'Loan transfer outcome unknown',
                                outcome
                            );
                        }
                        return res.status(500).json({
                            error: result.error || 'Transfer outcome unknown — loan kept for reconciliation',
                            reconciliation: true
                        });
                    }

                    if (ledger && ledgerId) {
                        await ledger.markFailed(ledgerId, result.error || 'Transfer failed', 'failure');
                    }
                    db.run('DELETE FROM credit_loans WHERE id = ?', [loan.id], () => { });

                    const errorMsg = result.error || 'Transfer failed';
                    if (errorMsg.toLowerCase().includes('locked') ||
                        errorMsg.toLowerCase().includes('too many failed attempts')) {
                        return res.status(423).json({
                            error: errorMsg,
                            locked: true,
                            suggestion: 'The lender account is temporarily locked. Please wait for the lock to expire or verify the LENDER_PIN in your .env file matches the account PIN in Formbar.'
                        });
                    }

                    return res.status(500).json({ error: errorMsg });
                });
            });
        });
    });
});

app.post('/credit/repay', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    if (!userId) {
        return res.status(400).json({ error: 'User ID not found in session' });
    }

    const repaymentAmount = parseInt(req.body.amount);
    if (!repaymentAmount || repaymentAmount <= 0) {
        return res.status(400).json({ error: 'Invalid repayment amount' });
    }

    const borrowerPin = req.body.pin;
    if (borrowerPin === undefined || borrowerPin === null || String(borrowerPin).trim() === '') {
        return res.status(400).json({ error: 'PIN is required for repayment.' });
    }

    // Loan is only updated after successful transfer.
    getActiveLoan(userId, (err, activeLoan) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (!activeLoan) {
            return res.status(400).json({ error: 'No active loan found' });
        }

        const remainingOwed = activeLoan.amount_owed - activeLoan.amount_paid;
        if (remainingOwed <= 0) {
            return res.status(400).json({ error: 'Loan is already paid off' });
        }
        if (repaymentAmount > remainingOwed) {
            return res.status(400).json({ error: `Repayment cannot exceed remaining balance of ${remainingOwed} digipogs` });
        }

        processLoanRepayment(req, res, userId, activeLoan, repaymentAmount, borrowerPin, false);
    });
});

app.post('/credit/repay/full', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    if (!userId) {
        return res.status(400).json({ error: 'User ID not found in session' });
    }

    const borrowerPin = req.body.pin;
    if (borrowerPin === undefined || borrowerPin === null || String(borrowerPin).trim() === '') {
        return res.status(400).json({ error: 'PIN is required for repayment.' });
    }

    getActiveLoan(userId, (err, activeLoan) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (!activeLoan) {
            return res.status(400).json({ error: 'No active loan found' });
        }

        const remainingOwed = activeLoan.amount_owed - activeLoan.amount_paid;
        if (remainingOwed <= 0) {
            return res.status(400).json({ error: 'Loan is already paid off' });
        }

        processLoanRepayment(req, res, userId, activeLoan, remainingOwed, borrowerPin, true);
    });
});

async function processLoanRepayment(req, res, userId, activeLoan, repaymentAmount, borrowerPin, isFull) {
    const split = accounting.allocateRepayment(
        activeLoan.principal,
        activeLoan.amount_paid,
        repaymentAmount
    );
    const idempotencyKey = req.body.idempotencyKey
        || `loan_repay:${activeLoan.id}:${activeLoan.amount_paid}:${repaymentAmount}:${isFull ? 'full' : 'partial'}`;

    let ledgerId = null;
    try {
        if (ledger) {
            const pending = await ledger.beginPending({
                idempotency_key: idempotencyKey,
                type: 'loan_repay',
                actor_formbar_user_id: userId,
                counterparty_formbar_user_id: LENDER_USER_ID,
                related_loan_id: activeLoan.id,
                requested_amount: repaymentAmount,
                gross_transfer_amount: repaymentAmount,
                net_amount: accounting.netAfterTax(repaymentAmount),
                tax_amount: accounting.taxOnGross(repaymentAmount),
                principal_component: split.principalComponent,
                interest_component: split.interestComponent,
                metadata: { full: !!isFull }
            });
            ledgerId = pending.id;
            if (pending.existing && pending.row && pending.row.status === 'completed') {
                return res.json({ success: true, message: 'Repayment already processed.' });
            }
        }
    } catch (ledgerErr) {
        return res.status(500).json({ error: 'Failed to record pending repayment' });
    }

    const result = await formbarApi.transferDigipogs(
        socket,
        userId,
        LENDER_USER_ID,
        repaymentAmount,
        isFull
            ? `FormBank loan full repayment: ${repaymentAmount} digipogs`
            : `FormBank loan repayment: ${repaymentAmount} digipogs`,
        borrowerPin
    );

    if (!result.success) {
        const outcome = result.outcome || 'failure';
        if (ledger && ledgerId) {
            if (outcome === 'timeout' || outcome === 'unknown') {
                await ledger.markReconciliationRequired(
                    ledgerId,
                    result.error || 'Repayment outcome unknown',
                    outcome
                );
                return res.status(500).json({
                    error: result.error || 'Transfer outcome unknown — verify manually',
                    reconciliation: true
                });
            }
            await ledger.markFailed(ledgerId, result.error || 'Transfer failed', 'failure');
        }
        return res.status(500).json({ error: result.error || 'Transfer failed' });
    }

    updateLoanPayment(activeLoan.id, repaymentAmount, async (err, paymentResult) => {
        if (err) {
            if (ledger && ledgerId) {
                await ledger.markReconciliationRequired(
                    ledgerId,
                    'Formbar transfer succeeded but loan payment update failed',
                    'success'
                );
            }
            return res.status(500).json({
                error: 'Transfer succeeded but failed to update loan payment — contact support',
                reconciliation: true
            });
        }

        if (ledger && ledgerId) {
            try {
                await ledger.markCompleted(ledgerId);
            } catch (markErr) {
                console.error('Failed to complete repay ledger:', markErr.message);
            }
        }

        updateCreditLimitFromRepayments(userId, (limitErr, limitResult) => {
            if (limitErr) {
                console.error('Failed to update credit limit from repayments:', limitErr);
            }
            const limitIncreased = limitResult && limitResult.increased;
            res.json({
                success: true,
                message: (isFull
                    ? `Full repayment of ${repaymentAmount} digipogs processed. Loan paid off!`
                    : `Repayment of ${repaymentAmount} digipogs processed.` +
                    (paymentResult.isPaid ? ' Loan paid off!' : '')) +
                    (limitIncreased ? ' Your credit limit has increased.' : '')
            });
        });
    });
}

// Check (write-check) routes
app.get('/checks', isAuthenticated, (req, res) => {
    const userId = req.session.userId;
    if (!userId) {
        return res.status(400).send('User ID not found in session');
    }
    getChecksForUser(userId, (err, checks) => {
        if (err) {
            console.error('Error getting checks:', err);
            return res.status(500).send('Error loading checks');
        }
        const safeChecks = (checks || []).map(c => {
            const safe = { ...c };
            delete safe.pin_for_redemption;
            return safe;
        });
        const ids = [];
        safeChecks.forEach(c => {
            ids.push(c.sender_formbar_user_id, c.receiver_formbar_user_id);
        });
        resolveUserNames(ids).then((userNames) => {
            res.render('checks', {
                user: req.session.user,
                userId: userId,
                checks: safeChecks,
                userNames
            });
        });
    });
});

app.get('/checks/:id', (req, res, next) => {
    const receiverIdQuery = req.query.receiverId;
    if (receiverIdQuery != null && String(receiverIdQuery).trim() !== '') {
        const checkId = parseInt(req.params.id, 10);
        const receiverId = parseInt(receiverIdQuery, 10);
        if (isNaN(checkId) || isNaN(receiverId) || receiverId < 1) {
            return res.status(400).send('Invalid check ID or receiver ID');
        }
        getCheckById(checkId, (err, check) => {
            if (err) {
                return res.status(500).send('Error loading check');
            }
            if (!check) {
                return res.status(404).send('Check not found');
            }
            if (check.receiver_formbar_user_id != null || check.status !== 'uncashed') {
                return res.status(400).redirect('/checks/' + checkId);
            }
            claimUncashedCheck(checkId, receiverId, (errClaim, claimed) => {
                if (errClaim) {
                    return res.status(500).send('Error redeeming check');
                }
                if (!claimed) {
                    return res.status(400).send('Check already redeemed by someone else.');
                }
                // Funds already sit at FormBank from write time; pay receiver from FormBank.
                redeemCheckPayout(check, receiverId).then((result) => {
                    clearCheckPin(checkId);
                    setCheckStatus(checkId, result.success ? 'completed' : 'funded_unpaid', () => { });
                    const safeCheck = { ...check };
                    delete safeCheck.pin_for_redemption;
                    resolveUserNames([receiverId, check.sender_formbar_user_id]).then((userNames) => {
                        res.render('check-cashed', {
                            check: safeCheck,
                            receiverId,
                            success: result.success,
                            userNames
                        });
                    });
                });
            });
        });
        return;
    }
    next();
}, isAuthenticated, (req, res) => {
    const userId = req.session.userId;
    const checkId = parseInt(req.params.id, 10);
    if (!userId || isNaN(checkId)) {
        return res.status(400).send('Bad request');
    }
    getCheckById(checkId, (err, check) => {
        if (err) {
            return res.status(500).send('Error loading check');
        }
        if (!check) {
            return res.status(404).send('Check not found');
        }
        const isSender = check.sender_formbar_user_id === userId;
        const hasReceiver = check.receiver_formbar_user_id != null;
        const isReceiver = hasReceiver && check.receiver_formbar_user_id === userId;
        const isUncashed = check.status === 'uncashed' && !hasReceiver;
        const isAdmin = userId === LENDER_USER_ID;

        if (isUncashed) {
            if (isSender || isAdmin) {
                renderCheckDetail(req, res, check, userId);
                return;
            }
            claimUncashedCheck(checkId, userId, (errClaim, claimed) => {
                if (errClaim) {
                    return res.status(500).send('Error redeeming check');
                }
                if (!claimed) {
                    return res.status(403).send('This check was already redeemed by someone else.');
                }
                // Funds already sit at FormBank from write time; pay receiver from FormBank.
                redeemCheckPayout(check, userId).then((result) => {
                    clearCheckPin(checkId);
                    setCheckStatus(checkId, result.success ? 'completed' : 'funded_unpaid', () => { });
                    getCheckById(checkId, (err2, updated) => {
                        if (err2 || !updated) {
                            return res.status(500).send('Error loading check');
                        }
                        renderCheckDetail(req, res, updated, userId);
                    });
                });
            });
            return;
        }

        if (!isSender && !isReceiver && !isAdmin) {
            return res.status(403).send('You do not have permission to view this check');
        }
        renderCheckDetail(req, res, check, userId);
    });
});

function renderCheckDetail(req, res, check, userId) {
    const checkId = check.id;
    const isSender = check.sender_formbar_user_id === userId;
    const statusPageUrl = `${THIS_URL}/checks/${checkId}`;
    const safeCheck = { ...check };
    delete safeCheck.pin_for_redemption;
    resolveUserNames([safeCheck.sender_formbar_user_id, safeCheck.receiver_formbar_user_id]).then((userNames) => {
        QRCode.toDataURL(statusPageUrl, { type: 'image/png', margin: 2 }, (err, qrDataUrl) => {
            if (err) {
                console.error('QR generation error:', err);
                qrDataUrl = '';
            }
            res.render('check-detail', {
                user: req.session.user,
                check: safeCheck,
                qrDataUrl,
                isSender,
                userNames
            });
        });
    });
}

async function recordCheckDepositLegs(checkId, senderId, amount, fee, chargeTotal, groupId, skipDeposit) {
    if (!ledger) return { depositId: null, feeId: null, taxId: null };
    const deposit = await ledger.beginPending({
        idempotency_key: `check_deposit:${checkId}`,
        type: 'check_deposit',
        actor_formbar_user_id: senderId,
        related_check_id: checkId,
        parent_group_id: groupId,
        requested_amount: amount,
        gross_transfer_amount: skipDeposit ? 0 : chargeTotal,
        net_amount: skipDeposit ? 0 : accounting.netAfterTax(chargeTotal),
        tax_amount: skipDeposit ? 0 : accounting.taxOnGross(chargeTotal),
        fee_amount: fee,
        metadata: { skipDeposit: !!skipDeposit }
    });
    const feeRow = await ledger.beginPending({
        idempotency_key: `check_fee:${checkId}`,
        type: 'check_fee',
        actor_formbar_user_id: senderId,
        related_check_id: checkId,
        parent_group_id: groupId,
        requested_amount: fee,
        fee_amount: fee,
        net_amount: fee
    });
    let taxId = null;
    if (!skipDeposit && accounting.taxOnGross(chargeTotal) > 0) {
        const taxRow = await ledger.beginPending({
            idempotency_key: `check_deposit_tax:${checkId}`,
            type: 'formbar_tax',
            actor_formbar_user_id: senderId,
            related_check_id: checkId,
            parent_group_id: groupId,
            requested_amount: accounting.taxOnGross(chargeTotal),
            gross_transfer_amount: chargeTotal,
            tax_amount: accounting.taxOnGross(chargeTotal),
            metadata: { leg: 'deposit' }
        });
        taxId = taxRow.id;
    }
    return { depositId: deposit.id, feeId: feeRow.id, taxId };
}

async function completeCheckDepositLegs(ids, skipDeposit) {
    if (!ledger) return;
    if (skipDeposit) {
        if (ids.depositId) await ledger.markCompleted(ids.depositId, { formbar_outcome: 'success' });
    } else if (ids.depositId) {
        await ledger.markCompleted(ids.depositId);
    }
    if (ids.feeId) await ledger.markCompleted(ids.feeId);
    if (ids.taxId) await ledger.markCompleted(ids.taxId);
}

async function failCheckDepositLegs(ids, error, outcome) {
    if (!ledger) return;
    if (ids.depositId) {
        if (outcome === 'timeout' || outcome === 'unknown') {
            await ledger.markReconciliationRequired(ids.depositId, error, outcome);
        } else {
            await ledger.markFailed(ids.depositId, error, outcome || 'failure');
        }
    }
    if (ids.feeId) await ledger.markFailed(ids.feeId, error, outcome || 'failure');
    if (ids.taxId) await ledger.markFailed(ids.taxId, error, outcome || 'failure');
}

app.post('/checks/write', isAuthenticated, async (req, res) => {
    const senderId = req.session.userId;
    if (!senderId) {
        return res.status(400).json({ error: 'User ID not found in session' });
    }
    const rawReceiverId = req.body.receiverId;
    const receiverId = (rawReceiverId === '' || rawReceiverId === undefined || rawReceiverId === null)
        ? null
        : parseInt(rawReceiverId, 10);
    const amount = parseInt(req.body.amount, 10);
    const pin = req.body.pin;
    const memo = req.body.memo || '';

    if (receiverId !== null && (isNaN(receiverId) || receiverId === senderId)) {
        return res.status(400).json({ error: 'Invalid receiver. Use another user\'s Formbar user ID or leave blank for "anyone".' });
    }
    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!pin) {
        return res.status(400).json({ error: 'PIN is required for transfers' });
    }

    const fee = calcCheckFee(amount);
    const payout = checkPayoutFromFormBank(amount);
    const chargeTotal = checkChargeToFormBank(amount);
    const isFormBank = senderId === LENDER_USER_ID;
    const toLender = receiverId === LENDER_USER_ID
    const memoLabel = memo || `Check: ${amount} digipogs`;

    // Create check row early so ledger can reference check id (pending status until funded)
    createCheck(senderId, receiverId, amount, fee, 'failed', memo, null, async (err, row) => {
        if (err || !row) {
            return res.status(500).json({ error: 'Failed to create check record' });
        }
        const checkId = row.id;
        const groupId = `check:${checkId}`;
        let depositIds = { depositId: null, feeId: null, taxId: null };

        try {
            depositIds = await recordCheckDepositLegs(
                checkId, senderId, amount, fee, chargeTotal, groupId, isFormBank
            );
        } catch (ledgerErr) {
            return res.status(500).json({ error: 'Failed to record pending check deposit' });
        }

        const doDeposit = isFormBank || toLender
            ? Promise.resolve({ success: true, outcome: 'success' })
            : formbarApi.transferDigipogs(
                socket,
                senderId,
                CHECK_FUNDS,
                chargeTotal,
                `Check deposit: net ${amount}, FormBank fee ${fee}`,
                pin
            );

        doDeposit.then(async (result1) => {
            if (!result1.success) {
                await failCheckDepositLegs(
                    depositIds,
                    result1.error || 'Deposit failed',
                    result1.outcome || 'failure'
                );
                return res.status(500).json({
                    error: result1.error || `Deposit to ${CHECK_FUNDS_LABEL} failed`,
                    reconciliation: result1.outcome === 'timeout' || result1.outcome === 'unknown'
                });
            }

            try {
                await completeCheckDepositLegs(depositIds, isFormBank);
            } catch (e) {
                if (ledger && depositIds.depositId) {
                    await ledger.markReconciliationRequired(
                        depositIds.depositId,
                        'Deposit succeeded but ledger complete failed',
                        'success'
                    );
                }
            }

            if (receiverId === null) {
                setCheckStatus(checkId, 'uncashed', (statusErr) => {
                    if (statusErr) {
                        return res.status(500).json({
                            error: 'Check funded but database error',
                            reconciliation: true,
                            checkId
                        });
                    }
                    res.json({
                        success: true,
                        checkId,
                        charged: isFormBank ? 0 : chargeTotal,
                        fee,
                        payout,
                        message: isFormBank
                            ? `Blank check created (${CHECK_FUNDS_LABEL}).`
                            : `Charged ${chargeTotal} digipogs (covers Formbar tax on both legs + FormBank's 5% fee of ${fee}). Receiver will net ${amount}.`
                    });
                });
                return;
            }

            let payoutLedgerId = null;
            try {
                if (ledger) {
                    const payoutPending = await ledger.beginPending({
                        idempotency_key: `check_payout:${checkId}`,
                        type: 'check_payout',
                        counterparty_formbar_user_id: receiverId,
                        related_check_id: checkId,
                        parent_group_id: groupId,
                        requested_amount: amount,
                        gross_transfer_amount: payout,
                        net_amount: amount,
                        tax_amount: accounting.taxOnGross(payout)
                    });
                    payoutLedgerId = payoutPending.id;
                }
            } catch (e) {
                setCheckStatus(checkId, 'funded_unpaid', () => { });
                return res.status(500).json({
                    error: 'Deposit succeeded but failed to record payout — contact support',
                    reconciliation: true,
                    checkId
                });
            }

            formbarApi.transferDigipogs(
                socket,
                senderId,
                receiverId,
                payout,
                memoLabel,
                toLender ? pin : LENDER_PIN
            ).then(async (result2) => {
                if (!result2.success) {
                    const outcome = result2.outcome || 'failure';
                    if (ledger && payoutLedgerId) {
                        if (outcome === 'timeout' || outcome === 'unknown') {
                            await ledger.markReconciliationRequired(
                                payoutLedgerId,
                                result2.error || 'Payout outcome unknown',
                                outcome
                            );
                        } else {
                            await ledger.markFailed(payoutLedgerId, result2.error || 'Payout failed', 'failure');
                        }
                    }
                    setCheckStatus(checkId, 'funded_unpaid', () => { });
                    return res.status(500).json({
                        error: result2.error || `${CHECK_FUNDS_LABEL} payout to receiver failed. Deposit is at FormBank — contact support.`,
                        reconciliation: true,
                        checkId
                    });
                }

                if (ledger && payoutLedgerId) {
                    try {
                        await ledger.markCompleted(payoutLedgerId);
                        if (accounting.taxOnGross(payout) > 0) {
                            await ledger.insertCompleted({
                                idempotency_key: `check_payout_tax:${checkId}`,
                                type: 'formbar_tax',
                                related_check_id: checkId,
                                parent_group_id: groupId,
                                counterparty_formbar_user_id: receiverId,
                                requested_amount: accounting.taxOnGross(payout),
                                gross_transfer_amount: payout,
                                tax_amount: accounting.taxOnGross(payout),
                                metadata: { leg: 'payout' }
                            });
                        }
                    } catch (e) {
                        await ledger.markReconciliationRequired(
                            payoutLedgerId,
                            'Payout succeeded but ledger complete failed',
                            'success'
                        );
                    }
                }

                setCheckStatus(checkId, 'completed', (statusErr) => {
                    if (statusErr) {
                        return res.status(500).json({
                            error: 'Check paid but database error',
                            reconciliation: true,
                            checkId
                        });
                    }
                    res.json({
                        success: true,
                        checkId,
                        charged: toLender ? payout : (isFormBank ? 0 : chargeTotal),
                        fee,
                        payout,
                        message: toLender
                            ? `Sent ${payout} digipogs directly to the lender (receiver nets ${amount}).`
                            : isFormBank
                            ? `Paid ${payout} digipogs from ${CHECK_FUNDS_LABEL} so receiver nets ${amount}.`
                            : `Charged ${chargeTotal}; ${CHECK_FUNDS_LABEL} paid ${payout} (receiver nets ${amount}); FormBank keeps ~${fee} (5%).`
                    });
                });
            });
        });
    });
});

async function redeemCheckPayout(check, receiverId) {
    const payout = checkPayoutFromFormBank(check.amount);
    const groupId = `check:${check.id}`;
    let payoutLedgerId = null;
    if (ledger) {
        const pending = await ledger.beginPending({
            idempotency_key: `check_payout:${check.id}`,
            type: 'check_payout',
            counterparty_formbar_user_id: receiverId,
            related_check_id: check.id,
            parent_group_id: groupId,
            requested_amount: check.amount,
            gross_transfer_amount: payout,
            net_amount: check.amount,
            tax_amount: accounting.taxOnGross(payout)
        });
        payoutLedgerId = pending.id;
        if (pending.existing && pending.row && pending.row.status === 'completed') {
            return { success: true, already: true };
        }
    }

    const result = await payCheckFromFormBank(check, receiverId);
    if (result.success) {
        if (ledger && payoutLedgerId) {
            await ledger.markCompleted(payoutLedgerId);
            if (accounting.taxOnGross(payout) > 0) {
                await ledger.insertCompleted({
                    idempotency_key: `check_payout_tax:${check.id}`,
                    type: 'formbar_tax',
                    related_check_id: check.id,
                    parent_group_id: groupId,
                    counterparty_formbar_user_id: receiverId,
                    requested_amount: accounting.taxOnGross(payout),
                    gross_transfer_amount: payout,
                    tax_amount: accounting.taxOnGross(payout),
                    metadata: { leg: 'payout' }
                });
            }
        }
        return { success: true };
    }

    const outcome = result.outcome || 'failure';
    if (ledger && payoutLedgerId) {
        if (outcome === 'timeout' || outcome === 'unknown') {
            await ledger.markReconciliationRequired(
                payoutLedgerId,
                result.error || 'Payout outcome unknown',
                outcome
            );
        } else {
            await ledger.markFailed(payoutLedgerId, result.error || 'Payout failed', 'failure');
        }
    }
    return { success: false, error: result.error, outcome, reconciliation: outcome === 'timeout' || outcome === 'unknown' };
}

// Socket.io client to auth server
const socket = io(AUTH_URL, {
    extraHeaders: {
        api: API_KEY
    }
});

socket.on('connect', () => {
    console.log('Connected to auth server');
});

socket.on('disconnect', () => {
    console.log('Disconnected from auth server');
});

// Debug: Log all socket events to help identify transfer responses
if (process.env.DEBUG_SOCKET === 'true') {
    const originalEmit = socket.emit.bind(socket);
    socket.emit = function (event, ...args) {
        console.log(`[SOCKET EMIT] ${event}`, args);
        return originalEmit(event, ...args);
    };

    socket.onAny((event, ...args) => {
        if (!['connect', 'disconnect'].includes(event)) {
            console.log(`[SOCKET EVENT] ${event}`, args);
        }
    });
}


// Start server
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
    if (USE_CHECK_POOL) {
        console.log(`Checks will go through Formbar pool ${POOL_ID}`);
    } else {
        console.log(`POOL_ID is blank; checks will go through lender user ${LENDER_USER_ID}`);
    }
});