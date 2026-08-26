/**
 * One-shot: reduce every user's stored credit_score by 250 (floored at 300),
 * then recalculate current_limit from the new score.
 *
 * Usage (from project root):
 *   node db/reduce-scores.js
 *
 * DB path: DATABASE_FILE from .env, or ./db/database.db
 */
require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const creditScore = require('../creditScore');

const SCORE_DROP = 250;
const dbPath = process.env.DATABASE_FILE || './db/database.db';
const resolvedPath = path.resolve(dbPath);

console.log(`Opening database: ${resolvedPath}`);
console.log(`Reducing each credit_score by ${SCORE_DROP} (min ${creditScore.SCORE_MIN}), then recalculating limits...\n`);

const db = new sqlite3.Database(resolvedPath, (err) => {
    if (err) {
        console.error('Failed to open database:', err.message);
        process.exit(1);
    }
});

db.all(
    'SELECT borrower_formbar_user_id AS user_id, credit_score, current_limit FROM credit_limits ORDER BY borrower_formbar_user_id ASC',
    [],
    (err, rows) => {
        if (err) {
            console.error('Failed to read credit_limits:', err.message);
            db.close();
            process.exit(1);
        }

        const list = rows || [];
        if (list.length === 0) {
            console.log('No rows in credit_limits. Nothing to do.');
            db.close();
            return;
        }

        let pending = list.length;
        let updated = 0;

        list.forEach((row) => {
            const oldScore = row.credit_score != null ? Number(row.credit_score) : creditScore.BASE_SCORE;
            const newScore = Math.max(creditScore.SCORE_MIN, Math.round(oldScore - SCORE_DROP));
            const newLimit = creditScore.creditLimitFromScore(newScore);

            db.run(
                'UPDATE credit_limits SET credit_score = ?, current_limit = ? WHERE borrower_formbar_user_id = ?',
                [newScore, newLimit, row.user_id],
                function (updErr) {
                    if (updErr) {
                        console.error(`User ${row.user_id}: update failed — ${updErr.message}`);
                    } else {
                        updated += 1;
                        console.log(
                            `User ${row.user_id}: score ${oldScore} → ${newScore} (${creditScore.scoreLabel(newScore)}), ` +
                            `limit ${row.current_limit} → ${newLimit}`
                        );
                    }
                    pending -= 1;
                    if (pending === 0) {
                        console.log(`\nDone. Updated ${updated}/${list.length} users.`);
                        db.close();
                    }
                }
            );
        });
    }
);
