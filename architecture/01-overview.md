# Ledger Service — Overview

General-purpose financial ledger accessible via REST API.
Built with Node.js, deployed on Kubernetes.
Single-currency transfers first; multi-currency support planned for later via dedicated account type.

## Component Architecture

```
┌─────────────┐     ┌──────────┐     ┌─────────┐     ┌─────────┐
│  API Nodes  │────▶│ Postgres │────▶│  Relay  │────▶│  Kafka  │
│ (stateless) │     │          │     │         │     │         │
└─────────────┘     └──────────┘     └─────────┘     └────┬────┘
                         ▲                                  │
                         │              ┌───────────────────┤
                         │              │                   │
                         │              ▼                   ▼
                         │   ┌───────────────────┐  ┌──────────────┐
                         └───│ Settlement Workers│  │Audit Consumer│
                             │   (batch + write) │  │   (→ S3)     │
                             └───────────────────┘  └──────────────┘
```

Each component scales independently:

- **API nodes** — horizontal, stateless
- **Relay** — single instance via K8s Lease API leader election, standby replica for failover
- **Settlement workers** — horizontal, partitioned by Kafka partition (keyed on destination wallet ID)
- **Audit consumer** — lightweight, reads from Kafka, writes to S3 Object Lock

**Managed services (outside K8s):**

- **Postgres** — RDS/Aurora, Cloud SQL, or Azure equivalent
- **Kafka** — MSK, Confluent Cloud, or equivalent
