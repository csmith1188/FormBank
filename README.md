# FormBank

**FormBank** is a digipog loan and check-writing app that integrates with [Formbar](https://github.com/csmith1188/Formbar.js). It provides credit/loan management and peer-to-peer checks for the York County School of Technology (York Tech) ecosystem. Students can borrow digipogs, repay loans, and write checks to other users (or leave checks open for anyone to redeem).

## Features

### Credit & Loans
- **Loan system**: Borrow digipogs with a fixed 20% interest per loan
- **Credit limits**: Start at 500 digipogs; limit increases by +500 each time your total repayments reach your current credit limit (configured via `CREDIT_LIMIT_STEP`)
- **Credit balance**: Overpayments are credited for future repayments
- **One active loan** per user at a time
- **Tax-aware**: Handles Formbar’s 10% transfer tax correctly

### Checks
- **Write checks** to a specific user (Formbar user ID) or leave receiver blank
- **One deposit**: sender pays FormBank enough to cover Formbar’s 10% tax on *both* legs plus FormBank’s **net 5%** fee
- **Payout**: FormBank sends a grossed-up amount so the receiver nets **100%** of the check amount
- **Blank check**: same deposit at write time; FormBank pays the redeemer on the status page
- **Check status page**: Sender and receiver can view check details and a QR code for the status URL
- **FormBank account**: If the writer is the lender (`LENDER_USER_ID`), the deposit charge is skipped (funds already at FormBank)

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
   CREDIT_LIMIT_STEP=500
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
| `CREDIT_LIMIT_STEP` | Starting credit limit and amount added each repayment threshold (default: 500) |

### Run the app
```bash
npm start
```
The app is available at `http://localhost:3000` (or your configured `PORT`).

## How it works

### Credit & loans (summary)
- Borrow **P** digipogs → receive **0.9×P** (after 10% tax), owe **P×1.2**
- Repayments reduce the balance; overpayments go to credit balance
- One active loan per user; every time your total repayments reach your current credit limit, that limit increases by `CREDIT_LIMIT_STEP` (default 500)

### Checks
- **With receiver ID**: One transfer sender → FormBank (grossed for two tax legs + 5% FormBank fee), then FormBank → receiver (grossed so they net 100% of the amount) using `LENDER_PIN`.
- **No receiver (blank)**: Same deposit to FormBank at write time. On redeem, FormBank → receiver (full net amount).
- **FormBank writer**: When the writer’s user ID equals `LENDER_USER_ID`, the deposit step is skipped and only the payout runs (for a specific receiver).

## Main routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Home (requires login) |
| GET | `/credit` | Credit dashboard: limit, balance, active loan, history |
| POST | `/credit/borrow` | Request a loan (`amount`) |
| POST | `/credit/repay` | Repay (`amount`, `pin`) |
| POST | `/credit/repay/full` | Pay full remaining balance (`pin`) |
| GET | `/checks` | Checks dashboard: list and write-check form |
| POST | `/checks/write` | Write a check (`receiverId` optional, `amount`, `pin`, `memo` optional) |
| GET | `/checks/:id` | Check detail (and QR). If `?receiverId=` is set, redeem for that user (no login). |

## Database schema (main tables)

- **credit_loans** – Loan records (borrower, principal, amount_owed, amount_paid, status, etc.)
- **credit_limits** – Per-user borrowing limit and paid-off count
- **credit_balances** – Overpayment credit per user
- **checks** – Check records: sender, receiver (nullable), amount, fee_charged, status (`completed` / `failed` / `uncashed`), memo, `pin_for_redemption` (used once for blank-check redemption, then cleared)
- **users** – Usernames (from login)

## Tech stack
- **Backend**: Node.js, Express
- **Auth**: Formbar OAuth (JWT), express-session (SQLite store)
- **DB**: SQLite3
- **Formbar**: socket.io-client for digipog transfers
- **Views**: EJS; styling aligned with York Tech branding (green theme, Autumn font)

## License
ISC
