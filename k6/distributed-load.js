/**
 * Distributed load stress test
 *
 * Models production load across thousands of wallets with low per-wallet activity.
 * Stresses API capacity, DB connection pool, Kafka partition spread, and
 * settlement worker parallelism. Unlike hot-wallet, there is minimal row contention
 * because each VU works on a different wallet pair.
 *
 * Run:
 *   k6 run k6/distributed-load.js
 *
 * With Prometheus remote-write output:
 *   k6 run --out experimental-prometheus-rw k6/distributed-load.js
 *
 * Env vars:
 *   BASE_URL      — API base URL (default: http://localhost:3000)
 *   WALLET_COUNT  — Number of wallets to create (default: 200)
 *   MAX_VUS       — Peak VU count (default: 200)
 */

import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const HEADERS = { 'Content-Type': 'application/json' };
const WALLET_COUNT = parseInt(__ENV.WALLET_COUNT || '200');
const MAX_VUS = parseInt(__ENV.MAX_VUS || '200');

// ── Custom metrics ────────────────────────────────────────────────────────────

const txCreateDuration = new Trend('tx_create_duration_ms', true);
const txCreated = new Counter('tx_created_total');
const txFailed = new Counter('tx_create_failed_total');

// ── Scenario config ───────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    distributed: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: MAX_VUS }, // ramp up
        { duration: '5m', target: MAX_VUS }, // sustain
        { duration: '1m', target: 0 }, // ramp down
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<1000', 'p(95)<500'],
    http_req_failed: ['rate<0.01'],
    tx_create_duration_ms: ['p(99)<1000'],
  },
};

// ── Setup: create org + WALLET_COUNT wallets, fund each ──────────────────────

export function setup() {
  const orgRes = http.post(
    `${BASE_URL}/organisations`,
    JSON.stringify({ name: 'Distributed Load Test', jurisdiction: 'GB', residency: 'GB' }),
    { headers: HEADERS },
  );
  if (orgRes.status !== 201) fail(`create org failed: ${orgRes.status} ${orgRes.body}`);
  const orgId = JSON.parse(orgRes.body).id;

  console.log(`Creating ${WALLET_COUNT} wallets...`);
  const wallets = [];
  for (let i = 0; i < WALLET_COUNT; i++) {
    const res = http.post(
      `${BASE_URL}/organisations/${orgId}/accounts`,
      JSON.stringify({ currency: 'GBP' }),
      { headers: HEADERS },
    );
    if (res.status !== 201) fail(`create wallet ${i} failed: ${res.status}`);
    wallets.push(JSON.parse(res.body).id);
  }

  // Fund each wallet with £10,000 (1,000,000 pence)
  console.log('Funding wallets...');
  const FUND = 1_000_000;
  for (const id of wallets) {
    const res = http.post(
      `${BASE_URL}/debug/accounts/${id}/fund`,
      JSON.stringify({ amount: FUND }),
      { headers: HEADERS },
    );
    if (res.status !== 200) fail(`fund wallet failed: ${res.status} ${res.body}`);
  }

  console.log(`Setup complete: org=${orgId}, wallets=${wallets.length}`);
  return { orgId, wallets };
}

// ── Main VU function ──────────────────────────────────────────────────────────

export default function ({ orgId, wallets }) {
  // Each VU uses its own wallet as source to avoid hot-wallet contention.
  // Destination is a random different wallet.
  const srcIdx = (__VU - 1) % wallets.length;
  let dstIdx;
  do {
    dstIdx = Math.floor(Math.random() * wallets.length);
  } while (dstIdx === srcIdx);

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/organisations/${orgId}/transactions`,
    JSON.stringify({
      idempotency_key: `dl-${__VU}-${__ITER}`,
      source_wallet_id: wallets[srcIdx],
      destination_wallet_id: wallets[dstIdx],
      amount: 10, // 10 pence per transaction
      currency: 'GBP',
    }),
    { headers: HEADERS },
  );

  txCreateDuration.add(Date.now() - start);

  const ok = check(res, {
    'status is 201': (r) => r.status === 201,
    'status is PENDING': (r) => JSON.parse(r.body).status === 'PENDING',
  });

  if (ok) {
    txCreated.add(1);
  } else {
    txFailed.add(1);
  }

  // Light pacing: 10 ms think time simulates realistic client behaviour
  // and prevents each VU from hammering at maximum CPU speed.
  sleep(0.01);
}
