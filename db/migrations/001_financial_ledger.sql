-- FormBank financial ledger and analytics support (001)

CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS financial_transactions (
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

CREATE TABLE IF NOT EXISTS financial_snapshots (
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
