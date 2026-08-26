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
const creditScore = require('./creditScore');
const QRCode = require('qrcode');


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
                            db.run('DROP TABLE checks_backup', () => {});
                        });
                    } else if (!hasPinCol) {
                        db.run('ALTER TABLE checks ADD COLUMN pin_for_redemption TEXT', () => {});
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
                            db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_formbar_id ON users(formbar_id)', () => {});
                        });
                    } else {
                        db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_formbar_id ON users(formbar_id)', () => {});
                    }
                });
            }
        );
        // Ensure credit_limits has credit_score column
        db.run(
            'CREATE TABLE IF NOT EXISTS credit_limits (borrower_formbar_user_id INTEGER PRIMARY KEY, current_limit INTEGER DEFAULT 250, paid_off_count INTEGER DEFAULT 0, credit_score INTEGER DEFAULT 580)',
            (err) => {
                if (err) return console.error('Error ensuring credit_limits table:', err);
                db.all('PRAGMA table_info(credit_limits)', (err, cols) => {
                    if (err || !cols) return;
                    if (!cols.some(c => c.name === 'credit_score')) {
                        db.run('ALTER TABLE credit_limits ADD COLUMN credit_score INTEGER DEFAULT 580', () => {});
                    }
                });
            }
        );
    }
});

//Constants
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'your_secret_key';
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:420/oauth';
const THIS_URL = process.env.THIS_URL || `http://localhost:${PORT}`;
const LOGIN_REDIRECT_URL = `${THIS_URL}/login`;
const API_KEY = process.env.API_KEY || 'your_api_key';
const LENDER_USER_ID = parseInt(process.env.LENDER_USER_ID) || 1;
const LENDER_PIN = parseInt(process.env.LENDER_PIN) || 3639; // PIN must be a number per Formbar docs
const FORMBAR_URL = (process.env.FORMBAR_URL || process.env.AUTH_URL || 'https://formbar.yorktechapps.com')
    .replace(/\/oauth\/?$/, '')
    .replace(/\/$/, '') || 'https://formbar.yorktechapps.com';

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
app.locals.formbarUserLink = function(formbarUserId, userNames) {
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
    db.get('SELECT current_limit, paid_off_count, credit_score FROM credit_limits WHERE borrower_formbar_user_id = ?', [userId], (err, row) => {
        if (err) return callback(err, null);
        if (!row) {
            const starter = creditScore.getCreditTerms([]);
            db.run(
                'INSERT INTO credit_limits (borrower_formbar_user_id, current_limit, paid_off_count, credit_score) VALUES (?, ?, 0, ?)',
                [userId, starter.creditLimit, starter.score],
                function(err) {
                    if (err) return callback(err, null);
                    callback(null, {
                        current_limit: starter.creditLimit,
                        paid_off_count: 0,
                        credit_score: starter.score
                    });
                }
            );
        } else {
            callback(null, row);
        }
    });
}

