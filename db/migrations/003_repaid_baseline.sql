-- repaid_baseline on credit_limits is added idempotently in migrate.js applySchemaFixes.
-- Used by npm run reset-credit so historical loan repayments do not re-inflate limits.
SELECT 1;
