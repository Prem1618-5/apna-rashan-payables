-- Apna Rashan Payables: initial schema.
-- Conventions: money in bigint paise, quantities in thousandths (qty_milli), GST rates in basis points,
-- calendar dates as DATE, instants as timestamptz. gen_random_uuid() is built into Postgres 13+.

-- ------------------------------------------------------------------ stores & people

CREATE TABLE stores (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{1,10}$'),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  gstin       text UNIQUE CHECK (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  address     text CHECK (length(address) <= 300),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  phone          text NOT NULL UNIQUE CHECK (phone ~ '^[6-9][0-9]{9}$'),
  pin_hash       text NOT NULL CHECK (pin_hash LIKE 'scrypt$%'),
  role           text NOT NULL CHECK (role IN ('owner', 'staff')),
  lang           text NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'hi')),
  active         boolean NOT NULL DEFAULT true,
  failed_logins  integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_stores (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id  uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, store_id)
);
CREATE INDEX user_stores_store_idx ON user_stores (store_id);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC-SHA256(SESSION_SECRET, token); the token itself is never stored.
  token_hash    bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ip            text,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ------------------------------------------------------------------ vendors

CREATE TABLE vendors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  trade_name          text CHECK (length(trade_name) <= 120),
  gstin               text UNIQUE CHECK (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  pan                 text CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  phone               text CHECK (phone ~ '^[0-9+ -]{6,20}$'),
  email               text CHECK (length(email) <= 120),
  payment_terms_days  integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'BLOCKED')),
  -- NULL created_by = created by the system (e.g. auto-created from an invoice's seller GSTIN).
  created_by          uuid REFERENCES users(id),
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'ACTIVE' OR approved_by IS NOT NULL)
);
CREATE INDEX vendors_pan_idx ON vendors (pan) WHERE pan IS NOT NULL;
CREATE INDEX vendors_name_idx ON vendors (lower(name));

CREATE TABLE vendor_bank_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  version             integer NOT NULL CHECK (version >= 1),
  -- AES-256-GCM with DATA_ENCRYPTION_KEY ("v1:iv:tag:ct"); never stored in plain text.
  account_number_enc  text NOT NULL CHECK (account_number_enc LIKE 'v1:%'),
  -- Keyed blind index (HMAC) of the normalised account number, for duplicate detection.
  account_hash        bytea NOT NULL CHECK (length(account_hash) = 32),
  account_last4       text NOT NULL CHECK (account_last4 ~ '^[A-Z0-9]{1,4}$'),
  account_length      integer NOT NULL CHECK (account_length BETWEEN 6 AND 25),
  ifsc                text NOT NULL CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name           text CHECK (length(bank_name) <= 100),
  branch_name         text CHECK (length(branch_name) <= 100),
  bene_code           text CHECK (bene_code ~ '^[A-Z0-9]{1,13}$'),
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'SUPERSEDED', 'REJECTED')),
  -- Cooling-off: payments to this account are blocked until this instant.
  usable_from         timestamptz,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  status_reason       text,
  UNIQUE (vendor_id, version),
  CHECK (status NOT IN ('APPROVED', 'SUPERSEDED') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND usable_from IS NOT NULL))
);
-- Exactly one approved bank account per vendor.
CREATE UNIQUE INDEX vendor_bank_one_approved ON vendor_bank_accounts (vendor_id) WHERE status = 'APPROVED';
CREATE INDEX vendor_bank_account_hash_idx ON vendor_bank_accounts (account_hash);
CREATE INDEX vendor_bank_pending_idx ON vendor_bank_accounts (vendor_id) WHERE status = 'PENDING';

-- ------------------------------------------------------------------ capture

CREATE TABLE documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     uuid NOT NULL REFERENCES stores(id),
  -- Generated on the phone; makes uploads idempotent across retries from the offline outbox.
  client_id    uuid NOT NULL UNIQUE,
  captured_by  uuid NOT NULL REFERENCES users(id),
  page_count   integer NOT NULL CHECK (page_count BETWEEN 1 AND 10),
  -- [{ key, sha256, mime, bytes }] in page order. Keys point into the Storage driver (fs / s3).
  pages        jsonb NOT NULL CHECK (jsonb_typeof(pages) = 'array'),
  page_sha256  text[] NOT NULL,
  -- Raw QR strings decoded on the phone, plus how each was classified.
  qr_payloads  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The CaptureResponse returned the first time, replayed for repeated client_ids.
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(page_sha256) = page_count)
);
CREATE INDEX documents_page_sha_idx ON documents USING gin (page_sha256);
CREATE INDEX documents_store_idx ON documents (store_id, created_at DESC);

