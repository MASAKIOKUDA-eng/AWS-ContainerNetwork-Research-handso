// HTTP latency / throughput test for one network path.
//
//   k6 run -e TARGET_URL=http://<endpoint>/1k -e MODE=latency -e RATE=500 -e DURATION=2m \
//          -e IP_POLICY=onlyIPv6 -e REUSE=yes -e LABEL=privatelink \
//          --summary-export results/raw/x.json k6-load.js
//
// MODE=latency    : constant arrival rate (same offered load for every path -> p99 is comparable)
// MODE=throughput : constant number of VUs downloading a large object (MB/s is comparable)
// IP_POLICY       : onlyIPv6 | onlyIPv4 | preferIPv6 | preferIPv4  (forces the address family)
// REUSE=no        : new TCP (+TLS) connection for every request (handshake cost becomes visible)
import http from 'k6/http';
import { check } from 'k6';

const TARGET_URL = __ENV.TARGET_URL;
if (!TARGET_URL) {
  throw new Error('TARGET_URL is required');
}
const MODE = __ENV.MODE || 'latency';
const RATE = parseInt(__ENV.RATE || '200', 10);
const VUS = parseInt(__ENV.VUS || '16', 10);
const DURATION = __ENV.DURATION || '2m';
const IP_POLICY = __ENV.IP_POLICY || 'onlyIPv6';
const EXPECT = parseInt(__ENV.EXPECT || '200', 10);

const measure = MODE === 'throughput'
  ? { executor: 'constant-vus', vus: VUS, duration: DURATION, startTime: '20s', tags: { phase: 'measure' } }
  : {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      startTime: '20s',
      preAllocatedVUs: Math.max(20, Math.floor(RATE / 5)),
      maxVUs: Math.max(200, RATE * 2),
      tags: { phase: 'measure' },
    };

export const options = {
  discardResponseBodies: true,
  noConnectionReuse: (__ENV.REUSE || 'yes') === 'no',
  dns: { ttl: '1m', select: 'random', policy: IP_POLICY },
  scenarios: {
    warmup: {
      executor: 'constant-vus',
      vus: 4,
      duration: '20s',
      tags: { phase: 'warmup' },
    },
    measure,
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    // Sub-metrics on the measure phase only, so the summary has clean numbers.
    'http_req_duration{phase:measure}': ['p(99)<60000'],
    'http_req_connecting{phase:measure}': ['p(99)<60000'],
    'http_req_tls_handshaking{phase:measure}': ['p(99)<60000'],
    'http_req_waiting{phase:measure}': ['p(99)<60000'],
    'http_req_failed{phase:measure}': ['rate<=1'],
    'data_received{phase:measure}': ['count>=0'],
    'iterations{phase:measure}': ['count>=0'],
    'dropped_iterations': ['count>=0'],
  },
};

export default function () {
  const res = http.get(TARGET_URL, {
    tags: { label: __ENV.LABEL || 'unknown' },
    responseCallback: http.expectedStatuses(EXPECT),
  });
  check(res, { [`status is ${EXPECT}`]: (r) => r.status === EXPECT });
}
