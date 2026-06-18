# API Surface

## DD-11: REST API with nested writes, flat reads

**Design principles:**
- Write operations nested under the ledger to enforce context
- Read operations flat by globally-unique ID for convenience
- Journal entries are read-only (written by settlement worker, not API consumers)
- Cancel is an explicit action endpoint (POST), not a PATCH — it has side effects (releasing pending_amount)
- Idempotency key required on all write operations (header or body TBD)
- All list endpoints support filtering and pagination

## Endpoints

**Ledgers**
```
POST   /ledgers                                    Create a ledger
GET    /ledgers/:ledger_id                          Get a ledger
GET    /ledgers                                     List ledgers
```

**Accounts**
```
POST   /ledgers/:ledger_id/accounts                 Create an account (wallet)
GET    /accounts/:id                                Get an account
GET    /accounts/:id/balance                        Get account balance (balance, pending_amount, available)
GET    /ledgers/:ledger_id/accounts                 List accounts (filters: currency, organisation_id)
```

**Transactions**
```
POST   /ledgers/:ledger_id/transactions             Create a transaction (→ PENDING, reserves funds)
GET    /transactions/:tx_id                         Get a transaction
POST   /transactions/:tx_id/cancel                  Cancel a pending transaction (best-effort)
GET    /ledgers/:ledger_id/transactions             List transactions (filters: status, source_wallet_id, destination_wallet_id, date range)
```

**Journal Entries (read-only)**
```
GET    /journal-entries/:id                         Get a journal entry with its lines
GET    /ledgers/:ledger_id/journal-entries           List journal entries (filters: transaction_id, wallet_id, date range)
```

## Balance endpoint response shape

```json
{
  "account_id": "uuid",
  "currency": "GBP",
  "balance": 1000000,
  "pending_amount": 50000,
  "available": 950000,
  "updated_at": "2025-01-15T10:30:00Z"
}
```

Amounts in smallest currency unit (e.g. pence, cents).
