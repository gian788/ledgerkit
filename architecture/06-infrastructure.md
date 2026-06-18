# Infrastructure & Observability

## DD-15: K8s Deployment & Workloads

**Four K8s workloads:**

| Workload          | Type                    | Scaling                                  | Sizing                               | Notes                                                                        |
| ----------------- | ----------------------- | ---------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| API Service       | Deployment              | HPA on CPU/request rate                  | Medium — request-bound               | Stateless, spread across 2 AZs                                               |
| Settlement Worker | Deployment              | KEDA on Kafka consumer lag               | Medium — bursty batch processing     | Replicas ≤ Kafka partitions                                                  |
| Outbox Relay      | Deployment (2 replicas) | None — single active via leader election | Small — polls DB, publishes to Kafka | K8s Lease API for leader election, standby replica for fast failover         |
| Audit Consumer    | Deployment              | HPA or fixed low replica count           | Small — reads queue, writes to S3    | Duplicates accepted for now; dedupe can be added later if volume warrants it |

**Managed services (outside K8s):**

- **Postgres** — RDS/Aurora (AWS), Cloud SQL (GCP), or Azure equivalent. Multi-AZ for HA.
- **Kafka** — MSK (AWS), Confluent Cloud, or equivalent. Partitioned by destination wallet ID.

**Multi-AZ:** All workloads spread across 2 availability zones. Pod anti-affinity rules ensure replicas don't land on the same AZ/node.

**Duplicate handling across the system:**

- Outbox relay: Lease API prevents concurrent leaders, but crash-before-mark-published can produce duplicates.
- Settlement worker: inherently idempotent — `UPDATE ... WHERE status = 'PENDING'` is a no-op on replay.
- Audit consumer: accepts occasional duplicates. S3 key-based deduplication can be added later if needed.

## DD-16: Observability — OpenTelemetry + Prometheus/Grafana/Jaeger

**No service mesh** — workloads communicate via Postgres and Kafka, not HTTP service-to-service. Istio/Linkerd would add sidecar overhead for minimal benefit. Revisit if HTTP-based microservices are added later.

**Stack:**

- **OpenTelemetry SDK** — application-level instrumentation for metrics, traces, and logs in all four workloads
- **Prometheus** — metrics collection and storage (scraped from OTel exporters)
- **Grafana** — dashboards and alerting
- **Jaeger** — distributed tracing (trace transaction lifecycle across API → relay → settlement)

**Key metrics to instrument:**

| Component         | Metrics                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| API Service       | Request latency (p50/p95/p99), error rate, requests/s, DB pool utilisation                        |
| Outbox Relay      | Poll frequency, rows fetched per poll, publish latency, relay lag (oldest unpublished row age)    |
| Settlement Worker | Kafka consumer lag, batch size, batch processing time, settlement success/failure rate            |
| Audit Consumer    | Consumer lag, S3 write latency, events/s                                                          |
| Cross-cutting     | Transaction lifecycle timing (created → settled), DB query latency, Kafka produce/consume latency |

**Key traces:**

- Full transaction lifecycle: API accept → outbox write → relay publish → Kafka → settlement → journal write
- Propagate trace context through Kafka message headers so the async path is linked to the originating API request

**Grafana dashboards (planned):**

- System health overview (all workloads)
- Transaction pipeline (throughput, latency, error rates per stage)
- Hot wallet monitor (transactions/s per wallet, settlement batch sizes)
- Outbox health (unpublished count, relay lag)