CREATE TABLE invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id             uuid NOT NULL REFERENCES stores(id),
  document_id          uuid NOT NULL UNIQUE REFERENCES documents(id),
  state                text NOT NULL DEFAULT 'CAPTURED' CHECK (state IN ('CAPTURED', 'EXTRACTING', 'NEEDS_VERIFICATION', 'VERIFIED', 'IN_PAYMENT_RUN', 'PAID', 'ON_HOLD', 'DUPLICATE', 'REJECTED', 'EXTRACTION_FAILED')),
  -- State to return to after ON_HOLD.
  held_from_state      text CHECK (held_from_state IN ('CAPTURED', 'NEEDS_VERIFICATION', 'VERIFIED', 'EXTRACTION_FAILED', 'DUPLICATE')),
  vendor_id            uuid REFERENCES vendors(id),
  -- header
  vendor_name          text,
  seller_gstin         text,
  buyer_gstin          text,
  invoice_no           text,
  invoice_date         date,
  irn                  text,
  doc_type             text NOT NULL DEFAULT 'INV' CHECK (doc_type IN ('INV', 'CRN', 'DBN')),
  -- Indian financial year of invoice_date, e.g. '2026-27' (set by the app).
  financial_year       text CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  -- totals (integer paise)
  taxable_paise        bigint NOT NULL DEFAULT 0,
  cgst_paise           bigint NOT NULL DEFAULT 0,
  sgst_paise           bigint NOT NULL DEFAULT 0,
  igst_paise           bigint NOT NULL DEFAULT 0,
  other_charges_paise  bigint NOT NULL DEFAULT 0,
  discount_paise       bigint NOT NULL DEFAULT 0,
  round_off_paise      bigint NOT NULL DEFAULT 0,
  grand_total_paise    bigint NOT NULL DEFAULT 0,
  header_meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  totals_meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  qr                   jsonb,
  -- blind total entry
  locked_total_paise   bigint,
  lock_attempts        integer NOT NULL DEFAULT 0 CHECK (lock_attempts >= 0),
  lock_flagged         boolean NOT NULL DEFAULT false,
  checks               jsonb NOT NULL DEFAULT '[]'::jsonb,
  extraction_runs      jsonb NOT NULL DEFAULT '[]'::jsonb,
  flagged_count        integer NOT NULL DEFAULT 0,
  due_date             date,
  hold_reason          text,
  reject_reason        text,
  duplicate_of         uuid REFERENCES invoices(id),
  duplicate_reason     text CHECK (duplicate_reason IN ('same_image', 'same_irn', 'same_number')),
  captured_by          uuid NOT NULL REFERENCES users(id),
  verified_by          uuid REFERENCES users(id),
  verified_at          timestamptz,
  verify_duration_ms   integer CHECK (verify_duration_ms >= 0),
  edit_count           integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'DUPLICATE' OR duplicate_of IS NOT NULL),
  CHECK (duplicate_of IS NULL OR duplicate_of <> id),
  CHECK (state <> 'ON_HOLD' OR held_from_state IS NOT NULL),
  -- A bill that can be paid must be sealed by a person and fully identified.
  CHECK (state NOT IN ('VERIFIED', 'IN_PAYMENT_RUN', 'PAID')
         OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND vendor_id IS NOT NULL
             AND invoice_no IS NOT NULL AND invoice_date IS NOT NULL AND due_date IS NOT NULL
             AND locked_total_paise IS NOT NULL))
);
CREATE INDEX invoices_store_created_idx ON invoices (store_id, created_at DESC, id DESC);
CREATE INDEX invoices_created_idx ON invoices (created_at DESC, id DESC);
CREATE INDEX invoices_state_idx ON invoices (state);
CREATE INDEX invoices_vendor_state_idx ON invoices (vendor_id, state);
CREATE INDEX invoices_due_idx ON invoices (due_date) WHERE state = 'VERIFIED';
-- The same e-invoice (IRN) or the same seller bill number in a financial year can be live only once.
-- Copies are kept, marked DUPLICATE (or REJECTED), so they don't count here.
CREATE UNIQUE INDEX invoices_live_irn ON invoices (irn)
  WHERE irn IS NOT NULL AND state NOT IN ('DUPLICATE', 'REJECTED');
