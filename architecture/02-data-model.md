# Data Model & Core Design Decisions

## DD-1: Org / User / Wallet hierarchy

- **Organisation** is the top-level entity. Holds jurisdiction and residency.
- **User** belongs to exactly one organisation.
- **Organisation** can have many wallets, each denominated in a single currency.

## DD-2: Double-entry bookkeeping

Every settled transaction produces a journal entry with balanced lines (sum of debits = sum of credits).
Journal entries are append-only — corrections are made via reversal entries, never mutations.

## DD-3: Transaction lifecycle — accept then settle

Two-phase flow:

1. **Accept (synchronous):** Validate balance, reserve funds, create transaction as PENDING, return to caller.
2. **Settle (async worker):** Write journal entry (debit + credit lines), update sender and receiver balances, mark transaction SETTLED.

## DD-4: Balance model — materialised balance + pending reservation

Each wallet stores two fields:
- `balance` — settled balance (only modified at settlement time)
- `pending_amount` — sum of all in-flight PENDING reservations

Available funds = `balance - pending_amount`.

**Tradeoff acknowledged:** accept-time reservation still serialises on the wallet row for the same sender, but the critical path is a single integer update (no journal writes), keeping the lock window minimal.

## DD-5: Reservation via atomic conditional update

Funds check and reservation happen in a single SQL statement:

```sql
UPDATE wallets
SET pending_amount = pending_amount + :amount
WHERE id = :wallet_id
  AND balance - pending_amount >= :amount
```

Zero rows affected = insufficient funds. No application-level retry needed; the DB handles row-level locking internally with the shortest possible lock duration.

## DD-6: Transaction states

- **PENDING** → funds reserved on sender, journal not yet written
- **SETTLED** → journal entry written, balances updated, reservation released
- **FAILED** → settlement could not complete, reservation released (pending_amount decremented, balance untouched)
- **CANCELLED** → user-initiated cancellation, reservation released (pending_amount decremented, balance untouched)

**Cancellation is best-effort via status check, not queue interception:**
- Cancel request: `UPDATE transactions SET status = 'CANCELLED' WHERE id = :id AND status = 'PENDING'` + atomic `pending_amount` release. If zero rows affected, transaction already settled — return "too late."
- Settlement worker: `UPDATE transactions SET status = 'SETTLED' WHERE id = :id AND status = 'PENDING'` inside its DB transaction. If zero rows affected (cancelled or already settled), abort and commit Kafka offset.
- Race safety: both sides use conditional UPDATE on `status = 'PENDING'` — exactly one wins, no double release of `pending_amount`.

## DD-12: Organisations and users are external

The ledger stores `organisation_id` and `user_id` as references but does not manage their lifecycle. Org/user management belongs to a separate identity service. For this project, seed them directly in the DB.

---

## Entities

```
organisations
  id              UUID PK
  name            VARCHAR
  jurisdiction    VARCHAR
  residency       VARCHAR
  created_at      TIMESTAMP

users
  id              UUID PK
  organisation_id UUID FK → organisations
  name            VARCHAR
  email           VARCHAR
  created_at      TIMESTAMP

wallets
  id              UUID PK
  organisation_id UUID FK → organisations
  currency        CHAR(3)          -- ISO 4217
  balance         BIGINT           -- smallest currency unit (pence, cents)
  pending_amount  BIGINT           -- sum of in-flight PENDING reservations
  created_at      TIMESTAMP

transactions
  id                    UUID PK
  idempotency_key       VARCHAR UNIQUE
  source_wallet_id      UUID FK → wallets
  destination_wallet_id UUID FK → wallets
  amount                BIGINT
  currency              CHAR(3)
  status                ENUM (PENDING, SETTLED, FAILED, CANCELLED)
  created_at            TIMESTAMP
  settled_at            TIMESTAMP NULL

journal_entries
  id              UUID PK
  transaction_id  UUID FK → transactions
  description     TEXT
  created_at      TIMESTAMP

journal_lines
  id                UUID PK
  journal_entry_id  UUID FK → journal_entries
  wallet_id         UUID FK → wallets
  amount            BIGINT
  direction         ENUM (DEBIT, CREDIT)

outbox
  id              UUID PK
  type            ENUM (SETTLEMENT, AUDIT)
  transaction_id  UUID FK → transactions
  payload         JSONB
  published       BOOLEAN DEFAULT false
  created_at      TIMESTAMP
  published_at    TIMESTAMP NULL
```
