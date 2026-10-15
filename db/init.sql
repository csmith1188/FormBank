CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL,
    formbar_id INTEGER UNIQUE
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
    paid_off_count INTEGER DEFAULT 0,
    deposit_posted INTEGER NOT NULL DEFAULT 0,
    deposit_held INTEGER NOT NULL DEFAULT 0,
    deposit_refunded INTEGER NOT NULL DEFAULT 0,
    -- Lifetime repayments at last credit reset; only (SUM(amount_paid) - baseline) counts toward new limit growth
    repaid_baseline INTEGER NOT NULL DEFAULT 0
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
    pin_for_redemption TEXT,
    cashed_at DATETIME
);

CREATE TABLE schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE financial_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    actor_formbar_user_id INTEGER,
    counterparty_formbar_user_id INTEGER,
    related_loan_id INTEGER,
    related_check_id INTEGER,
    parent_group_id TEXT,
    requested_amount INTEGER NOT NULL DEFAULT 0,
    gross_transfer_amount INTEGER NOT NULL DEFAULT 0,
    net_amount INTEGER NOT NULL DEFAULT 0,
    tax_amount INTEGER NOT NULL DEFAULT 0,
    fee_amount INTEGER NOT NULL DEFAULT 0,
    principal_component INTEGER NOT NULL DEFAULT 0,
    interest_component INTEGER NOT NULL DEFAULT 0,
    currency_note TEXT NOT NULL DEFAULT 'digipog',
    formbar_outcome TEXT,
    error_message TEXT,
    metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_ft_created_at ON financial_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_ft_type_status ON financial_transactions(type, status);
CREATE INDEX IF NOT EXISTS idx_ft_actor ON financial_transactions(actor_formbar_user_id);
CREATE INDEX IF NOT EXISTS idx_ft_loan ON financial_transactions(related_loan_id);
CREATE INDEX IF NOT EXISTS idx_ft_check ON financial_transactions(related_check_id);
CREATE INDEX IF NOT EXISTS idx_ft_status ON financial_transactions(status);

CREATE TABLE financial_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL UNIQUE,
    outstanding_principal INTEGER NOT NULL DEFAULT 0,
    outstanding_balances INTEGER NOT NULL DEFAULT 0,
    uncashed_obligations INTEGER NOT NULL DEFAULT 0,
    interest_collected INTEGER NOT NULL DEFAULT 0,
    check_fees_collected INTEGER NOT NULL DEFAULT 0,
    formbar_taxes INTEGER NOT NULL DEFAULT 0,
    unresolved_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_loan
ON credit_loans(borrower_formbar_user_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_loans_borrower ON credit_loans(borrower_formbar_user_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON credit_loans(status);
CREATE INDEX IF NOT EXISTS idx_checks_status ON checks(status);
CREATE INDEX IF NOT EXISTS idx_checks_sender ON checks(sender_formbar_user_id);
CREATE INDEX IF NOT EXISTS idx_checks_receiver ON checks(receiver_formbar_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_formbar_id ON users(formbar_id);
