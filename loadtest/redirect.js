import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

// The redirect path under increasing load. This is the hot path: creation is
// rare and cheap, redirects are the entire product.
//
// Run against the Compose stack:
//   npm run loadtest
//
// Rate limits are raised for the run (see docker-compose.loadtest.yml). The
// limiter has its own tests; the point here is to find where the *system*
// breaks, not to re-measure the limiter.

const BASE = __ENV.BASE_URL || "http://api:3000";
const LINKS = Number(__ENV.LINKS || 50);

const notFound = new Counter("redirect_not_found");
const throttled = new Counter("redirect_throttled");

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",
      // Arrival rate, not VUs: this holds request *rate* steady regardless of
      // how slow the system gets. With VUs, a slowing system quietly reduces
      // its own load and hides the breaking point.
      startRate: 100,
      timeUnit: "1s",
      preAllocatedVUs: 100,
      maxVUs: 2000,
      stages: [
        { target: 250, duration: "20s" },
        { target: 500, duration: "20s" },
        { target: 1000, duration: "20s" },
        { target: 2000, duration: "20s" },
        { target: 4000, duration: "30s" },
      ],
    },
  },
  thresholds: {
    // Deliberately strict, so a breach is informative rather than decorative.
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<200", "p(99)<500"],
  },
};

export function setup() {
  const codes = [];

  for (let i = 0; i < LINKS; i += 1) {
    const response = http.post(
      `${BASE}/links`,
      JSON.stringify({ longUrl: `https://example.com/loadtest/${i}` }),
      { headers: { "Content-Type": "application/json" } },
    );

    if (response.status === 201) {
      codes.push(response.json("code"));
    }
  }

  if (codes.length === 0) {
    throw new Error("setup created no links; is the API up and the rate limit raised?");
  }

  return { codes };
}

export default function (data) {
  const code = data.codes[Math.floor(Math.random() * data.codes.length)];
  // redirects: "manual" -- following them would measure example.com, not us.
  const response = http.get(`${BASE}/${code}`, { redirects: 0 });

  if (response.status === 404) notFound.add(1);
  if (response.status === 429) throttled.add(1);

  check(response, {
    "redirected": (r) => r.status === 302,
    "location present": (r) => !!r.headers.Location,
  });
}
