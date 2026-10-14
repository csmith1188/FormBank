/**
 * Parse analytics date-range query params into SQL-friendly bounds.
 */

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function endOfDay(d) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
}

/**
 * @param {{ range?: string, from?: string, to?: string }} query
 * @returns {{ range: string, from: string|null, to: string|null, label: string }}
 */
function parseDateRange(query = {}) {
    const range = String(query.range || '30d').toLowerCase();
    const now = new Date();
    let from = null;
    let to = endOfDay(now).toISOString();
    let label = 'Last 30 days';

    if (range === 'today') {
        from = startOfDay(now).toISOString();
        label = 'Today';
    } else if (range === '7d') {
        from = startOfDay(new Date(now.getTime() - 6 * 86400000)).toISOString();
        label = 'Last 7 days';
    } else if (range === '30d') {
        from = startOfDay(new Date(now.getTime() - 29 * 86400000)).toISOString();
        label = 'Last 30 days';
    } else if (range === '90d') {
        from = startOfDay(new Date(now.getTime() - 89 * 86400000)).toISOString();
        label = 'Last 90 days';
    } else if (range === 'all') {
        from = null;
        to = null;
        label = 'All time';
    } else if (range === 'custom') {
        if (query.from) {
            from = startOfDay(new Date(query.from)).toISOString();
        }
        if (query.to) {
            to = endOfDay(new Date(query.to)).toISOString();
        }
        label = 'Custom range';
    } else {
        from = startOfDay(new Date(now.getTime() - 29 * 86400000)).toISOString();
    }

    return { range, from, to, label };
}

/** SQL fragment + params for created_at filter on alias `ft` (or custom col). */
function dateFilterSql(from, to, column = 'ft.created_at') {
    const clauses = [];
    const params = [];
    if (from) {
        clauses.push(`${column} >= ?`);
        params.push(from);
    }
    if (to) {
        clauses.push(`${column} <= ?`);
        params.push(to);
    }
    return {
        sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
        params
    };
}

module.exports = { parseDateRange, dateFilterSql, startOfDay, endOfDay };
