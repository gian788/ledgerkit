# CI/CD & GitOps

## DD-17: CI/CD & GitOps

**Pipeline (on pull request):**
- Run tests scoped to what changed — if only settlement worker code changed, only run settlement-related tests. Keeps pipeline fast.
- Lint, type check, unit tests, integration tests as applicable.

**Pipeline (on merge to main):**
- Full test suite runs again.
- On success: build container images, push to registry, update Helm chart image tags.
- ArgoCD detects the change and syncs to cluster.

**GitOps — ArgoCD:**
- ArgoCD watches the Helm chart repo for changes and reconciles cluster state.
- Provides visibility into sync state, drift detection, and rollback history.
- Deployment audit trail: every change is a Git commit (who merged, when it synced, what was rolled back) — valuable for regulated environments.

**Deployment strategy — Canary with auto rollback:**
- All workloads deploy via canary rollout (Argo Rollouts).
- Small percentage of traffic goes to the new version first.
- Auto rollback triggered on error rate spike (monitored via Prometheus metrics).
- **Settlement worker is the highest-risk component** — a bug can corrupt balances. Canary gates on settlement success/failure rate before full promotion.
- API service canary gates on HTTP error rate and latency p99.

**Helm chart structure:**
- One chart per workload (api, settlement-worker, outbox-relay, audit-consumer), or a single umbrella chart with subcharts — TBD at implementation time.
- Environment-specific values files (dev, staging, production).
- ConfigMaps for application config, Secrets for credentials (DB connection strings, Kafka auth).
