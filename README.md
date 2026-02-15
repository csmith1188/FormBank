# Credit Pog - Formbar AUX App

A loan management system that integrates with Formbar to provide credit/loan functionality for digipogs. Students can borrow digipogs with a 20% interest rate, and their credit limit increases each time they successfully pay off a loan.

## Features

- **Loan System**: Borrow digipogs with fixed 20% interest per loan
- **Credit Limits**: Starting limit of 250 digipogs, increases by +250 for each paid-off loan
- **Credit Balance**: Overpayments are credited to your account for future loan repayments
- **One Active Loan**: Only one active loan allowed per student at a time
- **Tax-Aware**: Handles Formbar's 10% transfer tax correctly

## Setup

### Prerequisites

- Node.js (v14 or higher)
- Access to Formbar system
- SQLite3

### Installation

1. Install dependencies:
```bash
npm install
```

2. Initialize the database:
```bash
npm run init-db
```

3. Create a `.env` file in the root directory with the following variables:

```env
PORT=3000
SESSION_SECRET=your_secret_key_here
AUTH_URL=http://localhost:420/oauth
THIS_URL=http://localhost:3000
API_KEY=your_api_key_here
LENDER_USER_ID=1
LENDER_PIN=3639
```

### Environment Variables

- `PORT`: Port number for the server (default: 3000)
- `SESSION_SECRET`: Secret key for session encryption
- `AUTH_URL`: URL of the Formbar OAuth server
- `THIS_URL`: URL of this application (for OAuth redirects)
- `API_KEY`: API key for Formbar Socket.io connection
- `LENDER_USER_ID`: Formbar user ID of the lender/ATM account
- `LENDER_PIN`: PIN for automated transfers from the lender account

### Running the Application

```bash
npm start
```

The application will be available at `http://localhost:3000` (or your configured PORT).

## How It Works

### Tax-Aware Economics

Formbar applies a 10% tax on all digipog transfers. This affects both loan issuance and repayments:

#### Loan Issuance
- Student requests a loan of **P** digipogs
- Formbar transfers **P** from lender to student
- Student receives **0.9 × P** digipogs (after 10% tax)
- Student owes **P × 1.2** digipogs (principal + 20% interest)

**Example**: Student borrows 100 digipogs
- Receives: 90 digipogs (after tax)
- Owes: 120 digipogs (100 × 1.2)

#### Repayment
- Student sends **R** digipogs to lender
- Lender receives **0.9 × R** digipogs (after 10% tax)
- Student's loan balance decreases by **R** (the pre-tax amount sent)

**Example**: Student repays 50 digipogs
- Lender receives: 45 digipogs (after tax)
- Loan balance decreases by: 50 digipogs

### Credit Limits

- **Starting Limit**: 250 digipogs
- **Increase**: +250 digipogs for each fully paid-off loan
- **Progression**: 250 → 500 → 750 → 1000 → ...

### Credit Balance

If a student overpays their loan (sends more than the remaining balance), the excess is stored as a credit balance. This credit can be used for future loan repayments automatically.

**Example**: 
- Remaining owed: 20 digipogs
- Student sends: 50 digipogs
- Result: Loan paid off, 30 digipogs credited to account

## API Endpoints

### GET /credit
Main dashboard showing credit limit, active loan, credit balance, and loan history.

### POST /credit/borrow
Request a new loan.

**Body:**
```json
{
  "amount": 100
}
```

**Validation:**
- No active loan exists
- Amount ≤ current credit limit
- Amount > 0

### POST /credit/repay
Make a partial or full repayment.

**Body:**
```json
{
  "amount": 50,
  "pin": "optional_pin"
}
```

**Behavior:**
- Applies credit balance first (if available)
- Transfers remaining amount from borrower to lender
- If repayment exceeds remaining balance, excess is credited
- If loan is fully paid, credit limit increases by +250

### POST /credit/repay/full
Convenience endpoint to pay the exact remaining balance.

**Body:**
```json
{
  "pin": "optional_pin"
}
```

## Database Schema

### credit_loans
Stores all loan records.

- `id`: Primary key
- `borrower_formbar_user_id`: Formbar user ID of borrower
- `principal`: Loan amount (pre-tax)
- `interest_rate`: Interest rate (default 0.20)
- `amount_owed`: Total amount owed (ceil(principal × 1.20))
- `amount_paid`: Total amount paid toward loan
- `status`: 'active', 'paid', or 'defaulted'
- `created_at`: Loan creation timestamp
- `paid_at`: Loan payoff timestamp (nullable)

### credit_limits
Tracks borrowing limits per user.

- `borrower_formbar_user_id`: Primary key (Formbar user ID)
- `current_limit`: Current maximum loan amount
- `paid_off_count`: Number of loans successfully paid off

### credit_balances
Tracks overpayment credits.

- `borrower_formbar_user_id`: Primary key (Formbar user ID)
- `credit_balance`: Available credit for future repayments

## Notes

- All amounts are stored and calculated as integers (digipogs are whole numbers)
- Interest calculation uses `ceil(principal × 1.20)` to round up
- Only one active loan per user is enforced
- Formbar transfer failures do not modify loan state (transaction safety)
- Credit balance is automatically applied before requiring new transfers

## License

ISC

