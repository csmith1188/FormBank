# FormBank

**FormBank** is a digipog loan and check-writing app that integrates with [Formbar](https://github.com/csmith1188/Formbar.js). It provides credit/loan management and peer-to-peer checks for the York County School of Technology (York Tech) ecosystem. Students can borrow digipogs, repay loans, and write checks to other users (or leave checks open for anyone to redeem).

## Features

### Credit & Loans
- **Loan system**: Tiered interest by credit limit (higher at low limits, lower as you grow; floor 25%)
- **Security deposit**: 1000 digipogs required before the first loan; safe portions may be refunded after full repayments
- **Credit limits**: Start at 250 digipogs; limit increases by +250 when repayment thresholds are met (configured via `CREDIT_LIMIT_STEP`)
- **One active loan** per user at a time
- **Tax-aware**: Handles Formbar’s 10% transfer tax correctly

### Checks
- **Write checks** to a specific user (Formbar user ID) or leave receiver blank
- **One deposit**: sender pays FormBank enough to cover Formbar’s 10% tax on *both* legs plus FormBank’s **net 5%** fee
- **Payout**: FormBank sends a grossed-up amount so the receiver nets **100%** of the check amount
- **Blank check**: same deposit at write time; FormBank pays the redeemer on the status page
- **Check status page**: Sender and receiver can view check details and a QR code for the status URL
- **FormBank account**: If the writer is the lender (`LENDER_USER_ID`), the deposit charge is skipped (funds already at FormBank)
- **Check vault**: If `POOL_ID` is set, deposits and payouts go through that Formbar pool (Formbar DEV transfer API). If `POOL_ID` is blank, checks use `LENDER_USER_ID` instead.
- **Statuses**: `uncashed`, `completed`, `failed`, and `funded_unpaid` (deposit succeeded but payout did not)

### Admin analytics
- **Ledger**: Append-only `financial_transactions` records every loan issue/repay, check deposit/payout/fee, Formbar tax, and credit-limit change
- **Dashboard**: `/admin/analytics` (lender admin only) with financial position, P&L, loan/credit/check/user analytics, risk rules, reconciliation queue, Chart.js charts, and CSV exports
- **Reconciliation**: Timeouts and Formbar-success/local-DB-fail cases are marked `reconciliation_required` instead of silently dropping records

## Setup

### Prerequisites
- Node.js (v14 or higher)
- Access to a Formbar system
- SQLite3

### Installation

1. Clone or download the project, then install dependencies:
   ```bash
   npm install
   ```

2. Initialize the database:
   ```bash
   npm run init-db
   ```

3. Create a `.env` file in the project root:

   ```env
   PORT=3000
   SESSION_SECRET=your_secret_key_here
   AUTH_URL=http://localhost:420/oauth
   THIS_URL=http://localhost:3000
   API_KEY=your_api_key_here
   LENDER_USER_ID=1
   LENDER_PIN=3639
   # Optional. When set, checks go through this Formbar pool (DEV transfer API).
   # Leave blank to use LENDER_USER_ID until pool send/receive is on Formbar main.
   POOL_ID=
   CREDIT_LIMIT_STEP=250
   # Optional. Both required to show the eBank analytics section on /admin/analytics.
   # EBANK_USER_ID=28
   # EBANK_API_KEY=
   ```

### Environment variables
| Variable | Description |
|---------|-------------|
| `PORT` | Server port (default: 3000) |
| `SESSION_SECRET` | Secret for session encryption |
| `AUTH_URL` | Formbar OAuth base URL |
| `THIS_URL` | This app’s base URL (for redirects and check links) |
| `API_KEY` | API key for the Formbar Socket.io connection |
| `LENDER_USER_ID` | Formbar user ID of the lender/default account (also used for checks when `POOL_ID` is blank) |
| `LENDER_PIN` | PIN for loan transfers from the lender account, and for check payouts (lender PIN, or pool owner PIN when `POOL_ID` is set) |
| `POOL_ID` | Optional Formbar digipog pool ID for check deposits and payouts. Blank or `0` falls back to `LENDER_USER_ID`. Do not use the developer pool `0`. |
| `CREDIT_LIMIT_STEP` | Starting credit limit and amount added each repayment threshold (default: 250) |
| `EBANK_USER_ID` | Optional. Formbar user ID for eBank analytics. Must be set together with `EBANK_API_KEY` or the section is hidden. |
| `EBANK_API_KEY` | Optional. API key from the eBank user’s Formbar profile (or a manager key). Required with `EBANK_USER_ID` to enable the eBank analytics section. |

### Run the app
```bash
npm start
```
The app is available at `http://localhost:3000` (or your configured `PORT`). Migrations run automatically on startup.

### Tests
```bash
npm test
```

### Reset credit limits
Resets every borrower's `current_limit` to `CREDIT_LIMIT_STEP` (default 250) and `paid_off_count` to 0. Keeps `credit_loans` and `financial_transactions`. Sets `repaid_baseline` so old repayments do not immediately re-inflate limits.
```bash
npm run reset-credit -- --yes
```

## Accounting assumptions (analytics)

- **Formbar tax**: Recipient nets `floor(gross × 0.9)`. Gross-up helpers live in `lib/accounting.js`.
- **Interest collected**: Principal-first allocation. Contracted interest is not counted as revenue until collected.
- **Check fee revenue**: Recognized when a check deposit completes. Uncashed / `funded_unpaid` funds are **liabilities** (escrow), not profit.
- **Formbar taxes**: Recorded as expenses (not as FormBank fee revenue).
- **Borrower credit-balance liabilities**: FormBank has no per-user overpayment wallet; this card is **0**. Held user funds appear as check escrow or unresolved ledger rows.
- **Available funds**: There is no Formbar balance API in this app. The dashboard shows **Unverified** rather than an estimate.
- **Active users**: Distinct Formbar IDs with recorded financial activity — not the size of the local `users` username cache.
- **No overdue/default**: Loan age buckets are informational only.
- **Historical gaps**: Pre-migration repayments are backfilled as one aggregated `loan_repay` per loan (`legacy_aggregate`). Failed historical checks do not invent successful deposits. Credit-limit increase history starts when ledger writing began.

## How it works

### Credit & loans (summary)
- Post a **1000** digipog security deposit before borrowing (refunded in safe portions as limit grows)
- Borrow **P** digipogs → receive **0.9×P** (after 10% tax), owe **ceil(P × (1 + tiered rate))**
- Interest depends on current credit limit (100% at ≤250 … 25% at high limits)
- Repayments reduce the balance and cannot exceed the remaining amount owed
- One active loan per user; repayment thresholds raise the limit by `CREDIT_LIMIT_STEP` (default 250)

### Checks
- **With receiver ID**: One transfer sender → FormBank (grossed for two tax legs + 5% FormBank fee), then FormBank → receiver (grossed so they net 100% of the amount) using `LENDER_PIN`.
- **No receiver (blank)**: Same deposit to FormBank at write time. On redeem, FormBank → receiver (full net amount).
- **FormBank writer**: When the writer’s user ID equals `LENDER_USER_ID`, the deposit step is skipped and only the payout runs (for a specific receiver).
- **Pool vs lender**: Set `POOL_ID` to route checks through a Formbar pool (`{ id, type: 'pool' }` transfers, ready for Formbar DEV becoming main). Leave `POOL_ID` blank to keep the current lender-user flow.

## Main routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Home (requires login) |
| GET | `/credit` | Credit dashboard: limit, deposit, active loan, history |
| POST | `/credit/deposit` | Post 1000 digipog security deposit (`pin`) |
| POST | `/credit/borrow` | Request a loan (`amount`); requires deposit |
| POST | `/credit/repay` | Repay (`amount`, `pin`) |
| POST | `/credit/repay/full` | Pay full remaining balance (`pin`) |
| GET | `/checks` | Checks dashboard: list and write-check form |
| POST | `/checks/write` | Write a check (`receiverId` optional, `amount`, `pin`, `memo` optional) |
| GET | `/checks/:id` | Check detail (and QR). If `?receiverId=` is set, redeem for that user (no login). |
| GET | `/admin` | Credit limits + loan/balance edit tools (lender only) |
| POST | `/admin/credit-limit` | Set/create a borrower's credit limit (local bookkeeping) |
| POST | `/admin/loans/:id` | Edit loan principal, owed, paid, status (local bookkeeping) |
| POST | `/admin/loans/:id/void` | Void a loan locally (no Formbar refund) |
| GET | `/admin/checks` | All checks (lender only) |
| GET | `/admin/analytics` | Analytics dashboard (lender only) |
| GET | `/admin/analytics/borrowers/:formbarUserId` | Borrower profile (lender only) |
| GET | `/admin/analytics/export/:report.csv` | CSV exports: `transactions`, `lending`, `checks`, `summary` |
| GET | `/admin/analytics/api/summary` | JSON summary for charts/filters |

## Database schema (main tables)

- **credit_loans** – Loan records (borrower, principal, amount_owed, amount_paid, status, etc.)
- **credit_limits** – Per-user borrowing limit, paid-off count, and deposit_posted / deposit_held / deposit_refunded
- **checks** – Check records: sender, receiver (nullable), amount, fee_charged, status (`completed` / `failed` / `uncashed` / `funded_unpaid`), memo, `cashed_at`, `pin_for_redemption` (cleared after redeem)
- **financial_transactions** – Append-only ledger (types, amounts, tax/fee/principal/interest components, status, idempotency keys)
- **financial_snapshots** – Optional daily position snapshots for historical charts
- **users** – Usernames (from login; not Formbar population)

## Tech stack
- **Backend**: Node.js, Express
- **Auth**: Formbar OAuth (JWT), express-session (SQLite store)
- **DB**: SQLite3
- **Formbar**: socket.io-client for digipog transfers
- **Views**: EJS; styling aligned with York Tech branding (green theme, Autumn font)

## License
ISC
