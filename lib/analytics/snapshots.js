/**
 * Daily financial snapshots (only when not already stored for today).
 */

function getAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

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

function todayDate() {
    return new Date().toISOString().slice(0, 10);
}

async function ensureTodaySnapshot(db) {
    const day = todayDate();
    const existing = await getAsync(db, 'SELECT id FROM financial_snapshots WHERE snapshot_date = ?', [day]);
    if (existing) return existing;

    const pos = await getAsync(db, `
        SELECT
            (SELECT COALESCE(SUM(CASE WHEN amount_paid < principal THEN principal - amount_paid ELSE 0 END), 0)
             FROM credit_loans WHERE status = 'active') AS outstanding_principal,
            (SELECT COALESCE(SUM(amount_owed - amount_paid), 0)
             FROM credit_loans WHERE status = 'active') AS outstanding_balances,
            (SELECT COALESCE(SUM(amount), 0) FROM checks WHERE status IN ('uncashed', 'funded_unpaid')) AS uncashed_obligations,
            (SELECT COUNT(*) FROM financial_transactions WHERE status IN ('pending', 'reconciliation_required')) AS unresolved_count
    `);

    const dayAgg = await getAsync(db, `
        SELECT
            COALESCE(SUM(CASE WHEN type = 'loan_repay' AND status = 'completed' THEN interest_component ELSE 0 END), 0) AS interest_collected,
            COALESCE(SUM(CASE WHEN type = 'check_fee' AND status = 'completed' THEN fee_amount ELSE 0 END), 0) AS check_fees,
            COALESCE(SUM(CASE WHEN type = 'formbar_tax' AND status = 'completed' THEN tax_amount ELSE 0 END), 0) AS formbar_taxes
        FROM financial_transactions
        WHERE date(created_at) = ?
    `, [day]);

    await runAsync(db, `
        INSERT INTO financial_snapshots (
            snapshot_date, outstanding_principal, outstanding_balances, uncashed_obligations,
            interest_collected, check_fees_collected, formbar_taxes, unresolved_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        day,
        pos.outstanding_principal || 0,
        pos.outstanding_balances || 0,
        pos.uncashed_obligations || 0,
        dayAgg.interest_collected || 0,
        dayAgg.check_fees || 0,
        dayAgg.formbar_taxes || 0,
        pos.unresolved_count || 0
    ]);

    return { snapshot_date: day };
}

async function getRecentSnapshots(db, limit = 90) {
    return allAsync(db, `
        SELECT * FROM financial_snapshots
        ORDER BY snapshot_date DESC
        LIMIT ?
    `, [limit]);
}

module.exports = { ensureTodaySnapshot, getRecentSnapshots, todayDate };
