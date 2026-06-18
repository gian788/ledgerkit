export enum TransactionStatus {
  PENDING = 'PENDING',
  SETTLED = 'SETTLED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum JournalLineDirection {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

export enum OutboxEventType {
  SETTLEMENT = 'SETTLEMENT',
  AUDIT = 'AUDIT',
}

// ── DB row shapes ────────────────────────────────────────────────────────────
// Amounts are BigInt (smallest currency unit — pence, cents, etc.)
// UUIDs are string (crypto.randomUUID())

export interface Organisation {
  id: string;
  name: string;
  jurisdiction: string;
  residency: string;
  created_at: Date;
}

export interface User {
  id: string;
  organisation_id: string;
  name: string;
  email: string;
  created_at: Date;
}

export interface Wallet {
  id: string;
  organisation_id: string;
  currency: string;
  balance: bigint;
  pending_amount: bigint;
  created_at: Date;
}

export interface Transaction {
  id: string;
  idempotency_key: string;
  source_wallet_id: string;
  destination_wallet_id: string;
  amount: bigint;
  currency: string;
  status: TransactionStatus;
  created_at: Date;
  settled_at: Date | null;
}

export interface JournalEntry {
  id: string;
  transaction_id: string;
  description: string;
  created_at: Date;
}

export interface JournalLine {
  id: string;
  journal_entry_id: string;
  wallet_id: string;
  amount: bigint;
  direction: JournalLineDirection;
}

export interface OutboxRow {
  id: string;
  type: OutboxEventType;
  transaction_id: string;
  payload: Record<string, unknown>;
  published: boolean;
  created_at: Date;
  published_at: Date | null;
}
