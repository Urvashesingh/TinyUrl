import http from "k6/http";
import { check } from "k6";

// A single fixed arrival rate, held steady. Used to walk the system up in
// steps and find the rate at which latency turns the corner, which a ramp
// cannot show precisely because every rate is only visited for a moment.
//
//   RATE=400 k6 run steady.js

const BASE = __ENV.BASE_URL || "http://api:3000";
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || "25s";
const LINKS = Number(__ENV.LINKS || 50);

export const options = {
  scenarios: {
    steady: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.min(RATE * 2, 1500),
      maxVUs: 3000,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<200"],
  },
};

export function setup() {
  const codes = [];
  for (let i = 0; i < LINKS; i += 1) {
    const response = http.post(
      `${BASE}/links`,
      JSON.stringify({ longUrl: `https://example.com/steady/${i}` }),
      { headers: { "Content-Type": "application/json" } },
    );
    if (response.status === 201) codes.push(response.json("code"));
  }
  if (codes.length === 0) throw new Error("setup created no links");
  return { codes };
}

export default function (data) {
  const code = data.codes[Math.floor(Math.random() * data.codes.length)];
  const response = http.get(`${BASE}/${code}`, { redirects: 0 });
  check(response, { redirected: (r) => r.status === 302 });
}
