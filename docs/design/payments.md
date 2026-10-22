# Design: the payment solution (paying vendors)

Status: design · Related: brief §5.4–5.5, `DECISIONS.md` D-013 to D-015

## 1. The answer in one paragraph

Money stays in the owner's **HDFC current account** and moves through rails the
bank already supports. Our app prepares, checks and approves the payout run;
the bank executes it. All bank channels plug in behind one `BankAdapter`
interface, so we can move from file upload to full API without changing the
rest of the app.

| Phase | How money moves | What "one tap" means | Needs from HDFC |
|---|---|---|---|
| **Beta (MVP)** | **HDFC bulk upload file.** Our app generates the file, the owner uploads it in HDFC corporate net banking and authorises with the bank's own OTP | Approve in our app (passkey) → download file → upload and authorise at HDFC → import response or statement | Bulk-upload facility enabled + the exact file format |
| **Production** | **HDFC API Banking**: our server calls HDFC's payment APIs directly | Approve in our app → done; status and UTR come back automatically | API onboarding, keys/certificates, IP allow-listing, sandbox (see `docs/bank-integration-readiness.md`, to be written in M5) |
| Fallback | Payout platform (e.g. RazorpayX, Cashfree Payouts) | Same as production | Usually a current account at *their* partner bank, or a pre-funded balance. HDFC not confirmed as a partner. Per-transaction fees |

**Vendor bank-detail verification (penny drop)** is needed from day one, even
while payments go by file. Use a verification API (Cashfree, Razorpay and others
offer one; a few rupees per check, verify current price). It deposits ₹1 and
returns the account holder's name, which we fuzzy-match to the vendor's legal name.

### Why the file route is a good start, not a hack

- No bank integration approval needed, so we can start now.
- **Two independent locks:** owner approval in our app, then HDFC's own login and
  OTP. A bug or breach in our app alone cannot move money.
- The same safety core (ledger, idempotency, reconciliation) is built and tested
  now, and the API route reuses it later.

## 2. Flow

```
Verified bills ─► Payables (per vendor, all stores) ─► Payment run (DRAFT)
     │                                                    │ maker prepares
     │                                                    ▼
     │                                          PENDING_APPROVAL ── owner reviews warnings
     │                                                    │ owner approves with passkey
     │                                                    ▼          (maker ≠ checker)
     │                                               APPROVED
     │                       ┌────────────────────────────┴───────────────┐
     │              File adapter                                  API adapter
     │      generate file once, store hash                 submit each payment with
     │      owner uploads at HDFC                          its idempotency key
     │                       └────────────────────────────┬───────────────┘
     │                                                    ▼
     │                                              SUBMITTED
     │                                   ┌────────────────┼────────────────┐
     │                                SETTLED          FAILED          RETURNED
     │                                (UTR)        (retry safely)   (reverse, reopen bill)
     └────────── bills auto-close when their payment is SETTLED and reconciled
```

## 3. Safety controls (how we stop wrong, duplicate or fraudulent payments)

**Before the money**
- Bank details entered once per vendor, versioned, encrypted (KMS envelope
  encryption), masked everywhere. Never taken from invoice text or a UPI QR.
- Bank-detail change: owner approval + penny drop + cooling-off period (e.g. 48 h,
  configurable) + notification + audit trail. No payment to a changed account
  during cooling-off.
- Duplicate vendor check (same GSTIN, PAN or account number).

**At approval**
- Maker-checker: the person who prepares a run cannot approve it. Only the owner approves.
- Owner approval needs a passkey (Face ID / fingerprint). Approval is tied to a
  hash of the run's exact contents, so any change afterwards voids it.
- Warnings on the review screen: new vendor, bank details changed recently,
  amount far from the vendor's usual amount, possible duplicate bill, total above
  account balance, limits from config.
- Kill switch: one setting pauses all payment execution instantly.

**During execution**
- **Idempotency key** on every payment (`run_id + vendor_id + run_version`). A retry
  or a double tap can never pay twice.
- A bill can be in only one active payment (enforced by a database unique constraint, not just code).
- Bank file generated once per approved run. Its hash is stored. Re-generating
  needs a new approval.
- Rail choice (IMPS / NEFT / RTGS / UPI) by amount and urgency, from a config
  file. Limits and cut-off times are config, never hard-coded.

**After**
- **Append-only payment ledger:** every state change is a new row (who, when,
  why). Rows are never updated or deleted. Each row stores the previous row's
  hash, so tampering shows.
- **Reconciliation job:** imports the bank response file or statement and matches
  UTR + amount + beneficiary to payments. Unmatched items go to the exceptions queue.
- Returned or reversed payments reopen their bills automatically and alert the owner.

## 4. Money handling rules

- All amounts in integer paise (`bigint`). Never floats.
- Totals are computed in one place (`packages/core`) and used by phone and server.
- Statutory items (TDS, MSME 45-day rule, GST treatment) are configurable policy
  marked "confirm with the owner's CA", not hard-coded law.

## 5. Still to verify

- Whether the owner's HDFC account has bulk upload enabled, and its exact file
  format (ask the HDFC relationship manager; we will not invent one).
- HDFC API Banking onboarding steps, fees and limits.
- Current price and terms of the penny-drop verification provider we pick.
- Whether any payout platform can work with an existing HDFC current account.
