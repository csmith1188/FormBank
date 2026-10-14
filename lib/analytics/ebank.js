/**
 * eBank analytics from Formbar transaction history for the eBank user account.
 * Read-only — does not write FormBank balances.
 */

/**
 * Normalize a Formbar transaction row into a stable shape.
 * Formbar field names have varied across versions.
 */
function normalizeTransaction(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = raw.id != null ? raw.id : (raw.transaction_id != null ? raw.transaction_id : null);
    const amount = Number(
        raw.amount != null ? raw.amount
            : (raw.digipogs != null ? raw.digipogs
                : (raw.value != null ? raw.value : 0))
    );
    const fromId = raw.from != null ? raw.from
        : (raw.fromUser != null ? raw.fromUser
            : (raw.from_user != null ? raw.from_user
                : (raw.sender != null ? raw.sender
                    : (raw.from_id != null ? raw.from_id : null))));
    const toId = raw.to != null ? raw.to
        : (raw.toUser != null ? raw.toUser
            : (raw.to_user != null ? raw.to_user
                : (raw.receiver != null ? raw.receiver
                    : (raw.to_id != null ? raw.to_id : null))));
    const reason = raw.reason != null ? raw.reason
        : (raw.memo != null ? raw.memo
            : (raw.description != null ? raw.description : ''));
    const createdAt = raw.created_at || raw.createdAt || raw.timestamp || raw.time || null;
    return {
        id,
        amount: Number.isFinite(amount) ? amount : 0,
        fromId: fromId != null ? Number(fromId) : null,
        toId: toId != null ? Number(toId) : null,
        reason: String(reason || ''),
        createdAt,
        raw
    };
}

function extractTransactionList(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.data)) return payload.data;
    if (payload.data && Array.isArray(payload.data.transactions)) return payload.data.transactions;
    if (Array.isArray(payload.transactions)) return payload.transactions;
    if (payload.data && Array.isArray(payload.data.rows)) return payload.data.rows;
    return [];
}

/**
 * Build eBank analytics from Formbar user + transactions payloads.
 * @param {number} ebankUserId
 * @param {{id?: number, displayName?: string, digipogs?: number}|null} user
 * @param {object|array|null} transactionsPayload
 */
function buildEbankAnalytics(ebankUserId, user, transactionsPayload) {
    const list = extractTransactionList(transactionsPayload)
        .map(normalizeTransaction)
        .filter(Boolean);

    let inflow = 0;
    let outflow = 0;
    let formbankRelated = 0;
    const counterparties = new Map();

    for (const tx of list) {
        const isIn = tx.toId === ebankUserId;
        const isOut = tx.fromId === ebankUserId;
        if (isIn) inflow += tx.amount;
        if (isOut) outflow += tx.amount;
        if (/formbank/i.test(tx.reason)) formbankRelated += 1;

        const other = isOut ? tx.toId : (isIn ? tx.fromId : null);
        if (other != null && !Number.isNaN(other)) {
            const prev = counterparties.get(other) || { userId: other, count: 0, amount: 0 };
            prev.count += 1;
            prev.amount += tx.amount;
            counterparties.set(other, prev);
        }
    }

    const topCounterparties = [...counterparties.values()]
        .sort((a, b) => b.count - a.count || b.amount - a.amount)
        .slice(0, 20);

    const byDay = {};
    for (const tx of list) {
        if (!tx.createdAt) continue;
        const day = String(tx.createdAt).slice(0, 10);
        if (!byDay[day]) byDay[day] = { day, count: 0, inflow: 0, outflow: 0 };
        byDay[day].count += 1;
        if (tx.toId === ebankUserId) byDay[day].inflow += tx.amount;
        if (tx.fromId === ebankUserId) byDay[day].outflow += tx.amount;
    }
    const activityOverTime = Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1));

    const digipogs = user && (user.digipogs != null || user.DIGIPOGS != null)
        ? Number(user.digipogs != null ? user.digipogs : user.DIGIPOGS)
        : null;

    return {
        ebankUserId,
        displayName: user && user.displayName ? user.displayName : `User #${ebankUserId}`,
        digipogs: Number.isFinite(digipogs) ? digipogs : null,
        transactionCount: list.length,
        inflow,
        outflow,
        net: inflow - outflow,
        formbankRelatedCount: formbankRelated,
        topCounterparties,
        activityOverTime,
        recentTransactions: list.slice(0, 100),
        available: true,
        error: null
    };
}

function unavailableEbank(ebankUserId, error) {
    return {
        ebankUserId,
        displayName: `User #${ebankUserId}`,
        digipogs: null,
        transactionCount: 0,
        inflow: 0,
        outflow: 0,
        net: 0,
        formbankRelatedCount: 0,
        topCounterparties: [],
        activityOverTime: [],
        recentTransactions: [],
        available: false,
        error: error || 'Unable to load eBank transaction history from Formbar'
    };
}

module.exports = {
    normalizeTransaction,
    extractTransactionList,
    buildEbankAnalytics,
    unavailableEbank
};
