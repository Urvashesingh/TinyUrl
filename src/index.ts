import { PrismaClient } from "@prisma/client";
import { createApp } from "./app.js";
import { createLinkCache } from "./cache.js";
import { createRedisEventPublisher, type EventPublisher } from "./events.js";
import { createKafka, createKafkaEventPublisher, ensureClickTopic } from "./kafka.js";
import { closeRedis, createRedis } from "./redis.js";
import { attachLiveFeed } from "./liveFeed.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const prisma = new PrismaClient();
const redis = createRedis("api");
const cache = createLinkCache(redis);

let droppedEvents = 0;
function noteDroppedEvent(): void {
  droppedEvents += 1;
  // Only logged on powers of ten: an outage would otherwise produce one line
  // per redirect and bury everything else.
  if (Number.isInteger(Math.log10(droppedEvents))) {
    logger.warn({ droppedEvents }, "click events dropped");
  }
}

let events: EventPublisher;
let closeEvents: () => Promise<void> = async () => {};

if (config.eventTransport === "kafka") {
  const kafka = createKafka("api");
  await ensureClickTopic(kafka);
  const publisher = await createKafkaEventPublisher(kafka, noteDroppedEvent);
  events = publisher;
  closeEvents = () => publisher.close();
} else {
  events = createRedisEventPublisher(redis, noteDroppedEvent);
}

// Declared before createApp so the route can read the feed's snapshot, and
// assigned after listen() because the WebSocket server attaches to the HTTP
// server.
let liveFeed: ReturnType<typeof attachLiveFeed> | null = null;

const app = createApp({
  prisma,
  cache,
  redis,
  events,
  trendingSnapshot: () => liveFeed?.snapshot() ?? [],
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, transport: config.eventTransport }, "listening");
});

liveFeed = attachLiveFeed(server, redis);

/** How long in-flight requests get to finish before we stop being polite. */
const SHUTDOWN_GRACE_MS = 10_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, "draining connections");

  // A single hung keep-alive connection should not keep the pod alive forever.
  const forceExit = setTimeout(() => {
    logger.error("grace period elapsed, exiting immediately");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  // Close WebSocket clients first: server.close() waits for connections to
  // end, and an open socket would otherwise hold it until the force-exit.
  await liveFeed?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Flush buffered producer batches before the socket closes, or the last
  // events of a deploy are lost for no reason.
  await Promise.allSettled([closeEvents(), prisma.$disconnect(), closeRedis(redis)]);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}
