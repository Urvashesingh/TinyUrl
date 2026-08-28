import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createBatcher } from "./batch.js";
import { CLICK_CHANNEL, parseClickEvent, type ClickEvent } from "./events.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Analytics consumer. Runs as its own process, separate from the API.
 *
 * Separate because the two have opposite requirements: the API is latency
 * critical and should scale with request volume, while this is throughput
 * oriented and should scale with event volume. Sharing a process would let a
 * slow batch insert compete with a redirect for the same event loop.
 */
const prisma = new PrismaClient();

// A subscribed connection cannot issue ordinary commands, so this client is
// dedicated to the subscription. Offline queueing stays ON here: unlike the
// request path, there is no caller waiting, so buffering across a blip is
// strictly better than failing.
const subscriber = new Redis(config.redisUrl);

let dropped = 0;

const batcher = createBatcher<ClickEvent>({
  ...config.clickBatch,
  async flush(events) {
    await prisma.clickEvent.createMany({
      data: events.map((event) => ({
        code: event.code,
        occurredAt: new Date(event.occurredAt),
        userAgent: event.userAgent ?? null,
        referer: event.referer ?? null,
        ipHash: event.ipHash ?? null,
      })),
    });

    logger.debug({ count: events.length }, "click batch written");
  },
  onError(error, events) {
    // Analytics are lossy by construction at this phase; losing a batch is
    // survivable and must not stall the consumer or grow the buffer forever.
    dropped += events.length;
    logger.error({ err: error, count: events.length, dropped }, "click batch lost");
  },
});

subscriber.on("error", (error: Error) => {
  logger.warn({ err: error.message }, "subscriber connection problem");
});

subscriber.on("message", (channel, payload) => {
  if (channel !== CLICK_CHANNEL) {
    return;
  }

  const event = parseClickEvent(payload);
  if (!event) {
    // Malformed payloads are dropped rather than crashing the consumer: one
    // bad publisher must not be able to stop analytics for everyone.
    logger.warn({ payload: payload.slice(0, 200) }, "discarding unparseable click event");
    return;
  }

  batcher.add(event);
});

await subscriber.subscribe(CLICK_CHANNEL);
logger.info({ channel: CLICK_CHANNEL }, "click consumer listening");

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal, buffered: batcher.size() }, "consumer draining");

  const forceExit = setTimeout(() => {
    logger.error("grace period elapsed, exiting immediately");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  // Stop taking new events first, then write out what is already buffered.
  await subscriber.unsubscribe(CLICK_CHANNEL).catch(() => {});
  await batcher.drain();
  await Promise.allSettled([prisma.$disconnect(), subscriber.quit()]);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}
