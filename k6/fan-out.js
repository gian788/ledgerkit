/**
 * Fan-out (payout) stress test
 *
 * Models a payroll/payout pattern: one sender wallet paying many receivers.
 * Unlike hot-wallet (bidirectional contention) or distributed load (no contention),
 * this tests source-side reservation contention — all VUs compete to decrement
 * the same wallet's pending_amount.
 *
 * The bottleneck here is the atomic conditional UPDATE on the payer wallet row.
 * Monitors whether the DB can serialise high-concurrency reservations without
 * excessive lock waits or deadlocks.
 *
 * Run:
 *   k6 run k6/fan-out.js
 *
 * With Prometheus remote-write output:
 *   k6 run --out experimental-prometheus-rw k6/fan-out.js
 *
 * Env vars:
 *   BASE_URL      — API base URL (default: http://localhost:3000)
 *   RECEIVER_COUNT — Number of receiver wallets (default: 100)
 *   VUS           — Number of virtual users (default: 100)
 *   DURATION      — Test duration (default: 5m)
 */

import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const HEADERS = { 'Content-Type': 'application/json' };
const RECEIVER_COUNT = parseInt(__ENV.RECEIVER_COUNT || '100');

// ── Custom metrics ────────────────────────────────────────────────────────────

const txCreateDuration = new Trend('tx_create_duration_ms', true);
const txCreated = new Counter('tx_created_total');
const txFailed = new Counter('tx_create_failed_total');
const reservationContention = new Rate('reservation_contention_rate');

// ── Scenario config ───────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    fan_out: {
      executor: 'constant-vus',
      vus: parseInt(__ENV.VUS || '100'),
      duration: __ENV.DURATION || '5m',
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<500', 'p(95)<200'],
    http_req_failed: ['rate<0.01'],
    tx_create_duration_ms: ['p(99)<500'],
    // Track contention rate — high values indicate serialisation bottleneck
    reservation_contention_rate: ['rate<0.05'],
  },
};

// ── Setup: 1 payer wallet + RECEIVER_COUNT receiver wallets ──────────────────

export function setup() {
  const orgRes = http.post(
    `${BASE_URL}/organisations`,
    JSON.stringify({ name: 'Fan-Out Load Test', jurisdiction: 'GB', residency: 'GB' }),
    { headers: HEADERS },
  );
  if (orgRes.status !== 201) fail(`create org failed: ${orgRes.status} ${orgRes.body}`);
  const orgId = JSON.parse(orgRes.body).id;

  // Create payer
  const payerRes = http.post(
    `${BASE_URL}/organisations/${orgId}/accounts`,
    JSON.stringify({ currency: 'GBP' }),
    { headers: HEADERS },
  );
  if (payerRes.status !== 201) fail(`create payer failed: ${payerRes.status}`);
  const payer = JSON.parse(payerRes.body).id;

  // Fund payer with £10,000,000 (1,000,000,000 pence)
  // At 100 VUs × 100 pence/tx, headroom is 10,000,000 iterations
  const res = http.post(
    `${BASE_URL}/debug/accounts/${payer}/fund`,
    JSON.stringify({ amount: 1_000_000_000 }),
    { headers: HEADERS },
  );
  if (res.status !== 200) fail(`fund payer failed: ${res.status} ${res.body}`);

  // Create receiver wallets
  console.log(`Creating ${RECEIVER_COUNT} receiver wallets...`);
  const receivers = [];
  for (let i = 0; i < RECEIVER_COUNT; i++) {
    const r = http.post(
      `${BASE_URL}/organisations/${orgId}/accounts`,
      JSON.stringify({ currency: 'GBP' }),
      { headers: HEADERS },
    );
    if (r.status !== 201) fail(`create receiver ${i} failed: ${r.status}`);
    receivers.push(JSON.parse(r.body).id);
  }

  console.log(`Setup complete: payer=${payer}, receivers=${receivers.length}`);
  return { orgId, payer, receivers };
}

// ── Main VU function ──────────────────────────────────────────────────────────

export default function ({ orgId, payer, receivers }) {
  // Each VU picks a random receiver
  const receiver = receivers[Math.floor(Math.random() * receivers.length)];

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/organisations/${orgId}/transactions`,
    JSON.stringify({
      idempotency_key: `fo-${__VU}-${__ITER}`,
      source_wallet_id: payer,
      destination_wallet_id: receiver,
      amount: 100, // 100 pence = £1 per payout
      currency: 'GBP',
    }),
    { headers: HEADERS },
  );

  txCreateDuration.add(Date.now() - start);

  const status = res.status;
  const ok = check(res, {
    'status is 201': (r) => r.status === 201,
    'status is PENDING': (r) => JSON.parse(r.body).status === 'PENDING',
  });

  if (ok) {
    txCreated.add(1);
  } else if (status === 409 || status === 503) {
    // Reservation contention: API returned a conflict or unavailable
    reservationContention.add(1);
    txFailed.add(1);
  } else {
    txFailed.add(1);
  }
}
