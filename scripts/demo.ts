import { PrismaClient } from "@prisma/client";
import { config } from "../src/config.js";

/**
 * Seeds the console with something worth looking at.
 *
 * An empty leaderboard makes a working system look broken, and typing curl
 * commands while someone watches is a bad use of everyone's attention. This
 * creates a handful of links and gives them an uneven click distribution, so
 * the trending panel has an actual ranking rather than a row of ones.
 *
 *   npm run demo          add six links to whatever is already there
 *   npm run demo:reset    wipe every link first, then seed
 *
 * Reset exists because running the seed twice leaves two of everything, and a
 * console full of duplicates is a distraction while presenting.
 */
const BASE = process.env.DEMO_BASE_URL ?? `http://localhost:${config.port}`;

const LINKS: Array<{ url: string; clicks: number }> = [
  { url: "https://github.com/Urvashesingh/TinyUrl", clicks: 24 },
  { url: "https://www.postgresql.org/docs/current/ddl-partitioning.html", clicks: 15 },
  { url: "https://kafka.apache.org/documentation/#design", clicks: 9 },
  { url: "https://redis.io/docs/latest/develop/data-types/sorted-sets/", clicks: 6 },
  { url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/", clicks: 3 },
  { url: "https://grafana.com/docs/k6/latest/using-k6/scenarios/", clicks: 1 },
];

function headers(): Record<string, string> {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (config.createApiKey) {
    base["X-API-Key"] = config.createApiKey;
  }
  return base;
}

async function main(): Promise<void> {
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`No server at ${BASE}. Start it first: docker compose --profile app up -d`);
    process.exit(1);
  }

  // An argv flag rather than an env var: setting env vars inline is not
  // portable across PowerShell and POSIX shells, and this has to work on both.
  if (process.argv.includes("--reset")) {
    // Straight to the database: there is no delete endpoint, and there should
    // not be one just to support a demo script.
    const prisma = new PrismaClient();
    await prisma.$executeRawUnsafe("TRUNCATE click_events");
    const { count } = await prisma.link.deleteMany({});
    await prisma.$disconnect();
    console.log(`  cleared ${count} existing links
`);
  }

  for (const link of LINKS) {
    const response = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ longUrl: link.url }),
    });

    if (!response.ok) {
      console.error(`  create failed (${response.status}): ${link.url}`);
      continue;
    }

    const { code } = (await response.json()) as { code: string };

    // Sequential rather than parallel: the point is a believable ranking, and
    // a burst would just trip the rate limiter.
    for (let i = 0; i < link.clicks; i += 1) {
      await fetch(`${BASE}/${code}`, { redirect: "manual" });
    }

    console.log(`  ${code}  ${String(link.clicks).padStart(3)} clicks  ${link.url}`);
  }

  console.log(`\nDone. Open ${BASE} -- the trending panel fills in within a few seconds.`);
}

await main();