CREATE UNIQUE INDEX invoices_live_number ON invoices (seller_gstin, upper(invoice_no), financial_year, doc_type)
  WHERE seller_gstin IS NOT NULL AND invoice_no IS NOT NULL AND financial_year IS NOT NULL AND state NOT IN ('DUPLICATE', 'REJECTED');

CREATE TABLE invoice_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  idx             integer NOT NULL CHECK (idx >= 0),
  description     text NOT NULL CHECK (length(description) <= 300),
  hsn             text CHECK (hsn ~ '^[0-9A-Z]{2,10}$'),
  qty_milli       bigint NOT NULL,
  unit            text CHECK (length(unit) <= 20),
  mrp_paise       bigint,
  rate_paise      bigint NOT NULL,
  discount_paise  bigint NOT NULL DEFAULT 0,
  gst_rate_bp     integer NOT NULL CHECK (gst_rate_bp BETWEEN 0 AND 10000),
  taxable_paise   bigint NOT NULL,
  tax_paise       bigint NOT NULL,
  total_paise     bigint NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'edited', 'removed')),
  source          text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted', 'manual')),
  meta            jsonb,
  box             jsonb,
  -- Values as first extracted, kept when a person edits the line.
  original        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, idx)
);

CREATE TABLE verification_events (
  id               bigserial PRIMARY KEY,
  invoice_id       uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_id          uuid REFERENCES invoice_lines(id) ON DELETE SET NULL,
  user_id          uuid NOT NULL REFERENCES users(id),
  action           text NOT NULL CHECK (action IN ('lock_total', 'accept', 'edit', 'remove', 'add_line', 'header_edit', 'seal', 'seal_refused', 'reject', 'hold', 'unhold', 're_extract')),
  detail           jsonb,
  -- Time since this user's previous event on this invoice (speed / accuracy analysis).
  ms_since_prev    integer,
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_events_invoice_idx ON verification_events (invoice_id, at);

-- ------------------------------------------------------------------ payments

CREATE SEQUENCE payment_run_ref_seq;

CREATE TABLE payment_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref            text NOT NULL UNIQUE CHECK (ref ~ '^[A-Z0-9]{1,17}$'),
  state          text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'APPROVED', 'UPLOADED', 'PAID', 'CANCELLED')),
  value_date     date NOT NULL,
  prepared_by    uuid NOT NULL REFERENCES users(id),
  approved_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  uploaded_by    uuid REFERENCES users(id),
  uploaded_at    timestamptz,
  paid_by        uuid REFERENCES users(id),
  paid_at        timestamptz,
  cancelled_by   uuid REFERENCES users(id),
  cancelled_at   timestamptz,
  -- The HDFC file is generated once at approval; re-downloads return these exact bytes.
  file_name      text,
  -- Encrypted (it contains full account numbers): AES-256-GCM "v1:iv:tag:ct".
  file_content   text,
  file_sha256    text CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_sequence  integer CHECK (file_sequence BETWEEN 1 AND 999),
  control        jsonb,
  warnings       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (value_date, file_sequence),
  CHECK (state IN ('DRAFT', 'CANCELLED')
         OR (approved_by IS NOT NULL AND file_name IS NOT NULL AND file_content IS NOT NULL AND file_sha256 IS NOT NULL AND control IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_at IS NOT NULL)
);
CREATE INDEX payment_runs_created_idx ON payment_runs (created_at DESC);