function getCreditBalance(userId, callback) {
    db.get('SELECT credit_balance FROM credit_balances WHERE borrower_formbar_user_id = ?', [userId], (err, row) => {
        if (err) return callback(err, null);
        if (!row) {
            // Initialize with zero balance
            db.run('INSERT INTO credit_balances (borrower_formbar_user_id, credit_balance) VALUES (?, 0)', [userId], function(err) {
                if (err) return callback(err, null);
                callback(null, { credit_balance: 0 });
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

/**
 * Recompute credit score + limit from loan history and persist to credit_limits.
 */
function refreshCreditProfile(userId, callback) {
    getLoanHistory(userId, (err, loans) => {
        if (err) return callback(err, null);
        const list = loans || [];
        const terms = creditScore.getCreditTerms(list);
        const paidCount = list.filter((l) => l.status === 'paid').length;
        db.run(
            'INSERT INTO credit_limits (borrower_formbar_user_id, current_limit, paid_off_count, credit_score) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(borrower_formbar_user_id) DO UPDATE SET current_limit = excluded.current_limit, paid_off_count = excluded.paid_off_count, credit_score = excluded.credit_score',
            [userId, terms.creditLimit, paidCount, terms.score],
            (err2) => {
                if (err2) return callback(err2, null);
                callback(null, terms);
            }
        );
    });
}

/** Top N credit scores (recomputed from loan history). */
function getTopCreditScores(limit, callback) {
    const n = Math.max(1, parseInt(limit, 10) || 20);
    db.all(
        'SELECT borrower_formbar_user_id AS user_id FROM credit_limits ' +
        'UNION SELECT DISTINCT borrower_formbar_user_id AS user_id FROM credit_loans',
        [],
        (err, users) => {
            if (err) return callback(err, null);
            const list = users || [];
            if (list.length === 0) return callback(null, []);

            let pending = list.length;
            const results = [];
            list.forEach((u) => {
                getLoanHistory(u.user_id, (histErr, loans) => {
                    const terms = creditScore.getCreditTerms(histErr ? [] : (loans || []));
                    results.push({
                        user_id: u.user_id,
                        credit_score: terms.score,
                        score_label: terms.scoreLabel,
                        current_limit: terms.creditLimit
                    });
                    // Keep cached score in sync for admin / other views
                    db.run(
                        'INSERT INTO credit_limits (borrower_formbar_user_id, current_limit, paid_off_count, credit_score) VALUES (?, ?, ?, ?) ' +
                        'ON CONFLICT(borrower_formbar_user_id) DO UPDATE SET current_limit = excluded.current_limit, credit_score = excluded.credit_score',
                        [u.user_id, terms.creditLimit, (loans || []).filter((l) => l.status === 'paid').length, terms.score],
                        () => {}
                    );
                    pending -= 1;
                    if (pending === 0) {
                        results.sort((a, b) => {
                            if (b.credit_score !== a.credit_score) return b.credit_score - a.credit_score;
                            return b.current_limit - a.current_limit;
                        });
                        callback(null, results.slice(0, n));
                    }
                });
            });
        }
    );
}

function createLoan(userId, principal, interestRate, callback) {
    const rate = typeof interestRate === 'number' ? interestRate : creditScore.interestRateFromScore(creditScore.BASE_SCORE);
    const amountOwed = Math.ceil(principal * (1 + rate));
    db.run(
        'INSERT INTO credit_loans (borrower_formbar_user_id, principal, interest_rate, amount_owed, amount_paid, status) VALUES (?, ?, ?, ?, 0, ?)',
        [userId, principal, rate, amountOwed, 'active'],
        function(err) {
            if (err) return callback(err, null);
            callback(null, { id: this.lastID, principal, amountOwed, interestRate: rate });
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
            function(err) {
                if (err) return callback(err);
                callback(null, { isPaid, newAmountPaid, amountOwed: loan.amount_owed });
            }
        );
    });
}

function updateCreditBalance(userId, amount, callback) {
    db.run(
        'INSERT INTO credit_balances (borrower_formbar_user_id, credit_balance) VALUES (?, ?) ON CONFLICT(borrower_formbar_user_id) DO UPDATE SET credit_balance = credit_balance + ?',
        [userId, amount, amount],
        callback
    );
}

function deductCreditBalance(userId, amount, callback) {
    db.run(
        'UPDATE credit_balances SET credit_balance = credit_balance - ? WHERE borrower_formbar_user_id = ? AND credit_balance >= ?',
        [amount, userId, amount],
        function(err) {
            if (err) return callback(err);
            callback(null, this.changes > 0);
        }
    );
}

// Check (write-check) database helpers
function createCheck(senderId, receiverId, amount, fee, status, memo, pinForRedemption, callback) {
    if (typeof pinForRedemption === 'function') {
        callback = pinForRedemption;
        pinForRedemption = null;
    }
    db.run(
        'INSERT INTO checks (sender_formbar_user_id, receiver_formbar_user_id, amount, fee_charged, status, memo, pin_for_redemption) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [senderId, receiverId == null ? null : receiverId, amount, fee, status, memo || null, pinForRedemption || null],
        function(err) {
            if (err) return callback(err, null);
            callback(null, { id: this.lastID });
        }
    );
}

function clearCheckPin(checkId, callback) {
    db.run('UPDATE checks SET pin_for_redemption = NULL WHERE id = ?', [checkId], callback || (() => {}));
}

function getChecksForUser(userId, callback) {
    db.all(
        'SELECT * FROM checks WHERE sender_formbar_user_id = ? OR (receiver_formbar_user_id = ? AND status = ?) ORDER BY created_at DESC',
        [userId, userId, 'completed'],
        callback
    );
}

function getCheckById(id, callback) {
    db.get('SELECT * FROM checks WHERE id = ?', [id], callback);
}

function claimUncashedCheck(checkId, userId, callback) {
    db.run(
        'UPDATE checks SET receiver_formbar_user_id = ? WHERE id = ? AND receiver_formbar_user_id IS NULL',
        [userId, checkId],
        function(err) {
            if (err) return callback(err, false);
            callback(null, this.changes > 0);
        }
    );
}

function setCheckStatus(checkId, status, callback) {
    db.run('UPDATE checks SET status = ? WHERE id = ?', [status, checkId], callback);
}

/** Upsert local users cache keyed by Formbar ID + display name. */
function upsertFormbarUser(formbarId, displayName, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
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
                // Username taken by a different formbar user — fall through to insert with conflict-safe name
            }
            db.run(
                'INSERT INTO users (username, formbar_id) VALUES (?, ?)',
                [displayName, formbarId],
                (insertErr) => {
                    if (!insertErr) return done();
                    // Race / unique conflict: update by formbar_id if another row won
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
        const remote = await formbarApi.getUserById(FORMBAR_URL, API_KEY, id);
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
app.get('/admin', isAuthenticated, (req, res) => {
    const userId = req.session.userId;
    if (!userId) {
        return res.status(400).send('User ID not found in session');
    }
    if (userId !== LENDER_USER_ID) {
        return res.status(403).send('Admin panel is only available to the default user.');
    }

    db.all(
        'SELECT cl.borrower_formbar_user_id AS user_id, cl.current_limit, cl.credit_score, COALESCE(cb.credit_balance, 0) AS credit_balance ' +
        'FROM credit_limits cl ' +
        'LEFT JOIN credit_balances cb ON cb.borrower_formbar_user_id = cl.borrower_formbar_user_id ' +
        'ORDER BY user_id ASC',
        [],
        (err, rows) => {
            if (err) {
                console.error('Error loading admin data:', err);
                return res.status(500).send('Error loading admin data');
            }
            const users = rows || [];
            const ids = users.map(u => u.user_id).concat([userId]);

            // Refresh scores/limits so admin always sees current terms
            let pending = users.length;
            const finish = () => {
                resolveUserNames(ids).then((userNames) => {
                    res.render('admin', {
                        user: req.session.user,
                        userId,
                        isAdmin: true,
                        users,
                        userNames,
                        scoreLabel: creditScore.scoreLabel
                    });
                });
            };
            if (pending === 0) return finish();
            users.forEach((u) => {
                refreshCreditProfile(u.user_id, (errRefresh, terms) => {
                    if (!errRefresh && terms) {
                        u.credit_score = terms.score;
                        u.current_limit = terms.creditLimit;
                    }
                    pending -= 1;
                    if (pending === 0) finish();
                });
            });
        }
    );
});

// Credit routes
app.get('/credit', isAuthenticated, (req, res) => {
    const userId = req.session.userId;
    if (!userId) {
        return res.status(400).send('User ID not found in session');
    }

    refreshCreditProfile(userId, (err, terms) => {
        if (err) {
            console.error('Error refreshing credit profile:', err);
            return res.status(500).send('Error loading credit data');
        }

        getCreditBalance(userId, (err, balanceData) => {
            if (err) {
                console.error('Error getting credit balance:', err);
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

                    getTopCreditScores(20, (hsErr, highscores) => {
                        if (hsErr) {
                            console.error('Error loading credit highscores:', hsErr);
                        }
                        const board = highscores || [];
                        const ids = board.map((r) => r.user_id);
                        resolveUserNames(ids).then((userNames) => {
                            res.render('credit', {
                                user: req.session.user,
                                userId,
                                creditScore: terms.score,
                                creditScoreLabel: terms.scoreLabel,
                                creditLimit: terms.creditLimit,
                                interestRate: terms.interestRate,
                                checkFeeRate: terms.checkFeeRate,
                                checkFeeMin: terms.checkFeeMin,
                                creditBalance: balanceData.credit_balance,
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

        refreshCreditProfile(userId, (err, terms) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            if (principal > terms.creditLimit) {
                return res.status(400).json({ error: `Loan amount exceeds your credit limit of ${terms.creditLimit} digipogs` });
            }

            // Create loan record first (before transfer)
            createLoan(userId, principal, terms.interestRate, (err, loan) => {
                if (err) {
                    return res.status(500).json({ error: 'Failed to create loan record' });
                }

                // Transfer digipogs from lender to borrower
                formbarApi.transferDigipogs(
                    socket,
                    LENDER_USER_ID,
                    userId,
                    principal,
                    `FormBank loan: ${principal} digipogs`,
                    LENDER_PIN
                ).then(result => {
                    if (!result.success) {
                        // Rollback: delete the loan record
                        db.run('DELETE FROM credit_loans WHERE id = ?', [loan.id], () => {});
                        
                        // Check if it's an account lock error
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
                    }

                    refreshCreditProfile(userId, () => {});
                    const ratePct = Math.round(loan.interestRate * 1000) / 10;
                    res.json({
                        success: true,
                        message: `Loan of ${principal} digipogs issued at ${ratePct}% interest (score ${terms.score}). You received ${Math.floor(principal * 0.9)} digipogs (after 10% tax). You owe ${loan.amountOwed} digipogs.`
                    });
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

    // Loan and credit_balance are only updated after successful transfer or verified credit deduction.
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

        // Get credit balance
        getCreditBalance(userId, (err, balanceData) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            const creditBalance = balanceData.credit_balance || 0;
            let amountToApply = repaymentAmount;
            let transferNeeded = repaymentAmount;
            let creditUsed = 0;

            // Apply credit balance first
            if (creditBalance > 0 && repaymentAmount > 0) {
                creditUsed = Math.min(creditBalance, repaymentAmount);
                amountToApply = creditUsed;
                transferNeeded = repaymentAmount - creditUsed;
                
                if (creditUsed > 0) {
                    deductCreditBalance(userId, creditUsed, (err, deducted) => {
                        if (err) {
                            return res.status(500).json({ error: 'Failed to apply credit balance' });
                        }
                        // If deduction failed (e.g. balance was insufficient), treat as no credit used so we require a transfer
                        if (!deducted) {
                            creditUsed = 0;
                        }
                        processRepayment();
                    });
                } else {
                    processRepayment();
                }
            } else {
                processRepayment();
            }

            function processRepayment() {
                // Cap repayment to remaining owed
                const actualRepayment = Math.min(repaymentAmount, remainingOwed);
                const actualTransferNeeded = Math.max(0, actualRepayment - creditUsed);

                if (actualTransferNeeded > 0) {
                    // PIN already validated at top of handler. Transfer first; only update loan after success.
                    const pinForTransfer = req.body.pin;
                    // Transfer from borrower to lender
                    formbarApi.transferDigipogs(
                        socket,
                        userId,
                        LENDER_USER_ID,
                        actualTransferNeeded,
                        `FormBank loan repayment: ${actualTransferNeeded} digipogs`,
                        pinForTransfer
                    ).then(result => {
                        if (!result.success) {
                            // Rollback credit deduction if it happened
                            if (creditUsed > 0) {
                                updateCreditBalance(userId, creditUsed, () => {});
                            }
                            return res.status(500).json({ error: result.error || 'Transfer failed' });
                        }

                        // Update loan payment
                        updateLoanPayment(activeLoan.id, actualRepayment, (err, paymentResult) => {
                            if (err) {
                                return res.status(500).json({ error: 'Failed to update loan payment' });
                            }

                            // Handle overpayment (if any)
                            const overpayment = repaymentAmount - actualRepayment;
                            if (overpayment > 0) {
                                updateCreditBalance(userId, overpayment, (err) => {
                                    if (err) {
                                        console.error('Failed to credit overpayment:', err);
                                    }
                                });
                            }

                            // Recalculate credit score and limit from loan history
                            refreshCreditProfile(userId, (limitErr, terms) => {
                                if (limitErr) {
                                    console.error('Failed to refresh credit profile:', limitErr);
                                }

                                const scoreNote = terms
                                    ? ` Credit score: ${terms.score} (${terms.scoreLabel}); limit: ${terms.creditLimit}.`
                                    : '';

                                res.json({ 
                                    success: true, 
                                    message: `Repayment of ${actualRepayment} digipogs processed${overpayment > 0 ? ` (${overpayment} digipogs credited to your account)` : ''}.` +
                                        (paymentResult.isPaid ? ' Loan paid off!' : '') +
                                        scoreNote
                                });
                            });
                        });
                    });
                } else {
                    // No transfer needed, just update loan
                    updateLoanPayment(activeLoan.id, actualRepayment, (err, paymentResult) => {
                        if (err) {
                            // Rollback credit deduction
                            if (creditUsed > 0) {
                                updateCreditBalance(userId, creditUsed, () => {});
                            }
                            return res.status(500).json({ error: 'Failed to update loan payment' });
                        }

                        // Handle overpayment
                        const overpayment = repaymentAmount - actualRepayment;
                        if (overpayment > 0) {
                            updateCreditBalance(userId, overpayment, (err) => {
                                if (err) {
                                    console.error('Failed to credit overpayment:', err);
                                }
                            });
                        }

                        // Recalculate credit score and limit from loan history
                        refreshCreditProfile(userId, (limitErr, terms) => {
                            if (limitErr) {
                                console.error('Failed to refresh credit profile:', limitErr);
                            }

                            const scoreNote = terms
                                ? ` Credit score: ${terms.score} (${terms.scoreLabel}); limit: ${terms.creditLimit}.`
                                : '';

                            res.json({ 
                                success: true, 
                                message: `Repayment of ${actualRepayment} digipogs processed using credit balance${overpayment > 0 ? ` (${overpayment} digipogs credited)` : ''}.` +
                                    (paymentResult.isPaid ? ' Loan paid off!' : '') +
                                    scoreNote
                            });
                        });
                    });
                }
            }
        });
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

    // Get active loan
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

        // Get credit balance
        getCreditBalance(userId, (err, balanceData) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            const creditBalance = balanceData.credit_balance || 0;
            let creditUsed = Math.min(creditBalance, remainingOwed);
            let transferNeeded = Math.max(0, remainingOwed - creditBalance);

            // Apply credit balance first
            if (creditUsed > 0) {
                deductCreditBalance(userId, creditUsed, (err, deducted) => {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to apply credit balance' });
                    }
                    // If deduction failed (e.g. balance was insufficient), require full transfer
                    if (!deducted) {
                        creditUsed = 0;
                        transferNeeded = remainingOwed;
                    }
                    processFullRepayment();
                });
            } else {
                processFullRepayment();
            }

            function processFullRepayment() {
                if (transferNeeded > 0) {
                    // PIN already validated at top of handler. Transfer first; only update loan after success.
                    // Transfer from borrower to lender
                    formbarApi.transferDigipogs(
                        socket,
                        userId,
                        LENDER_USER_ID,
                        transferNeeded,
                        `FormBank loan full repayment: ${transferNeeded} digipogs`,
                        borrowerPin
                    ).then(result => {
                        if (!result.success) {
                            // Rollback credit deduction if it happened
                            if (creditUsed > 0) {
                                updateCreditBalance(userId, creditUsed, () => {});
                            }
                            return res.status(500).json({ error: result.error || 'Transfer failed' });
                        }

                        // Update loan payment
                        updateLoanPayment(activeLoan.id, remainingOwed, (err, paymentResult) => {
                            if (err) {
                                return res.status(500).json({ error: 'Failed to update loan payment' });
                            }

                            // Loan should be paid now; recalculate credit score and limit
                            refreshCreditProfile(userId, (limitErr, terms) => {
                                if (limitErr) {
                                    console.error('Failed to refresh credit profile:', limitErr);
                                }

                                const scoreNote = terms
                                    ? ` Credit score: ${terms.score} (${terms.scoreLabel}); limit: ${terms.creditLimit}.`
                                    : '';

                                res.json({ 
                                    success: true, 
                                    message: `Full repayment of ${remainingOwed} digipogs processed${creditUsed > 0 ? ` (${creditUsed} from credit balance, ${transferNeeded} transferred)` : ''}. Loan paid off!` +
                                        scoreNote
                                });
                            });
                        });
                    });
                } else {
                    // No transfer needed, just update loan
                    updateLoanPayment(activeLoan.id, remainingOwed, (err, paymentResult) => {
                        if (err) {
                            // Rollback credit deduction
                            if (creditUsed > 0) {
                                updateCreditBalance(userId, creditUsed, () => {});
                            }
                            return res.status(500).json({ error: 'Failed to update loan payment' });
                        }

                        // Loan should be paid now; recalculate credit score and limit
                        refreshCreditProfile(userId, (limitErr, terms) => {
                            if (limitErr) {
                                console.error('Failed to refresh credit profile:', limitErr);
                            }

                            const scoreNote = terms
                                ? ` Credit score: ${terms.score} (${terms.scoreLabel}); limit: ${terms.creditLimit}.`
                                : '';

                            res.json({ 
                                success: true, 
                                message: `Full repayment of ${remainingOwed} digipogs processed using credit balance. Loan paid off!` +
                                    scoreNote
                            });
                        });
                    });
                }
            }
        });
    });
});

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
            refreshCreditProfile(userId, (errTerms, terms) => {
                if (errTerms) {
                    console.error('Error loading credit terms for checks:', errTerms);
                }
                const feeTerms = terms || creditScore.getCreditTerms([]);
                res.render('checks', {
                    user: req.session.user,
                    userId: userId,
                    checks: safeChecks,
                    userNames,
                    creditScore: feeTerms.score,
                    creditScoreLabel: feeTerms.scoreLabel,
                    checkFeeRate: feeTerms.checkFeeRate,
                    checkFeeMin: feeTerms.checkFeeMin
                });
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
                return res.status(400).redirect('/checks/' + checkId );
            }
            claimUncashedCheck(checkId, receiverId, (errClaim, claimed) => {
                if (errClaim) {
                    return res.status(500).send('Error redeeming check');
                }
                if (!claimed) {
                    return res.status(400).send('Check already redeemed by someone else.');
                }
                redeemCheckToReceiver(check, receiverId).then((result) => {
                    setCheckStatus(checkId, result.success ? 'completed' : 'failed', () => {});
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

        if (isUncashed) {
            if (isSender) {
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
                redeemCheckToReceiver(check, userId).then((result) => {
                    setCheckStatus(checkId, result.success ? 'completed' : 'failed', () => {});
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

        if (!isSender && !isReceiver) {
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

app.post('/checks/write', isAuthenticated, (req, res) => {
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

    const isDefaultUser = senderId === LENDER_USER_ID;

    refreshCreditProfile(senderId, (errTerms, terms) => {
        if (errTerms) {
            return res.status(500).json({ error: 'Failed to load credit profile for fee calculation' });
        }
        const fee = isDefaultUser ? 0 : creditScore.checkFeeFromScore(terms.score, amount);
        writeCheckWithFee(fee);
    });

    function writeCheckWithFee(fee) {
        const total = amount + fee;
        const depositMemo = fee > 0
            ? `FormBank check deposit: ${amount} + ${fee} fee`
            : `FormBank check deposit: ${amount}`;
        const payoutMemo = memo || `Check: ${amount} digipogs`;

        // Blank check: deposit amount+fee to FormBank; payout happens on redeem
        if (receiverId === null) {
            if (isDefaultUser) {
                createCheck(senderId, null, amount, fee, 'uncashed', memo, null, (err, row) => {
                    if (err) {
                        return res.status(500).json({ error: 'Check recorded but database error' });
                    }
                    res.json({ success: true, checkId: row.id });
                });
                return;
            }
            formbarApi.transferDigipogs(
                socket,
                senderId,
                LENDER_USER_ID,
                total,
                depositMemo,
                pin
            ).then((result) => {
                if (!result.success) {
                    createCheck(senderId, null, amount, fee, 'failed', memo, null, () => {});
                    return res.status(500).json({ error: result.error || 'Deposit to FormBank failed' });
                }
                // No sender PIN stored — FormBank holds funds until redeem
                createCheck(senderId, null, amount, fee, 'uncashed', memo, null, (err, row) => {
                    if (err) {
                        return res.status(500).json({ error: 'Check recorded but database error' });
                    }
                    res.json({ success: true, checkId: row.id });
                });
            });
            return;
        }

        // Specific receiver: sender → FormBank (amount+fee), then FormBank → receiver (amount)
        function payoutToReceiver(checkStatusOnFail) {
            formbarApi.transferDigipogs(
                socket,
                LENDER_USER_ID,
                receiverId,
                amount,
                payoutMemo,
                LENDER_PIN
            ).then((result2) => {
                if (!result2.success) {
                    createCheck(senderId, receiverId, amount, fee, checkStatusOnFail, memo, null, () => {});
                    return res.status(500).json({
                        error: result2.error || 'FormBank payout to receiver failed'
                    });
                }
                createCheck(senderId, receiverId, amount, fee, 'completed', memo, null, (err, row) => {
                    if (err) {
                        return res.status(500).json({ error: 'Check recorded but database error' });
                    }
                    res.json({ success: true, checkId: row.id });
                });
            });
        }

        if (isDefaultUser) {
            payoutToReceiver('failed');
            return;
        }

        formbarApi.transferDigipogs(
            socket,
            senderId,
            LENDER_USER_ID,
            total,
            depositMemo,
            pin
        ).then((result1) => {
            if (!result1.success) {
                createCheck(senderId, receiverId, amount, fee, 'failed', memo, null, () => {});
                return res.status(500).json({ error: result1.error || 'Deposit to FormBank failed' });
            }
            payoutToReceiver('failed');
        });
    }
});

/**
 * Pay a blank/uncashed check to a receiver.
 * New model: FormBank holds funds → payout with LENDER_PIN.
 * Legacy (pin_for_redemption set): amount still with sender → use stored PIN.
 */
function redeemCheckToReceiver(check, receiverId) {
    const checkId = check.id;
    const memo = check.memo
        ? `Check #${checkId}: ${check.memo}`
        : `Check #${checkId} redemption`;

    if (check.pin_for_redemption) {
        return formbarApi.transferDigipogs(
            socket,
            check.sender_formbar_user_id,
            receiverId,
            check.amount,
            memo,
            check.pin_for_redemption
        ).then((result) => {
            clearCheckPin(checkId);
            return result;
        });
    }

    return formbarApi.transferDigipogs(
        socket,
        LENDER_USER_ID,
        receiverId,
        check.amount,
        memo,
        LENDER_PIN
    );
}

// Socket.io client to auth server
const socket = io(AUTH_URL, {
    extraHeaders: {
        api: API_KEY
    }
});

socket.on('connect', () => {
    console.log('Connected to auth server');
    socket.emit('getActiveClass');
});

socket.on('disconnect', () => {
    console.log('Disconnected from auth server');
});

socket.on('setClass', (classData) => {
    console.log('Received class data:', classData);
    socket.emit('classUpdate');
});

socket.on('classUpdate', (classroomData) => {
    console.log(`Classroom id: ${classroomData.id}, Name: ${classroomData.className}, Active: ${classroomData.isActive}`);
    console.log(`Response: ${classroomData.poll.totalResponses} / ${classroomData.poll.totalResponders}`);
    console.log(classroomData.poll.responses);
    
    
});

// Debug: Log all socket events to help identify transfer responses
if (process.env.DEBUG_SOCKET === 'true') {
    const originalEmit = socket.emit.bind(socket);
    socket.emit = function(event, ...args) {
        console.log(`[SOCKET EMIT] ${event}`, args);
        return originalEmit(event, ...args);
    };
    
    socket.onAny((event, ...args) => {
        if (!['connect', 'disconnect', 'setClass', 'classUpdate'].includes(event)) {
            console.log(`[SOCKET EVENT] ${event}`, args);
        }
    });
}


// Start server
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});