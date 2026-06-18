// Outbox relay — polls the outbox table, publishes to Kafka (SETTLEMENT →
// transactions.pending, AUDIT → audit.events), marks rows as published.
// Leader election via K8s Lease API prevents concurrent relays.
// Implementation: phase 3 (see CLAUDE.md implementation order).

console.log('outbox-relay: not yet implemented');
