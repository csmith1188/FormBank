-- Loan security deposit columns are added idempotently in migrate.js applySchemaFixes
-- (deposit_posted, deposit_held, deposit_refunded on credit_limits).
-- Fresh installs get them from init.sql. This migration records the schema change.
SELECT 1;
