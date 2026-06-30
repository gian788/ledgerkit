/**
 * Hot wallet stress test
 *
 * Models the highest-contention case: two wallets transferring back and forth
 * at maximum throughput. Stresses row-level locks on wallet.pending_amount,
 * Kafka single-partition throughput, and settlement batching.
 *
 * Run:
 *   k6 run k6/hot-wallet.js
 *
 * With Prometheus remote-write output (requires Prometheus running):
 *   k6 run --out experimental-prometheus-rw k6/hot-wallet.js
 *
 * Env vars:
 *   BASE_URL   — API base URL (default: http://localhost:3000)
 *   VUS        — Number of virtual users (default: 50)
 *   DURATION   — Test duration (default: 5m)
 */

import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const HEADERS = { 'Content-Type': 'application/json' };

// ── Custom metrics ────────────────────────────────────────────────────────────

const txCreateDuration = new Trend('tx_create_duration_ms', true);
const txCreated = new Counter('tx_created_total');
const txFailed = new Counter('tx_create_failed_total');
const txRejected = new Rate('tx_insufficient_funds_rate');

// ── Scenario config ───────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    hot_wallet: {
      executor: 'constant-vus',
      vus: parseInt(__ENV.VUS || '50'),
      duration: __ENV.DURATION || '5m',
    },
  },
  thresholds: {
    // API must serve transaction creates within 500 ms at p99 under load
    http_req_duration: ['p(99)<500', 'p(95)<200'],
    // Error rate (network/5xx) must stay below 1%
    http_req_failed: ['rate<0.01'],
    // Custom: our transaction-create latency
    tx_create_duration_ms: ['p(99)<500'],
    // Insufficient-funds rejections should be near-zero (wallets are pre-funded)
    tx_insufficient_funds_rate: ['rate<0.001'],
  },
};

// ── Setup: create org + 2 wallets, fund each ─────────────────────────────────

export function setup() {
  const orgRes = http.post(
    `${BASE_URL}/organisations`,
    JSON.stringify({ name: 'Hot Wallet Load Test', jurisdiction: 'GB', residency: 'GB' }),
    { headers: HEADERS },
  );
  if (orgRes.status !== 201) fail(`create org failed: ${orgRes.status} ${orgRes.body}`);
  const orgId = JSON.parse(orgRes.body).id;

  function createWallet() {
    const res = http.post(
      `${BASE_URL}/organisations/${orgId}/accounts`,
      JSON.stringify({ currency: 'GBP' }),
      { headers: HEADERS },
    );
    if (res.status !== 201) fail(`create wallet failed: ${res.status} ${res.body}`);
    return JSON.parse(res.body).id;
  }

  const walletA = createWallet();
  const walletB = createWallet();

  // Fund each wallet with £100,000 (10,000,000 pence).
  // At 50 VUs × 100 pence/tx, headroom is 2,000,000 iterations — well beyond 5 min.
  const FUND = 10_000_000;
  for (const id of [walletA, walletB]) {
    const res = http.post(
      `${BASE_URL}/debug/accounts/${id}/fund`,
      JSON.stringify({ amount: FUND }),
      { headers: HEADERS },
    );
    if (res.status !== 200) fail(`fund wallet failed: ${res.status} ${res.body}`);
  }

  return { orgId, walletA, walletB };
}

// ── Main VU function ──────────────────────────────────────────────────────────

export default function ({ orgId, walletA, walletB }) {
  // Alternate direction each iteration so both wallets see balanced inflow/outflow
  const [src, dst] = __ITER % 2 === 0 ? [walletA, walletB] : [walletB, walletA];

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/organisations/${orgId}/transactions`,
    JSON.stringify({
      idempotency_key: `hw-${__VU}-${__ITER}`,
      source_wallet_id: src,
      destination_wallet_id: dst,
      amount: 100, // 100 pence = £1
      currency: 'GBP',
    }),
    { headers: HEADERS },
  );

  txCreateDuration.add(Date.now() - start);

  const ok = check(res, {
    'status is 201': (r) => r.status === 201,
    'body has id': (r) => JSON.parse(r.body).id !== undefined,
    'status is PENDING': (r) => JSON.parse(r.body).status === 'PENDING',
  });

  if (res.status === 422) {
    // Insufficient funds — wallets may be temporarily exhausted mid-test
    txRejected.add(1);
  } else if (!ok) {
    txFailed.add(1);
  } else {
    txCreated.add(1);
  }
}
