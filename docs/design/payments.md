# Design: payments (kept simple)

Status: design · Related: `DECISIONS.md` D-021, D-022 · File format: `hdfc-bulk-file.md`

## The decision

**The app makes the file. HDFC makes the payment.**

The app does not connect to any bank or payout service. It:

1. Collects verified bills that are due, across all stores.
2. Makes **one payment per vendor** (bills minus credit notes).
3. Shows the owner one review screen with warnings.
4. On approval, generates the **HDFC ENet bulk upload file** and its control totals.

The owner uploads the file in HDFC ENet and authorises it with HDFC's own OTP.
The money never moves through our app, so a bug in our app cannot pay anyone.

## Statuses

`DRAFT` → `APPROVED` (file generated) → `UPLOADED` (owner confirms) → `PAID`
(owner confirms; optional UTR per payment). A rejected or failed payment: the
owner marks it `FAILED` and its bills go back to "due".

## Safety, kept to what matters

- Bank details entered once per vendor. The account number is typed twice
  (must match) and IFSC is format-checked. Never read from invoice text or a UPI QR.
- Changing a vendor's bank details needs owner approval and is logged.
- The person who prepares a run is not the person who approves it (owner approves).
- A bill can be in only one open run (database constraint).
- The file is generated once per approved run; its SHA-256 hash is stored.
- Control totals (count + amount) must match what ENet shows before authorising.

## Left out on purpose (possible later)

HDFC API Banking, payout platforms, penny-drop verification, automatic import
of bank statements, rail optimisation beyond NEFT / RTGS / internal transfer.
