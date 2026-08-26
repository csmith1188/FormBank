/**
 * Recalculate every user's current_limit from their stored credit_score
 * using the current creditLimitFromScore() mapping (max 100,000).
 *
 * Usage (from project root):
 *   node db/recalc-limits.js
 *   npm run recalc-limits
 */
try { require('dotenv').config(); } catch (_) { /* optional */ }
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const creditScore = require('../creditScore');

function resolveDbPath() {
    const candidates = [
        process.env.DATABASE_FILE,
        './db/database.db',
        './db/app.db'
    ].filter(Boolean);
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        try {
            if (fs.existsSync(resolved) && fs.statSync(resolved).size > 0) return resolved;
        } catch (_) { /* skip */ }
    }
    return null;
}

const resolvedPath = resolveDbPath();

console.log(
    `Recalculating limits (score ${creditScore.SCORE_MIN} → ${creditScore.LIMIT_AT_MIN_SCORE}, ` +
    `score ${creditScore.SCORE_MAX} → ${creditScore.LIMIT_AT_MAX_SCORE})...\n`
);

if (!resolvedPath) {
    console.error('No non-empty database file found (checked DATABASE_FILE, db/database.db, db/app.db).');
    process.exit(1);
}

console.log(`Opening database: ${resolvedPath}`);

const db = new sqlite3.Database(resolvedPath, (err) => {
    if (err) {
        console.error('Failed to open database:', err.message);
        process.exit(1);
    }
    creditScore.recalculateAllCreditLimits(db, (recalcErr, result) => {
        if (recalcErr) {
            console.error('Recalculation failed:', recalcErr.message);
            db.close();
            process.exit(1);
        }
        console.log(`\nDone. Updated ${result.updated}/${result.total} users.`);
        db.close();
    });
});
