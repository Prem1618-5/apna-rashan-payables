# HDFC bulk payment file

Code: `packages/hdfc-bulk-file` · Layout: `packages/hdfc-bulk-file/src/spec.ts`

## Scope

The app's job ends when the file is ready. Payment happens in HDFC:

```
App: verified bills → one payment per vendor → bank file + control totals
Owner: ENet login → upload file → check count and total match → authorise with HDFC OTP
HDFC: sends NEFT / RTGS / internal transfers
App: owner marks the run "Uploaded" / "Paid" (optionally types the UTRs)
```

## Where the format comes from (read this)

HDFC does **not** publish the ENet bulk-upload layout on its public website. It
is given to ENet customers inside the portal and by the relationship manager.
What public sources confirm:

| Fact | Source |
|---|---|
| ENet bulk upload accepts plain ASCII text files | Cashfree bulk payment guide |
| Upload file limit is 2 MB | HDFC ENet FAQ (search result excerpt) |
| Bulk modes are NEFT, RTGS and HDFC-to-HDFC funds transfer; bulk IMPS/UPI not supported (as of 2018–19) | CA Club India article |
| One bad row rejects the whole file | CA Club India article |
| The vendor-payment file is 28 columns, bare CSV, no quoting, so a comma inside a value shifts every later column | Public description of an open-source ENet file generator |
| File is made from HDFC's Excel template saved as CSV | HDFC bulk upload manual (third-party copy, ~2016) |

The column list below is the widely used ENet vendor-payment layout. It matches
all the facts above, but **it has not been checked against an official 2026
template**. The whole layout lives in one file (`spec.ts`) so any difference
is a one-file change.

## Layout `hdfc-enet-vendor-payment-v1`

No header row · comma separated · no quotes · CRLF line endings · ASCII only ·
one row per payment.

| # | Column | Max | What we write |
|---|---|---|---|
| 1 | Transaction Type | 1 | `I` if vendor's IFSC starts with HDFC, else `R` if amount ≥ ₹2,00,000, else `N` |
| 2 | Beneficiary Code | 13 | Vendor's ENet beneficiary code (required for `I`) |
| 3 | Beneficiary Account Number | 25 | From vendor master |
| 4 | Instrument Amount | 20 | Rupees with 2 decimals, no commas: `5729.50` |
| 5 | Beneficiary Name | 40 | Vendor legal name, cleaned |
| 6–7 | Drawee Location, Print Location | 20 | Empty (for cheque/DD only) |
| 8–12 | Bene Address 1–5 | 70 | Optional |
| 13 | Instruction Reference Number | 20 | Our payment reference |
| 14 | Customer Reference Number | 20 | Our payment reference (used to match the bank's report) |
| 15–21 | Payment details 1–7 | 30 | `BILLS` + bill numbers; `+N MORE` if they don't fit |
| 22 | Cheque Number | 12 | Empty |
| 23 | Chq / Trn Date | 10 | Payment date `DD/MM/YYYY` |
| 24 | MICR Number | 15 | Empty |
| 25 | IFC Code | 11 | Vendor IFSC |
| 26 | Bene Bank Name | 100 | Optional |
| 27 | Bene Bank Branch Name | 40 | Optional |
| 28 | Beneficiary email id | 100 | Optional; HDFC may email the vendor an advice |

**File name:** `{CLIENTCODE}{DD}{MM}.{SEQ}`, for example `ARAD012310.001` (third
file of the day = `.003`). This follows the naming seen in a real ENet sample
file (`8892RBI2708.009`). Confirm with HDFC.

## Rules the generator enforces

The bank rejects the whole file for one bad row, so the app refuses to make a
file until every row is valid, and lists every problem at once.

- **Bank details:** IFSC format (`AAAA0XXXXXX`), account number 6–25 letters/digits
  (warning if not the usual 9–18 digits), same account under two vendors → error.
- **Amount:** integer paise, more than zero, optional per-payment limit. Never floats.
- **One payment per vendor** per file; references unique; the same bill twice → error.
- **Credit notes** reduce the vendor's total; if they cancel it out, no payment.
- **Text cleaning:** only `A–Z a–z 0–9 space . - /` are kept. Commas, quotes,
  `&`, line breaks and Hindi script are removed, so columns can never shift.
  A name that becomes empty (e.g. Hindi only) is an error: store the English legal name.
- **Too long:** account, IFSC, codes, references → error; names and narration → shortened with a warning.
- **Date:** real calendar date only (no 30 February), written `DD/MM/YYYY`.
- **File:** ASCII only, ≤ 2 MB, SHA-256 hash recorded so the uploaded file can be proven unchanged.

## Control totals: the owner's final check

With every file the app shows **number of payments** and **total amount**
(also split into NEFT / RTGS / internal). After uploading, ENet shows its own
count and total before you authorise. **If they differ, do not authorise.**

## Before the first real payment run (owner checklist)

1. Ask the HDFC relationship manager (or download from ENet → Upload) for the
   current **bulk vendor payment template and a sample file**.
2. Compare it column by column with the table above. Send any differences and
   we change `spec.ts` only.
3. Confirm: client code, file name rule, whether beneficiaries must be registered
   in ENet first (and whether NEFT/RTGS rows need the beneficiary code), and the
   transaction type letters.
4. **Test run:** make a file paying ₹1 to one of your own other bank accounts.
   Upload, authorise, and check it arrives.
5. Then run a small real batch (2–3 vendors) before the full run.

## Try it

```bash
pnpm install
pnpm test                                   # 23 tests
pnpm --filter @arad/hdfc-bulk-file sample   # writes out/ARAD012310.001 + summary
```
