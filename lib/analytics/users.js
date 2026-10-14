const { dateFilterSql } = require('./dateRange');

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
            resolve(row || {});
        });
    });
}

async function getUserAnalytics(db, { from, to } = {}) {
    const uniqueAll = await getAsync(db, `
        SELECT COUNT(DISTINCT uid) AS total FROM (
            SELECT actor_formbar_user_id AS uid FROM financial_transactions
            WHERE actor_formbar_user_id IS NOT NULL AND status = 'completed'
            UNION
            SELECT counterparty_formbar_user_id AS uid FROM financial_transactions
            WHERE counterparty_formbar_user_id IS NOT NULL AND status = 'completed'
        )
    `);

    const df = dateFilterSql(from, to, 'ft.created_at');

    const active = await getAsync(db, `
        SELECT
            COUNT(DISTINCT CASE WHEN type IN ('loan_issue') THEN counterparty_formbar_user_id END) AS active_borrowers,
            COUNT(DISTINCT CASE WHEN type = 'check_deposit' THEN actor_formbar_user_id END) AS active_check_writers,
            COUNT(DISTINCT CASE WHEN type = 'check_payout' THEN counterparty_formbar_user_id END) AS active_check_recipients,
            COUNT(*) AS transactions_in_range
        FROM financial_transactions ft
        WHERE ft.status = 'completed' ${df.sql}
    `, df.params);

    const firstSeen = await allAsync(db, `
        SELECT uid, MIN(first_at) AS first_at FROM (
            SELECT actor_formbar_user_id AS uid, MIN(created_at) AS first_at
            FROM financial_transactions
            WHERE actor_formbar_user_id IS NOT NULL AND status = 'completed'
            GROUP BY actor_formbar_user_id
            UNION ALL
            SELECT counterparty_formbar_user_id AS uid, MIN(created_at) AS first_at
            FROM financial_transactions
            WHERE counterparty_formbar_user_id IS NOT NULL AND status = 'completed'
            GROUP BY counterparty_formbar_user_id
        )
        GROUP BY uid
    `);

    let newParticipants = 0;
    let returningParticipants = 0;
    if (from) {
        for (const u of firstSeen) {
            if (u.first_at >= from && (!to || u.first_at <= to)) newParticipants += 1;
            else if (u.first_at < from) {
                // returning if they also have activity in range — checked below
            }
        }
        const activeInRange = await allAsync(db, `
            SELECT DISTINCT uid FROM (
                SELECT actor_formbar_user_id AS uid FROM financial_transactions ft
                WHERE actor_formbar_user_id IS NOT NULL AND status = 'completed' ${df.sql}
                UNION
                SELECT counterparty_formbar_user_id AS uid FROM financial_transactions ft
                WHERE counterparty_formbar_user_id IS NOT NULL AND status = 'completed' ${df.sql}
            )
        `, [...df.params, ...df.params]);
        const firstMap = new Map(firstSeen.map((u) => [u.uid, u.first_at]));
        for (const a of activeInRange) {
            const first = firstMap.get(a.uid);
            if (first && first < from) returningParticipants += 1;
        }
        newParticipants = activeInRange.filter((a) => {
            const first = firstMap.get(a.uid);
            return first && first >= from && (!to || first <= to);
        }).length;
    } else {
        newParticipants = firstSeen.length;
        returningParticipants = 0;
    }

    const distinctActive = await getAsync(db, `
        SELECT COUNT(DISTINCT uid) AS n FROM (
            SELECT actor_formbar_user_id AS uid FROM financial_transactions ft
            WHERE actor_formbar_user_id IS NOT NULL AND status = 'completed' ${df.sql}
            UNION
            SELECT counterparty_formbar_user_id AS uid FROM financial_transactions ft
            WHERE counterparty_formbar_user_id IS NOT NULL AND status = 'completed' ${df.sql}
        )
    `, [...df.params, ...df.params]);

    const txsPerActive = distinctActive.n > 0
        ? (active.transactions_in_range || 0) / distinctActive.n
        : 0;

    const borrowCounts = await allAsync(db, `
        SELECT counterparty_formbar_user_id AS user_id, COUNT(*) AS loan_count
        FROM financial_transactions ft
        WHERE type = 'loan_issue' AND status = 'completed' ${df.sql}
        GROUP BY counterparty_formbar_user_id
        ORDER BY loan_count DESC
        LIMIT 20
    `, df.params);

    const checkFreq = await allAsync(db, `
        SELECT actor_formbar_user_id AS user_id, COUNT(*) AS check_count
        FROM financial_transactions ft
        WHERE type = 'check_deposit' AND status = 'completed' ${df.sql}
        GROUP BY actor_formbar_user_id
        ORDER BY check_count DESC
        LIMIT 20
    `, df.params);

    const dual = await getAsync(db, `
        SELECT COUNT(*) AS dual_users FROM (
            SELECT counterparty_formbar_user_id AS uid
            FROM financial_transactions
            WHERE type = 'loan_issue' AND status = 'completed' AND counterparty_formbar_user_id IS NOT NULL
            INTERSECT
            SELECT actor_formbar_user_id AS uid
            FROM financial_transactions
            WHERE type = 'check_deposit' AND status = 'completed' AND actor_formbar_user_id IS NOT NULL
        )
    `);

    const cacheCount = await getAsync(db, 'SELECT COUNT(*) AS n FROM users');

    return {
        totalUniqueFinancialUsers: uniqueAll.total || 0,
        usernameCacheCount: cacheCount.n || 0,
        usernameCacheNote: 'Local username cache is not Formbar user population',
        activeBorrowers: active.active_borrowers || 0,
        activeCheckWriters: active.active_check_writers || 0,
        activeCheckRecipients: active.active_check_recipients || 0,
        activeUsersInRange: distinctActive.n || 0,
        newParticipants,
        returningParticipants,
        transactionsPerActiveUser: txsPerActive,
        topBorrowers: borrowCounts,
        topCheckUsers: checkFreq,
        dualParticipants: dual.dual_users || 0
    };
}

module.exports = { getUserAnalytics };
