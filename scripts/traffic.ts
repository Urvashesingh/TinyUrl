import { config } from "../src/config.js";

/**
 * Steady background clicks on links that already exist.
 *
 * Grafana panels are flat when nothing is happening, and a flat graph is a
 * poor advertisement for a system that is working. Run this in a second
 * terminal while the dashboard is on screen and the lines move.
 *
 * Unlike `npm run demo` this creates no new links, so the console's Recent
 * panel stays as it was. Ctrl+C to stop.
 *
 *   npm run traffic
 */
const BASE = process.env.DEMO_BASE_URL ?? `http://localhost:${config.port}`;

// Comfortably under the 600/min redirect limit, so the graphs show real
// traffic rather than a wall of 429s.
const PER_SECOND = Number(process.env.TRAFFIC_RATE ?? 5);

function headers(): Record<string, string> {
  return config.createApiKey ? { "X-API-Key": config.createApiKey } : {};
}

const response = await fetch(`${BASE}/links`, { headers: headers() }).catch(() => null);
if (!response?.ok) {
  console.error(`No server at ${BASE}. Start it: docker compose --profile app up -d`);
  process.exit(1);
}

const { links } = (await response.json()) as { links: Array<{ code: string }> };
if (links.length === 0) {
  console.error("No links to click. Run `npm run demo` first.");
  process.exit(1);
}

console.log(`Clicking ${links.length} links at ~${PER_SECOND}/s. Ctrl+C to stop.\n`);

let clicks = 0;
let errors = 0;

setInterval(() => {
  // Weighted towards the head of the list so the leaderboard keeps a shape
  // instead of flattening into a tie.
  const index = Math.floor(Math.random() ** 2 * links.length);
  const code = links[index].code;

  void fetch(`${BASE}/${code}`, { redirect: "manual" })
    .then((r) => {
      clicks += 1;
      if (r.status !== 302) {
        errors += 1;
      }
    })
    .catch(() => {
      errors += 1;
    });
}, 1000 / PER_SECOND);

setInterval(() => {
  process.stdout.write(`\r  ${clicks} clicks sent${errors ? `, ${errors} not redirected` : ""}   `);
}, 1000);