CREATE TABLE payment_run_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES payment_runs(id) ON DELETE CASCADE,
  vendor_id        uuid NOT NULL REFERENCES vendors(id),
  -- The bank account version paid (NULL only while a DRAFT is blocked for missing bank details).
  bank_account_id  uuid REFERENCES vendor_bank_accounts(id),
  amount_paise     bigint NOT NULL CHECK (amount_paise > 0),
  customer_ref     text NOT NULL UNIQUE CHECK (customer_ref ~ '^[A-Z0-9]{1,20}$'),
  txn_type         text CHECK (txn_type IN ('N', 'R', 'I')),
  state            text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'PAID', 'FAILED')),
  utr              text CHECK (utr ~ '^[A-Z0-9]{6,30}$'),
  fail_reason      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, vendor_id),
  CHECK (state <> 'FAILED' OR fail_reason IS NOT NULL)
);
CREATE INDEX payment_run_items_vendor_idx ON payment_run_items (vendor_id);

CREATE TABLE payment_run_bills (
  id            bigserial PRIMARY KEY,
  run_id        uuid NOT NULL REFERENCES payment_runs(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES payment_run_items(id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL REFERENCES invoices(id),
  -- Signed: credit notes are negative.
  amount_paise  bigint NOT NULL,
  -- false once the run is cancelled or the payment failed (the bill is due again).
  active        boolean NOT NULL DEFAULT true,
  released_at   timestamptz,
  released_reason text,
  UNIQUE (run_id, invoice_id),
  CHECK (active OR released_at IS NOT NULL)
);
-- A bill can be in only ONE open (non-cancelled, non-failed) payment run.
CREATE UNIQUE INDEX payment_run_bills_one_open_run ON payment_run_bills (invoice_id) WHERE active;
CREATE INDEX payment_run_bills_item_idx ON payment_run_bills (item_id);

-- ------------------------------------------------------------------ jobs (Postgres queue)

CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  state         text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'dead')),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  run_at        timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz,
  locked_by     text,
  last_error    text,
  -- At most one queued/running job per key (e.g. 'extract:<invoiceId>').
  dedupe_key    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CHECK (state <> 'running' OR locked_until IS NOT NULL)
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE state = 'queued';
CREATE INDEX jobs_lease_idx ON jobs (locked_until) WHERE state = 'running';
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running');

-- ------------------------------------------------------------------ audit log (append-only, hash chained)

CREATE TABLE audit_log (
  -- Assigned by the trigger, gapless, in chain order.
  id         bigint PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   uuid REFERENCES users(id),
  -- Display name at the time ('system' for the worker / migrations / seed).
  actor      text NOT NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text NOT NULL,
  detail     jsonb,
  reason     text,
  prev_hash  text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash       text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id, id DESC);

-- Canonical text of a row's content. jsonb::text is deterministic (keys sorted by jsonb rules).
CREATE FUNCTION audit_row_content(r audit_log) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|',
    r.id::text,
    to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(r.actor_id::text, ''),
    r.actor, r.action, r.entity, r.entity_id,
    coalesce(r.detail::text, ''),
    coalesce(r.reason, ''))
$$;

CREATE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_id bigint;
  last_hash text;
BEGIN
  -- Serialise appends so the chain never forks. Held until the inserting transaction ends.
  PERFORM pg_advisory_xact_lock(7243100001);
  SELECT id, hash INTO last_id, last_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.id := coalesce(last_id, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.hash := encode(sha256(convert_to(NEW.prev_hash || audit_row_content(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END $$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Returns the first row whose hash or link does not verify, or no rows when the whole chain is intact.
CREATE FUNCTION audit_verify() RETURNS TABLE (bad_id bigint, problem text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_log;
  expected_prev text := repeat('0', 64);
  expected_id bigint := 1;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY id LOOP
    IF r.id <> expected_id THEN
      bad_id := r.id; problem := 'gap in sequence (expected ' || expected_id || ')'; RETURN NEXT; RETURN;
    END IF;
    IF r.prev_hash <> expected_prev THEN
      bad_id := r.id; problem := 'prev_hash does not match previous row'; RETURN NEXT; RETURN;
    END IF;
    IF r.hash <> encode(sha256(convert_to(r.prev_hash || audit_row_content(r), 'UTF8')), 'hex') THEN
      bad_id := r.id; problem := 'hash does not match row content'; RETURN NEXT; RETURN;
    END IF;
    expected_prev := r.hash;
    expected_id := r.id + 1;
  END LOOP;
END $$;
