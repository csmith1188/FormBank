CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL
);

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
    current_limit INTEGER DEFAULT 250,
    paid_off_count INTEGER DEFAULT 0
);

CREATE TABLE credit_balances (
    borrower_formbar_user_id INTEGER PRIMARY KEY,
    credit_balance INTEGER DEFAULT 0
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