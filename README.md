# FormBank

**FormBank** is a digipog loan and check-writing app that integrates with [Formbar](https://github.com/csmith1188/Formbar.js). It provides credit/loan management and peer-to-peer checks for the York County School of Technology (York Tech) ecosystem. Students can borrow digipogs, repay loans, and write checks to other users (or leave checks open for anyone to redeem).

## Features

### Credit & Loans
- **Credit score**: FICO-style 300–850 score from payment history, utilization, credit age, and repayment volume (new borrowers start at 580 / Fair)
- **Score-based terms**: Higher score → higher credit limit, lower interest, smaller check fees
- **Loan system**: Interest is set from your score when you borrow (about 8%–30%)
- **Credit balance**: Overpayments are credited for future repayments
- **One active loan** per user at a time
- **Tax-aware**: Handles Formbar’s 10% transfer tax correctly

### Checks
- **Write checks** to a specific user (Formbar user ID) or leave receiver blank
- **Flow**: Sender pays **amount + fee** to FormBank in one transfer; on success FormBank pays the receiver the check amount
- **Fee**: Driven by credit score (about 1.5%–8% with a score-based minimum; skipped if the writer is the default/lender user)
- **Blank check**: Amount + fee are deposited to FormBank at write time; FormBank pays the amount when someone redeems via the check status page (logged in or with `?receiverId=`)
- **Check status page**: Sender and receiver can view check details and a QR code for the status URL. Only they (and redeemer for blank checks) can access the page
- **Default user**: If the user writing the check is the lender (default user in `.env`), the deposit step is skipped and FormBank pays the receiver directly

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
   ```

### Environment variables
| Variable | Description |
|---------|-------------|
| `PORT` | Server port (default: 3000) |
| `SESSION_SECRET` | Secret for session encryption |
| `AUTH_URL` | Formbar OAuth base URL |
| `THIS_URL` | This app’s base URL (for redirects and check links) |
| `API_KEY` | API key for the Formbar Socket.io connection |
| `LENDER_USER_ID` | Formbar user ID of the lender/default account |
| `LENDER_PIN` | PIN for transfers from the lender account (and for redemption on behalf of sender when applicable) |

### Run the app
```bash
npm start
```
The app is available at `http://localhost:3000` (or your configured `PORT`).

## How it works

### Credit & loans (summary)
- Credit score (300–850) is computed from loan history; see `creditScore.js`
- Score sets **limit**, **interest**, and **check fees**
- Borrow **P** digipogs → receive **0.9×P** (after 10% tax), owe **P×(1 + rate)**
- Repayments reduce the balance; overpayments go to credit balance
- One active loan per user; paying loans and building history raises your score and terms

### Checks
- **With receiver ID**: Sender → FormBank for amount+fee, then FormBank → receiver for amount. Check is recorded as completed or failed.
- **No receiver (blank)**: Sender → FormBank for amount+fee at write time. On redeem, FormBank → receiver for amount.
- **Default user**: When the writer’s user ID equals `LENDER_USER_ID`, the deposit step is skipped and FormBank pays the receiver directly.
- **Legacy blank checks** (written under the old fee-only model with a stored sender PIN) still redeem sender → receiver using that PIN.

## Main routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Home (requires login) |
| GET | `/credit` | Credit dashboard: score, limit, rate, balance, active loan, history |
| POST | `/credit/borrow` | Request a loan (`amount`) |
| POST | `/credit/repay` | Repay (`amount`, `pin`) |
| POST | `/credit/repay/full` | Pay full remaining balance (`pin`) |
| GET | `/checks` | Checks dashboard: list and write-check form |
| POST | `/checks/write` | Write a check (`receiverId` optional, `amount`, `pin`, `memo` optional) |
| GET | `/checks/:id` | Check detail (and QR). If `?receiverId=` is set, redeem for that user (no login). |

## Database schema (main tables)

- **credit_loans** – Loan records (borrower, principal, interest_rate, amount_owed, amount_paid, status, etc.)
- **credit_limits** – Per-user borrowing limit, paid-loan count, and cached credit_score
- **credit_balances** – Overpayment credit per user
- **checks** – Check records: sender, receiver (nullable), amount, fee_charged, status (`completed` / `failed` / `uncashed`), memo, `pin_for_redemption` (used once for blank-check redemption, then cleared)
- **users** – Usernames and Formbar IDs (from login / API cache)

## Tech stack
- **Backend**: Node.js, Express
- **Auth**: Formbar OAuth (JWT), express-session (SQLite store)
- **DB**: SQLite3
- **Formbar**: socket.io-client for digipog transfers
- **Views**: EJS; styling aligned with York Tech branding (green theme, Autumn font)

## License
ISC
